import { describe, expect, it } from "@effect/vitest"
import { hashOf, leavesHost } from "../src/controller/Cache.ts"

describe("cache", () => {
  it("names a store path's narinfo after its hash", () => {
    expect(hashOf("/nix/store/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello-2.12.3")).toBe("kwhxkl8yn5y8wqiq11jsybagw3fbc4iv")
    expect(hashOf("/nix/store/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello-2.12.3/bin/hello")).toBeUndefined()
    expect(hashOf("/tmp/kwhxkl8yn5y8wqiq11jsybagw3fbc4iv-hello")).toBeUndefined()
  })

  it("needs the cache only for releases that leave the controller's host", () => {
    expect(leavesHost(["http://srv-2:18100"], "srv-2")).toBe(false)
    expect(leavesHost(["http://srv-1:18100", "http://srv-2:18100"], "srv-2")).toBe(true)
    expect(leavesHost([], "srv-2")).toBe(false)
  })
})
