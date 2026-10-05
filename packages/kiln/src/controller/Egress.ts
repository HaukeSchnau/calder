import type { Socket } from "bun"
import { Effect, Layer } from "effect"
import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"
import * as Tunnel from "../Tunnel.ts"
import { Config } from "./Config.ts"

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

/** Loopback, private, link-local, CGNAT (the Tailnet), multicast and reserved addresses. */
export const isPrivate = (address: string): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped !== null) return isPrivate(mapped[1]!)
  if (isIP(address) === 4) {
    const n = v4(address)
    return v4Ranges.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)))
  }
  const lower = address.toLowerCase()
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)
}

/** `*.example.org` matches subdomains, anything else the exact host. */
export const allowed = (host: string, patterns: ReadonlyArray<string>) =>
  patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p))

interface Client extends Tunnel.End {
  head: Array<Uint8Array>
  decided: boolean
}

const refuse = (socket: Socket<Client>, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
}

/**
 * The only way out for sandboxed workers (pull-request runs, `PrivateNetwork=yes`): an HTTP CONNECT
 * proxy on a unix socket that reaches allowlisted hosts on public addresses. Workers bridge it to a
 * loopback port inside their network namespace.
 */
export const layer = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* Config
  if (config.egress === null) return
  const { allow, allowPrivate } = config.egress
  const services = yield* Effect.context<never>()
  const log = (message: string) => Effect.runForkWith(services)(Effect.logInfo(message))
  const path = join(config.runtimeDir, "egress.sock")
  if (existsSync(path)) rmSync(path)

  const open = async (socket: Socket<Client>, host: string, port: number) => {
    if (!allowed(host, allow)) {
      log(`egress refused ${host}:${port}: not on the allowlist`)
      return refuse(socket, "403 Not On The Allowlist")
    }
    const addresses = isIP(host) !== 0 ? [{ address: host }] : await Bun.dns.lookup(host, {}).catch(() => [])
    if (addresses.length === 0) return refuse(socket, "502 Unknown Host")
    if (!allowPrivate.includes(host) && addresses.some((a) => isPrivate(a.address))) {
      log(`egress refused ${host}:${port}: private address`)
      return refuse(socket, "403 Private Address")
    }
    const upstream = await Bun.connect<Tunnel.End>({
      hostname: addresses[0]!.address,
      port,
      data: Tunnel.end(),
      socket: Tunnel.handlers,
    }).catch(() => null)
    if (upstream === null) return refuse(socket, "502 Connect Failed")
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    Tunnel.link(socket, upstream)
  }

  const server = Bun.listen<Client>({
    unix: path,
    socket: {
      ...Tunnel.handlers,
      open(socket) {
        socket.data = { ...Tunnel.end(), head: [], decided: false }
      },
      data(socket, chunk) {
        if (socket.data.decided) return Tunnel.handlers.data(socket, chunk)
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
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
  chmodSync(path, 0o660)
  const group = readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith("kiln-workers:"))
  if (group !== undefined) chownSync(path, process.getuid!(), Number(group.split(":")[2]))
}))
