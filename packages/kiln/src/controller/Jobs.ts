import { Context, Deferred, Effect, Fiber, Layer, Option, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { randomBytes } from "node:crypto"
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import type { Job, JobEvent, JobResult } from "../Protocol.ts"
import { Unauthorized } from "../Protocol.ts"
import { Config } from "./Config.ts"

export type Pool = "pr" | "trusted"

export interface Sample {
  readonly timestamp: number
  readonly cpuPercent: number
  readonly memoryBytes: number
}

export interface ActiveJob {
  readonly id: string
  readonly token: string
  readonly spec: Job
  readonly pool: Pool
  readonly onEvent: (event: JobEvent) => Effect.Effect<void>
  readonly result: Deferred.Deferred<JobResult>
  readonly samples: Array<Sample>
  /** Set by the RPC server while the job holds a deploy lease. */
  lease: string | undefined
}

export interface Usage {
  readonly cpuSeconds: number | null
  readonly memoryPeakBytes: number | null
}

export class Jobs extends Context.Service<Jobs, {
  /**
   * Runs a job in a worker and waits for its result. Interrupting stops the worker, unless the job is
   * uninterruptible (actions), in which case it is waited for.
   */
  readonly run: (spec: Job, options: {
    readonly pool: Pool
    readonly onEvent: (event: JobEvent) => Effect.Effect<void>
    readonly onStart?: (job: ActiveJob) => Effect.Effect<void>
    /** Actions finish what they started: cancelling waits for them instead of stopping them. */
    readonly uninterruptible?: boolean
  }) => Effect.Effect<{ readonly result: JobResult; readonly usage: Usage; readonly id: string }>
  readonly authorize: (id: string, token: string) => Effect.Effect<ActiveJob, Unauthorized>
  readonly get: (id: string) => ActiveJob | undefined
  readonly active: () => ReadonlyArray<ActiveJob>
}>()("kiln/controller/Jobs") {}

const groupId = (name: string) => {
  const line = readText("/etc/group")?.split("\n").find((l) => l.startsWith(`${name}:`))
  return line === undefined ? undefined : Number(line.split(":")[2])
}

const parseCpuUsec = (stat: string) => Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0)
const readNumber = (path: string) => {
  try {
    return Number(readFileSync(path, "utf8").trim())
  } catch {
    return null
  }
}
const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export const layer = Layer.effect(Jobs)(Effect.gen(function*() {
  const config = yield* Config
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const jobs = new Map<string, ActiveJob>()
  const jobsDir = join(config.runtimeDir, "jobs")
  mkdirSync(jobsDir, { recursive: true, mode: 0o751 })
  // systemd creates the runtime directory with the controller's own group; workers need to reach the
  // socket and their token files in it.
  const workers = groupId("kiln-workers")
  if (workers !== undefined) {
    chownSync(config.runtimeDir, process.getuid!(), workers)
    chmodSync(config.runtimeDir, 0o750)
    chownSync(jobsDir, process.getuid!(), workers)
    chmodSync(jobsDir, 0o750)
  }
  const exec = (argv: ReadonlyArray<string>) => Exec.exec(argv).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

  const unit = (pool: Pool, id: string) => `kiln-job-${pool}@${id}.service`

  // A controller restart orphans running workers; their tokens are gone, so stop them.
  if (config.jobs.mode === "systemd") {
    yield* exec(["systemctl", "stop", "kiln-job-pr@*.service", "kiln-job-trusted@*.service"]).pipe(Effect.ignore)
  }

  const groupOf = (pool: Pool) => groupId(`kiln-${pool}`)

  const cgroupOf = (pool: Pool, id: string) =>
    exec(["systemctl", "show", "-p", "ControlGroup", "--value", unit(pool, id)]).pipe(
      Effect.map((r) => (r.stdout.trim() === "" ? undefined : join("/sys/fs/cgroup", r.stdout.trim()))),
    )

  /** Whether the unit is still alive, and why it died if not. */
  const unitState = (pool: Pool, id: string) =>
    exec(["systemctl", "show", "-p", "ActiveState", "-p", "Result", unit(pool, id)]).pipe(
      Effect.map((r) => {
        const props = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]))
        return { active: props.ActiveState === "active" || props.ActiveState === "activating", result: props.Result ?? "" }
      }),
    )

  const run: Jobs["Service"]["run"] = (spec, options) =>
    Effect.gen(function*() {
      const id = randomBytes(8).toString("hex")
      const token = randomBytes(32).toString("hex")
      const result = yield* Deferred.make<JobResult>()
      const job: ActiveJob = { id, token, spec, pool: options.pool, onEvent: options.onEvent, result, samples: [], lease: undefined }
      const tokenFile = join(jobsDir, `${id}.token`)

      const start = Effect.gen(function*() {
        jobs.set(id, job)
        writeFileSync(tokenFile, token, { mode: 0o640 })
        const gid = groupOf(options.pool)
        if (gid !== undefined && config.jobs.mode === "systemd") chownSync(tokenFile, process.getuid!(), gid)
        if (options.onStart) yield* options.onStart(job)
      })

      const cleanup = Effect.sync(() => {
        jobs.delete(id)
        if (existsSync(tokenFile)) rmSync(tokenFile)
      })

      let cpuStart: number | null = null
      let cpuLast: { usec: number; at: number } | null = null
      let cgroup: string | undefined
      const sample = Effect.gen(function*() {
        cgroup ??= yield* cgroupOf(options.pool, id)
        if (cgroup === undefined) return
        const usec = parseCpuUsec(readText(join(cgroup, "cpu.stat")) ?? "")
        const memory = readNumber(join(cgroup, "memory.current")) ?? 0
        const now = Date.now()
        cpuStart ??= usec
        const percent = cpuLast === null ? 0 : ((usec - cpuLast.usec) / 1000 / (now - cpuLast.at)) * 100
        cpuLast = { usec, at: now }
        job.samples.push({ timestamp: now, cpuPercent: Math.round(percent), memoryBytes: memory })
        if (job.samples.length > 1800) job.samples.shift()
      })
      let memoryPeak: number | null = null
      const finalUsage = Effect.sync((): Usage => {
        if (cgroup !== undefined) memoryPeak = readNumber(join(cgroup, "memory.peak")) ?? memoryPeak
        const cpuSeconds = cpuLast === null || cpuStart === null ? null : (cpuLast.usec - cpuStart) / 1e6
        return { cpuSeconds, memoryPeakBytes: memoryPeak ?? Math.max(0, ...job.samples.map((s) => s.memoryBytes)) }
      })

      const systemd = Effect.gen(function*() {
        // Without --no-block this returns once systemd has executed the worker (Type=exec), so the unit
        // is active when the watch below first looks.
        const started = yield* exec(["systemctl", "start", unit(options.pool, id)])
        if (started.exitCode !== 0) {
          return { _tag: "Died", message: `could not start the worker: ${started.stderr.trim()}` } satisfies JobResult
        }
        const watch = Effect.gen(function*() {
          yield* sample.pipe(Effect.ignore)
          const state = yield* unitState(options.pool, id)
          if (!state.active) {
            yield* Effect.sleep("1 second")
            const done = yield* Deferred.poll(result)
            if (Option.isNone(done)) {
              yield* Deferred.succeed(result, {
                _tag: "Died",
                message: state.result === "oom-kill"
                  ? "the worker ran out of memory and was killed"
                  : `the worker exited without a result (${state.result || "unknown"})`,
              })
            }
          }
        }).pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped)
        const fiber = yield* watch
        const value = yield* Deferred.await(result)
        yield* sample.pipe(Effect.ignore)
        yield* Fiber.interrupt(fiber)
        return value
      })

      const processMode = Effect.gen(function*() {
        const [command, ...args] = config.workerCommand
        const handle = yield* spawner.spawn(ChildProcess.make(command!, [...args, "worker", id], {
          env: { KILN_SOCKET: join(config.runtimeDir, "worker.sock"), KILN_TOKEN_FILE: tokenFile },
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
          detached: true,
          forceKillAfter: "10 seconds",
        }))
        const exited = yield* handle.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.sleep("500 millis").pipe(
              Effect.andThen(Deferred.succeed(result, { _tag: "Died", message: `the worker exited with ${code} without a result` })),
            )
          ),
          Effect.ignore,
          Effect.forkScoped,
        )
        const value = yield* Deferred.await(result)
        yield* Fiber.interrupt(exited)
        return value
      })

      const stop = config.jobs.mode === "systemd"
        ? exec(["systemctl", "stop", unit(options.pool, id)]).pipe(Effect.ignore)
        : Effect.void

      const body = Effect.scoped(
        (config.jobs.mode === "systemd" ? systemd : processMode).pipe(Effect.onInterrupt(() => stop)),
      ).pipe(
        Effect.catch((error) => Effect.succeed({ _tag: "Died", message: `the worker failed to run: ${error.message}` } satisfies JobResult)),
      )
      const value = yield* Effect.acquireUseRelease(
        start,
        () => (options.uninterruptible === true ? Effect.uninterruptible(body) : body),
        () => cleanup,
      )
      return { result: value, usage: yield* finalUsage, id }
    })

  return {
    run,
    authorize: (id, token) => {
      const job = jobs.get(id)
      return job !== undefined && job.token === token
        ? Effect.succeed(job)
        : Effect.fail(new Unauthorized({ reason: "unknown job or wrong token" }))
    },
    get: (id) => jobs.get(id),
    active: () => [...jobs.values()],
  }
}))
