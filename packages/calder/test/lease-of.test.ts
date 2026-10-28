import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { leaseOf } from "../src/controller/WorkerServer.ts"
import type { RunInfo } from "../src/Protocol.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const run = (event: RunInfo["event"], branch: string | null) => ({ project: "app", event, branch }) as RunInfo

describe("the lease a deploy takes", () => {
  it("is the project's, checked against the default branch for manual and scheduled runs, whatever revision they run", () => {
    // `calder trigger --branch feature --inputs '{"release":"prod"}'` runs feature's head as a manual run of the default branch.
    expect(leaseOf(run({ _tag: "Manual", inputs: { release: "prod" } }, "main"), true)).toEqual({ key: "app", branch: "main" })
    expect(leaseOf(run({ _tag: "Schedule", cron: "0 3 * * *" }, "main"), true)).toEqual({ key: "app", branch: "main" })
    expect(leaseOf(run({ _tag: "Push", branch: "main" }, "main"), true)).toEqual({ key: "app", branch: "main" })
  })

  it("is the pull request's own for its previews and their removal, and removing one checks no head", () => {
    expect(leaseOf(run({ _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: false }, "feature"), true))
      .toEqual({ key: "app#pr-5", branch: "feature" })
    expect(leaseOf(run({ _tag: "PullRequestClosed", number: 5, base: "main", head: "feature" }, "main"), true))
      .toEqual({ key: "app#pr-5", branch: null })
  })

  it("leaves an action's head check to the action", () => {
    expect(leaseOf(run({ _tag: "Push", branch: "main" }, "main"), false)).toEqual({ key: "app", branch: null })
  })
})
