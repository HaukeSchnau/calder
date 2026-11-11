import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import type { Job, JobResult, PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const planned: PlannedStep = {
  ...step,
  name: "planned",
  kind: "build",
  needs: [],
  detail: "checks.x86_64-linux.planned",
  build: { attr: "checks.x86_64-linux.planned", drv: "/nix/store/planned.drv", out: "/nix/store/planned", system: "x86_64-linux" },
}
/** A build whose footprint changed, so the plan left it for the first of the run's builds to evaluate. */
const app: PlannedStep = { ...planned, name: "app", detail: "checks.x86_64-linux.app", build: { attr: "checks.x86_64-linux.app", drv: null, out: null, system: null } }

const evaluated: JobResult = {
  _tag: "Evaluated",
  derivations: { app: { drv: "/nix/store/app.drv", out: "/nix/store/app", system: "x86_64-linux" } },
  tooLarge: {},
  uses: {},
  recorded: {
    footprints: [{ id: "f", revision: "sha", entries: [] }],
    evaluations: [{ attr: "checks.x86_64-linux.app", footprint: "f", count: 0, digest: "d", derivation: { drv: "/nix/store/app.drv", out: "/nix/store/app", system: "x86_64-linux" } }],
  },
}

describe("evaluating builds on agents", () => {
  it.live("a trusted run's builds evaluate on an agent of the configured platform, for this host's system, and keep what it recorded", () =>
    Effect.gen(function*() {
      const jobs: Array<Extract<Job, { _tag: "Step" }>> = []
      const kept: Array<{ attr: string; run_id: string }> = []
      const { status, placed, steps } = yield* drive({
        steps: [app, planned],
        evaluateOn: "aarch64-linux",
        // `app`'s closure holds `planned`'s derivation, which the agent's store lacks; this host's has it.
        requisites: ["/nix/store/planned.drv"],
        result: (_step, job, agent) => {
          if (job.evaluate === undefined) return undefined
          jobs.push(job)
          return agent === null ? undefined : evaluated
        },
        meanwhile: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ attr: string; run_id: string }>`select attr, run_id from evaluations`.pipe(
            Effect.repeat({ until: (r) => r.length > 0, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("3 seconds"),
            Effect.orDie,
          )
          kept.push(...rows)
        }),
      })
      expect(status).toBe("passed")
      expect(placed.toSorted()).toEqual(["app evaluates on aarch64-linux", "app here", "planned here"])
      // The agent evaluates for this host's system, from the mirrors here, records under it, and the
      // records count like those of an evaluation here.
      expect(jobs[0]!.run).toMatchObject({ system: "x86_64-linux", flake: "", mirror: "http://calder.test/git/app.git" })
      expect(kept).toEqual([{ attr: "checks.x86_64-linux.app", run_id: "app-2" }])
      // This host finds which builds use which, since only its store has the planned derivations.
      expect(steps.get("app")?.needs).toEqual(["planned"])
    }))

  it.live("an evaluation no agent takes in time runs here", () =>
    Effect.gen(function*() {
      const { status, placed } = yield* drive({
        steps: [app],
        evaluateOn: "aarch64-linux",
        agentless: true,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(status).toBe("passed")
      expect(placed).toEqual(["app evaluates here", "app here"])
    }))

  it.live("an evaluation that fails on the agent runs here", () =>
    Effect.gen(function*() {
      const { status, placed } = yield* drive({
        steps: [app],
        evaluateOn: "aarch64-linux",
        result: (_step, job, agent) =>
          job.evaluate === undefined ? undefined
          : agent === null ? evaluated
          : { _tag: "Died", message: "error: cannot fetch input 'git+ssh://git@forge/schnau/private.git'" },
      })
      expect(status).toBe("passed")
      expect(placed).toEqual(["app evaluates on aarch64-linux", "app evaluates here", "app here"])
    }))

  it.live("a pull request's builds evaluate here, in its sandbox", () =>
    Effect.gen(function*() {
      const { status, placed } = yield* drive({
        steps: [app],
        evaluateOn: "aarch64-linux",
        event: { _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: false },
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(status).toBe("passed")
      expect(placed).toEqual(["app evaluates here", "app here"])
    }))
})
