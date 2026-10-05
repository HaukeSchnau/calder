import { BunSocket } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { readFileSync } from "node:fs"
import { type AgentOrder, AgentRpcs } from "./Protocol.ts"

export interface Options {
  /** The controller's URL. */
  readonly url: string
  readonly tokenFile: string
  readonly name: string
  readonly platform: string
  readonly slots: number
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

/**
 * `kiln agent`: runs workers on this host for the controller's jobs of this platform. Workers outlive
 * a lost connection; the agent reconnects and tells the controller which ones still run.
 */
export const run = (options: Options) =>
  Effect.gen(function*() {
    const token = readFileSync(options.tokenFile, "utf8").trim()
    const auth = { token, name: options.name }
    const client = yield* RpcClient.make(AgentRpcs)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const running = new Map<string, Fiber.Fiber<void>>()

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

    const worker = (job: string, jobToken: string) =>
      Effect.scoped(Effect.gen(function*() {
        if (options.admission !== null) yield* admitted(options.admission)
        const [command, ...args] = options.kiln
        const handle = yield* spawner.spawn(ChildProcess.make(command!, [...args, "worker", job], {
          env: { KILN_URL: options.url, KILN_TOKEN: jobToken, KILN_WORKSPACES: options.workspaces },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          detached: true,
          forceKillAfter: "10 seconds",
        }))
        return yield* handle.exitCode
      })).pipe(
        Effect.catchCause((cause) => Effect.logError(`worker ${job} failed to start`, cause).pipe(Effect.as(-1))),
        Effect.onInterrupt(() => Effect.logInfo(`stopped worker ${job}`)),
        Effect.flatMap((code) =>
          client.exited({ ...auth, job, code }).pipe(Effect.retry(Schedule.spaced("5 seconds")), Effect.ignore)
        ),
        Effect.ensuring(Effect.sync(() => running.delete(job))),
      )

    const obey = (order: AgentOrder) =>
      Effect.gen(function*() {
        if (order._tag === "Start") {
          yield* Effect.logInfo(`starting worker ${order.job}`)
          running.set(order.job, yield* Effect.forkDetach(worker(order.job, order.token)))
        } else {
          const fiber = running.get(order.job)
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        }
      })

    yield* Effect.logInfo(`agent ${options.name} serving ${options.platform} jobs from ${options.url}`)
    yield* Effect.suspend(() =>
      client.work({ ...auth, platform: options.platform, slots: options.slots, running: [...running.keys()] }).pipe(
        Stream.runForEach(obey),
      )
    ).pipe(
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
