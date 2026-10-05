import { BunSocket } from "@effect/platform-bun"
import { Context, Effect, Layer, Predicate, Schedule, type Scope } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type JobEvent, WorkerRpcs } from "../Protocol.ts"
import * as Repo from "./Repo.ts"

const makeClient = RpcClient.make(WorkerRpcs)
export type Client = Effect.Success<typeof makeClient>

/**
 * Retries a call that a lost connection cut short; the client reconnects on its own. A controller
 * that stalls past the client's 5-second ping drops the connection, and with it every call in flight.
 */
export const reconnecting = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(Effect.retry({
    while: (error) => Predicate.isTagged(error, "RpcClientError"),
    schedule: Schedule.exponential("500 millis").pipe(Schedule.upTo({ duration: "2 minutes" })),
  }))

/** For workers an agent started on another host: the controller's URL and the agent's workspace directory. */
export interface Remote {
  readonly url: string
  readonly workspaces: string
}

/** The worker's job: its id and token, the controller client, and a buffer for events. */
export class Job extends Context.Service<Job, {
  readonly id: string
  readonly token: string
  readonly remote: Remote | null
  readonly client: Client
  readonly emit: (event: JobEvent) => Effect.Effect<void>
  readonly log: (stream: "stdout" | "stderr" | "kiln", text: string) => Effect.Effect<void>
  readonly flush: Effect.Effect<void>
}>()("kiln/worker/Job") {}

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

export const make = (id: string, token: string, remote: Remote | null): Effect.Effect<Job["Service"], never, RpcClient.Protocol | Scope.Scope> =>
  Effect.gen(function*() {
    const client = yield* makeClient
    let buffer: Array<JobEvent> = []
    const flush = Effect.suspend(() => {
      if (buffer.length === 0) return Effect.void
      const events = buffer
      buffer = []
      return reconnecting(client.events({ job: id, token, events })).pipe(Effect.orDie)
    })
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
      flush,
    }
  })
