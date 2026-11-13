// Drives one push run through the real workflow, with stub services around it.
import type { Domain } from "@calder-ci/api"
import { Effect, Fiber, Layer, PlatformError, Schedule, Sink, Stream, type Duration } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { type AgentUsage, Agents, make as makeAgents } from "../src/controller/Agents.ts"
import { Cache } from "../src/controller/Cache.ts"
import { Comments } from "../src/controller/Comments.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Jobs } from "../src/controller/Jobs.ts"
import * as Live from "../src/controller/Live.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { type Project, Projects } from "../src/controller/Projects.ts"
import * as Rows from "../src/controller/Rows.ts"
import { InfrastructureRetries, layerCore, RouseAfterStart, type RunsCore, SpillEvery } from "../src/controller/Runs.ts"
import { Telemetry } from "../src/controller/Telemetry.ts"
import * as Workflow from "../src/controller/Workflow.ts"
import { taskKey } from "../src/Keys.ts"
import { compatibility, type Job, type JobEvent, type JobResult, type PlannedStep, type PlanSpec } from "../src/Protocol.ts"
import { config } from "./config.ts"
import { insertRun, insertStep, layer as sqlite } from "./sqlite.ts"

export const unused = () => Effect.die(new Error("not used by these tests"))

/** The fields every planned step of these tests shares. */
export const step = {
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

export interface Drive {
  readonly steps: ReadonlyArray<PlannedStep>
  /** Steps that passed with the same keys in `app-1`. */
  readonly passed?: ReadonlyArray<string>
  readonly cache?: Cache["Service"]
  /** The value a step's job passes with. */
  readonly value?: (step: string) => unknown
  /** What a step's job does once it started, before it passes, such as report Nix's activities. */
  readonly work?: (step: string, emit: (event: JobEvent) => Effect.Effect<void>) => Effect.Effect<void>
  /** How a step's job ends instead of passing with its `value`. */
  readonly result?: (step: string, job: Extract<Job, { _tag: "Step" }>) => JobResult | undefined
  /** Keeps reading the steps after the run ended until this holds, for work the run doesn't wait for. */
  readonly settled?: (steps: ReadonlyMap<string, Domain.StepRun>) => boolean
  /** The run's event, a push to main by default. */
  readonly event?: Domain.Event
  /** What the run's plan says besides its steps. */
  readonly plan?: Partial<PlanSpec>
  /** `app-2` is queued without its plan, which a plan job of `.calder/` tree `tree` returns. */
  readonly unplanned?: boolean
  /** Fills the database before the workflow starts. */
  readonly seed?: Effect.Effect<void, unknown, SqlClient.SqlClient>
  /** Reads the database once the run's steps settled, returned as `read`. */
  readonly read?: Effect.Effect<unknown, unknown, SqlClient.SqlClient>
  /** Changes `app-2`'s step rows before the workflow starts, such as to resume a step after a restart. */
  readonly resume?: Effect.Effect<void, unknown, SqlClient.SqlClient>
  /** The project's configuration besides its name and repository. */
  readonly project?: Partial<Project>
  /** What `nix-store --query --requisites` answers; any other query of the store finds nothing. */
  readonly requisites?: ReadonlyArray<string>
  /** Runs beside the run, such as a newer run that supersedes it; the run's services stay up until it ends. */
  readonly meanwhile?: Effect.Effect<void, never, RunsCore | Workflow.Runs | SqlClient.SqlClient>
  /** How long Gitea takes to take a commit status, none by default. */
  readonly statusDelay?: (context: string, state: string, description: string) => number | undefined
  /** The controller's placement key, none by default. */
  readonly placementKey?: string
  /** The controller's state directory, one that doesn't exist by default. */
  readonly stateDir?: string
  /** How many plan slots the controller has, one by default. */
  readonly planSlots?: number
  /** Collects the `nix` commands Calder runs, which then succeed; without it they aren't found. */
  readonly nix?: Array<ReadonlyArray<string>>
  /**
   * Evaluation workers this controller adopted from the one before its restart: local jobs of `app-2`'s
   * steps whose `evaluate` lists the steps given, which reattaching ends with `result`.
   */
  readonly adoptedEvaluations?: ReadonlyArray<string>
  /** An evaluator agent (`calder agent --evaluator`) is connected. */
  readonly evaluator?: boolean
  /** The agents that take tasks, read anew whenever the controller looks; none by default. */
  readonly agents?: () => ReadonlyArray<AgentUsage>
  /** RouseAfterStart: none, unless a test asks for the controller's hold. */
  readonly rouseAfterStart?: Duration.Input
  /** What `nix-store --check-validity --print-invalid` finds valid, such as an evaluator agent's derivations; without it, the store answers nothing. */
  readonly valid?: (path: string) => boolean
  /**
   * Makes `app-2` a rerun of `app-1`, whose steps ended like this: `secrets` is the step's secrets
   * digest, `lease` the newest run number whose step held the project's lease.
   */
  readonly rerunOf?: ReadonlyArray<{
    readonly name: string
    readonly status: string
    readonly key?: string
    readonly value?: unknown
    readonly secrets?: string
    readonly lease?: number
  }>
}

/**
 * Drives `app-2`, a push run of `steps`. Returns how it ended, the jobs that ran, in order, the commit
 * statuses Calder reported last for each context, and the steps.
 */
export const drive = ({
  steps: planned,
  passed = [],
  cache = { has: () => Effect.succeed(false), publish: unused },
  value = () => null,
  work = () => Effect.void,
  result = () => undefined,
  settled = () => true,
  event = { _tag: "Push", branch: "main" },
  plan: extra = {},
  unplanned = false,
  seed = Effect.void,
  read = Effect.void,
  resume = Effect.void,
  project: configured = {},
  meanwhile = Effect.void,
  requisites,
  rerunOf,
  placementKey,
  stateDir,
  planSlots,
  nix,
  statusDelay = () => undefined,
  evaluator = false,
  agents: taskAgents = () => [],
  rouseAfterStart = "0 millis",
  adoptedEvaluations = [],
  valid,
}: Drive) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const trust = event._tag === "PullRequest" ? "pr" : "trusted"
    const pr = event._tag === "PullRequest" ? event.number : null
    const plan: PlanSpec = { version: 1, app: null, trust, reuse: "all", schedules: [], steps: [...planned], ...extra }
    yield* seed
    yield* insertRun("app-1", { at: 1 })
    for (const name of passed) {
      yield* sql`insert into results (key, run_id, step, trust, value, outputs, created_at, status)
        values (${taskKey(name, {}, null)}, 'app-1', ${name}, 'trusted', 'null', '{}', 1, 'passed')`
    }
    for (const s of rerunOf ?? []) {
      yield* insertStep("app-1", s.name, { status: s.status, ...(s.key === undefined ? {} : { key: s.key }) })
      yield* sql`update steps set value = ${JSON.stringify(s.value ?? null)}, secrets_digest = ${s.secrets ?? null}
        where run_id = 'app-1' and name = ${s.name}`
      if (s.lease !== undefined) yield* sql`insert into lease_steps (project, step, run) values ('app', ${s.name}, ${s.lease})`
    }
    const fork = event._tag === "PullRequest" && event.fork ? 1 : 0
    yield* sql`insert into runs (id, project, number, event, sha, branch, pr, commit_title, author, commit_time, trust, status, created_at,
        started_at, trace_id, span_id, plan, rerun_of, fork)
      values ('app-2', 'app', 2, ${JSON.stringify(event)}, 'sha', 'main', ${pr}, 'title', 'hauke', 2, ${trust}, ${unplanned ? "queued" : "running"},
        2, 2, 't', 's', ${unplanned ? null : JSON.stringify(plan)}, ${rerunOf === undefined ? null : "app-1"}, ${fork})`
    for (const [position, s] of unplanned ? [] : plan.steps.entries()) {
      yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
        values ('app-2', ${s.name}, ${s.kind}, 'pending', ${JSON.stringify(s)}, ${position}, 's')`
    }
    yield* resume

    const jobs: Array<string> = []
    /** Every command Calder ran, with its arguments. */
    const commands: Array<ReadonlyArray<string>> = []
    /** The plan job the controller ran, with the earlier plan it handed the worker. */
    let planJob: Extract<Job, { _tag: "Plan" }> | undefined
    const adopted = adoptedEvaluations.length === 0 ? [] : [{
      id: "adopted",
      startedAt: 1,
      pool: trust === "trusted" ? "trusted" as const : fork === 1 ? "fork" as const : "pr" as const,
      spec: {
        _tag: "Step",
        run: { id: "app-2", project: "app", trust },
        step: adoptedEvaluations[0]!,
        evaluate: { builds: adoptedEvaluations.map((name) => ({ name, attr: name })), planned: [] },
      } as unknown as Extract<Job, { _tag: "Step" }>,
    }]
    /** The pool each step's job ran in, and the plan's as `plan`. */
    const pools = new Map<string, string>()
    /** The jobs that ran in the larger pull-request unit. */
    const large: Array<string> = []
    /** The jobs that went to an evaluator agent (Jobs `evaluation`). */
    const evaluations: Array<string> = []
    /** Where each step's last job went: to an agent, and which other systems' agents could take it. */
    const placements = new Map<string, { readonly remote: boolean; readonly offload: boolean; readonly systems: ReadonlyArray<string> }>()
    const statuses = new Map<string, string>()
    /** The platforms whose sleeping agents' hosts the controller woke (Agents `rouse`). */
    const roused: Array<string> = []
    /** Every commit status Calder reported, in order, as `context: state: description`. */
    const history: Array<string> = []
    const project: Project = { name: "app", repo: "schnau/app", defaultBranch: "main", targets: null, secrets: {}, ...configured }
    const services = Layer.mergeAll(
      config({
        ...(placementKey === undefined ? {} : { placementKey }),
        ...(stateDir === undefined ? {} : { stateDir }),
        ...(planSlots === undefined ? {} : { jobs: { mode: "process", slots: { plans: planSlots, builds: 1, tasks: 1, actions: 1 } } }),
      }),
      Layer.succeed(InfrastructureRetries)(["5 millis", "5 millis"]),
      Layer.succeed(SpillEvery)("10 millis"),
      Layer.succeed(RouseAfterStart)(rouseAfterStart),
      Live.layer,
      Layer.succeed(Agents)({
        ...makeAgents(null),
        usage: () => [
          ...(evaluator
            ? [{ name: "dev-hauke", platform: "x86_64-linux", slots: 2, running: 0, connected: true, build: "b", compatibility, current: true, evaluator: true, portableOnly: false, pools: ["trusted" as const], free: 2 }]
            : []),
          ...taskAgents(),
        ],
        rouse: (platform) => Effect.sync(() => void roused.push(platform)),
      }),
      Layer.succeed(Cache)(cache),
      Layer.succeed(Comments)({ note: unused, touch: () => Effect.void }),
      // Only the store answers, holding nothing, so a build's output exists only where `cache` has it.
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) commands.push([command.command, ...command.args])
          const answers = ChildProcess.isStandardCommand(command) && requisites !== undefined && command.args[1] === "--requisites"
          const checks = ChildProcess.isStandardCommand(command) && valid !== undefined && command.args[0] === "--check-validity" && command.args[1] === "--print-invalid"
          if (checks) {
            const invalid = (command as ChildProcess.StandardCommand).args.filter((a) => a.startsWith("/nix/store/") && !valid!(a))
            return Effect.succeed(ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(invalid.join("\n"))),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }))
          }
          const collected = ChildProcess.isStandardCommand(command) && command.command === "nix" && nix !== undefined
          if (collected) nix.push(command.args)
          return ChildProcess.isStandardCommand(command) && (command.command === "nix-store" || collected)
            ? Effect.succeed(ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answers || collected ? 0 : 1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: answers ? Stream.make(new TextEncoder().encode(requisites!.join("\n"))) : Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }))
            : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "spawn" }))
        }),
      ),
      Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: unused }),
      Layer.succeed(Mirror)({
        path: () => "/mirror",
        fetch: () => Effect.void,
        hasPipeline: unused,
        pipelineTree: () => Effect.succeed("tree"),
        commit: unused,
        between: unused,
        contains: unused,
        pipelineDir: () => Effect.succeed("/calder"),
        flake: () => "git+file:///mirror",
        byUrl: () => ({ "ssh://git@gitea.test/schnau/lib.git": "/state/mirrors/lib.git" }),
        train: unused,
        trainOf: unused,
        push: unused,
      }),
      Layer.succeed(Telemetry)({ exportSpan: () => Effect.void, log: () => Effect.void, gauge: () => Effect.void, span: (_parent, _name, _attributes, effect) => effect, logs: unused, trace: unused }),
      Layer.succeed(Gitea)({
        status: (_repo, _sha, status) => {
          const record = Effect.sync(() => {
            statuses.set(status.context, `${status.state}: ${status.description}`)
            history.push(`${status.context}: ${status.state}: ${status.description}`)
          })
          const delay = statusDelay(status.context, status.state, status.description)
          return delay === undefined ? record : Effect.sleep(delay).pipe(Effect.andThen(record))
        },
        requiredChecks: () => Effect.succeed([]),
        head: unused,
        pullTitle: unused,
        comment: unused,
        dispatch: unused,
        repos: unused,
        hasFile: unused,
        pull: unused,
        updatePull: unused, mergedPull: unused,
        mergePull: unused,
        openPulls: unused,
      }),
      Layer.succeed(Jobs)({
        run: (job, options) =>
          Effect.gen(function*() {
            if (job._tag === "Plan") {
              jobs.push(job.rules === true ? "rules" : "plan")
              pools.set(job.rules === true ? "rules" : "plan", options.pool)
              if (job.rules !== true) planJob = job
              return { result: { _tag: "Planned", plan }, usage: { cpuSeconds: null, memoryPeakBytes: null }, id: "job-plan" }
            }
            if (job._tag === "Step") jobs.push(job.evaluate === undefined ? job.step : `${job.step} evaluates`)
            if (job._tag === "Step") pools.set(job.step, options.pool)
            if (job._tag === "Step" && job.evaluate === undefined) {
              placements.set(job.step, { remote: options.agent === true, offload: options.offload === true, systems: options.systems ?? [] })
            }
            if (options.large === true) large.push(jobs.at(-1) ?? "plan")
            if (options.evaluation === true) evaluations.push(jobs.at(-1) ?? "plan")
            yield* options.onStart ?? Effect.void
            if (job._tag === "Step") yield* work(job.step, options.onEvent)
            return {
              result: (job._tag === "Step" ? result(job.step, job) : undefined) ??
                { _tag: "Passed", value: job._tag === "Step" ? value(job.step) : null, outputs: {}, key: null },
              usage: { cpuSeconds: null, memoryPeakBytes: null },
              id: `job-${jobs.length}`,
            }
          }),
        adopted: () => adopted,
        reattach: (id) =>
          Effect.gen(function*() {
            const job = adopted.find((a) => a.id === id)!
            adopted.splice(adopted.indexOf(job), 1)
            jobs.push(`${job.spec.step} evaluates (adopted)`)
            return { result: result(job.spec.step, job.spec) ?? { _tag: "Died", message: "no result" }, usage: { cpuSeconds: null, memoryPeakBytes: null }, id }
          }),
        settled: () => Effect.never,
        authorize: unused,
        get: () => undefined,
        active: () => [],
      }),
    )
    // The workflow drives unfinished runs as it starts.
    const ended = Effect.gen(function*() {
      const run = yield* Rows.loadRun("app-2")
      return run?.status ?? "missing"
    }).pipe(
      Effect.repeat({ until: (status) => !["queued", "planning", "running"].includes(status), schedule: Schedule.spaced("10 millis") }),
      Effect.timeout("5 seconds"),
    )
    const status = yield* Effect.gen(function*() {
      const beside = yield* Effect.forkChild(meanwhile)
      yield* ended
      yield* Fiber.join(beside)
      // What runs beside may run the run again, such as a rerun once it ended.
      return yield* ended
    }).pipe(Effect.provide(Workflow.layer.pipe(Layer.provideMerge(layerCore), Layer.provide(services))))
    const load = Effect.map(Rows.loadSteps("app-2"), (rows) => new Map(rows.map((s) => [s.name, Rows.step(s)])))
    const steps = yield* load.pipe(Effect.repeat({ until: settled, schedule: Schedule.spaced("10 millis") }), Effect.timeout("5 seconds"))
    const stored = JSON.parse((yield* Rows.loadRun("app-2"))?.plan ?? "null") as PlanSpec
    const records = yield* sql<{ attr: string; trust: string }>`select attr, trust from evaluations order by id`
    const trusted = yield* Rows.records({ project: "app", trust: "trusted", fork: 0 })
    return { status, jobs, statuses, history, steps, pools, large, evaluations, placements, roused, records, trusted, commands, plan: stored, planJob, read: yield* read }
  }).pipe(Effect.provide(sqlite))
