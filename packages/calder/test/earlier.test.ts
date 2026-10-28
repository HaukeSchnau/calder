import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const derivations = (name: string) => ({ bundle: { drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system: "x86_64-linux" } })

/** Inserts a planned run of `sha` with root tree `tree` and returns its row. */
const run = (id: string, sha: string, tree: string, options: { readonly trust?: "pr" | "trusted"; readonly fork?: boolean; readonly at: number }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const plan = { version: 1, app: "app", trust: options.trust ?? "trusted", reuse: "all", schedules: [], steps: [], derivations: derivations(sha) }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id, plan, fork, tree)
      values (${id}, 'app', ${Number(id.split("-")[1])}, '{}', ${sha}, 'main', 't', 'h', 0, ${options.trust ?? "trusted"}, 'passed',
        ${options.at}, 't', 's', ${JSON.stringify(plan)}, ${options.fork === true ? 1 : 0}, ${tree})`
    return (yield* Rows.loadRun(id))!
  })

describe("an earlier plan of the same tree", () => {
  it.effect("comes from the newest trusted or same-repo run of that tree, never from a fork's", () =>
    Effect.gen(function*() {
      yield* run("app-1", "pr-head", "tree-1", { trust: "pr", at: 1 })
      yield* run("app-2", "fork-head", "tree-1", { trust: "pr", fork: true, at: 2 })
      yield* run("app-3", "other", "tree-2", { at: 3 })
      const merge = yield* run("app-4", "merge", "tree-1", { at: 4 })
      expect(yield* Rows.earlierPlan(merge)).toEqual({ revision: "pr-head", derivations: derivations("pr-head"), app: "app" })
      const alone = yield* run("app-5", "alone", "tree-3", { at: 5 })
      expect(yield* Rows.earlierPlan(alone)).toBeNull()
    }).pipe(Effect.provide(sqlite)))
})
