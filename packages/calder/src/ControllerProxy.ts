import type { ServerWebSocket } from "bun"
import { Effect } from "effect"
import { existsSync, rmSync } from "node:fs"

/**
 * The controller's routes a worker on an agent uses: its RPC, the mirrors, the store and outputs, each
 * behind the job's token. The UI's RPC (`/rpc`), which needs no sign-in on the Tailnet and can start
 * trusted runs, and the agents' own (`/agent`) stay out of a sandboxed worker's reach.
 */
export const forwarded = (pathname: string) =>
  pathname === "/worker" || pathname === "/store" || pathname === "/outputs" || pathname.startsWith("/git/")

/**
 * `headers` without what belongs to one connection (RFC 9110 7.6.1): the fixed hop-by-hop set and the
 * headers its `Connection` names. Requests and responses cross two connections here.
 */
export const withoutHopByHop = (headers: Headers) => {
  const kept = new Headers(headers)
  const named = (headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "")
  for (const name of [...named, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
    kept.delete(name)
  }
  return kept
}

interface Peer {
  readonly target: string
  upstream: WebSocket | null
  /** What the worker sent before the controller's side was open, and its size in bytes. */
  readonly early: Array<string | Buffer>
  earlyBytes: number
}

/**
 * How much a worker may send before the controller's side is open. The queue is the agent's memory, outside
 * the worker unit's limit; a worker's RPC sends one batch of events at a time.
 */
const earlyLimit = 64 * 1024 ** 2

/**
 * Serves the controller to one job's worker on a unix socket, which the worker's unit can reach from its
 * own network namespace (`Main.bridge`): requests to `forwarded` routes go on to `controller`, the agent's
 * URL of it, and WebSockets to `/worker` are relayed both ways. Closes with the scope.
 */
export const serve = (path: string, controller: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (existsSync(path)) rmSync(path)
      const base = controller.replace(/\/$/, "")
      return Bun.serve<Peer, never>({
        unix: path,
        // Outputs such as packaged desktop apps, far past Bun's 128 MiB default (controller/Http.ts).
        maxRequestBodySize: 8 * 1024 ** 3,
        fetch(request, server) {
          const url = new URL(request.url)
          if (!forwarded(url.pathname)) return new Response("not a worker's route\n", { status: 404 })
          const target = `${base}${url.pathname}${url.search}`
          if (url.pathname === "/worker") {
            const data: Peer = { target: target.replace(/^http/, "ws"), upstream: null, early: [], earlyBytes: 0 }
            return server.upgrade(request, { data }) ? undefined : new Response("WebSocket only\n", { status: 426 })
          }
          const headers = withoutHopByHop(request.headers)
          headers.delete("host")
          const body = request.method === "GET" || request.method === "HEAD" ? null : request.body
          return fetch(target, { method: request.method, headers, body, redirect: "manual", decompress: false })
            .then((response) =>
              new Response(response.body, { status: response.status, statusText: response.statusText, headers: withoutHopByHop(response.headers) })
            )
            .catch(() => new Response("the controller can't be reached\n", { status: 502 }))
        },
        websocket: {
          open(ws: ServerWebSocket<Peer>) {
            const upstream = new WebSocket(ws.data.target)
            upstream.binaryType = "arraybuffer"
            ws.data.upstream = upstream
            upstream.onopen = () => {
              for (const message of ws.data.early.splice(0)) upstream.send(message)
            }
            upstream.onmessage = (event) => ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer))
            upstream.onclose = (event) => ws.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason)
            upstream.onerror = () => ws.close(1011, "the controller can't be reached")
          },
          message(ws: ServerWebSocket<Peer>, message) {
            const upstream = ws.data.upstream
            if (upstream !== null && upstream.readyState === WebSocket.OPEN) return void upstream.send(message)
            ws.data.earlyBytes += typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
            if (ws.data.earlyBytes > earlyLimit) return ws.close(1009, "too much before the controller answered")
            ws.data.early.push(message)
          },
          close(ws: ServerWebSocket<Peer>) {
            ws.data.upstream?.close()
          },
        },
      })
    }),
    (server) => Effect.promise(() => server.stop(true)),
  )
