import { BunSocket } from "@effect/platform-bun"
import { UiRpcs } from "@calder-ci/api"
import { Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"

/** A client of a controller's UI RPC, for `calder trigger` and friends. */
export const client = RpcClient.make(UiRpcs)

export const layer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(url.replace(/^http/, "ws").replace(/\/$/, "") + "/rpc")),
    Layer.provide(RpcSerialization.layerJson),
  )

