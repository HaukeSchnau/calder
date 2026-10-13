import { BunSocket } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Build from "./Build.ts"
import * as Exec from "./Exec.ts"
import { type AgentOrder, AgentRpcs, compatibility } from "./Protocol.ts"

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
  /** Where workers keep their task slots and extracted `.kiln/` directories. */
  readonly workspaces: string
  /** argv that starts this kiln, before `worker <job>`. */
  readonly kiln: ReadonlyArray<string>
  /**
   * A command whose `lease` subcommand prints `ready` once the host admits a job and holds that
   * admission until its stdin closes (`builder-control` on the Apple builder).
   */
  readonly admission: string | null
}

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

/**
 * `kiln agent`: runs workers on this host for the controller's jobs of this platform. Workers outlive
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

    const worker = (job: string, jobToken: string, stop: Deferred.Deferred<void>) =>
      Effect.scoped(Effect.gen(function*() {
        if (options.admission !== null) yield* admitted(options.admission)
        const [command, ...args] = options.kiln
        // Added before the worker, so it runs after the worker's group is gone.
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(join(pids, job), { force: true })))
        const handle = yield* spawner.spawn(ChildProcess.make(command!, [...args, "worker", job], {
          env: { KILN_URL: options.url, KILN_TOKEN: jobToken, KILN_WORKSPACES: options.workspaces },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          detached: true,
          forceKillAfter: "10 seconds",
        }))
        writeFileSync(join(pids, job), String(handle.pid))
        return yield* handle.exitCode
      })).pipe(
        Effect.catchCause((cause) => Effect.logError(`worker ${job} failed to start`, cause).pipe(Effect.as(-1))),
        Effect.raceFirst(Deferred.await(stop).pipe(Effect.andThen(Effect.logInfo(`stopped worker ${job}`)), Effect.as(-1))),
        Effect.ensuring(Effect.sync(() => running.delete(job))),
        Effect.flatMap((code) => exited(job, code)),
      )

    const obey = (order: AgentOrder) =>
      Effect.gen(function*() {
        if (order._tag === "Start") {
          yield* Effect.logInfo(`starting worker ${order.job}`)
          const stop = Deferred.makeUnsafe<void>()
          running.set(order.job, stop)
          yield* Effect.forkDetach(worker(order.job, order.token, stop))
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

    yield* Effect.logInfo(`agent ${options.name} serving ${options.platform} jobs from ${options.url}`)
    yield* Effect.suspend(() => {
      offering = offered()
      return client.work({ ...auth, platform: options.platform, slots: offering, running: [...running.keys()], build: Build.id, compatibility }).pipe(
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
