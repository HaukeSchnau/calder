import { describe, expect, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { promisify } from "node:util"
import { admit, allowed, isPrivate } from "../src/controller/Egress.ts"
import { environment } from "../src/worker/Egress.ts"

describe("Egress", () => {
  it("refuses private, Tailnet and loopback addresses", () => {
    for (const address of ["10.1.2.3", "100.101.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1",
      "0:0:0:0:0:0:0:1", "::a00:1", "fe80::1%eth0"]) {
      expect(isPrivate(address), address).toBe(true)
    }
    for (const address of ["104.16.0.35", "140.82.121.4", "2606:4700::6810:84e5", "100.128.0.1", "172.32.0.1", "::ffff:6810:23", "64:ff9b::6810:23"]) {
      expect(isPrivate(address), address).toBe(false)
    }
  })

  it("matches exact hosts and subdomain wildcards", () => {
    const allow = ["registry.npmjs.org", "*.githubusercontent.com"]
    expect(allowed("registry.npmjs.org", allow)).toBe(true)
    expect(allowed("objects.githubusercontent.com", allow)).toBe(true)
    expect(allowed("githubusercontent.com", allow)).toBe(false)
    expect(allowed("evil-registry.npmjs.org", allow)).toBe(false)
  })

  it("admits a host and port listed for private addresses on any address, and others only on public ones", () => {
    const egress = { allow: ["registry.npmjs.org"], allowPrivate: ["git.schnau.dev:443"] }
    // Gitea's npm registry for @schnau packages: listed only in allowPrivate, on the Tailnet.
    expect(admit("git.schnau.dev", 443, undefined, egress)).toBeNull()
    expect(admit("git.schnau.dev", 443, ["100.118.194.2"], egress)).toBeNull()
    expect(admit("registry.npmjs.org", 443, ["104.16.0.35"], egress)).toBeNull()
    expect(admit("registry.npmjs.org", 443, ["10.0.0.5"], egress)).toMatchObject({ status: "403 Private Address" })
    expect(admit("example.org", 443, undefined, egress)).toMatchObject({ status: "403 Not On The Allowlist" })
    expect(admit("git.schnau.dev", 443, [], egress)).toMatchObject({ status: "502 Unknown Host" })
    // The forge's host on another port, and another host of its domain, stay closed.
    expect(admit("git.schnau.dev", 22, ["100.118.194.2"], egress)).toMatchObject({ status: "403 Not On The Allowlist" })
    expect(admit("evil.git.schnau.dev", 443, ["100.118.194.2"], { ...egress, allowPrivate: ["*.git.schnau.dev:443"] }))
      .toMatchObject({ status: "403 Not On The Allowlist" })
  })
})

/**
 * A test's server on port 0, which listens on the wildcard address, asked by that address as Effect's
 * `HttpServer.formatAddress` gives it (`http://[::]:<port>`), by `0.0.0.0` and by `[::1]`.
 */
const client = `
import http from "node:http"
const server = http.createServer((_, res) => res.end("direct"))
await new Promise((resolve) => server.listen(0, resolve))
const viaHttp = (url) => new Promise((resolve) => http.get(url, (res) => res.setEncoding("utf8").on("data", resolve)).on("error", (e) => resolve(e.code)))
const seen = {}
for (const host of ["[::]", "0.0.0.0", "[::1]"]) {
  const url = \`http://\${host}:\${server.address().port}/\`
  seen[host] = { fetch: await fetch(url).then((r) => r.text(), (e) => e.cause?.code ?? e.message), http: await viaHttp(url) }
}
server.close()
console.log(JSON.stringify(seen))
`

describe("a sandboxed job's proxy environment", () => {
  it("leaves out a server the job started itself, by its wildcard and loopback addresses", async () => {
    // Drops what reaches it, so a request that goes through it fails at once.
    const proxy = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    try {
      const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", client], { env: environment(url) })
      const direct = { fetch: "direct", http: "direct" }
      expect(JSON.parse(stdout)).toEqual({ "[::]": direct, "0.0.0.0": direct, "[::1]": direct })
    } finally {
      proxy.close()
    }
  })
})
