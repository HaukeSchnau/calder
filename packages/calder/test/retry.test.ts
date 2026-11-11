import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { retryable } from "../src/controller/Runs.ts"
import * as Workflow from "../src/controller/Workflow.ts"
import type { JobResult, PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const task = (name: string, needs: ReadonlyArray<string> = []): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [...needs],
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

/** An action, which takes an action slot, so it runs beside the tests' one task slot. */
const action = (name: string): PlannedStep => ({ ...step, name, kind: "action", needs: [], detail: name, action: { deploy: false, secrets: [] } })

const failed: JobResult = { _tag: "Failed", tag: "BuildFailed", message: "failed to start SSH connection", error: null, key: null }

/** Fails `name`'s first job, as a builder that dropped its connection would. */
const failingOnce = (name: string) => {
  let calls = 0
  return (s: string) => (s === name && calls++ === 0 ? failed : undefined)
}

const statusOf = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ status: string }>`select status from steps where run_id = 'app-2' and name = ${name}`
    return row?.status
  }).pipe(Effect.orDie)

const runOf = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ status: string; retries: number }>`select status, retries from runs where id = 'app-2'`
  return row!
}).pipe(Effect.orDie)

const until = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>, done: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }), Effect.timeout("5 seconds"), Effect.orDie)

const rerun = Effect.gen(function*() {
  const runs = yield* Workflow.Runs
  return yield* runs.rerun("app-2").pipe(Effect.orDie)
})

describe("a rerun in place", () => {
  it("runs the failed steps and what they blocked again, downstream of each, and leaves what passed", () => {
    const steps = [
      { name: "a", status: "passed", spec: task("a") },
      { name: "b", status: "failed", spec: task("b") },
      { name: "c", status: "blocked", spec: task("c", ["b"]) },
      { name: "d", status: "blocked", spec: task("d", ["c"]) },
      { name: "e", status: "pending", spec: task("e", ["b", "a"]) },
      { name: "f", status: "skipped", spec: task("f", ["a"]) },
    ] as const
    expect(retryable(steps)).toEqual(["b", "c", "d"])
  })

  it.live("of a run that ended runs its failed step and the step it blocked in the same run, which then passes", () =>
    Effect.gen(function*() {
      let retried: { readonly id: string } | undefined
      let after: { readonly status: string; readonly retries: number } | undefined
      const { status, jobs, steps } = yield* drive({
        steps: [task("a"), task("b"), task("c", ["b"]), task("d", ["a"])],
        result: failingOnce("b"),
        meanwhile: Effect.gen(function*() {
          yield* until(runOf, (r) => r.status === "failed")
          retried = yield* rerun
          after = yield* until(runOf, (r) => r.status === "passed")
        }),
      })
      expect(status).toBe("passed")
      expect(retried?.id).toBe("app-2")
      expect(after?.retries).toBe(1)
      expect(jobs.filter((j) => j === "b")).toHaveLength(2)
      expect(jobs.filter((j) => j === "a" || j === "d").toSorted()).toEqual(["a", "d"])
      expect(jobs.at(-1)).toBe("c")
      expect(steps.get("c")?.status).toBe("passed")
    }))

  it.live("while the run goes on starts the failed step at once, and a dependent that hadn't started waits for it", () =>
    Effect.gen(function*() {
      let slowEnded = false
      let againBeforeSlowEnded: boolean | undefined
      let bJobs = 0
      let retries: number | undefined
      const { status, jobs, steps } = yield* drive({
        steps: [action("slow"), task("b"), task("c", ["b", "slow"])],
        result: (s) => (s === "b" && bJobs === 1 ? failed : undefined),
        work: (s) =>
          s === "slow"
            ? Effect.sleep("600 millis").pipe(Effect.andThen(Effect.sync(() => void (slowEnded = true))))
            : s === "b"
            ? Effect.suspend(() => {
              bJobs++
              if (bJobs === 1) return Effect.void
              againBeforeSlowEnded = !slowEnded
              // b's second job outlasts slow, so c is ready to run while b still runs again.
              return Effect.sleep("1200 millis")
            })
            : Effect.void,
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("b"), (s) => s === "failed")
          yield* rerun
          retries = (yield* until(runOf, (r) => r.status === "passed")).retries
        }),
      })
      expect(status).toBe("passed")
      expect(againBeforeSlowEnded).toBe(true)
      expect(jobs.filter((j) => j === "c")).toHaveLength(1)
      expect(steps.get("c")?.status).toBe("passed")
      // Waiting, c never settled blocked, which the driver would have had to run again.
      expect(retries).toBe(1)
    }))

  it.live("refuses a run that still goes on with nothing failed yet", () =>
    Effect.gen(function*() {
      let refused: string | undefined
      yield* drive({
        steps: [task("slow")],
        work: () => Effect.sleep("300 millis"),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("slow"), (s) => s === "running")
          const runs = yield* Workflow.Runs
          refused = yield* runs.rerun("app-2").pipe(Effect.flip, Effect.map((e) => e.message), Effect.orElseSucceed(() => "it reran"))
        }),
      })
      expect(refused).toContain("nothing of app-2 failed so far")
    }))
})
