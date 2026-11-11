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
})
