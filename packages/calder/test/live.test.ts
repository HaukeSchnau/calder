import { describe, expect, it } from "@effect/vitest"
import type { Domain } from "@calder-ci/api"
import { Effect, Fiber, Stream } from "effect"
import * as Live from "../src/controller/Live.ts"

const line = (step: string, text: string): Domain.LogLine => ({ step, shard: null, stream: "stdout", level: "info", timestamp: 0, text })

const run = (status: Domain.RunStatus): Domain.Run => ({
  id: "calder-7",
  project: "calder",
  number: 7,
  event: { _tag: "Push", branch: "main" },
  commit: { sha: "0123456789abcdef", changeId: null, title: "a change", author: "hauke", timestamp: 0 },
  title: null,
  trust: "trusted",
  status,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  traceId: null,
  counts: {},
})

describe("following a run's logs", () => {
  it.effect("takes in steps that start later and ends when the run does", () =>
    Effect.gen(function*() {
      const live = yield* Live.Live
      live.append("calder-7", line("plan", "planned"))
      const following = yield* live.follow("calder-7").pipe(Stream.map((l) => l.text), Stream.runCollect, Effect.forkChild({ startImmediately: true }))
      live.append("calder-7", line("plan", "more planning"))
      live.finish("calder-7", "plan")
      live.append("calder-7", line("qa", "testing"))
      live.append("calder-8", line("qa", "another run"))
      live.finish("calder-7", "qa")
      yield* live.publish({ _tag: "RunChanged", run: run("passed") })
      expect(yield* Fiber.join(following)).toEqual(["more planning", "testing"])
    }).pipe(Effect.provide(Live.layer)))

  it.effect("ends at once when the run ended before following began", () =>
    Effect.gen(function*() {
      const live = yield* Live.Live
      yield* live.publish({ _tag: "RunChanged", run: run("failed") })
      expect(yield* live.follow("calder-7").pipe(Stream.runCollect)).toEqual([])
    }).pipe(Effect.provide(Live.layer)))
})
