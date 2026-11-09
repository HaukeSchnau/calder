import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { anchored, load, type Streak, streaks } from "../src/controller/Health.ts"
import { insertRun, insertStep, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const push = '{"_tag":"Push","branch":"main"}'
const schedule = '{"_tag":"Schedule","cron":"0 * * * *"}'

/** Runs of `p` on main at 1, 2, 3, ..., each planned with the given step statuses. */
const runs = (...list: ReadonlyArray<{ readonly event?: string; readonly steps: Record<string, string>; readonly errored?: boolean }>) =>
  Effect.gen(function*() {
    for (const [i, run] of list.entries()) {
      const id = `p-${i + 1}`
      yield* insertRun(id, { at: i + 1, branch: "main", event: run.event ?? push, planned: run.errored !== true, status: run.errored === true ? "errored" : "passed" })
      for (const [name, status] of Object.entries(run.steps)) yield* insertStep(id, name, { status, finished: i + 1 })
    }
    return streaks(yield* load("p", "main", 0))
  })

describe("streaks", () => {
  it.effect("counts a step's failed runs in a row until it passes, and leaves blocked and skipped steps out", () =>
    Effect.gen(function*() {
      const result = yield* runs(
        { steps: { build: "passed", placement: "failed", publish: "blocked" } },
        { steps: { build: "reused", placement: "died", publish: "blocked" } },
        { steps: { build: "reused", placement: "skipped", publish: "skipped" } },
        { steps: { build: "reused", placement: "failed", publish: "blocked" } },
      )
      expect(result).toEqual([{ step: "placement", since: 1, firstRun: "p-1", runs: 3, endedAt: null, settled: false }])
      // Read a run at a time, it follows the streak back past the newest runs.
      expect(streaks(yield* load("p", "main", 0, 1))).toEqual(result)
    }).pipe(Effect.provide(layer)))

  it.effect("ends a streak when the step passes, and starts a new one when it fails again", () =>
    Effect.gen(function*() {
      const result = yield* runs(
        { steps: { deploy: "failed" } },
        { steps: { deploy: "failed" } },
        { steps: { deploy: "passed" } },
        { steps: { deploy: "failed" } },
        { steps: { deploy: "reused" } },
      )
      expect(result).toEqual([{ step: "deploy", since: 4, firstRun: "p-4", runs: 1, endedAt: 5, settled: true }])
    }).pipe(Effect.provide(layer)))

  it.effect("ends a step's streak once a newer run of the same event plans without it, but not one of another event", () =>
    Effect.gen(function*() {
      const result = yield* runs(
        { steps: { "deploy-old": "failed", "deploy-gitea": "failed" } },
        { event: schedule, steps: { "deploy-gitea": "failed" } },
        { steps: { "deploy-new": "passed", "deploy-gitea": "failed" } },
        { steps: { "deploy-new": "passed", "deploy-gitea": "failed" } },
      )
      expect(result).toEqual([
        { step: "deploy-gitea", since: 1, firstRun: "p-1", runs: 4, endedAt: null, settled: false },
        { step: "deploy-old", since: 1, firstRun: "p-1", runs: 1, endedAt: 3, settled: false },
      ])
    }).pipe(Effect.provide(layer)))

  it.effect("counts a run that failed before it planned as its plan failing", () =>
    Effect.gen(function*() {
      const result = yield* runs(
        { steps: { test: "passed" } },
        { errored: true, steps: {} },
        { errored: true, steps: {} },
      )
      expect(result).toEqual([{ step: "(plan)", since: 2, firstRun: "p-2", runs: 2, endedAt: null, settled: true }])
    }).pipe(Effect.provide(layer)))

  it.effect("reads only trusted runs of the branch", () =>
    Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1, branch: "main", planned: true })
      yield* insertStep("p-1", "test", { status: "passed" })
      yield* insertRun("p-2", { at: 2, branch: "feature", planned: true })
      yield* insertStep("p-2", "test", { status: "failed" })
      yield* insertRun("p-3", { at: 3, branch: "main", trust: "pr", planned: true, event: '{"_tag":"Check","ref":"x","base":"main"}' })
      yield* insertStep("p-3", "test", { status: "failed" })
      expect(streaks(yield* load("p", "main", 0))).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("keeps where a streak started once retention pruned that run, and not once a pass ended it", () =>
    Effect.gen(function*() {
      const failing = { step: "deploy", runs: 2, endedAt: null }
      const keep = (streak: Streak) => anchored("p", [streak], 100)
      expect(yield* keep({ ...failing, since: 1, firstRun: "p-1", settled: false })).toEqual([{ ...failing, since: 1, firstRun: "p-1", settled: false }])
      // p-1 left the runs read: the oldest failure there is p-2 now, which can't tell where the streak started.
      expect(yield* keep({ ...failing, since: 2, firstRun: "p-2", settled: false })).toEqual([{ ...failing, since: 1, firstRun: "p-1", settled: false }])
      expect(yield* keep({ ...failing, since: 2, firstRun: "p-2", settled: false, endedAt: 5 })).toEqual([{ ...failing, since: 1, firstRun: "p-1", settled: false, endedAt: 5 }])
      // Months without a run: the next failure is all the runs read hold, and starts a streak of its own.
      expect(yield* keep({ ...failing, since: 90, firstRun: "p-9", settled: false })).toEqual([{ ...failing, since: 90, firstRun: "p-9", settled: false }])
    }).pipe(Effect.provide(layer)))

  it.effect("follows a failing step that only older runs have, until it passes", () =>
    Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1, branch: "main", planned: true, event: schedule })
      yield* insertStep("p-1", "nightly", { status: "passed" })
      yield* insertRun("p-2", { at: 2, branch: "main", planned: true, event: schedule })
      yield* insertStep("p-2", "nightly", { status: "failed" })
      for (const i of [3, 4, 5]) {
        yield* insertRun(`p-${i}`, { at: i, branch: "main", planned: true })
        yield* insertStep(`p-${i}`, "test", { status: "passed" })
      }
      expect(streaks(yield* load("p", "main", 0, 2))).toEqual([])
      expect(streaks(yield* load("p", "main", 0, 2, ["nightly"]))).toEqual([{ step: "nightly", since: 2, firstRun: "p-2", runs: 1, endedAt: null, settled: true }])
    }).pipe(Effect.provide(layer)))
})
