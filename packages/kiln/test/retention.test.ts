import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { prune } from "../src/controller/Db.ts"
import { insertRun, insertStep, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const day = 86_400_000
/** Thirty days of retention on day 100: runs that finished before day 70 are past it. */
const pruned = prune(30, 100 * day)

const result = (runId: string, key: string, at: number, status = "passed") =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into results (key, run_id, step, trust, value, outputs, created_at, status)
      values (${key}, ${runId}, 'test', 'trusted', 'null', '{}', ${at}, ${status})`
  })

const fileResult = (runId: string, key: string, status: string, at: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into file_results (key, project, step, file, run_id, trust, status, duration_ms, created_at)
      values (${key}, 'p', 'test', ${key}, ${runId}, 'trusted', ${status}, 1, ${at})`
  })

/** What is left of a run: its plan, steps and results, or nothing. */
const left = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const run = yield* sql<{ plan: string | null }>`select plan from runs where id = ${runId}`
    if (run[0] === undefined) return null
    const count = (table: string) =>
      Effect.map(sql<{ n: number }>`select count(*) as n from ${sql(table)} where run_id = ${runId}`, (rows) => rows[0]!.n)
    const results = yield* sql<{ key: string }>`select key from results where run_id = ${runId} order by key`
    const files = yield* sql<{ key: string }>`select key from file_results where run_id = ${runId} order by key`
    return {
      plan: run[0].plan !== null,
      steps: yield* count("steps"),
      tests: yield* count("tests"),
      results: [...results, ...files].map((r) => r.key),
    }
  })

describe("prune", () => {
  it.live("deletes runs past the window with their steps and tests, and keeps the ones inside it", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const [id, at] of [["p-1", 1], ["p-2", 80]] as const) {
        yield* insertRun(id, { at: at * day })
        yield* insertStep(id, "test")
        yield* sql`insert into tests (run_id, project, step, suite, name, status, duration_ms, created_at)
          values (${id}, 'p', 'test', 'suite', 'works', 'passed', 1, ${at * day})`
      }
      expect(yield* pruned).toEqual({ deleted: 1, trimmed: 0 })
      expect(yield* left("p-1")).toBeNull()
      expect(yield* sql`select * from steps where run_id = 'p-1'`).toEqual([])
      expect(yield* sql`select * from tests where run_id = 'p-1'`).toEqual([])
      expect(yield* left("p-2")).toEqual({ plan: true, steps: 1, tests: 1, results: [] })
    }).pipe(Effect.provide(layer)))

  it.live("keeps the newest result of each key and outcome, and the row of the run that holds it", () =>
    Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1 * day })
      yield* insertStep("p-1", "test")
      yield* result("p-1", "superseded", 1 * day)
      yield* result("p-1", "newest", 1 * day)
      yield* fileResult("p-1", "file-superseded", "passed", 1 * day)
      yield* fileResult("p-1", "file-failed", "failed", 1 * day)
      yield* fileResult("p-1", "file-newest-passing", "passed", 1 * day)
      yield* insertRun("p-2", { at: 2 * day })
      yield* result("p-2", "superseded", 2 * day)
      yield* result("p-2", "newest", 2 * day, "failed")
      yield* fileResult("p-2", "file-superseded", "flaky", 2 * day)
      yield* fileResult("p-2", "file-newest-passing", "failed", 2 * day)
      yield* insertRun("p-3", { at: 80 * day })
      expect(yield* pruned).toEqual({ deleted: 0, trimmed: 2 })
      expect(yield* left("p-1")).toEqual({ plan: false, steps: 0, tests: 0, results: ["newest", "file-newest-passing"] })
      expect(yield* left("p-2")).toEqual({ plan: false, steps: 0, tests: 0, results: ["newest", "superseded", "file-superseded"] })
    }).pipe(Effect.provide(layer)))

  it.live("keeps a result that a run inside the window reused", () =>
    Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1 * day })
      yield* result("p-1", "key", 1 * day)
      yield* insertRun("p-2", { at: 2 * day })
      yield* result("p-2", "key", 2 * day)
      yield* insertRun("p-3", { at: 80 * day })
      yield* insertStep("p-3", "test", { status: "reused", reusedFrom: "p-1" })
      yield* pruned
      expect(yield* left("p-1")).toEqual({ plan: false, steps: 0, tests: 0, results: ["key"] })
    }).pipe(Effect.provide(layer)))

  it.live("keeps the row of the newest run of each pull request, which the catch-up looks for", () =>
    Effect.gen(function*() {
      const event = '{"_tag":"PullRequest","number":5,"base":"main","head":"feature"}'
      yield* insertRun("p-1", { at: 1 * day, event })
      yield* insertRun("p-2", { at: 2 * day, event })
      yield* insertRun("p-3", { at: 80 * day })
      expect(yield* pruned).toEqual({ deleted: 1, trimmed: 1 })
      expect(yield* left("p-1")).toBeNull()
      expect(yield* left("p-2")).toEqual({ plan: false, steps: 0, tests: 0, results: [] })
    }).pipe(Effect.provide(layer)))

  it.live("keeps each project's newest planned run whole", () =>
    Effect.gen(function*() {
      yield* insertRun("q-1", { at: 1 * day })
      yield* insertStep("q-1", "test")
      expect(yield* pruned).toEqual({ deleted: 0, trimmed: 0 })
      expect(yield* left("q-1")).toEqual({ plan: true, steps: 1, tests: 0, results: [] })
    }).pipe(Effect.provide(layer)))
})
