import { describe, expect, it } from "@effect/vitest"
import { directUses } from "../src/worker/Resolve.ts"

describe("build edges", () => {
  it("links each build to the planned builds it uses directly", () => {
    const builds = [
      { name: "deps", drv: "/nix/store/d.drv" },
      { name: "release", drv: "/nix/store/r.drv" },
      { name: "gate", drv: "/nix/store/g.drv" },
      { name: "projectRelease", drv: "/nix/store/r.drv" },
    ]
    const closures = new Map([
      ["deps", new Set(["/nix/store/d.drv"])],
      ["release", new Set(["/nix/store/r.drv", "/nix/store/d.drv"])],
      ["projectRelease", new Set(["/nix/store/r.drv", "/nix/store/d.drv"])],
      ["gate", new Set(["/nix/store/g.drv", "/nix/store/r.drv", "/nix/store/d.drv"])],
    ])
    expect(Object.fromEntries(directUses(builds, closures))).toEqual({
      release: ["deps"],
      projectRelease: ["deps"],
      gate: ["release", "projectRelease"],
    })
  })
})
