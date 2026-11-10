import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const task = (name: string, after: ReadonlyArray<string> = [], ended: ReadonlyArray<string> = []): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [],
  after: [...after],
  exits: [...ended],
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

  it.live("a deploy after others ended runs once they did, whether they deployed, were skipped or failed", () =>
    Effect.gen(function*() {
      let inputs: unknown
      const { status, jobs, steps } = yield* drive({
        steps: [task("deploy-mbp"), task("deploy-m1"), task("deploy-srv-2", [], ["deploy-mbp", "deploy-m1"])],
        work: (name) => (name === "deploy-m1" ? Effect.sleep("50 millis") : Effect.void),
        result: (name, job) =>
          name === "deploy-srv-2" ? void (inputs = job.inputs)
          : name === "deploy-mbp" ? { _tag: "Skipped", reason: "mbp is offline; a later run deploys it" }
          : name === "deploy-m1" ? { _tag: "Failed", error: null, tag: "TaskFailed", message: "exited with 1", key: null }
          : undefined,
      })
      expect(status).toBe("failed")
      expect(jobs.at(-1)).toBe("deploy-srv-2")
      expect(steps.get("deploy-mbp")?.status).toBe("skipped")
      expect(steps.get("deploy-m1")?.status).toBe("failed")
      expect(steps.get("deploy-srv-2")?.status).toBe("passed")
      expect(steps.get("deploy-srv-2")!.startedAt!).toBeGreaterThanOrEqual(steps.get("deploy-m1")!.finishedAt!)
      // Only an action reads the outcomes it waited for.
      expect(inputs).toEqual({})
    }))
})
