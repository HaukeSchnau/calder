import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { inChunks } from "../src/controller/Rows.ts"

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
