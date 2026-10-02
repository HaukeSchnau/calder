import { UiRpcs } from "@kiln/api"
import { Effect, Layer, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

const Protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket("ws://127.0.0.1:8791/rpc").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
  Layer.provide(RpcSerialization.layerJson),
)
const id = process.argv[2]!
const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(UiRpcs)
  const d = yield* client.run({ id })
  console.log("run ok", d.run.number, d.steps.map((s) => `${s.name}:${s.status}`).join(" "))
  for (const s of d.steps) {
    const lines = yield* client.logs({ runId: id, step: s.name }).pipe(Stream.runCollect)
    console.log("logs", s.name, lines.length)
  }
  const spans = yield* client.trace({ runId: id })
  console.log("trace", spans.length)
  for (const s of d.steps) {
    const st = yield* client.stepStats({ project: d.run.project, step: s.name })
    const m = yield* client.stepMetrics({ runId: id, step: s.name })
    console.log("stats", s.name, st.samples.length, m.samples.length)
  }
})
Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Protocol))).then(() => process.exit(0), (e) => { console.error("FAILED", e); process.exit(1) })
