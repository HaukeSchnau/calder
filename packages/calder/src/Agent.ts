import { BunSocket } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { chmodSync, chownSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Build from "./Build.ts"
import * as ControllerProxy from "./ControllerProxy.ts"
import * as Egress from "./controller/Egress.ts"
import * as Exec from "./Exec.ts"
import { groupId } from "./Groups.ts"
import { type AgentOrder, AgentRpcs, compatibility, type Pool, sandboxed } from "./Protocol.ts"

export interface Options {
  /** The controller's URL. */
  readonly url: string
  readonly tokenFile: string
  readonly name: string
  readonly platform: string
  readonly slots: number
  /**
   * A file with the number of jobs to take right now, which the host rewrites as its own load changes.
   * It replaces `slots`; a file that can't be read offers none.
   */
  readonly slotsFile: string | null
  /** Where workers keep their task slots and extracted `.calder/` directories. */
  readonly workspaces: string
  /** argv that starts this calder, before `worker <job>`. */
  readonly calder: ReadonlyArray<string>
  /**
   * A command whose `lease` subcommand prints `ready` once the host admits a job and holds that
   * admission until its stdin closes, like a Mac builder's admission wrapper.
   */
  readonly admission: string | null
  /**
   * Takes the controller's evaluation jobs only, never tasks or setups, and its workers push the
   * derivations they evaluate to this store, the controller's (`calder agent --evaluator <store>`).
   */
  readonly evaluator: string | null
  /** Takes only tasks of other systems that may run on this one (PlannedStep `systems`), none of its platform's own. */
  readonly portableOnly: boolean
  /**
   * Starts each job's worker as the host's systemd unit of the job's pool (`unitOf`), which the host
   * sandboxes like the controller's, instead of as a child process, and so takes every pool's jobs. Each
   * job gets a directory here that only its pool's group may enter, with its token, a socket to the
   * controller's worker routes (ControllerProxy) and, for pull requests, one to the egress proxy.
   */
  readonly units: string | null
}

/** The host's unit that runs a job of `pool` (`calder agent --units`), like the controller's. */
export const unitOf = (pool: Pool, job: string) => `calder-job-${pool}@${job}.service`

/** The pools an agent may have units for; it runs those whose group, `calder-<pool>`, its host has. */
const unitPools: ReadonlyArray<Pool> = ["pr", "fork", "trusted"]

const systemctl = (args: ReadonlyArray<string>) => Exec.exec(["systemctl", ...args])

/** Sends `signal` to a process group; false once the group is gone. */
const signalGroup = (group: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-group, signal)
    return true
  } catch {
    return false
  }
}

/** A process's command line, or "" once it is gone. The Linux VM's agent has no `ps` on its PATH. */
const commandLine = (pid: number) =>
  process.platform === "linux"
    ? Effect.sync(() => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")
      } catch {
        return ""
      }
    })
    : Exec.exec(["ps", "-ww", "-o", "command=", "-p", String(pid)]).pipe(Effect.map((r) => r.stdout), Effect.orElseSucceed(() => ""))

/**
 * Stops the workers an earlier run of the agent left behind, which `dir` lists as a file per job with
 * the worker's pid. Each worker leads its own process group, which launchd leaves running when the
 * agent exits; nothing tracks them any more, and new jobs would get their slots and workspaces. A
 * worker gets time to stop its task before its group is killed.
 */
export const stopLeftovers = (dir: string) =>
  Effect.gen(function*() {
    mkdirSync(dir, { recursive: true })
    for (const job of readdirSync(dir)) {
      const pid = Number(readFileSync(join(dir, job), "utf8"))
      // A process that got the pid since is left alone.
      if ((yield* commandLine(pid)).includes(`worker ${job}`)) {
        yield* Effect.logInfo(`stopping worker ${job}, which an earlier run of this agent started`)
        for (const [signal, ms] of [["SIGTERM", 20_000], ["SIGKILL", 5_000]] as const) {
          signalGroup(pid, signal)
          for (let waited = 0; waited < ms && signalGroup(pid, 0); waited += 250) yield* Effect.sleep("250 millis")
        }
      }
      rmSync(join(dir, job), { force: true })
    }
  })

/** Records a worker's pid for `stopLeftovers`. Host cleanup may have removed the directory since the agent started. */
export const recordPid = (dir: string, job: string, pid: number) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, job), String(pid))
}

/**
 * Runs a job in its pool's unit of the host (`Options.units`) and returns the worker's exit code. The
 * job's directory under `units`, which only the pool's group (`group`) may enter, holds its token, a
 * socket to the controller's worker routes at `url` (ControllerProxy) and, for a sandboxed pool, one to an
 * egress proxy with the job's allowlist. They and the unit go with the scope.
 */
export const runInUnit = (
  options: {
    readonly units: string
    readonly url: string
    /** The group of a pool's units; tests, whose user can't hand files to `calder-<pool>`, pass their own. */
    readonly group?: (pool: Pool) => number | undefined
  },
  order: Extract<AgentOrder, { readonly _tag: "Start" }>,
) =>
  Effect.gen(function*() {
    const pool = order.pool ?? "trusted"
    const group = (options.group ?? ((pool: Pool) => groupId(`calder-${pool}`)))(pool)
    if (group === undefined) return yield* Effect.die(new Error(`the host has no group calder-${pool} for the job's unit`))
    const dir = join(options.units, order.job)
    const share = (path: string, mode: number) => {
      chownSync(path, process.getuid!(), group)
      chmodSync(path, mode)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dir, { recursive: true })
        share(dir, 0o750)
      }),
      () => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    )
    writeFileSync(join(dir, "token"), order.token, { mode: 0o600 })
    share(join(dir, "token"), 0o640)
    yield* ControllerProxy.serve(join(dir, "controller.sock"), options.url)
    share(join(dir, "controller.sock"), 0o660)
    if (sandboxed(pool)) {
      // A controller from before pools sends no allowlist, and nothing gets out.
      yield* Egress.serve(join(dir, "egress.sock"), order.egress ?? { allow: [], allowPrivate: [] }, (message) =>
        void Effect.runFork(Effect.logInfo(`worker ${order.job}: ${message}`)))
      share(join(dir, "egress.sock"), 0o660)
    }
    const unit = unitOf(pool, order.job)
    // However the wait ends, the unit doesn't outlive the job's directory: systemctl may lose systemd
    // while the unit runs on.
    const started = yield* systemctl(["start", "--wait", unit]).pipe(Effect.ensuring(systemctl(["stop", unit]).pipe(Effect.ignore)))
    if (started.exitCode !== 0) yield* Effect.logWarning(`worker ${order.job}: ${started.stderr.trim() || `${unit} failed`}`)
    return started.exitCode
  })

/**
 * `calder agent`: runs workers on this host for the controller's jobs of this platform. Workers outlive
 * a lost connection; the agent reconnects and tells the controller which ones still run. Those an
 * earlier run of the agent left behind it stops before it takes jobs.
 */
export const run = (options: Options) =>
  Effect.gen(function*() {
    const token = readFileSync(options.tokenFile, "utf8").trim()
    const auth = { token, name: options.name }
    const client = yield* RpcClient.make(AgentRpcs)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Workers whose process still runs, with what stops each one.
    const running = new Map<string, Deferred.Deferred<void>>()
    // Their pids, for the agent's next run if this one dies first.
    const pids = join(options.workspaces, ".workers")
    yield* stopLeftovers(pids)

    const offered = () => {
      if (options.slotsFile === null) return options.slots
      try {
        const slots = Number.parseInt(readFileSync(options.slotsFile, "utf8"), 10)
        return Number.isInteger(slots) && slots > 0 ? slots : 0
      } catch {
        return 0
      }
    }
    let offering = offered()

    /** Holds an admission slot for the scope. */
    const admitted = (command: string) =>
      Effect.gen(function*() {
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const lease = yield* spawner.spawn(ChildProcess.make(command, ["lease"], {
          stdin: Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain),
          stderr: "inherit",
        }))
        const ready = yield* lease.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead)
        if (ready._tag === "None" || ready.value !== "ready") return yield* Effect.die(new Error("the host refused admission"))
      })

    const exited = (job: string, code: number) =>
      client.exited({ ...auth, job, code }).pipe(Effect.retry(Schedule.spaced("5 seconds")), Effect.ignore)

    // Units an earlier run of the agent started run on without it: their sockets went with its runtime
    // directory, and new jobs would get their workspaces.
    if (options.units !== null) {
      const listed = yield* systemctl(["list-units", "--plain", "--no-legend", "--state=active,activating,deactivating",
        ...unitPools.map((pool) => unitOf(pool, "*"))])
      const left = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "").filter((unit) => unit.startsWith("calder-job-"))
      if (left.length > 0) {
        yield* Effect.logInfo(`stopping ${left.join(" ")}, which an earlier run of this agent started`)
        yield* systemctl(["stop", ...left])
      }
      mkdirSync(options.units, { recursive: true })
      // Only job directories, whatever else the directory holds.
      for (const dir of readdirSync(options.units)) if (/^[0-9a-f]+$/.test(dir)) rmSync(join(options.units, dir), { recursive: true, force: true })
    }
    const pools = options.units === null ? ["trusted" as const] : unitPools.filter((pool) => groupId(`calder-${pool}`) !== undefined)
    if (pools.length === 0) return yield* Effect.die(new Error("--units needs the host's calder-pr, calder-fork or calder-trusted group"))

    const worker = (order: Extract<AgentOrder, { readonly _tag: "Start" }>, stop: Deferred.Deferred<void>) =>
      Effect.scoped(Effect.gen(function*() {
        const job = order.job
        if (options.admission !== null) yield* admitted(options.admission)
        if (options.units !== null) {
          return yield* runInUnit({ units: options.units, url: options.url }, order)
        }
        const [command, ...args] = options.calder
        // Added before the worker, so it runs after the worker's group is gone.
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(join(pids, job), { force: true })))
        const handle = yield* spawner.spawn(ChildProcess.make(command!, [...args, "worker", job], {
          env: {
            CALDER_URL: options.url,
            CALDER_TOKEN: order.token,
            CALDER_WORKSPACES: options.workspaces,
            ...(options.evaluator === null ? {} : { CALDER_EVALUATOR_STORE: options.evaluator }),
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          detached: true,
          forceKillAfter: "10 seconds",
        }))
        recordPid(pids, job, handle.pid)
        return yield* handle.exitCode
      })).pipe(
        Effect.catchCause((cause) => Effect.logError(`worker ${order.job} failed to start`, cause).pipe(Effect.as(-1))),
        Effect.raceFirst(Deferred.await(stop).pipe(Effect.andThen(Effect.logInfo(`stopped worker ${order.job}`)), Effect.as(-1))),
        Effect.ensuring(Effect.sync(() => running.delete(order.job))),
        Effect.flatMap((code) => exited(order.job, code)),
      )

    const obey = (order: AgentOrder) =>
      Effect.gen(function*() {
        if (order._tag === "Start") {
          yield* Effect.logInfo(`starting worker ${order.job}`)
          const stop = Deferred.makeUnsafe<void>()
          running.set(order.job, stop)
          yield* Effect.forkDetach(worker(order, stop))
        } else {
          const stop = running.get(order.job)
          // The controller holds a slot until it hears the worker is gone, which it may have missed.
          if (stop === undefined) yield* Effect.forkDetach(exited(order.job, -1))
          else yield* Deferred.succeed(stop, undefined)
        }
      })

    if (options.slotsFile !== null) {
      yield* Effect.gen(function*() {
        const slots = offered()
        if (slots === offering) return
        yield* client.offer({ ...auth, slots })
        offering = slots
      }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped)
    }

    yield* Effect.logInfo(
      options.evaluator === null
        ? `agent ${options.name} serving ${options.platform} jobs from ${options.url}${options.units === null ? "" : `, each in its pool's unit`}`
        : `agent ${options.name} evaluating for ${options.url}, pushing derivations to ${options.evaluator}`,
    )
    yield* Effect.suspend(() => {
      offering = offered()
      return client.work({ ...auth, platform: options.platform, slots: offering, running: [...running.keys()], build: Build.id, compatibility,
        evaluator: options.evaluator !== null, portableOnly: options.portableOnly, pools }).pipe(
        Stream.runForEach(obey),
      )
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("lost the controller", cause)),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    )
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(BunSocket.layerWebSocket(`${options.url.replace(/^http/, "ws")}/agent`)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
  )
