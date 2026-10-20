import { describe, expect, it } from "@effect/vitest"
import { hashOf, leavesHost } from "../src/controller/Cache.ts"

describe("cache", () => {
  it("names a store path's narinfo after its hash", () => {
    expect(hashOf("/nix/store/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello-2.12.3")).toBe("kwhxkl8yn5y8wqiq11jsybagw3fbc4iv")
    expect(hashOf("/nix/store/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello-2.12.3/bin/hello")).toBeUndefined()
    expect(hashOf("/tmp/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello")).toBeUndefined()
  })

  it("needs the cache only for releases that leave the controller's host", () => {
    expect(leavesHost(["http://host-a:18100"], "host-a")).toBe(false)
    expect(leavesHost(["http://host-b:18100", "http://host-a:18100"], "host-a")).toBe(true)
    expect(leavesHost([], "host-a")).toBe(false)
  })
})
