import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { CommandFailed } from "../src/Exec.ts"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const out = "/nix/store/0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c-app"
const app: PlannedStep = {
  ...step,
  name: "app",
  kind: "build",
  needs: [],
  detail: "packages.x86_64-linux.app",
  build: { attr: "packages.x86_64-linux.app", drv: "/nix/store/1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d-app.drv", out, system: "x86_64-linux" },
}

const rejected = new CommandFailed({
  command: "nix-cache-publish",
  exitCode: 1,
  stderr: [
    "copying 2 paths...",
    `copying path '${out}' to 'ssh-ng://nix-publish@cache'...`,
    `error: cannot add path '${out}' because it lacks a signature by a trusted key`,
    "",
  ].join("\n"),
})

describe("publishing", () => {
  it.live("a build whose output the cache rejects still passes, and its step says why", () =>
    Effect.gen(function*() {
      const { status, steps } = yield* drive({
        steps: [app],
        cache: { has: () => Effect.succeed(false), publish: () => Effect.fail(rejected) },
        value: () => out,
        settled: (steps) => steps.get("app")?.publishError !== null,
      })
      expect(status).toBe("passed")
      expect(steps.get("app")).toMatchObject({
        status: "passed",
        publishError: `error: cannot add path '${out}' because it lacks a signature by a trusted key`,
      })
    }))

  it.live("a build the cache takes has no publish error", () =>
    Effect.gen(function*() {
      const published: Array<string> = []
      const { status, steps } = yield* drive({
        steps: [app],
        cache: { has: () => Effect.succeed(false), publish: (path) => Effect.sync(() => void published.push(path)) },
        value: () => out,
        settled: () => published.length > 0,
      })
      expect(status).toBe("passed")
      expect(published).toEqual([out])
      expect(steps.get("app")?.publishError).toBeNull()
    }))
})
