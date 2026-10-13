import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { remembered } from "../src/controller/Fleet.ts"

describe("Fleet", () => {
  it.effect("asks a host for its apps again after its /health failed", () =>
    Effect.gen(function*() {
      const answers: Array<Effect.Effect<ReadonlyArray<string>, string>> = [Effect.fail("connection refused"), Effect.succeed(["kiln"])]
      const appsOf = remembered(() => answers.shift()!)
      expect(yield* appsOf("http://srv-1:18100")).toEqual([])
      expect(yield* appsOf("http://srv-1:18100")).toEqual(["kiln"])
    }))
})
