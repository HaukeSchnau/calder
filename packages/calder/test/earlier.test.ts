import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const derivations = (name: string) => ({ bundle: { drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system: "x86_64-linux" } })

/** Inserts a planned run of `sha` with root tree `tree` and returns its row. */
const run = (
  id: string,
  sha: string,
  tree: string,
  options: { readonly trust?: "pr" | "trusted"; readonly fork?: boolean; readonly at: number; readonly event?: object },
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const plan = { version: 1, app: "app", trust: options.trust ?? "trusted", reuse: "all", schedules: [], steps: [], derivations: derivations(sha) }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id, plan, fork, tree)
      values (${id}, 'app', ${Number(id.split("-")[1])}, ${JSON.stringify(options.event ?? { _tag: "Push", branch: "main" })}, ${sha}, 'main', 't', 'h', 0, ${options.trust ?? "trusted"}, 'passed',
        ${options.at}, 't', 's', ${JSON.stringify(plan)}, ${options.fork === true ? 1 : 0}, ${tree})`
    return (yield* Rows.loadRun(id))!
  })

describe("an earlier plan of the same tree", () => {
  it.effect("comes from the newest run of that tree the run trusts: the default branch's, or for a same-repo pull request its kind too", () =>
    Effect.gen(function*() {
      yield* run("app-1", "pushed", "tree-1", { at: 1 })
      yield* run("app-2", "pr-head", "tree-1", { trust: "pr", at: 2 })
      yield* run("app-3", "fork-head", "tree-1", { trust: "pr", fork: true, at: 3 })
      // Another branch's push and manual run are trusted, but they ran that branch's ci.ts.
      yield* run("app-5", "feature-push", "tree-1", { at: 5, event: { _tag: "Push", branch: "feature" } })
      yield* run("app-6", "feature-manual", "tree-1", { at: 6, event: { _tag: "Manual", inputs: {}, branch: "feature" } })
      const other = yield* run("app-4", "other", "tree-2", { at: 4 })
      const next = (trust: "pr" | "trusted", fork: 0 | 1, tree = "tree-1") => Rows.earlierPlan({ ...other, sha: "next", tree, trust, fork }, "main")
      // A pull request's ci.ts runs in the worker that planned, so its plan reaches neither the merge nor a fork.
      expect(yield* next("trusted", 0)).toEqual({ revision: "pushed", derivations: derivations("pushed"), app: "app" })
      expect(yield* next("pr", 1)).toEqual({ revision: "pushed", derivations: derivations("pushed"), app: "app" })
      expect(yield* next("pr", 0)).toEqual({ revision: "pr-head", derivations: derivations("pr-head"), app: "app" })
      expect(yield* next("trusted", 0, "tree-3")).toBeNull()
    }).pipe(Effect.provide(sqlite)))
})
