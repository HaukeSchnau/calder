import { Effect } from "effect"
import * as Tunnel from "../Tunnel.ts"

/**
 * In a sandboxed worker's own network namespace, a loopback port that forwards to the controller's
 * egress proxy socket. Every process the worker starts gets it as its proxy.
 */
export const bridge = (socket: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.listen<Tunnel.End>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          ...Tunnel.handlers,
          open(client) {
            client.data = Tunnel.end()
            void Bun.connect<Tunnel.End>({ unix: socket, data: Tunnel.end(), socket: Tunnel.handlers }).then(
              (proxy) => Tunnel.link(client, proxy),
              () => client.end(),
            )
          },
        },
      })
    ),
    (server) => Effect.sync(() => server.stop(true)),
  ).pipe(Effect.tap((server) =>
    Effect.sync(() => {
      const url = `http://127.0.0.1:${server.port}`
      for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) process.env[name] = url
      process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1"
    })
  ))
