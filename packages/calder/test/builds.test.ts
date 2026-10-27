import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const build = (name: string, system: string): PlannedStep => ({
  ...step,
  name,
  kind: "build",
  needs: [],
  detail: `checks.${system}.${name}`,
  build: { attr: `checks.${system}.${name}`, drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system },
})

describe("builds", () => {
  it.live("a build for another system doesn't hold the slot this host's builds need", () =>
    Effect.gen(function*() {
      // The test config has one build slot. The darwin build waits for its remote builder until the linux one ran.
      const linuxRan = yield* Deferred.make<void>()
      const { status, jobs } = yield* drive({
        steps: [build("darwin", "aarch64-darwin"), build("linux", "x86_64-linux")],
        work: (name) => (name === "darwin" ? Deferred.await(linuxRan) : Deferred.succeed(linuxRan, undefined)),
      })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["darwin", "linux"])
    }))
})
