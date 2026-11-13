import { Effect } from "effect"
import * as Tunnel from "../Tunnel.ts"

/**
 * In a sandboxed worker's own network namespace, a loopback port that forwards to the egress proxy
 * socket. Every process the worker starts gets it as its proxy.
 */
export const bridge = (socket: string) =>
  Tunnel.loopback(socket).pipe(Effect.tap((server) =>
    Effect.sync(() => {
      const url = `http://127.0.0.1:${server.port}`
      for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) process.env[name] = url
      process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1"
    })
  ))
