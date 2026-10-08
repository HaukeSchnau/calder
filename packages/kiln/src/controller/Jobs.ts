import { Context, Deferred, Effect, Fiber, Layer, Option, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { randomBytes } from "node:crypto"
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { sha256 } from "../Keys.ts"
import type { Job, JobEvent, JobResult } from "../Protocol.ts"
import { Unauthorized } from "../Protocol.ts"
import { Agents } from "./Agents.ts"
import { Config } from "./Config.ts"

export type Pool = "pr" | "trusted"

export interface Sample {
  readonly timestamp: number
  readonly cpuPercent: number
  readonly memoryBytes: number
}

export interface ActiveJob {
  readonly id: string
  readonly tokenHash: string
  readonly spec: Job
  readonly pool: Pool
  /** Runs on an agent, which fetches over HTTP what local workers read from disk. */
  readonly remote: boolean
  readonly onEvent: (event: JobEvent) => Effect.Effect<void>
  readonly result: Deferred.Deferred<JobResult>
  readonly samples: Array<Sample>
  /** Set by the RPC server while the job holds a deploy lease: the project, its app and its endpoints. */
  lease: { readonly project: string; readonly app: string; readonly targets: ReadonlyArray<string> } | undefined
}

export interface Usage {
  readonly cpuSeconds: number | null
  readonly memoryPeakBytes: number | null
}

/** A worker that kept running while the controller restarted. */
export interface Adopted {
  readonly id: string
  readonly spec: Extract<Job, { readonly _tag: "Step" }>
  readonly startedAt: number
}

export class Jobs extends Context.Service<Jobs, {
  /**
   * Runs a job in a worker and waits for its result. Interrupting stops the worker, unless the job is
   * uninterruptible (actions), in which case it is waited for.
   */
  readonly run: (spec: Job, options: {
    readonly pool: Pool
    readonly onEvent: (event: JobEvent) => Effect.Effect<void>
    /** Runs as the worker starts: here at once, on an agent once one takes the job. */
    readonly onStart?: Effect.Effect<void>
    /** Actions finish what they started: cancelling waits for them instead of stopping them. */
    readonly uninterruptible?: boolean
    /** Another platform than the controller's runs on an agent of that platform. */
    readonly platform?: string | null
    /** Runs on an agent even of the controller's platform. */
    readonly agent?: boolean
    /** Taken only by an agent with a free slot right now; otherwise the job comes back `Lost`. */
    readonly offload?: boolean
    /** A local step that may outlive a restart of the controller, which adopts it instead of stopping it. */
    readonly adoptable?: boolean
  }) => Effect.Effect<{ readonly result: JobResult; readonly usage: Usage; readonly id: string }>
  /** The workers adopted at startup that no step has reattached yet. */
  readonly adopted: () => ReadonlyArray<Adopted>
  /** Takes over an adopted worker for its step: waits for it like `run` waits for a new one. */
  readonly reattach: (id: string, onEvent: (event: JobEvent) => Effect.Effect<void>) => Effect.Effect<{ readonly result: JobResult; readonly usage: Usage; readonly id: string }>
  /** Completes once an adopted worker finished, was stopped, or was given up for lack of a step. */
  readonly settled: (id: string) => Effect.Effect<void>
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
  const agents = yield* Agents
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const sql = yield* SqlClient.SqlClient
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
  const jobs = new Map<string, ActiveJob>()
  // Workers outlive a stopping controller; the next one adopts them. Effect interrupts every fiber on
  // the signal, and only this tells that apart from cancelling a job.
  let stopping = false
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => (stopping = true))
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

  /** Samples a local worker's cgroup while it runs, and turns a unit that died without a result into one. */
  const follow = (job: ActiveJob) =>
    Effect.gen(function*() {
      // A unit's cgroup counts CPU from the unit's start, adopted or not.
      const cpuStart = 0
      let cpuLast: { usec: number; at: number } | null = null
      let cgroup: string | undefined
      const sample = Effect.gen(function*() {
        cgroup ??= yield* cgroupOf(job.pool, job.id)
        if (cgroup === undefined) return
        const usec = parseCpuUsec(readText(join(cgroup, "cpu.stat")) ?? "")
        const memory = readNumber(join(cgroup, "memory.current")) ?? 0
        const now = Date.now()
        const percent = cpuLast === null ? 0 : ((usec - cpuLast.usec) / 1000 / (now - cpuLast.at)) * 100
        cpuLast = { usec, at: now }
        job.samples.push({ timestamp: now, cpuPercent: Math.round(percent), memoryBytes: memory })
        if (job.samples.length > 1800) job.samples.shift()
      })
      let memoryPeak: number | null = null
      const finalUsage = Effect.sync((): Usage => {
        if (cgroup !== undefined) memoryPeak = readNumber(join(cgroup, "memory.peak")) ?? memoryPeak
        const cpuSeconds = cpuLast === null ? null : (cpuLast.usec - cpuStart) / 1e6
        return { cpuSeconds, memoryPeakBytes: memoryPeak ?? Math.max(0, ...job.samples.map((s) => s.memoryBytes)) }
      })
      const watch = Effect.gen(function*() {
        yield* sample.pipe(Effect.ignore)
        const state = yield* unitState(job.pool, job.id)
        if (!state.active) {
          yield* Effect.sleep("1 second")
          const done = yield* Deferred.poll(job.result)
          if (Option.isNone(done)) {
            yield* Deferred.succeed(job.result, {
              _tag: "Died",
              message: state.result === "oom-kill"
                ? "the worker ran out of memory and was killed"
                : `the worker exited without a result (${state.result || "unknown"})`,
            })
          }
        }
      }).pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped)
      const fiber = yield* watch
      const value = yield* Deferred.await(job.result)
      yield* sample.pipe(Effect.ignore)
      yield* Fiber.interrupt(fiber)
      return { result: value, usage: yield* finalUsage }
    })

  const stopUnit = (pool: Pool, id: string) => exec(["systemctl", "stop", unit(pool, id)]).pipe(Effect.ignore)

  // Workers the last controller left running: adopt those whose units still run, stop the rest.
  const adoptable = new Map<string, Adopted>()
  const sinks = new Map<string, { buffer: Array<JobEvent>; target: ((event: JobEvent) => Effect.Effect<void>) | undefined }>()
  const settledOf = new Map<string, Deferred.Deferred<void>>()
  const forget = (id: string) =>
    Effect.gen(function*() {
      jobs.delete(id)
      adoptable.delete(id)
      sinks.delete(id)
      yield* db(sql`delete from jobs where id = ${id}`)
      const settled = settledOf.get(id)
      if (settled !== undefined) yield* Deferred.succeed(settled, undefined)
    })
  if (config.jobs.mode === "systemd") {
    const rows = yield* db(sql<{ id: string; token_hash: string; pool: Pool; spec: string; created_at: number }>`select * from jobs`)
    for (const row of rows) {
      const spec = JSON.parse(row.spec) as Job
      const state = yield* unitState(row.pool, row.id)
      if (!state.active || spec._tag !== "Step") {
        yield* db(sql`delete from jobs where id = ${row.id}`)
        continue
      }
      const sink = { buffer: [] as Array<JobEvent>, target: undefined as ((event: JobEvent) => Effect.Effect<void>) | undefined }
      sinks.set(row.id, sink)
      settledOf.set(row.id, Deferred.makeUnsafe<void>())
      adoptable.set(row.id, { id: row.id, spec, startedAt: row.created_at })
      jobs.set(row.id, {
        id: row.id,
        tokenHash: row.token_hash,
        spec,
        pool: row.pool,
        remote: false,
        onEvent: (event) => sink.target?.(event) ?? Effect.sync(() => sink.buffer.push(event)),
        result: Deferred.makeUnsafe<JobResult>(),
        samples: [],
        lease: undefined,
      })
    }
    const listed = yield* exec(["systemctl", "list-units", "--all", "--plain", "--no-legend", "kiln-job-pr@*.service", "kiln-job-trusted@*.service"])
    const kept = new Set([...adoptable.values()].map((a) => unit(jobs.get(a.id)!.pool, a.id)))
    const orphans = listed.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((u) => u.startsWith("kiln-job-") && !kept.has(u))
    if (orphans.length > 0) yield* exec(["systemctl", "stop", ...orphans]).pipe(Effect.ignore)
    if (adoptable.size > 0) yield* Effect.logInfo(`adopted ${adoptable.size} running workers`)
    // A step reattaches within seconds of the restart; a worker no step claims is of no use.
    yield* Effect.forEach([...adoptable.keys()], (id) =>
      Effect.gen(function*() {
        if (!adoptable.has(id)) return
        const job = jobs.get(id)
        if (job !== undefined) yield* stopUnit(job.pool, id)
        yield* forget(id)
      }), { discard: true }).pipe(Effect.delay("10 minutes"), Effect.forkScoped)
  }

  const run: Jobs["Service"]["run"] = (spec, options) =>
    Effect.gen(function*() {
      const id = randomBytes(8).toString("hex")
      const token = randomBytes(32).toString("hex")
      const result = yield* Deferred.make<JobResult>()
      const platform = options.platform ?? config.system
      const remote = options.agent === true || platform !== config.system
      const job: ActiveJob = { id, tokenHash: sha256(token), spec, pool: options.pool, remote, onEvent: options.onEvent, result, samples: [], lease: undefined }
      const tokenFile = join(jobsDir, `${id}.token`)
      const persisted = options.adoptable === true && !remote && config.jobs.mode === "systemd" && spec._tag === "Step"

      const start = Effect.gen(function*() {
        jobs.set(id, job)
        writeFileSync(tokenFile, token, { mode: 0o640 })
        const gid = groupOf(options.pool)
        if (gid !== undefined && config.jobs.mode === "systemd") chownSync(tokenFile, process.getuid!(), gid)
        // The worker fetched its secrets when it started; the journal never holds them.
        if (persisted) {
          yield* db(sql`insert into jobs (id, token_hash, pool, spec, created_at)
            values (${id}, ${job.tokenHash}, ${options.pool}, ${JSON.stringify({ ...spec, secrets: {} })}, ${Date.now()})`)
        }
      })
      const onStart = options.onStart ?? Effect.void

      const cleanup = Effect.gen(function*() {
        if (stopping && persisted) return
        jobs.delete(id)
        if (existsSync(tokenFile)) rmSync(tokenFile)
        if (persisted) yield* db(sql`delete from jobs where id = ${id}`)
      })

      let usage: Usage = { cpuSeconds: null, memoryPeakBytes: null }
      const systemd = Effect.gen(function*() {
        // Without --no-block this returns once systemd has executed the worker (Type=exec), so the unit
        // is active when the watch below first looks.
        yield* onStart
        const started = yield* exec(["systemctl", "start", unit(options.pool, id)])
        if (started.exitCode !== 0) {
          return { _tag: "Died", message: `could not start the worker: ${started.stderr.trim()}` } satisfies JobResult
        }
        const followed = yield* follow(job)
        usage = followed.usage
        return followed.result
      })

      const processMode = Effect.gen(function*() {
        const [command, ...args] = config.workerCommand
        yield* onStart
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

      const agentMode = Effect.gen(function*() {
        // An offloaded job never waits: no agent takes it, and it runs here.
        if (options.offload !== true) {
          const stale = agents.usage().filter((a) => a.connected && !a.current && a.platform === platform)
          const why = stale.map((a) => `; ${a.name} runs another Kiln build (${a.build}) and needs a deploy`).join("")
          yield* options.onEvent({ _tag: "Log", stream: "kiln", text: `waiting for a ${platform} agent${why}`, timestamp: Date.now() })
        }
        const exited = yield* agents.run({ id, token }, platform, { wait: options.offload !== true, onPlaced: onStart }).pipe(
          Effect.flatMap((code) =>
            Effect.sleep("1 second").pipe(
              Effect.andThen(Deferred.succeed(result, {
                _tag: "Lost",
                message: code === -1
                  ? "the agent lost the worker"
                  : code === -2
                  ? "no agent had a free slot"
                  : `the worker exited with ${code} on the agent without a result`,
              })),
            )
          ),
          Effect.forkScoped,
        )
        const value = yield* Deferred.await(result)
        yield* Fiber.interrupt(exited)
        return value
      })

      const stop = remote
        ? agents.stop(id)
        : config.jobs.mode === "systemd"
        ? Effect.suspend(() => (stopping && persisted ? Effect.void : stopUnit(options.pool, id)))
        : Effect.void

      const body = Effect.scoped(
        (remote ? agentMode : config.jobs.mode === "systemd" ? systemd : processMode).pipe(Effect.onInterrupt(() => stop)),
      ).pipe(
        Effect.catch((error) => Effect.succeed({ _tag: "Died", message: `the worker failed to run: ${error.message}` } satisfies JobResult)),
      )
      const value = yield* Effect.acquireUseRelease(
        start,
        () => (options.uninterruptible === true ? Effect.uninterruptible(body) : body),
        () => cleanup,
      )
      return { result: value, usage, id }
    })

  const reattach: Jobs["Service"]["reattach"] = (id, onEvent) =>
    Effect.gen(function*() {
      const job = jobs.get(id)
      const sink = sinks.get(id)
      if (job === undefined || sink === undefined || !adoptable.delete(id)) {
        return { result: { _tag: "Died", message: "the adopted worker is gone" } satisfies JobResult, usage: { cpuSeconds: null, memoryPeakBytes: null }, id }
      }
      for (const event of sink.buffer.splice(0)) yield* onEvent(event)
      sink.target = onEvent
      const followed = yield* Effect.scoped(follow(job)).pipe(
        Effect.onInterrupt(() => (stopping ? Effect.void : stopUnit(job.pool, id))),
        Effect.ensuring(Effect.suspend(() => (stopping ? Effect.void : forget(id)))),
      )
      return { ...followed, id }
    })

  return {
    run,
    adopted: () => [...adoptable.values()],
    reattach,
    settled: (id) => {
      const settled = settledOf.get(id)
      return settled === undefined ? Effect.void : Deferred.await(settled)
    },
    authorize: (id, token) => {
      const job = jobs.get(id)
      return job !== undefined && job.tokenHash === sha256(token)
        ? Effect.succeed(job)
        : Effect.fail(new Unauthorized({ reason: "unknown job or wrong token" }))
    },
    get: (id) => jobs.get(id),
    active: () => [...jobs.values()],
  }
}))
