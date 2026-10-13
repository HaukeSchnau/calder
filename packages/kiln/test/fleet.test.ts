import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { remembered } from "../src/controller/Fleet.ts"

describe("Fleet", () => {
  it.effect("counts a host that never answered as unknown, and asks it again", () =>
    Effect.gen(function*() {
      const answers: Array<Effect.Effect<ReadonlyArray<string>, string>> = [Effect.fail("connection refused"), Effect.succeed(["kiln"])]
      const appsOf = remembered(() => answers.shift()!)
      expect(yield* appsOf("http://srv-1:18100")).toBeNull()
      expect(yield* appsOf("http://srv-1:18100")).toEqual(["kiln"])
    }))
})
