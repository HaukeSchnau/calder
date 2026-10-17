import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Estimates from "../src/controller/Estimates.ts"
import { insertRun, insertStep, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const layer = Estimates.layer.pipe(Layer.provideMerge(sqlite))

/** Runs `p-1` … `p-<n>` whose step `test` took 1 s, 2 s, …, and whose step `shard` ran three shards of that length. */
const history = (n: number) =>
  Effect.forEach(Array.from({ length: n }, (_, i) => i + 1), (i) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun(`p-${i}`, { at: i * 100_000 })
      yield* insertStep(`p-${i}`, "test", { started: i * 100_000, finished: i * 100_000 + i * 1000 })
      for (const shard of [1, 2, 3]) {
        yield* sql`insert into shards (run_id, step, shard, key, status, started_at, finished_at)
          values (${`p-${i}`}, 'shard', ${shard}, 'k', 'passed', ${i * 100_000}, ${i * 100_000 + i * 1000})`
      }
    }), { discard: true })

describe("Estimates", () => {
  it.effect("takes the median of a step's last ten executions and a sharded step's last thirty shards", () =>
    Effect.gen(function*() {
      yield* history(12)
      const estimates = yield* Estimates.Estimates
      // Runs 3 to 12 count for the step, 3 s … 12 s; runs 3 to 12 for the shards too, three each.
      expect((yield* estimates.steps("p")).get("test")).toBe(8000)
      expect((yield* estimates.shards("p")).get("shard")).toBe(8000)
    }).pipe(Effect.provide(layer)))

  it.effect("follows steps and shards as they settle, counting each execution once", () =>
    Effect.gen(function*() {
      yield* history(3)
      const estimates = yield* Estimates.Estimates
      expect((yield* estimates.steps("p")).get("test")).toBe(2000)
      const settled = { run_id: "p-4", name: "test", status: "passed" as const, started_at: 400_000, finished_at: 460_000 }
      yield* estimates.stepSettled("p", { ...settled, status: "running", finished_at: null })
      expect((yield* estimates.steps("p")).get("test")).toBe(2000)
      yield* estimates.stepSettled("p", settled)
      yield* estimates.stepSettled("p", settled)
      // 1 s, 2 s, 3 s and 60 s.
      expect((yield* estimates.steps("p")).get("test")).toBe(3000)

      expect((yield* estimates.shards("p")).get("shard")).toBe(2000)
      for (const index of [1, 2, 3, 4, 4]) {
        yield* estimates.shardSettled("p", { run: "p-4", step: "shard", index, startedAt: 400_000, finishedAt: 460_000 })
      }
      // Three shards each of 1 s, 2 s and 3 s, and four of 60 s.
      expect((yield* estimates.shards("p")).get("shard")).toBe(3000)
    }).pipe(Effect.provide(layer)))
})
