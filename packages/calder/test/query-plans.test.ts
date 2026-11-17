import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const plan = (statement: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe<{ detail: string }>(`explain query plan ${statement}`)
    return rows.map((r) => r.detail)
  })

/** A step of the plan that reads every row of `table` itself, not through an index. */
const fullScan = (details: ReadonlyArray<string>, table: string) =>
  details.filter((d) => d === `SCAN ${table}` || (d.startsWith(`SCAN ${table} `) && !d.includes("INDEX")))

describe("query plans", () => {
  it.effect("the overview's and `calder runs`' newest runs read runs through an index", () =>
    Effect.gen(function*() {
      const details = yield* plan("select * from runs where 1 = 1 order by created_at desc limit 40")
      expect(fullScan(details, "runs")).toEqual([])
      expect(details.join("\n")).not.toContain("TEMP B-TREE FOR ORDER BY")
    }).pipe(Effect.provide(layer)))

  it.effect("the outputs sweep reads named outputs from indexes, not from every step and result", () =>
    Effect.gen(function*() {
      const details = yield* plan(`select distinct each.value as path from (
          select outputs from steps where outputs is not null
          union all select outputs from results where status = 'passed'
        ) as named, json_each(named.outputs) as each`)
      expect(fullScan(details, "steps")).toEqual([])
      expect(fullScan(details, "results")).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("the health export reads steps from covering indexes, never past a step's spec", () =>
    Effect.gen(function*() {
      const outcomes = yield* plan(`select r.id, s.name, s.status, s.finished_at
        from (select * from runs where project = 'p' and branch = 'main' and trust = 'trusted' order by created_at desc limit 30) r
        left join steps s on s.run_id = r.id order by r.created_at, r.id, s.position, s.name`)
      expect(outcomes.join("\n")).toContain("COVERING INDEX steps_outcomes")
      const passed = yield* plan(`select s.finished_at from steps s where s.name = 'test' and s.status in ('passed', 'reused')
        and s.run_id in (select id from runs where project = 'p') order by s.finished_at desc limit 1`)
      expect(passed.join("\n")).toContain("COVERING INDEX steps_passed")
      expect(passed.join("\n")).not.toContain("TEMP B-TREE FOR ORDER BY")
    }).pipe(Effect.provide(layer)))

  it.effect("runs' step counts and a step's file durations read covering indexes, never past a step's spec", () =>
    Effect.gen(function*() {
      const counts = yield* plan(`select run_id, case when status = 'reused' and files_total = 0 then 'no-files' else status end as status,
        count(*) as n from steps where run_id in ('a', 'b') and kind != 'output' group by 1, 2`)
      expect(counts.join("\n")).toContain("COVERING INDEX steps_outcomes")
      const durations = yield* plan(`select file, duration_ms from (
          select file, duration_ms, row_number() over (partition by file order by created_at desc) as n
          from file_results where project = 'p' and step = 'test' and status != 'failed'
        ) where n <= 5`)
      expect(durations.join("\n")).toContain("COVERING INDEX file_results_file")
    }).pipe(Effect.provide(layer)))
})
