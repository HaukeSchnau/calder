import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const install: PlannedStep = { ...step, name: "install", kind: "setup", needs: [], target: false, detail: "pnpm install", setup: { deps: "deps", platform: null } }

const task = (name: string): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: ["install"],
  detail: name,
  task: {
    shell: null,
    keyBase: name,
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [],
    platform: null,
  },
})

/** `install` and the tasks `lint` and `test` that start from it. */
const plan = [install, task("lint"), task("test")]
const value = (name: string) => (name === "install" ? { fresh: true } : null)

describe("setups", () => {
  it.live("a setup doesn't run when every task that starts from it reuses its result", () =>
    Effect.gen(function*() {
      const { status, jobs, statuses, steps } = yield* drive({ steps: plan, passed: ["lint", "test"], value })
      expect(status).toBe("passed")
      expect(jobs).toEqual([])
      expect(steps.get("install")).toMatchObject({ status: "reused", key: "deps", queuedAt: null, startedAt: null })
      expect(statuses.get("calder/install")).toBe("success: not needed: no task that starts from it ran")
    }))

  it.live("a setup runs once a task that starts from it runs, and that task waits for it", () =>
    Effect.gen(function*() {
      const { status, jobs, statuses, steps } = yield* drive({ steps: plan, passed: ["lint"], value })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["install", "test"])
      expect([steps.get("install")?.status, steps.get("lint")?.status, steps.get("test")?.status]).toEqual(["passed", "reused", "passed"])
      expect(statuses.get("calder/install")).toMatch(/^success: passed/)
    }))
})
