import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import { appAttr } from "../src/Protocol.ts"
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
    readonly derivations?: Record<string, { drv: string; out: string; system: string } | null>
    readonly trusted?: ReadonlyArray<string>
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
      derivations: options.derivations ?? derivations(sha),
      ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
    }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id, plan, fork, tree)
      values (${id}, 'app', ${Number(id.split("-")[1])}, ${JSON.stringify(options.event ?? { _tag: "Push", branch: "main" })}, ${sha}, 'main', 't', 'h', 0, ${options.trust ?? "trusted"}, 'passed',
        ${options.at}, 't', 's', ${JSON.stringify(plan)}, ${options.fork === true ? 1 : 0}, ${tree})`
    return (yield* Rows.loadRun(id))!
  })

const pullRequest = (fork: boolean) => ({ _tag: "PullRequest", number: 7, base: "main", head: "feature", fork })
const whole = (sha: string) => ({ derivations: derivations(sha), app: "app", trusted: ["bundle", appAttr], whole: true })

describe("an earlier plan of the same tree", () => {
  it.effect("comes from the newest run of that tree the run trusts: the default branch's, or for a same-repo pull request its kind too, trusted first", () =>
    Effect.gen(function*() {
      yield* run("app-1", "pushed", "tree-1", { at: 1 })
      yield* run("app-2", "pr-head", "tree-1", { trust: "pr", at: 2 })
      // A push to another branch ran that branch's ci.ts in the trusted worker; a fork's plan is never reused.
      yield* run("app-3", "feature", "tree-1", { at: 3, event: { _tag: "Push", branch: "feature" } })
      yield* run("app-5", "forked", "tree-1", { trust: "pr", fork: true, at: 5 })
      yield* run("app-6", "only-feature", "tree-3", { at: 6, event: { _tag: "Push", branch: "feature" } })
      const other = yield* run("app-4", "other", "tree-2", { at: 4 })
      const next = (trust: "pr" | "trusted", fork: 0 | 1, tree = "tree-1") => Rows.earlierPlan({ ...other, sha: "next", tree, trust, fork }, "main")
      // A pull request's ci.ts runs in the worker that planned, so its plan reaches neither the merge nor a fork.
      expect(yield* next("trusted", 0)).toEqual({ run: "app-1", revision: "pushed", ...whole("pushed") })
      expect(yield* next("pr", 1)).toEqual({ run: "app-1", revision: "pushed", ...whole("pushed") })
      expect(yield* next("pr", 0)).toEqual({ run: "app-1", revision: "pushed", ...whole("pushed") })
      expect(yield* next("trusted", 0, "tree-3")).toBeNull()
      // Without a trusted plan, a same-repo pull request takes another's.
      yield* run("app-7", "pr-other-tree", "tree-4", { trust: "pr", at: 7 })
      expect(yield* next("pr", 0, "tree-4")).toMatchObject({ revision: "pr-other-tree", trusted: [], whole: false })
    }).pipe(Effect.provide(sqlite)))

  it.effect("for a merge is its same-repo pull request's, of the attributes the controller marked as ones a trusted run takes", () =>
    Effect.gen(function*() {
      const shell = { drv: "/nix/store/shell.drv", out: "/nix/store/shell", system: "x86_64-linux" }
      // The pull request's plan took its dev shell from a record its first push made in the pull requests' pool.
      yield* run("app-2", "pr-head", "tree-1", {
        trust: "pr",
        at: 2,
        event: pullRequest(false),
        derivations: { ...derivations("pr-head"), shell },
        trusted: ["bundle", appAttr],
      })
      const merge = yield* run("app-9", "merge", "tree-1", { at: 0 })
      const taken = Rows.earlierPlan({ ...merge, sha: "merge" }, "main")
      expect(yield* taken).toEqual({ run: "app-2", revision: "pr-head", derivations: derivations("pr-head"), app: "app", trusted: ["bundle", appAttr], whole: false })

      // Never a fork's, a check's, nor the attributes a pull request took from another pull request's records or plan:
      // their ci.ts ran in a worker the default branch doesn't trust, or what they took did.
      yield* run("app-3", "fork-head", "tree-1", { trust: "pr", fork: true, at: 3, event: pullRequest(true), trusted: ["bundle", appAttr] })
      yield* run("app-4", "check", "tree-1", { trust: "pr", at: 4, event: { _tag: "Check", ref: "calder/check/x", base: "main" }, trusted: ["bundle", appAttr] })
      yield* run("app-5", "pr-amended", "tree-1", { trust: "pr", at: 5, event: pullRequest(false) })
      expect(yield* taken).toMatchObject({ revision: "pr-head" })
      // Nor the app's name, when the record that named it was another pull request's.
      yield* run("app-6", "pr-app", "tree-1", { trust: "pr", at: 6, event: pullRequest(false), trusted: ["bundle"] })
      expect(yield* taken).toEqual({ run: "app-6", revision: "pr-app", derivations: derivations("pr-app"), trusted: ["bundle"], whole: false })
      // A same-repo pull request takes the newest a trusted run would take whole, so its own plan stays one.
      expect(yield* Rows.earlierPlan({ ...merge, trust: "pr" }, "main")).toMatchObject({ revision: "pr-app", whole: false })
      yield* run("app-8", "pr-whole", "tree-1", { trust: "pr", at: 8, event: pullRequest(false), trusted: ["bundle", appAttr] })
      expect(yield* Rows.earlierPlan({ ...merge, trust: "pr" }, "main")).toMatchObject({ revision: "pr-whole", whole: true })
    }).pipe(Effect.provide(sqlite)))

  it.effect("is never one that took a record the audit found wrong", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* run("app-1", "pushed", "tree-1", { at: 1 })
      yield* run("app-2", "pr-head", "tree-1", { trust: "pr", at: 2, event: pullRequest(false), trusted: ["bundle", appAttr] })
      yield* sql`insert into run_records (run_id, attr, evaluation) values ('app-2', 'bundle', 7)`
      const merge = yield* run("app-9", "merge", "tree-1", { at: 0 })
      const taken = Rows.earlierPlan({ ...merge, sha: "merge" }, "main")
      expect(yield* taken).toMatchObject({ revision: "pr-head" })
      // As Runs.ts `audit` notes record 7 of another attribute's mismatch.
      yield* sql`insert into audit_mismatches (project, attr, revision, detail, at) values ('app', 'other', 'head', ${JSON.stringify({ record: 8 })}, 1)`
      expect(yield* taken).toMatchObject({ revision: "pr-head" })
      yield* sql`insert into audit_mismatches (project, attr, revision, detail, at) values ('app', 'bundle', 'head', ${JSON.stringify({ record: 7 })}, 1)`
      expect(yield* taken).toMatchObject({ revision: "pushed" })
    }).pipe(Effect.provide(sqlite)))
})

describe("the attributes of a same-repo pull request's plan a trusted run takes", () => {
  /** Inserts a footprint record of `trust` and returns its id. */
  const record = (trust: "pr" | "trusted") =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ id: number }>`insert into evaluations (project, attr, footprint, count, digest, trust, run_id, created_at)
        values ('app', 'a', 1, 1, 'd', ${trust}, 'app-1', 1) returning id`
      return row!.id
    })
  const drv = { drv: "/nix/store/x.drv", out: "/nix/store/x", system: "x86_64-linux" }
  const plan = (fromRecords?: Record<string, number>, reused?: { revision: string; attrs: Array<string> }) => ({
    derivations: { a: drv, b: drv, c: drv },
    ...(fromRecords === undefined ? {} : { fromRecords }),
    ...(reused === undefined ? {} : { reused }),
  })

  it.effect("are those it evaluated, took from trusted records, or took from what a trusted run takes of the plan it reused", () =>
    Effect.gen(function*() {
      const trusted = yield* record("trusted")
      const pr = yield* record("pr")
      const attrs = (p: ReturnType<typeof plan>, earlier: { revision: string; trusted: Array<string> } | null = null) => Rows.trustedAttrs("app", p, earlier)
      expect(yield* attrs(plan())).toEqual(["a", "b", "c", appAttr])
      expect(yield* attrs(plan({ a: trusted, b: pr }))).toEqual(["a", "c", appAttr])
      expect(yield* attrs(plan({ [appAttr]: pr }))).toEqual(["a", "b", "c"])
      // A record an audit or pruning dropped since can't be told apart from a pull request's.
      expect(yield* attrs(plan({ a: 9999 }))).toEqual(["b", "c", appAttr])
      const reused = plan(undefined, { revision: "head", attrs: ["a", "b", appAttr] })
      expect(yield* attrs(reused, { revision: "head", trusted: ["a", "c", appAttr] })).toEqual(["a", "c", appAttr])
      expect(yield* attrs(reused, { revision: "other", trusted: ["a", "b", "c", appAttr] })).toEqual(["c"])
      expect(yield* attrs(reused, null)).toEqual(["c"])
    }).pipe(Effect.provide(sqlite)))

  it.effect("include one taken from a record an evaluator agent made for a same-repo pull request", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const pullRequest = { project: "app", id: "app-2", trust: "pr", fork: 0, event: JSON.stringify({ _tag: "PullRequest", number: 5, fork: false }) } as const
      const recorded = {
        footprints: [{ id: "1", revision: "a", entries: [["flake.nix", "read"] as const] }],
        evaluations: [{ id: 1, attr: "a", footprint: "1", count: 1, digest: "d", derivation: null }],
      }
      // As Runs.ts `evaluateBuilds` keeps what an evaluator agent recorded.
      yield* Rows.keepRecords(pullRequest, "main", recorded, "trusted")
      const [row] = yield* sql<{ id: number }>`select id from evaluations where run_id = 'app-2'`
      expect(yield* Rows.trustedAttrs("app", plan({ a: row!.id }), null)).toEqual(["a", "b", "c", appAttr])
    }).pipe(Effect.provide(sqlite)))
})
