import { BunSocket } from "@effect/platform-bun"
import { Context, Effect, Layer, type Scope } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type JobEvent, WorkerRpcs } from "../Protocol.ts"

const makeClient = RpcClient.make(WorkerRpcs)
export type Client = Effect.Success<typeof makeClient>

/** The worker's job: its id and token, the controller client, and a buffer for events. */
export class Job extends Context.Service<Job, {
  readonly id: string
  readonly token: string
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

export const make = (id: string, token: string): Effect.Effect<Job["Service"], never, RpcClient.Protocol | Scope.Scope> =>
  Effect.gen(function*() {
    const client = yield* makeClient
    let buffer: Array<JobEvent> = []
    const flush = Effect.suspend(() => {
      if (buffer.length === 0) return Effect.void
      const events = buffer
      buffer = []
      return client.events({ job: id, token, events }).pipe(Effect.orDie)
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
      client,
      emit,
      log: (stream, text) => emit({ _tag: "Log", stream, text, timestamp: Date.now() }),
      flush,
    }
  })
