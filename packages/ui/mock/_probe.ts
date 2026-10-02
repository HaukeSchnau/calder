import { UiRpcs } from "@kiln/api"
import { Effect, Layer, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

const Protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket("ws://127.0.0.1:8791/rpc").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
  Layer.provide(RpcSerialization.layerJson),
)

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(UiRpcs)
  const ov = yield* client.overview()
  console.log("projects", ov.projects.map((p) => `${p.name} main=${p.main?.status} #${p.main?.number} hist=${p.history.length} deps=${p.deployments.map((d) => `${d.host}:${d.revision?.slice(0, 7)}${d.deployingRun ? "*" : ""}`).join(",")}`))
  console.log("active", ov.active.map((r) => `${r.project} #${r.number} ${r.status} ${JSON.stringify(r.counts)}`))
  console.log("recent", ov.recent.length, ov.slots)
  const failed = ov.recent.find((r) => r.status === "failed" && r.project === "t3code")!
  const d = yield* client.run({ id: failed.id })
  console.log("detail", d.run.number, d.steps.map((s) => `${s.name}:${s.status}`).join(" "), d.failingTests.length, d.siblings.map((s) => s.number))
  console.log(d.steps.find((s) => s.status === "failed")?.error)
  const lines = yield* client.logs({ runId: failed.id, step: "test web" }).pipe(Stream.runCollect)
  console.log("lines", lines.length, lines.at(-1))
  const spans = yield* client.trace({ runId: failed.id })
  console.log("spans", spans.length)
  const active = ov.active[0]!
  const ad = yield* client.run({ id: active.id })
  const running = ad.steps.find((s) => s.status === "running")!
  console.log("follow", active.project, active.number, running.name)
  const live = yield* client.logs({ runId: active.id, step: running.name, follow: true }).pipe(Stream.take(3), Stream.runCollect)
  console.log(live.map((l) => l.text))
    const stats = yield* client.stepStats({ project: "t3code", step: "test web" })
  console.log("stats", stats.samples.length)
  const m = yield* client.stepMetrics({ runId: active.id, step: running.name })
  console.log("metrics", m.samples.length)
  const th = yield* client.testHistory({ project: "t3code", suite: "ThreadView", name: "replays tool output after reconnect" })
  console.log("history", th.map((t) => t.status[0]).join(""))
})

Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Protocol))).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
