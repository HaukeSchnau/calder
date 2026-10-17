import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, PlatformError, Schedule } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { Agents, make as makeAgents } from "../src/controller/Agents.ts"
import { Cache } from "../src/controller/Cache.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Jobs } from "../src/controller/Jobs.ts"
import * as Live from "../src/controller/Live.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import * as Rows from "../src/controller/Rows.ts"
import { layerCore } from "../src/controller/Runs.ts"
import { Telemetry } from "../src/controller/Telemetry.ts"
import * as Workflow from "../src/controller/Workflow.ts"
import { taskKey } from "../src/Keys.ts"
import type { PlannedStep, PlanSpec } from "../src/Protocol.ts"
import { config } from "./config.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const unused = () => Effect.die(new Error("not used by these tests"))

const step = {
  exits: [],
  after: [],
  required: [],
  target: true,
  neverReuse: false,
  build: null,
  setup: null,
  task: null,
  action: null,
  output: null,
} satisfies Partial<PlannedStep>

const install: PlannedStep = { ...step, name: "install", kind: "setup", needs: [], target: false, detail: "pnpm install", setup: { deps: "deps", platform: null } }

const task = (name: string): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: ["install"],
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

/**
 * Drives `app-2`, a push run of `install` and the tasks `lint` and `test` that start from it, after
 * `passed` passed with the same keys in `app-1`. Returns the jobs that ran, in order, and the commit
 * statuses Calder reported last for each context.
 */
const drive = (passed: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const plan: PlanSpec = { version: 1, app: null, trust: "trusted", reuse: "all", schedules: [], steps: [install, task("lint"), task("test")] }
    yield* insertRun("app-1", { at: 1 })
    for (const name of passed) {
      yield* sql`insert into results (key, run_id, step, trust, value, outputs, created_at, status)
        values (${taskKey(name, {}, null)}, 'app-1', ${name}, 'trusted', 'null', '{}', 1, 'passed')`
    }
    yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
        started_at, trace_id, span_id, plan)
      values ('app-2', 'app', 2, '{"_tag":"Push","branch":"main"}', 'sha', 'main', 'title', 'hauke', 2, 'trusted', 'running', 2, 2, 't', 's',
        ${JSON.stringify(plan)})`
    for (const [position, s] of plan.steps.entries()) {
      yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
        values ('app-2', ${s.name}, ${s.kind}, 'pending', ${JSON.stringify(s)}, ${position}, 's')`
    }

    const jobs: Array<string> = []
    const statuses = new Map<string, string>()
    const project = { name: "app", repo: "schnau/app", defaultBranch: "main", targets: null, secrets: {} }
    const services = Layer.mergeAll(
      config(),
      Live.layer,
      Layer.succeed(Agents)(makeAgents(null)),
      Layer.succeed(Cache)({ has: () => Effect.succeed(false), publish: unused }),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.make(() => Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "spawn" }))),
      ),
      Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: unused }),
      Layer.succeed(Mirror)({
        path: () => "/mirror",
        fetch: unused,
        hasPipeline: unused,
        commit: unused,
        pipelineDir: () => Effect.succeed("/calder"),
        flake: () => "git+file:///mirror",
      }),
      Layer.succeed(Telemetry)({ exportSpan: () => Effect.void, log: () => Effect.void, span: (_parent, _name, _attributes, effect) => effect, logs: unused, trace: unused }),
      Layer.succeed(Gitea)({
        status: (_repo, _sha, status) => Effect.sync(() => void statuses.set(status.context, `${status.state}: ${status.description}`)),
        requiredChecks: () => Effect.succeed([]),
        head: unused,
        pullTitle: unused,
        comment: unused,
        dispatch: unused,
        repos: unused,
        hasFile: unused,
        pull: unused,
        updatePull: unused,
        mergePull: unused,
        openPulls: unused,
      }),
      Layer.succeed(Jobs)({
        run: (job, options) =>
          Effect.gen(function*() {
            if (job._tag === "Step") jobs.push(job.step)
            yield* options.onStart ?? Effect.void
            return {
              result: { _tag: "Passed", value: job._tag === "Step" && job.step === "install" ? { fresh: true } : null, outputs: {}, key: null },
              usage: { cpuSeconds: null, memoryPeakBytes: null },
              id: `job-${jobs.length}`,
            }
          }),
        adopted: () => [],
        reattach: unused,
        settled: unused,
        authorize: unused,
        get: () => undefined,
        active: () => [],
      }),
    )
    // The workflow drives unfinished runs as it starts.
    const ended = Effect.gen(function*() {
      const run = yield* Rows.loadRun("app-2")
      return run?.status ?? "missing"
    }).pipe(Effect.repeat({ until: (status) => status !== "running", schedule: Schedule.spaced("10 millis") }), Effect.timeout("5 seconds"))
    const status = yield* ended.pipe(Effect.provide(Workflow.layer.pipe(Layer.provideMerge(layerCore), Layer.provide(services))))
    const steps = new Map((yield* Rows.loadSteps("app-2")).map((s) => [s.name, Rows.step(s)]))
    return { status, jobs, statuses, steps }
  }).pipe(Effect.provide(sqlite))

describe("setups", () => {
  it.live("a setup doesn't run when every task that starts from it reuses its result", () =>
    Effect.gen(function*() {
      const { status, jobs, statuses, steps } = yield* drive(["lint", "test"])
      expect(status).toBe("passed")
      expect(jobs).toEqual([])
      expect(steps.get("install")).toMatchObject({ status: "reused", key: "deps", queuedAt: null, startedAt: null })
      expect(statuses.get("calder/install")).toBe("success: not needed: no task that starts from it ran")
    }))

  it.live("a setup runs once a task that starts from it runs, and that task waits for it", () =>
    Effect.gen(function*() {
      const { status, jobs, statuses, steps } = yield* drive(["lint"])
      expect(status).toBe("passed")
      expect(jobs).toEqual(["install", "test"])
      expect([steps.get("install")?.status, steps.get("lint")?.status, steps.get("test")?.status]).toEqual(["passed", "reused", "passed"])
      expect(statuses.get("calder/install")).toMatch(/^success: passed/)
    }))
})
