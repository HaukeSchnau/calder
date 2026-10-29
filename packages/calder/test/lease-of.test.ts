import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { vi } from "vitest"
import * as Leases from "../src/controller/Leases.ts"
import { leaseOf, pullRequestStale } from "../src/controller/WorkerServer.ts"
import { branchOf } from "../src/controller/Workflow.ts"
import type { RunInfo } from "../src/Protocol.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const run = (event: RunInfo["event"], branch: string | null) => ({ project: "app", event, branch }) as RunInfo

describe("the lease a deploy takes", () => {
  it("is the project's, checked against the run's branch: the default branch's for a schedule, the triggered one for a manual run", () => {
    // A schedule's branch is the default branch; a manual run's is the branch it was triggered on.
    expect(branchOf({ _tag: "Schedule", cron: "0 3 * * *" }, "main")).toBe("main")
    expect(branchOf({ _tag: "Manual", inputs: {} }, "main")).toBe("main")
    expect(branchOf({ _tag: "Manual", inputs: { release: "prod" }, branch: "feature" }, "main")).toBe("feature")
    expect(leaseOf(run({ _tag: "Manual", inputs: { release: "prod" } }, "main"), true)).toEqual({ key: "app", current: { branch: "main" } })
    expect(leaseOf(run({ _tag: "Schedule", cron: "0 3 * * *" }, "main"), true)).toEqual({ key: "app", current: { branch: "main" } })
    expect(leaseOf(run({ _tag: "Push", branch: "main" }, "main"), true)).toEqual({ key: "app", current: { branch: "main" } })
  })

  it("is the pull request's own for its previews, which deploy only while it is open at their revision, and their removal", () => {
    expect(leaseOf(run({ _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: false }, "feature"), true))
      .toEqual({ key: "app#pr-5", current: { pullRequest: 5 } })
    expect(leaseOf(run({ _tag: "PullRequestClosed", number: 5, base: "main", head: "feature" }, "main"), true))
      .toEqual({ key: "app#pr-5", current: null })
  })

  it("is the project's lease of its name for a task that names one, checked against its branch like the project's", () => {
    expect(leaseOf(run({ _tag: "Push", branch: "main" }, "main"), "testflight")).toEqual({ key: "app#testflight", current: { branch: "main" } })
    expect(leaseOf(run({ _tag: "Manual", inputs: { release: "native" } }, "main"), "play")).toEqual({ key: "app#play", current: { branch: "main" } })
  })

  it.effect("lets a beta deploy through while a store build holds its own lease, and the store build's next run wait for it", () =>
    Effect.gen(function*() {
      let fence = 0
      const leases = Leases.make({ nextFence: () => Effect.sync(() => ++fence), held: () => Effect.void, released: () => Effect.void })
      const push = (number: number) => ({ ...run({ _tag: "Push", branch: "main" }, "main"), number }) as RunInfo
      const store = leaseOf(push(10), "testflight")
      expect((yield* leases.acquire(store.key, { job: "testflight@10", run: 10, step: "testflight" }))._tag).toBe("Held")

      // The next push deploys beta at once, though run 10's TestFlight build still holds its lease.
      const beta = leaseOf(push(11), true)
      expect((yield* leases.acquire(beta.key, { job: "deploy-beta@11", run: 11, step: "deploy-beta" }))._tag).toBe("Held")

      // Its own TestFlight build waits for run 10's, so uploads keep the order of their runs.
      const next = yield* Effect.forkChild(leases.acquire(leaseOf(push(11), "testflight").key, { job: "testflight@11", run: 11, step: "testflight" }))
      yield* Effect.yieldNow
      expect(leases.holder(store.key)?.job).toBe("testflight@10")
      yield* leases.release(store.key, "testflight@10")
      expect((yield* Fiber.join(next))._tag).toBe("Held")
    }))

  it("leaves an action's head check to the action", () => {
    expect(leaseOf(run({ _tag: "Push", branch: "main" }, "main"), false)).toEqual({ key: "app", current: null })
  })

  it("lets a preview through only while its pull request is open at the run's revision, so none follows its removal", () => {
    const sha = "a".repeat(40)
    expect(pullRequestStale(5, { open: true, merged: false, sha }, sha)).toBeUndefined()
    expect(pullRequestStale(5, { open: false, merged: false, sha }, sha)).toBe("pull request #5 is closed")
    expect(pullRequestStale(5, { open: false, merged: true, sha }, sha)).toBe("pull request #5 is merged")
    expect(pullRequestStale(5, { open: true, merged: false, sha: "b".repeat(40) }, sha)).toBe("pull request #5 moved on to bbbbbbbbbbbb")
  })
})
