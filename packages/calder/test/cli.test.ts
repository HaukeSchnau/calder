import { describe, expect, it } from "@effect/vitest"
import type { Domain } from "@calder-ci/api"
import { Event } from "@calder-ci/core"
import { Effect, Stream } from "effect"
import { TestConsole } from "effect/testing"
import * as Cli from "../src/Cli.ts"

const queued: Domain.Run = {
  id: "calder-7",
  project: "calder",
  number: 7,
  event: { _tag: "Push", branch: "feature" },
  commit: { sha: "0123456789abcdef", changeId: null, title: "a change", author: "hauke", timestamp: 0 },
  title: null,
  trust: "trusted",
  status: "queued",
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  traceId: null,
  counts: {},
}

describe("calder plan --event", () => {
  it.effect("reads every form, with JSON inputs that contain colons", () =>
    Effect.gen(function*() {
      expect(yield* Cli.parseEvent("push")).toEqual(Event.push("main"))
      expect(yield* Cli.parseEvent("pr:12")).toEqual(Event.pullRequest({ number: 12 }))
      expect(yield* Cli.parseEvent("schedule:0 3 * * *")).toEqual(Event.schedule("0 3 * * *"))
      expect(yield* Cli.parseEvent("check")).toEqual(Event.check({ ref: "calder/check/local" }))
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

describe("calder with an unknown subcommand", () => {
  it("names the closest subcommand first", () => {
    expect(Cli.closest("stauts", ["trigger", "runs", "status", "logs"])[0]).toBe("status")
    expect(Cli.closest("run", ["trigger", "rerun", "runs"])[0]).toBe("runs")
  })
})

describe("following a run", () => {
  it.effect("ends with the reason when the run ended before the change feed started", () =>
    Effect.gen(function*() {
      const errored = { ...queued, status: "errored" as const, error: "no rule runs pushes to feature" }
      const client = {
        changes: () => Stream.never,
        run: () => Effect.succeed({ seq: 1, run: errored, steps: [], failingTests: [], retried: [], siblings: [] }),
      }
      const ended = yield* Cli.follow(client, queued)
      expect(ended.status).toBe("errored")
      expect(yield* TestConsole.logLines).toContain("errored: no rule runs pushes to feature")
    }).pipe(Effect.provide(TestConsole.layer)))
})
