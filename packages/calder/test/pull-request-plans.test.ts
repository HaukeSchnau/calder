import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const check: PlannedStep = { ...step, name: "check", kind: "action", needs: [], detail: "check", action: { deploy: false, secrets: [], preview: false } }

const pullRequest = (fork: boolean) => ({ _tag: "PullRequest", number: 5, base: "main", head: "feature", fork }) as const

/** Footprint records 1 of a trusted run and 2 of a pull request's. */
const records = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`insert into evaluations (id, project, attr, footprint, count, digest, trust, run_id, created_at)
    values (1, 'app', 'a', 1, 1, 'd', 'trusted', 'app-0', 1), (2, 'app', 'b', 1, 1, 'd', 'pr', 'app-0', 1)`
})

describe("a pull request's plan", () => {
  it.live("of a fork runs in the forks' pool", () =>
    Effect.gen(function*() {
      const { pools } = yield* drive({ steps: [check], event: pullRequest(true), unplanned: true })
      expect(pools.get("plan")).toBe("fork")
      expect(pools.get("check")).toBe("fork")
    }))

  it.live("of a same-repo pull request says whether a trusted run may take it, which the worker can't claim", () =>
    Effect.gen(function*() {
      const plan = (fromRecords: Record<string, number>, event = pullRequest(false)) =>
        Effect.map(
          drive({ steps: [check], event, unplanned: true, seed: records, plan: { fromRecords, trustedInputs: true } }),
          (driven) => driven.plan.trustedInputs,
        )
      expect(yield* plan({ a: 1 })).toBe(true)
      expect(yield* plan({ a: 1, b: 2 })).toBeUndefined()
      // Nor when only the record that named the app is a pull request's.
      expect(yield* plan({ a: 1, "lib.project.project": 2 })).toBeUndefined()
      expect(yield* plan({ a: 1 }, pullRequest(true))).toBeUndefined()
    }))
})
