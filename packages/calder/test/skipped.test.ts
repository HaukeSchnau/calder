import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const task = (name: string, after: ReadonlyArray<string> = []): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [],
  after: [...after],
  neverReuse: true,
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
    lease: true,
  },
})

describe("skipped steps", () => {
  it.live("a deploy that didn't deploy is skipped, not passed, and so is what comes after it", () =>
    Effect.gen(function*() {
      const { status, jobs, statuses, steps } = yield* drive({
        steps: [task("deploy-mbp"), task("smoke-mbp", ["deploy-mbp"]), task("deploy-m1")],
        result: (name) => (name === "deploy-mbp" ? { _tag: "Skipped", reason: "mbp is offline; a later run deploys it" } : undefined),
      })
      expect(status).toBe("passed")
      expect(jobs.toSorted()).toEqual(["deploy-m1", "deploy-mbp"])
      expect(steps.get("deploy-mbp")).toMatchObject({ status: "skipped", error: { tag: "Skipped", message: "mbp is offline; a later run deploys it" } })
      expect(steps.get("smoke-mbp")).toMatchObject({ status: "skipped", error: { message: "deploy-mbp was skipped" } })
      expect(steps.get("deploy-m1")?.status).toBe("passed")
      expect(statuses.get("calder/deploy-mbp")).toBe("warning: skipped: mbp is offline; a later run deploys it")
    }))
})
