import { Effect } from "effect"
import * as Tunnel from "../Tunnel.ts"

/**
 * The environment that sends a sandboxed worker's processes to the egress proxy at `url`. NO_PROXY
 * also names the wildcard addresses, by which a test reaches a server it started on port 0
 * (`HttpServer.formatAddress` gives `http://[::]:<port>`).
 */
export const environment = (url: string): Record<string, string> => {
  // undici before 8.10, which Node 24's fetch and WebSocket use, compares an IPv6 host with its
  // brackets, and Node's http compares it without them. The bracketed forms can go once no job runs
  // Node 24.
  const noProxy = "localhost,127.0.0.1,0.0.0.0,::1,[::1],::,[::]"
  return {
    ...Object.fromEntries(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].map((name) => [name, url])),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node's own fetch and http ignore the variables above without it; corepack downloads pnpm so.
    NODE_USE_ENV_PROXY: "1",
  }
}

/**
 * In a sandboxed worker's own network namespace, a loopback port that forwards to the egress proxy
 * socket. Every process the worker starts gets it as its proxy.
 */
export const bridge = (socket: string) =>
  Tunnel.loopback(socket).pipe(Effect.tap((server) =>
    Effect.sync(() => Object.assign(process.env, environment(`http://127.0.0.1:${server.port}`)))
  ))
