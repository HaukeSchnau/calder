import { describe, expect, it } from "@effect/vitest"
import { allowed, isPrivate } from "../src/controller/Egress.ts"

describe("Egress", () => {
  it("refuses private, Tailnet and loopback addresses", () => {
    for (const address of ["10.1.2.3", "100.83.228.36", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivate(address), address).toBe(true)
    }
    for (const address of ["104.16.0.35", "140.82.121.4", "2606:4700::6810:84e5", "100.128.0.1", "172.32.0.1"]) {
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
})
