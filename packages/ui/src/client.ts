import { UiRpcs } from "@calder-ci/api"
import { Effect, Layer } from "effect"
import { Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

export type Connection = "connecting" | "live" | "offline"

export const connectionAtom = Atom.make<Connection>("connecting").pipe(Atom.keepAlive)

/** Next to the page, which is at `/` on the private network and at `/app/` for the web. */
const url = new URL("rpc", location.href)
url.protocol = location.protocol === "https:" ? "wss:" : "ws:"

/** The controller's UI RPCs over one WebSocket next to the page, reconnecting on its own. */
export class Calder extends AtomRpc.Service<Calder>()("Calder", {
  group: UiRpcs,
  protocol: (get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide([
        Socket.layerWebSocket(url.href).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: Effect.sync(() => get.registry.set(connectionAtom, "live")),
          onDisconnect: Effect.sync(() => get.registry.set(connectionAtom, "offline")),
        }),
      ]),
    ),
}) {}
