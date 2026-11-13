import type { Socket } from "bun"
import { Effect, Layer } from "effect"
import { chmodSync, chownSync, existsSync, rmSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"
import type { EgressPolicy } from "../Protocol.ts"
import * as Tunnel from "../Tunnel.ts"
import { Config } from "./Config.ts"
import { workersGroup } from "./Jobs.ts"

const v4 = (address: string) => address.split(".").reduce((n, part) => n * 256 + Number(part), 0)

const v4Ranges: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
]

/**
 * The IPv4 address a canonical IPv6 one carries: IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`)
 * or IPv4-compatible (`::/96`).
 */
const carried = (canonical: string) => {
  const groups = /^(?:::ffff:|64:ff9b::|::)(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(canonical)
  if (groups === null) return undefined
  const n = parseInt(groups[1] ?? "0", 16) * 65536 + parseInt(groups[2]!, 16)
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")
}

/**
 * Loopback, private, link-local, CGNAT (the Tailnet), multicast and reserved addresses. An IPv6 address
 * is compared in the URL parser's canonical form, without a zone id, so every notation of one address
 * gives one answer; anything that isn't an address counts as private.
 */
export const isPrivate = (address: string): boolean => {
  const bare = address.split("%")[0]!
  if (isIP(bare) === 4) {
    const n = v4(bare)
    return v4Ranges.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)))
  }
  if (isIP(bare) !== 6) return true
  const canonical = new URL(`http://[${bare}]`).hostname.slice(1, -1)
  const inner = carried(canonical)
  if (inner !== undefined) return isPrivate(inner)
  return canonical === "::" || /^f[cd]/.test(canonical) || /^fe[89ab]/.test(canonical) || /^ff/.test(canonical)
}

/** `*.example.org` matches subdomains, anything else the exact host. */
export const allowed = (host: string, patterns: ReadonlyArray<string>) =>
  patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p))

/**
 * Why the proxy refuses `host:port`, or null. Without `addresses` it checks only the lists, before the
 * proxy resolves the host. A host in `allow` may resolve only to public addresses. An entry of
 * `allowPrivate` names one host and port exactly (`git.schnau.dev:443`), which may resolve to any
 * address: the forge on the Tailnet shares its address with every other port of its host.
 */
export const admit = (
  host: string,
  port: number,
  addresses: ReadonlyArray<string> | undefined,
  egress: EgressPolicy,
): { readonly status: string; readonly reason: string } | null => {
  const anywhere = egress.allowPrivate.includes(`${host}:${port}`)
  if (!anywhere && !allowed(host, egress.allow)) return { status: "403 Not On The Allowlist", reason: "not on the allowlist" }
  if (addresses === undefined) return null
  if (addresses.length === 0) return { status: "502 Unknown Host", reason: "unknown host" }
  if (!anywhere && addresses.some(isPrivate)) return { status: "403 Private Address", reason: "private address" }
  return null
}

interface Client extends Tunnel.End {
  head: Array<Uint8Array>
  decided: boolean
  /** Bytes queued in `early` while the upstream connects. */
  earlyBytes: number
}

/**
 * How much a client may send after its CONNECT before the upstream is linked: the proxy's memory, outside
 * the worker unit's limit. Clients wait for the 200 before they send, so there is little to keep.
 */
const earlyLimit = 1024 ** 2

/**
 * The first of `addresses` that takes the connection. A host may resolve to IPv6 first where only IPv4
 * gets out, such as from an agent whose host rejects IPv6 for its jobs to keep them off the LAN.
 */
const connectAny = async (addresses: ReadonlyArray<string>, port: number) => {
  for (const hostname of addresses) {
    const upstream = await Bun.connect<Tunnel.End>({ hostname, port, data: Tunnel.end(), socket: Tunnel.handlers }).catch(() => null)
    if (upstream !== null) return upstream
  }
  return null
}

const refuse = (socket: Socket<Client>, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
}

/**
 * The only way out for sandboxed workers (pull-request runs, `PrivateNetwork=yes`): an HTTP CONNECT
 * proxy on the unix socket `path` that reaches allowlisted hosts (`admit`). Workers bridge it to a
 * loopback port inside their network namespace. `log` hears every refusal of a listed host's address
 * and of an unlisted host. Closes with the scope.
 */
export const serve = (path: string, egress: EgressPolicy, log: (message: string) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (existsSync(path)) rmSync(path)
      const open = async (socket: Socket<Client>, host: string, port: number) => {
        const unlisted = admit(host, port, undefined, egress)
        if (unlisted !== null) {
          log(`egress refused ${host}:${port}: ${unlisted.reason}`)
          return refuse(socket, unlisted.status)
        }
        const addresses = isIP(host) !== 0 ? [host] : (await Bun.dns.lookup(host, {}).catch(() => [])).map((a) => a.address)
        const refused = admit(host, port, addresses, egress)
        if (refused !== null) {
          if (refused.status !== "502 Unknown Host") log(`egress refused ${host}:${port}: ${refused.reason}`)
          return refuse(socket, refused.status)
        }
        const upstream = await connectAny(addresses, port)
        if (upstream === null) return refuse(socket, "502 Connect Failed")
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        Tunnel.link(socket, upstream)
      }
      return Bun.listen<Client>({
        unix: path,
        socket: {
          ...Tunnel.handlers,
          open(socket) {
            socket.data = { ...Tunnel.end(), head: [], decided: false, earlyBytes: 0 }
          },
          data(socket, chunk) {
            if (socket.data.decided) {
              if (socket.data.peer === null && (socket.data.earlyBytes += chunk.length) > earlyLimit) return void socket.end()
              return Tunnel.handlers.data(socket, chunk)
            }
            socket.data.head.push(chunk)
            const buffered = Buffer.concat(socket.data.head)
            const split = buffered.indexOf("\r\n\r\n")
            if (split === -1) {
              if (buffered.length > 16384) refuse(socket, "431 Request Header Fields Too Large")
              return
            }
            socket.data.decided = true
            if (buffered.length > split + 4) socket.data.early.push(buffered.subarray(split + 4))
            const [method, target] = buffered.subarray(0, split).toString("latin1").split("\r\n")[0]!.split(" ")
            const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "")
            if (method !== "CONNECT" || match === null) return refuse(socket, "405 Only CONNECT")
            void open(socket, match[1]!.toLowerCase(), Number(match[2]))
          },
        },
      })
    }),
    (server) => Effect.sync(() => server.stop(true)),
  )

/** The controller's egress proxy, `egress.sock` in its runtime directory, for its local sandboxed workers. */
export const layer = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* Config
  if (config.egress === null) return
  const services = yield* Effect.context<never>()
  const path = join(config.runtimeDir, "egress.sock")
  yield* serve(path, config.egress, (message) => void Effect.runForkWith(services)(Effect.logInfo(message)))
  chmodSync(path, 0o660)
  const group = workersGroup(config.jobs.mode)
  if (group !== undefined) chownSync(path, process.getuid!(), group)
}))
