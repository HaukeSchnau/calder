import { BunSocket } from "@effect/platform-bun"
import { Cause, Clock, Context, Data, Duration, Effect, Exit, Fiber, Layer, Predicate, Schedule, type Scope, Semaphore } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type JobEvent, WorkerRpcs } from "../Protocol.ts"
import * as Repo from "./Repo.ts"

const makeClient = RpcClient.make(WorkerRpcs)
export type Client = Effect.Success<typeof makeClient>

/** The controller stopped while it handled a call: Effect's RpcServer interrupts its handlers and sends the interrupt back. */
class ControllerStopped extends Data.TaggedError("ControllerStopped")<{}> {}

/**
 * How long calls keep trying once the controller went away. A restarting controller adopts running
 * workers, but it may first wait two minutes for an action to finish. A deploy of the controller's own
 * host may then wait minutes for the new controller to answer, and switch back to the old one.
 */
const patience = "15 minutes"

/** A try that lasted this long was taken by a controller, such as a wait for the deploy lease; a failure after it starts a new wait. */
const taken = "1 minute"

/**
 * Retries a call that a lost connection or a stopping controller cut short; the client reconnects on
 * its own. A controller that stalls past the client's 5-second ping drops the connection, and with it
 * every call in flight. The call runs in a fiber of its own, so an interrupt that ends it came from the
 * controller. Interrupting `reconnecting` interrupts the call, unless the caller made it uninterruptible:
 * a deploy waits for the lease in the acquire of an `acquireRelease`, which only the lease's grant or
 * a controller's answer ends.
 */
export const reconnecting = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    // When the latest try began, and when the failures since the last try a controller took began.
    let tried = 0
    let since: number | undefined
    return Effect.gen(function*() {
      tried = yield* Clock.currentTimeMillis
      const exit = yield* Fiber.await(yield* Effect.forkChild(call, { startImmediately: true }))
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* new ControllerStopped()
      return yield* exit
    }).pipe(
      Effect.retry({
        while: (error) =>
          Effect.gen(function*() {
            if (!Predicate.isTagged(error, "RpcClientError") && !(error instanceof ControllerStopped)) return false
            const now = yield* Clock.currentTimeMillis
            if (since === undefined || now - tried >= Duration.toMillis(taken)) since = now
            return now - since < Duration.toMillis(patience)
          }),
        schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
      }),
      Effect.catchIf((error): error is ControllerStopped => error instanceof ControllerStopped, () =>
        Effect.die(new Error(`the controller stopped while handling the call, and every try for ${patience}`))),
    )
  })

/** Retries a fetch from the controller, which crosses the internet for agents, where streams sometimes reset. */
export const fetching = <A, E, R>(fetch: Effect.Effect<A, E, R>) =>
  fetch.pipe(Effect.retry({ times: 3, schedule: Schedule.exponential("2 seconds") }))

/** For workers an agent started on another host: the controller's URL and the agent's workspace directory. */
export interface Remote {
  readonly url: string
  readonly workspaces: string
  /** On an evaluator agent: the controller's store, where an evaluation job pushes its derivations. */
  readonly store?: string
}

/** The worker's job: its id and token, the controller client, and a buffer for events. */
export class Job extends Context.Service<Job, {
  readonly id: string
  readonly token: string
  readonly remote: Remote | null
  readonly client: Client
  readonly emit: (event: JobEvent) => Effect.Effect<void>
  readonly log: (stream: "stdout" | "stderr" | "calder", text: string) => Effect.Effect<void>
  /** Masks the job's secrets in text that leaves the worker another way than its log. */
  readonly redact: (text: string) => string
  readonly flush: Effect.Effect<void>
}>()("calder/worker/Job") {}

export const layerClient = (socket: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerNet({ path: socket })),
    Layer.provide(RpcSerialization.layerNdjson),
  )

export const layerClientRemote = (remote: Remote) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(`${remote.url.replace(/^http/, "ws")}/worker`)),
    Layer.provide(RpcSerialization.layerJson),
  )

/** Git's environment for this job; an agent's worker fetches from the controller with its token. */
export const gitEnv = (job: Job["Service"]) =>
  job.remote === null ? Repo.gitEnv : {
    ...Repo.gitEnv,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${job.id}:${job.token}`,
  }

/**
 * Git's environment for Nix's fetches in an evaluation on an agent: each forge repository from the
 * controller's endpoint (`mirrors`, whose targets are its `/git/` URLs), with the job's token sent to that
 * origin alone, never to another host an input names, and no prompt for credentials.
 */
export const evaluationEnv = (mirrors: Readonly<Record<string, string>>, job: { readonly id: string; readonly token: string }) => {
  const origins = [...new Set(Object.values(mirrors).flatMap((target) => {
    const at = /^(https?:\/\/[^/]+)\/git\//.exec(target)
    return at === null ? [] : [`${at[1]}/git/`]
  }))]
  return {
    ...Repo.insteadOf(mirrors, [
      ["safe.directory", "*"],
      ...origins.map((origin) => [`http.${origin}.extraHeader`, `Authorization: Bearer ${job.id}:${job.token}`] as const),
    ]),
    GIT_TERMINAL_PROMPT: "0",
  }
}

export const make = (id: string, token: string, remote: Remote | null): Effect.Effect<Job["Service"], never, RpcClient.Protocol | Scope.Scope> =>
  Effect.gen(function*() {
    const client = yield* makeClient
    let buffer: Array<JobEvent> = []
    let batch = 0
    // One batch at a time, in order, so the controller can tell a batch sent again by its number.
    const sending = yield* Semaphore.make(1)
    const flush = sending.withPermits(1)(Effect.suspend(() => {
      if (buffer.length === 0) return Effect.void
      const events = buffer
      buffer = []
      batch += 1
      return reconnecting(client.events({ job: id, token, events, batch })).pipe(Effect.orDie)
    }))
    yield* flush.pipe(Effect.delay("250 millis"), Effect.forever, Effect.forkScoped)
    yield* Effect.addFinalizer(() => flush)
    const emit = (event: JobEvent) =>
      Effect.suspend(() => {
        buffer.push(event)
        return buffer.length >= 500 ? flush : Effect.void
      })
    return {
      id,
      token,
      remote,
      client,
      emit,
      log: (stream, text) => emit({ _tag: "Log", stream, text, timestamp: Date.now() }),
      // The worker masks secrets once it has its job (`Worker.run`).
      redact: (text) => text,
      flush,
    }
  })
