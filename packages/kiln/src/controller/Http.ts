import { BunHttpServer } from "@effect/platform-bun"
import { UiRpcs } from "@kiln/api"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { AgentRpcs, WorkerRpcs } from "../Protocol.ts"
import { Config } from "./Config.ts"
import * as Outputs from "./Outputs.ts"
import * as Remote from "./Remote.ts"
import * as Ui from "./Ui.ts"
import * as Webhook from "./Webhook.ts"
import * as WorkerServer from "./WorkerServer.ts"

/**
 * Gitea's webhook, the UI's RPC over a WebSocket, the UI itself, and what agents and their workers on
 * other hosts call.
 */
export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const rpc = RpcServer.layer(UiRpcs).pipe(
    Layer.provide(Ui.handlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  )
  const agents = RpcServer.layer(AgentRpcs).pipe(
    Layer.provide(Remote.agentHandlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/agent" })),
    Layer.provide(RpcSerialization.layerJson),
  )
  const workers = RpcServer.layer(WorkerRpcs).pipe(
    Layer.provide(WorkerServer.handlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/worker" })),
    Layer.provide(RpcSerialization.layerJson),
  )
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/hooks/gitea", Webhook.handle),
    HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
    HttpRouter.add("GET", "/git/*", Remote.git),
    HttpRouter.add("POST", "/git/*", Remote.git),
    HttpRouter.add("PUT", "/outputs", Remote.output),
    HttpRouter.add("GET", "/store", Remote.store),
    HttpRouter.add("GET", "/outputs/*", Outputs.serve),
    rpc,
    agents,
    workers,
    config.ui === null ? Layer.empty : HttpStaticServer.layer({ root: config.ui, spa: true }),
  )
  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    // Agents upload task outputs such as packaged desktop apps, far past Bun's 128 MiB default. Bun also
    // closes a response that stalls for 10 s, which cut git fetches and downloads to agents on slow links
    // and quiet log follows; the proxy in front keeps its own timeouts.
    Layer.provide(BunHttpServer.layer({
      port: config.listen.port,
      hostname: config.listen.host,
      maxRequestBodySize: 8 * 1024 ** 3,
      idleTimeout: 0,
    })),
  )
}))
