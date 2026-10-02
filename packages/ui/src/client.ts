import { UiRpcs } from "@kiln/api"
import { Effect, Layer } from "effect"
import { Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

export type Connection = "connecting" | "live" | "offline"

export const connectionAtom = Atom.make<Connection>("connecting").pipe(Atom.keepAlive)

const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`

/** The controller's UI RPCs over one WebSocket on the page's origin, reconnecting on its own. */
export class Kiln extends AtomRpc.Service<Kiln>()("Kiln", {
  group: UiRpcs,
  protocol: (get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide([
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: Effect.sync(() => get.registry.set(connectionAtom, "live")),
          onDisconnect: Effect.sync(() => get.registry.set(connectionAtom, "offline")),
        }),
      ]),
    ),
}) {}
