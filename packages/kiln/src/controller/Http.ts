import { BunHttpServer } from "@effect/platform-bun"
import { UiRpcs } from "@kiln/api"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Config } from "./Config.ts"
import * as Ui from "./Ui.ts"
import * as Webhook from "./Webhook.ts"

/** Gitea's webhook, the UI's RPC over a WebSocket, and the UI itself. */
export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const rpc = RpcServer.layer(UiRpcs).pipe(
    Layer.provide(Ui.handlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson),
  )
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/hooks/gitea", Webhook.handle),
    HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
    rpc,
    config.ui === null ? Layer.empty : HttpStaticServer.layer({ root: config.ui, spa: true }),
  )
  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provide(BunHttpServer.layer({ port: config.listen.port, hostname: config.listen.host })),
  )
}))
