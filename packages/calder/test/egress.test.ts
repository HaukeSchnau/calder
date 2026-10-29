import { describe, expect, it } from "@effect/vitest"
import { admit, allowed, isPrivate } from "../src/controller/Egress.ts"

describe("Egress", () => {
  it("refuses private, Tailnet and loopback addresses", () => {
    for (const address of ["10.1.2.3", "100.101.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1"]) {
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
