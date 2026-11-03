import type { Domain } from "@calder-ci/api"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import { obsolete, RunsCore } from "../src/controller/Runs.ts"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const attr = "nixosConfigurations.srv-1.config.system.build.toplevel"
const old = "/nix/store/d7gk87np00000000000000000000000-nixos-system-srv-1.drv"
const next = "/nix/store/37i5xxmr00000000000000000000000-nixos-system-srv-1.drv"

const build = (drv: string | null, name = "srv-1"): PlannedStep => ({
  ...step,
  name,
  kind: "build",
  needs: [],
  detail: attr,
  build: { attr, drv, out: drv?.replace(/\.drv$/, "") ?? null, system: null },
})

/** A run of `id` (`<project>-<number>`) with its build steps, each pending unless it says otherwise. */
const insert = (id: string, options: {
  readonly status: Domain.RunStatus
  readonly event?: Domain.Event
  readonly sha?: string
  readonly at?: number
  readonly builds?: ReadonlyArray<readonly [PlannedStep, Domain.StepStatus?]>
}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const project = id.slice(0, id.lastIndexOf("-"))
    const number = Number(id.slice(id.lastIndexOf("-") + 1))
    const event = options.event ?? { _tag: "Push", branch: "main" }
    const builds = options.builds ?? []
    const plan = { version: 1, app: null, trust: "trusted", reuse: "all", schedules: [], steps: builds.map(([s]) => s) }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id, plan)
      values (${id}, ${project}, ${number}, ${JSON.stringify(event)}, ${options.sha ?? id}, 'main', 'title', 'hauke', 1, 'trusted',
        ${options.status}, ${options.at ?? number}, 't', 's', ${options.status === "queued" || options.status === "planning" ? null : JSON.stringify(plan)})`
    for (const [position, [s, status]] of builds.entries()) {
      yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
        values (${id}, ${s.name}, 'build', ${status ?? "pending"}, ${JSON.stringify(s)}, ${position}, 's')`
    }
  }).pipe(Effect.orDie)

describe("a superseded run's running build", () => {
  it.live("knows what the runs that go on build, and whether a run of the project may still add builds", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const live = Rows.liveBuilds("infra")
      // infra-587 builds the old closure; superseded, it is cancelled.
      yield* insert("infra-587", { status: "cancelled", builds: [[build(old), "running"]] })
      expect(yield* live).toEqual({ unknown: false, drvs: [] })

      // The run that replaced it hasn't planned yet, or has to evaluate srv-1 first.
      yield* insert("infra-590", { status: "planning" })
      expect((yield* live).unknown).toBe(true)
      yield* sql`delete from runs where id = 'infra-590'`
      yield* insert("infra-590", { status: "running", builds: [[build(null)]] })
      expect((yield* live).unknown).toBe(true)
      yield* sql`update steps set spec = ${JSON.stringify(build(next))} where run_id = 'infra-590'`
      expect(yield* live).toEqual({ unknown: false, drvs: [next] })

      // Another project's unsettled builds count; its runs that haven't planned or evaluated don't.
      yield* insert("other-3", { status: "running", builds: [[build(old, "host")], [build("/nix/store/x-done.drv", "done"), "reused"]] })
      yield* insert("other-4", { status: "planning" })
      yield* insert("other-5", { status: "running", builds: [[build(null, "host")]] })
      expect(yield* live).toEqual({ unknown: false, drvs: [next, old] })
    }).pipe(Effect.provide(sqlite)))

  it("is obsolete once no run that goes on builds its derivation or depends on what it builds right now", () => {
    const tests = "/nix/store/pytest00000000000000000000000000-python3-test-suite.drv"
    const known = { unknown: false, drvs: [next] }
    // The newer run builds the same derivation, or may still turn out to: it waits for this build.
    expect(obsolete(old, { unknown: false, drvs: [old] }, [], null)).toBe(false)
    expect(obsolete(old, { unknown: true, drvs: [] }, [], null)).toBe(false)
    // Another derivation: this build stops, unless it is building something the newer one depends on,
    // which stopping would make the daemon start over.
    expect(obsolete(old, known, [], null)).toBe(true)
    expect(obsolete(old, known, [tests], new Set([next, tests]))).toBe(false)
    expect(obsolete(old, known, [tests], new Set([next]))).toBe(true)
    expect(obsolete(old, known, [tests], null)).toBe(false)
  })

  const tests = "/nix/store/pytest00000000000000000000000000-python3-test-suite.drv"
  /**
   * Drives run 2, whose srv-1 builds `building` until it is stopped or 300 ms passed, and supersedes it
   * once it runs with run 3, which builds `newer` and depends on `requisites`.
   */
  const superseded = (newer: PlannedStep, building: ReadonlyArray<string> = [], requisites?: ReadonlyArray<string>) =>
    drive({
      steps: [build(old)],
      ...(requisites === undefined ? {} : { requisites }),
      work: (name, emit) =>
        name !== "srv-1" ? Effect.void : Effect.gen(function*() {
          for (const [id, drv] of building.entries()) {
            yield* emit({ _tag: "Activity", activity: { id, parent: 0, type: "build", text: `building '${drv}'`, drv, start: 0, end: null, failed: false } })
          }
          yield* Effect.sleep("300 millis")
        }),
      meanwhile: Effect.gen(function*() {
        const status = Effect.map(Rows.loadStep("app-2", "srv-1"), (row) => row?.status ?? "pending")
        yield* status.pipe(Effect.repeat({ until: (s) => s === "running", schedule: Schedule.spaced("10 millis") }))
        yield* insert("app-3", { status: "running", sha: "newer", at: 3, builds: [[newer]] })
        yield* (yield* RunsCore).supersede("app-2", "superseded by #3")
        yield* status.pipe(Effect.repeat({ until: Rows.terminal, schedule: Schedule.spaced("10 millis") }))
      }),
    })

  it.live("stops once the run that replaced it builds another derivation", () =>
    Effect.gen(function*() {
      const { status, steps } = yield* superseded(build(next))
      expect(status).toBe("cancelled")
      expect(steps.get("srv-1")?.status).toBe("cancelled")
    }))

  it.live("runs on while the run that replaced it builds the same derivation", () =>
    Effect.gen(function*() {
      const { steps } = yield* superseded(build(old))
      expect(steps.get("srv-1")?.status).toBe("passed")
    }))

  it.live("runs on while it builds a dependency of the newer derivation, and stops when what it builds is its own", () =>
    Effect.gen(function*() {
      expect((yield* superseded(build(next), [tests], [next, tests])).steps.get("srv-1")?.status).toBe("passed")
      expect((yield* superseded(build(next), [tests], [next])).steps.get("srv-1")?.status).toBe("cancelled")
    }))
})

describe("a new run", () => {
  it.live("replaces active pushes and schedules of older revisions of its branch, when it is a push", () =>
    Effect.gen(function*() {
      const hourly: Domain.Event = { _tag: "Schedule", cron: "23 * * * *" }
      yield* insert("infra-587", { status: "running", sha: "a" })
      yield* insert("infra-588", { status: "running", sha: "b" })
      yield* insert("infra-589", { status: "running", sha: "b", event: hourly })
      yield* insert("infra-586", { status: "running", sha: "a", event: { _tag: "Manual", branch: "main", inputs: {} } as Domain.Event })
      yield* insert("infra-585", { status: "passed", sha: "z" })
      yield* insert("infra-590", { status: "queued", sha: "c" })
      const push = { project: "infra", branch: "main", pr: null, sha: "c" }
      expect([...(yield* Rows.replaced({ ...push, event: { _tag: "Push", branch: "main" } }))].sort()).toEqual(["infra-587", "infra-588", "infra-589"])
      // A schedule of the head replaces nothing, and isn't replaced by a push of the same revision.
      yield* insert("infra-591", { status: "running", sha: "c", event: hourly })
      expect(yield* Rows.replaced({ ...push, event: hourly })).toEqual([])
      expect(yield* Rows.replaced({ ...push, event: { _tag: "Push", branch: "main" } })).not.toContain("infra-591")
    }).pipe(Effect.provide(sqlite)))
})
