import type { Domain } from "@calder-ci/api"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import { RunsCore } from "../src/controller/Runs.ts"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const install: PlannedStep = { ...step, name: "install", kind: "setup", needs: [], target: false, detail: "pnpm install", setup: { deps: "deps", platform: null } }

const task = (name: string, options: { readonly setup?: boolean; readonly neverReuse?: boolean } = {}): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: options.setup === true ? ["install"] : [],
  neverReuse: options.neverReuse === true,
  detail: name,
  task: {
    shell: null,
    keyBase: name,
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [],
    platform: null,
  },
})

/** What `calder check --background` and `calder watch` start: work that takes only slots nothing else wants. */
const background: Domain.Event = { _tag: "Check", ref: "calder/check/agent", base: "main", background: true }

/** Pull request #7's run `app-3`, beside `app-2`, with `steps`. */
const pullRequest = (steps: ReadonlyArray<PlannedStep>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const event: Domain.Event = { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false }
    const plan = { version: 1, app: null, trust: "pr", reuse: "all", schedules: [], steps }
    yield* sql`insert into runs (id, project, number, event, sha, branch, pr, commit_title, author, commit_time, trust, status, created_at,
        started_at, trace_id, span_id, plan, fork)
      values ('app-3', 'app', 3, ${JSON.stringify(event)}, 'sha', 'feature', 7, 'title', 'hauke', 3, 'pr', 'running', 3, 3, 't', 's',
        ${JSON.stringify(plan)}, 0)`
    for (const [position, s] of steps.entries()) {
      yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
        values ('app-3', ${s.name}, ${s.kind}, 'pending', ${JSON.stringify(s)}, ${position}, 's')`
    }
    const core = yield* RunsCore
    for (const s of steps) yield* core.step("app-3", s.name).pipe(Effect.forkChild)
  }).pipe(Effect.orDie)

const until = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>, done: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }))
const stepOf = (run: string, name: string) => Effect.map(Rows.loadStep(run, name), (row) => row ?? null).pipe(Effect.orDie)

/**
 * Drives the background check `app-2` with `checked`, and once its `first` step waits for a task slot, the
 * pull request `app-3` with `pulled`. The controller has one task slot, which background work never gets.
 * Returns how `app-3`'s steps stood once they ended, or after 2 s, before anything cancelled the check.
 */
const beside = (checked: ReadonlyArray<PlannedStep>, first: string, pulled: ReadonlyArray<PlannedStep>) =>
  Effect.gen(function*() {
    let pull: ReadonlyArray<Rows.StepRow | null> = []
    let waited: string | null = null
    const driven = yield* drive({
      steps: checked,
      event: background,
      value: (name) => (name === "install" ? { fresh: true } : null),
      meanwhile: Effect.gen(function*() {
        const row = yield* until(stepOf("app-2", first), (r) => r?.waiting?.startsWith("a task slot") === true)
        waited = row?.waiting ?? null
        yield* pullRequest(pulled)
        const ended = Effect.forEach(pulled, (s) => stepOf("app-3", s.name))
        pull = yield* until(ended, (rows) => rows.every((r) => r !== null && Rows.terminal(r.status))).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => ended }),
        )
        // The agent that started the check is gone; nothing else ends it.
        yield* (yield* RunsCore).cancel("app-2", "cancelled from the UI")
      }),
    })
    return { ...driven, pull: new Map(pull.flatMap((r) => (r === null ? [] : [[r.name, r] as const]))), waited }
  })

describe("work a background check shares", () => {
  it.live("a pull request's setup doesn't wait behind a background check's setup of the same dependencies that gets no slot", () =>
    Effect.gen(function*() {
      // The check's lint never reuses, so its install starts at once and is the one preparing the dependencies.
      const { pull, jobs, waited } = yield* beside([install, task("lint", { setup: true, neverReuse: true })], "install", [install, task("test", { setup: true })])
      // The pull request waited for the check's install, which then ran as the pull request's work.
      expect([pull.get("install")?.status, pull.get("test")?.status]).toEqual(["reused", "passed"])
      expect(jobs).toEqual(["install", "test"])
      expect(waited).toBe("a task slot: 0 of 1 busy; background work starts only while another slot stays free")
    }))

  it.live("a pull request's task doesn't wait behind a background check's task of the same key that gets no slot", () =>
    Effect.gen(function*() {
      const { pull, jobs, steps } = yield* beside([task("lint")], "lint", [task("lint")])
      // The pull request took the check's result, which the check's job had to run for.
      expect(pull.get("lint")).toMatchObject({ status: "reused", reused_from: "app-2" })
      expect(steps.get("lint")?.status).toBe("passed")
      expect(jobs).toEqual(["lint"])
    }))
})
