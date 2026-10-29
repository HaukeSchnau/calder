import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { counts, inChunks } from "../src/controller/Rows.ts"
import { insertRun, insertStep, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

describe("inChunks", () => {
  it.live("writes every row once, in order, a thousand at a time", () =>
    Effect.gen(function*() {
      const rows = Array.from({ length: 2500 }, (_, i) => i)
      const written: Array<ReadonlyArray<number>> = []
      yield* inChunks(rows, (chunk) => Effect.sync(() => written.push(chunk)))
      expect(written.map((chunk) => chunk.length)).toEqual([1000, 1000, 500])
      expect(written.flat()).toEqual(rows)
    }))
})

describe("a run's counts", () => {
  it.live("count a task whose each matched no file apart from those that reused a result", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("app-1", { at: 1 })
      yield* insertStep("app-1", "lint", { status: "passed" })
      yield* insertStep("app-1", "test", { status: "reused" })
      yield* insertStep("app-1", "test-ui", { status: "reused" })
      yield* sql`update steps set files_total = ${3} where name = 'test'`
      yield* sql`update steps set files_total = ${0} where name = 'test-ui'`
      expect((yield* counts(["app-1"])).get("app-1")).toEqual({ passed: 1, reused: 1, "no-files": 1 })
    }).pipe(Effect.provide(sqlite)))
})
