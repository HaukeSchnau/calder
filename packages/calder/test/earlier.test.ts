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
  options: {
    readonly trust?: "pr" | "trusted"
    readonly fork?: boolean
    readonly at: number
    readonly event?: object
    readonly trustedInputs?: boolean
  },
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const plan = {
      version: 1,
      app: "app",
      trust: options.trust ?? "trusted",
      reuse: "all",
      schedules: [],
      steps: [],
      derivations: derivations(sha),
      ...(options.trustedInputs === undefined ? {} : { trustedInputs: options.trustedInputs }),
    }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id, plan, fork, tree)
      values (${id}, 'app', ${Number(id.split("-")[1])}, ${JSON.stringify(options.event ?? { _tag: "Push", branch: "main" })}, ${sha}, 'main', 't', 'h', 0, ${options.trust ?? "trusted"}, 'passed',
        ${options.at}, 't', 's', ${JSON.stringify(plan)}, ${options.fork === true ? 1 : 0}, ${tree})`
    return (yield* Rows.loadRun(id))!
  })

describe("an earlier plan of the same tree", () => {
  it.effect("comes from the newest run of that tree the run trusts: the default branch's, or for a same-repo pull request its kind too, trusted first", () =>
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
      expect(yield* next("trusted", 0)).toEqual({ revision: "pushed", derivations: derivations("pushed"), app: "app", trusted: true })
      expect(yield* next("pr", 1)).toEqual({ revision: "pushed", derivations: derivations("pushed"), app: "app", trusted: true })
      expect(yield* next("pr", 0)).toEqual({ revision: "pushed", derivations: derivations("pushed"), app: "app", trusted: true })
      expect(yield* next("trusted", 0, "tree-3")).toBeNull()
      // Without a trusted plan, a same-repo pull request takes another's.
      yield* run("app-7", "pr-other-tree", "tree-4", { trust: "pr", at: 7 })
      expect(yield* next("pr", 0, "tree-4")).toMatchObject({ revision: "pr-other-tree", trusted: false })
    }).pipe(Effect.provide(sqlite)))

  it.effect("for a merge is its same-repo pull request's, once that plan took only what a trusted run takes", () =>
    Effect.gen(function*() {
      const pullRequest = (fork: boolean) => ({ _tag: "PullRequest", number: 7, base: "main", head: "feature", fork })
      yield* run("app-1", "pushed", "tree-1", { at: 1 })
      yield* run("app-2", "pr-head", "tree-1", { trust: "pr", at: 2, event: pullRequest(false), trustedInputs: true })
      const merge = yield* run("app-9", "merge", "tree-1", { at: 0 })
      const taken = Rows.earlierPlan({ ...merge, sha: "merge" }, "main")
      expect(yield* taken).toEqual({ revision: "pr-head", derivations: derivations("pr-head"), app: "app", trusted: true })

      // Never a fork's, a check's, nor a pull request's that took another pull request's records or plan:
      // their ci.ts ran in a worker the default branch doesn't trust, or what they took did.
      yield* run("app-3", "fork-head", "tree-1", { trust: "pr", fork: true, at: 3, event: pullRequest(true), trustedInputs: true })
      yield* run("app-4", "check", "tree-1", { trust: "pr", at: 4, event: { _tag: "Check", ref: "calder/check/x", base: "main" }, trustedInputs: true })
      yield* run("app-5", "pr-amended", "tree-1", { trust: "pr", at: 5, event: pullRequest(false) })
      expect(yield* taken).toEqual({ revision: "pr-head", derivations: derivations("pr-head"), app: "app", trusted: true })
      // A same-repo pull request takes the newest a trusted run would take, so its own plan stays one.
      expect(yield* Rows.earlierPlan({ ...merge, sha: "next", trust: "pr" }, "main")).toMatchObject({ revision: "pr-head", trusted: true })
    }).pipe(Effect.provide(sqlite)))
})

describe("a same-repo pull request's plan took only what a trusted run takes", () => {
  /** Inserts a footprint record of `trust` and returns its id. */
  const record = (trust: "pr" | "trusted") =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ id: number }>`insert into evaluations (project, attr, footprint, count, digest, trust, run_id, created_at)
        values ('app', 'a', 1, 1, 'd', ${trust}, 'app-1', 1) returning id`
      return row!.id
    })

  it.effect("when every record it took is a trusted run's, and the plan it reused one a trusted run takes", () =>
    Effect.gen(function*() {
      const trusted = yield* record("trusted")
      const pr = yield* record("pr")
      const inputs = (taken: Record<string, number> | undefined, reused?: string, earlier: { revision: string; trusted: boolean } | null = null) =>
        Rows.trustedInputs("app", taken, reused, earlier)
      expect(yield* inputs(undefined)).toBe(true)
      expect(yield* inputs({ a: trusted })).toBe(true)
      expect(yield* inputs({ a: trusted, b: pr })).toBe(false)
      // A record an audit or pruning dropped since can't be told apart from a pull request's.
      expect(yield* inputs({ a: 9999 })).toBe(false)
      expect(yield* inputs(undefined, "head", { revision: "head", trusted: true })).toBe(true)
      expect(yield* inputs(undefined, "head", { revision: "head", trusted: false })).toBe(false)
      expect(yield* inputs(undefined, "head", null)).toBe(false)
    }).pipe(Effect.provide(sqlite)))
})
