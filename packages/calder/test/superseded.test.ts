import type { Domain } from "@calder-ci/api"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import type { Cache } from "../src/controller/Cache.ts"
import { RunsCore } from "../src/controller/Runs.ts"
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
        values (${id}, ${s.name}, ${s.kind}, ${status ?? "pending"}, ${JSON.stringify(s)}, ${position}, 's')`
    }
  }).pipe(Effect.orDie)

const task = (name: string): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [],
  neverReuse: true,
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
    offload: true,
    preview: false,
    lease: false,
  },
})

const until = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>, done: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }))
const statusOf = (run: string, name: string) => Effect.map(Rows.loadStep(run, name), (row) => row?.status ?? "pending")

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
})

describe("a superseded run's running job", () => {
  type Last = Effect.Effect<void, never, SqlClient.SqlClient>
  type Hook = Effect.Effect<Last | void, never, RunsCore | SqlClient.SqlClient>
  /**
   * Drives run 2, whose `first` step's job runs for 2 s, and supersedes it once that runs: `before` runs
   * first, `after` right after, and what either returns once run 2's step ended. Returns how long that
   * step took to end after it was superseded.
   */
  const superseded = (first: PlannedStep, options: {
    readonly before?: Hook
    readonly after?: Hook
    readonly cache?: Cache["Service"]
    readonly onDone?: () => void
    /** Steps of run 2 besides `first`, which wait for its slot. */
    readonly extra?: ReadonlyArray<PlannedStep>
  } = {}) =>
    Effect.gen(function*() {
      let stoppedAfter = Number.POSITIVE_INFINITY
      const driven = yield* drive({
        steps: [first, ...(options.extra ?? [])],
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        work: (name) => (name === first.name ? Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(() => options.onDone?.()))) : Effect.void),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("app-2", first.name), (s) => s === "running")
          for (const e of options.extra ?? []) {
            yield* until(Effect.map(Rows.loadStep("app-2", e.name), (row) => row?.waiting ?? null), (w) => w !== null)
          }
          const last1 = yield* options.before ?? Effect.void
          const at = Date.now()
          yield* (yield* RunsCore).supersede("app-2", "superseded by #3")
          const last2 = yield* options.after ?? Effect.void
          yield* until(statusOf("app-2", first.name), Rows.terminal)
          stoppedAfter = Date.now() - at
          for (const last of [last1, last2]) if (last !== undefined) yield* last
        }),
      })
      return { ...driven, stoppedAfter }
    })
  const later = (run: string, name: string) => until(statusOf(run, name), Rows.terminal).pipe(Effect.asVoid)
  /** Starts `run`'s step `name` beside the run, and waits until it waits for `reason`. */
  const waits = (run: string, name: string, reason: (waiting: string | null) => boolean) =>
    Effect.gen(function*() {
      yield* (yield* RunsCore).step(run, name).pipe(Effect.forkChild)
      yield* until(Effect.map(Rows.loadStep(run, name), (row) => row?.waiting ?? null), reason)
      return later(run, name)
    })

  it.live("stops a build once the run that replaced it builds another derivation", () =>
    Effect.gen(function*() {
      const { status, steps, stoppedAfter } = yield* superseded(build(old), {
        before: insert("app-3", { status: "running", sha: "newer", at: 3, builds: [[build(next)]] }),
      })
      expect(status).toBe("cancelled")
      expect(steps.get("srv-1")?.status).toBe("cancelled")
      expect(stoppedAfter).toBeLessThan(1000)
    }))

  it.live("stops a build at once while the run that replaced it still plans, when another claim waits for its slots", () =>
    Effect.gen(function*() {
      const { steps, jobs, stoppedAfter } = yield* superseded(build(old), {
        before: Effect.gen(function*() {
          yield* insert("app-4", { status: "running", sha: "other", at: 4, builds: [[build(next, "other")]] })
          const last = yield* waits("app-4", "other", (w) => w?.startsWith("a build slot") === true)
          yield* insert("app-3", { status: "planning", sha: "newer", at: 3 })
          return last
        }),
      })
      expect(steps.get("srv-1")?.status).toBe("cancelled")
      expect(stoppedAfter).toBeLessThan(1000)
      expect(jobs).toEqual(["srv-1", "other"])
    }))

  it.live("runs a build on while the run that replaced it plans, and that run's build of the same derivation waits for it without a slot and takes its output", () =>
    Effect.gen(function*() {
      let built = false
      const cache = { has: () => Effect.sync(() => built), publish: () => Effect.void }
      const { steps, jobs } = yield* superseded(build(old), {
        // Workflow.create supersedes older runs as soon as it created the run, before that one planned.
        before: insert("app-3", { status: "planning", sha: "newer", at: 3 }),
        after: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`delete from runs where id = 'app-3'`.pipe(Effect.orDie)
          yield* insert("app-3", { status: "running", sha: "newer", at: 3, builds: [[build(old, "srv-1-again")]] })
          const last = yield* waits("app-3", "srv-1-again", (w) => w === "another run's build of the same derivation")
          return Effect.gen(function*() {
            yield* last
            expect(yield* statusOf("app-3", "srv-1-again")).toBe("reused")
          })
        }),
        cache,
        onDone: () => void (built = true),
      })
      expect(steps.get("srv-1")?.status).toBe("passed")
      expect(jobs).toEqual(["srv-1"])
    }))

  it.live("waits only for a build of the same derivation that started, not one still queued for a slot", () =>
    Effect.gen(function*() {
      const { steps, jobs } = yield* drive({
        steps: [build(next, "busy")],
        work: (name) => (name === "busy" ? Effect.sleep("1 second") : Effect.void),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("app-2", "busy"), (s) => s === "running")
          const core = yield* RunsCore
          // Run 3's build of srv-1 queues for the only build slot; run 4's, on a deploy's critical path, takes the lane.
          yield* insert("app-3", { status: "running", sha: "three", at: 3, builds: [[build(old)]] })
          yield* core.step("app-3", "srv-1").pipe(Effect.forkChild)
          yield* until(Effect.map(Rows.loadStep("app-3", "srv-1"), (row) => row?.waiting ?? null), (w) => w?.startsWith("a build slot") === true)
          yield* insert("app-4", { status: "running", sha: "four", at: 4, builds: [[{ ...build(old), critical: true }]] })
          yield* core.step("app-4", "srv-1").pipe(Effect.forkChild)
          yield* until(statusOf("app-4", "srv-1"), Rows.terminal)
          expect(yield* statusOf("app-2", "busy")).toBe("running")
          yield* later("app-3", "srv-1")
        }),
      })
      expect(steps.get("busy")?.status).toBe("passed")
      expect(jobs.slice(0, 2)).toEqual(["busy", "srv-1"])
    }))

  it.live("withdraws its queued builds first, so they neither start nor count as waiting for the running build's slot", () =>
    Effect.gen(function*() {
      // The infra-891 shape: m1 builds, mbp waits for the same pool, and the run that replaced it plans.
      const { steps, jobs } = yield* superseded(build(old), {
        before: insert("app-3", { status: "planning", sha: "newer", at: 3 }),
        extra: [build(next, "srv-2")],
      })
      expect(steps.get("srv-1")?.status).toBe("passed")
      expect(steps.get("srv-2")?.status).toBe("cancelled")
      expect(jobs).toEqual(["srv-1"])
    }))

  it.live("never starts a queued task once the run is superseded", () =>
    Effect.gen(function*() {
      const { steps, jobs } = yield* superseded(task("lint"), { extra: [task("check")] })
      expect(steps.get("lint")?.status).toBe("cancelled")
      expect(steps.get("check")?.status).toBe("cancelled")
      expect(jobs).toEqual(["lint"])
    }))

  it.live("stops a task at once and gives its slot to the run that replaced it", () =>
    Effect.gen(function*() {
      let tookOver = Number.POSITIVE_INFINITY
      const { steps, jobs, stoppedAfter } = yield* superseded(task("lint"), {
        before: Effect.gen(function*() {
          yield* insert("app-3", { status: "running", sha: "newer", at: 3, builds: [[task("check")]] })
          // Run 3's task waits for the only task slot, which run 2's lint holds.
          const at = Date.now()
          const last = yield* waits("app-3", "check", (w) => w?.startsWith("a task slot") === true)
          return last.pipe(Effect.tap(() => Effect.sync(() => void (tookOver = Date.now() - at))))
        }),
      })
      expect(steps.get("lint")?.status).toBe("cancelled")
      expect(stoppedAfter).toBeLessThan(1000)
      expect(jobs).toEqual(["lint", "check"])
      expect(tookOver).toBeLessThan(1500)
    }))

  it.live("lets a deploy finish", () =>
    Effect.gen(function*() {
      const { steps } = yield* superseded({ ...task("deploy-srv-1"), task: { ...task("deploy-srv-1").task!, lease: true } }, {
        before: insert("app-3", { status: "running", sha: "newer", at: 3 }),
      })
      expect(steps.get("deploy-srv-1")?.status).toBe("passed")
    }))
})

describe("a cancelled run's running job", () => {
  it.live("stops at once", () =>
    Effect.gen(function*() {
      let stoppedAfter = Number.POSITIVE_INFINITY
      const { status, steps } = yield* drive({
        steps: [task("lint")],
        work: () => Effect.sleep("2 seconds"),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("app-2", "lint"), (s) => s === "running")
          const at = Date.now()
          yield* (yield* RunsCore).cancel("app-2", "cancelled by hauke")
          yield* until(statusOf("app-2", "lint"), Rows.terminal)
          stoppedAfter = Date.now() - at
        }),
      })
      expect(status).toBe("cancelled")
      expect(steps.get("lint")?.status).toBe("cancelled")
      expect(stoppedAfter).toBeLessThan(1000)
    }))

  it.live("never lets a queued job of the run start on the slot it frees", () =>
    Effect.gen(function*() {
      const { steps, jobs } = yield* drive({
        steps: [task("lint"), task("check")],
        work: () => Effect.sleep("2 seconds"),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("app-2", "lint"), (s) => s === "running")
          yield* until(Effect.map(Rows.loadStep("app-2", "check"), (row) => row?.waiting ?? null), (w) => w !== null)
          yield* (yield* RunsCore).cancel("app-2", "cancelled by hauke")
          yield* until(statusOf("app-2", "check"), Rows.terminal)
        }),
      })
      expect(steps.get("check")?.status).toBe("cancelled")
      expect(jobs).toEqual(["lint"])
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
