import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import * as Estimates from "../src/controller/Estimates.ts"
import { insertRun, insertStep, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/** Runs `p-1` … `p-<n>` whose step `test` took 1 s, 2 s, … */
const history = (n: number) =>
  Effect.forEach(Array.from({ length: n }, (_, i) => i + 1), (i) =>
    Effect.gen(function*() {
      yield* insertRun(`p-${i}`, { at: i * 100_000 })
      yield* insertStep(`p-${i}`, "test", { started: i * 100_000, finished: i * 100_000 + i * 1000 })
    }), { discard: true })

describe("Estimates", () => {
  it.effect("takes the median of a step's last ten executions", () =>
    Effect.gen(function*() {
      yield* history(12)
      const estimates = Estimates.make()
      // Runs 3 to 12 count: 3 s … 12 s.
      expect((yield* estimates.forProject("p")).get("test")).toBe(8000)
      expect(yield* estimates.forProject("p")).toEqual(yield* Estimates.forProject("p"))
    }).pipe(Effect.provide(layer)))

  it.effect("follows steps as they settle, counting each execution once", () =>
    Effect.gen(function*() {
      yield* history(3)
      const estimates = Estimates.make()
      expect((yield* estimates.forProject("p")).get("test")).toBe(2000)
      const settled = { run_id: "p-4", name: "test", status: "passed" as const, started_at: 400_000, finished_at: 460_000 }
      yield* estimates.settled("p", { ...settled, status: "running", finished_at: null })
      expect((yield* estimates.forProject("p")).get("test")).toBe(2000)
      yield* estimates.settled("p", settled)
      yield* estimates.settled("p", settled)
      // 1 s, 2 s, 3 s and 60 s.
      expect((yield* estimates.forProject("p")).get("test")).toBe(3000)
    }).pipe(Effect.provide(layer)))
})
