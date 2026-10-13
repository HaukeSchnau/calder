import { describe, expect, it } from "@effect/vitest"
import { Event } from "@kiln/core"
import { Effect } from "effect"
import * as Cli from "../src/Cli.ts"

describe("kiln plan --event", () => {
  it.effect("reads every form, with JSON inputs that contain colons", () =>
    Effect.gen(function*() {
      expect(yield* Cli.parseEvent("push")).toEqual(Event.push("main"))
      expect(yield* Cli.parseEvent("pr:12")).toEqual(Event.pullRequest({ number: 12 }))
      expect(yield* Cli.parseEvent("schedule:0 3 * * *")).toEqual(Event.schedule("0 3 * * *"))
      expect(yield* Cli.parseEvent("check")).toEqual(Event.check({ ref: "kiln/check/local" }))
      expect(yield* Cli.parseEvent(`manual:{"url":"https://example.com"}`)).toEqual(Event.manual({ url: "https://example.com" }))
    }))

  it.effect("rejects a mistyped event and lists the forms", () =>
    Effect.gen(function*() {
      for (const text of ["pus:main", "pr:abc", "schedule", "manual:main", "manual:[1]"]) {
        const error = yield* Effect.flip(Cli.parseEvent(text))
        expect(error.message).toContain(`--event ${text} is not an event`)
        expect(error.message).toContain("push[:<branch>]")
      }
    }))
})
