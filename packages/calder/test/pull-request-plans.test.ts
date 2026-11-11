import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { appAttr, type PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const check: PlannedStep = { ...step, name: "check", kind: "action", needs: [], detail: "check", action: { deploy: false, secrets: [], preview: false } }

const drv = { drv: "/nix/store/dddddddddddddddddddddddddddddddd-a.drv", out: "/nix/store/dddddddddddddddddddddddddddddddd-a", system: "x86_64-linux" }

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

  it.live("of a same-repo pull request says which attributes a trusted run may take, which the worker can't claim", () =>
    Effect.gen(function*() {
      const plan = (fromRecords: Record<string, number>, event = pullRequest(false)) =>
        Effect.map(
          drive({ steps: [check], event, unplanned: true, seed: records, plan: { derivations: { a: drv, b: drv }, fromRecords, trusted: ["a", "b", appAttr] } }),
          (driven) => driven.plan.trusted,
        )
      expect(yield* plan({ a: 1 })).toEqual(["a", "b", appAttr])
      // An attribute it took from a pull request's record isn't one, the others are.
      expect(yield* plan({ a: 1, b: 2 })).toEqual(["a", appAttr])
      // Nor the app's name, when the record that named it is a pull request's.
      expect(yield* plan({ a: 1, [appAttr]: 2 })).toEqual(["a", "b"])
      expect(yield* plan({ a: 1 }, pullRequest(true))).toBeUndefined()
    }))

  it.live("that a merge reused gives the merge the records it took, so the audit lists the merge with the pull request", () =>
    Effect.gen(function*() {
      const seed = Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const plan = { version: 1, app: "app", trust: "pr", reuse: "all", schedules: [], steps: [], derivations: { a: drv, b: drv }, trusted: ["a", "b", appAttr] }
        yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
            trace_id, span_id, plan, fork, tree)
          values ('app-0', 'app', 0, ${JSON.stringify(pullRequest(false))}, 'pr-head', 'feature', 't', 'h', 0, 'pr', 'passed', 0, 't', 's',
            ${JSON.stringify(plan)}, 0, 'tree-1')`
        yield* sql`insert into run_records (run_id, attr, evaluation) values ('app-0', 'a', 1), ('app-0', 'b', 2)`
      })
      const { planJob, read } = yield* drive({
        steps: [check],
        unplanned: true,
        seed,
        resume: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`update runs set tree = 'tree-1' where id = 'app-2'`),
        // The merge's plan took a and the app's name from the pull request's and evaluated b itself.
        plan: { derivations: { a: drv, b: drv }, reused: { revision: "pr-head", attrs: ["a", appAttr] } },
        read: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select attr, evaluation from run_records where run_id = 'app-2' order by attr`),
      })
      expect(planJob?.earlier?.revision).toBe("pr-head")
      expect(read).toEqual([{ attr: "a", evaluation: 1 }])
    }))
})
