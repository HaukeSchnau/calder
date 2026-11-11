import type { Domain } from "@calder-ci/api"
import { Event, On } from "@calder-ci/core"
import { Context, Deferred, Duration, Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { placementToken, secretsDigest, sha256, taskKey } from "../Keys.ts"
import * as Values from "../Values.ts"
import type { Job, JobEvent, JobResult, Mismatch, Outcome, PlannedStep, PlanSpec, RunInfo } from "../Protocol.ts"
import { Agents } from "./Agents.ts"
import { Cache } from "./Cache.ts"
import { Comments } from "./Comments.ts"
import { Config } from "./Config.ts"
import * as Each from "./Each.ts"
import * as Estimates from "./Estimates.ts"
import * as InFlight from "./InFlight.ts"
import { Gitea, type StatusState } from "./Gitea.ts"
import { type Pool, Jobs, type Usage } from "./Jobs.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import * as Outputs from "./Outputs.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"
import * as Slots from "./Slots.ts"
import * as Telemetry from "./Telemetry.ts"
import * as Tests from "./Tests.ts"
import { leaseOf } from "./WorkerServer.ts"

const activeStatuses = ["queued", "planning", "running"] as const

/**
 * How long a build that failed for an infrastructure reason (`Infrastructure`, such as a remote builder
 * whose SSH connection dropped) waits before each further attempt; it runs once more than this has
 * entries. Tests shorten them.
 */
export const InfrastructureRetries = Context.Reference<ReadonlyArray<Duration.Input>>("calder/controller/InfrastructureRetries", {
  defaultValue: () => ["30 seconds", "2 minutes"],
})
/** How often a superseded run's running build asks whether a run that goes on needs it. */
const neededEvery = "30 seconds"

/**
 * Whether a superseded run's running build of `drv` is of no use to the runs that go on (Rows `liveBuilds`):
 * none of them builds `drv`, and none depends on a derivation the build is building right now (`building`).
 * `closure` holds what the runs that go on build and depend on, or null where it couldn't be read. Stopping
 * a build makes the Nix daemon stop what it builds for it, so a dependency both closures share, such as a
 * test suite hours into its run, would start over in the newer run's build. A run of the project that may
 * still add builds keeps every build, and so does a closure that couldn't be read.
 */
export const obsolete = (
  drv: string,
  live: { readonly unknown: boolean; readonly drvs: ReadonlyArray<string> },
  building: ReadonlyArray<string>,
  closure: ReadonlySet<string> | null,
) => !live.unknown && !live.drvs.includes(drv) && (building.length === 0 || (closure !== null && !building.some((d) => closure.has(d))))

const short = (sha: string) => sha.slice(0, 12)

const duration = (ms: number) => Duration.format(Duration.millis(Math.round(ms / 1000) * 1000))

/** The remote builders of Nix's machines file (`/etc/nix/machines`): each one's address and systems. */
export const buildersOf = (machines: string) =>
  machines.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("@"))
    .map((line) => {
      const [uri = "", systems = ""] = line.split(/\s+/)
      return { uri, systems: systems.split(",") }
    })

/**
 * What the run workflow's activities do: plan a revision, execute one step, finish the run. Each reads
 * and writes the journal, so a resumed workflow sees what already happened.
 */
export class RunsCore extends Context.Service<RunsCore, {
  readonly plan: (runId: string) => Effect.Effect<PlanSpec | null>
  /** Audits a project's footprint records against a fresh evaluation of its default branch's head. */
  readonly audit: (project: string) => Effect.Effect<ReadonlyArray<Mismatch>>
  readonly step: (runId: string, name: string) => Effect.Effect<Domain.StepStatus>
  /** A build whose output already exists settles at once, without waiting for the builds it uses. */
  readonly built: (runId: string, name: string) => Effect.Effect<boolean>
  readonly finish: (runId: string) => Effect.Effect<void>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
  /**
   * Cancels a run a newer one replaces: its waiting work never starts, but jobs already running finish
   * and keep their results, which the newer run reuses or waits for.
   */
  readonly supersede: (runId: string, reason: string) => Effect.Effect<void>
  /**
   * Puts steps of a planned run back to pending so the run runs them again, in place: `only`, or every
   * failed or died step with what ended without success downstream of it (`retryable`). Reopens a run
   * that ended. Returns the steps it reset; its driver has to run them (Workflow.ts).
   */
  readonly retry: (
    runId: string,
    reason: string,
    options?: {
      readonly only?: ReadonlyArray<string>
      /** Neither counts as a retry of the run nor tells Gitea and the step's log, such as for a step the driver runs again itself. */
      readonly quiet?: boolean
    },
  ) => Effect.Effect<ReadonlyArray<string>>
  /** Blocked steps none of whose dependencies failed, died or is blocked any more, such as after a retry passed. */
  readonly unblocked: (runId: string) => Effect.Effect<ReadonlyArray<string>>
}>()("calder/controller/RunsCore") {}

/** What a step waits for before it runs: its dependencies, the steps it reads and those it runs after. */
const upstream = (s: PlannedStep) => [...s.needs, ...s.after, ...s.exits]

/**
 * The steps a rerun runs again in place: every failed or died step, and every step downstream of one that
 * ended without passing, such as one it blocked. Steps that passed or were reused keep their result, and
 * steps that haven't ended wait for what runs again.
 */
export const retryable = (steps: ReadonlyArray<{ readonly name: string; readonly status: Domain.StepStatus; readonly spec: PlannedStep }>) => {
  const below = new Map<string, Array<string>>()
  for (const s of steps) for (const d of upstream(s.spec)) below.set(d, [...(below.get(d) ?? []), s.name])
  const status = new Map(steps.map((s) => [s.name, s.status]))
  const seeds = steps.filter((s) => s.status === "failed" || s.status === "died").map((s) => s.name)
  const picked = new Set(seeds)
  const seen = new Set(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    for (const next of below.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
      const s = status.get(next)
      if (s !== undefined && Rows.terminal(s) && !Rows.succeeded(s)) picked.add(next)
    }
  }
  return steps.map((s) => s.name).filter((n) => picked.has(n))
}

/** Terminal colours and titles some tools write even without a terminal; the UI styles lines itself. */
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")

/** Why a publish failed, in one line: Nix's last `error:` line, or the error itself. */
const publishFailure = (error: Exec.ExecError): string => {
  if (error._tag !== "CommandFailed") return error.message
  const lines = plain(error.stderr).split("\n").map((line) => line.trim()).filter((line) => line !== "")
  return lines.findLast((line) => line.startsWith("error:")) ?? lines.at(-1) ?? `exit code ${error.exitCode}`
}

export const layerCore = Layer.effect(RunsCore)(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* Jobs
  const agents = yield* Agents
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const telemetry = yield* Telemetry.Telemetry
  const projects = yield* Projects
  const spawner = yield* Exec.SpawnerTag
  const cache = yield* Cache
  const comments = yield* Comments
  const estimates = yield* Estimates.Estimates
  const infrastructureRetries = yield* InfrastructureRetries
  // Steps a deploy or a preview waits for take one slot of each pool beyond its capacity, so they never
  // queue behind long checks: in studienbuch-20 a deploy waited 264 s for a task slot.
  const lane = 1
  const slots = {
    // One plan per project at a time: two of infra's plans side by side, a pull request's and a push's,
    // held 8.7 GB of the 8 GiB jobs slice and both ran past 30 minutes. A long plan also leaves the other
    // slots to other projects: three of infra's pull requests once held every plan slot for an hour while
    // every other project's runs stayed in planning.
    plans: Slots.make({ capacity: config.jobs.slots.plans, maxPerProject: 1 }),
    builds: Slots.make({ capacity: config.jobs.slots.builds, lane }),
    // Each other system's builds wait for its remote builders apart, so one that is unavailable stalls only its own.
    remoteBuilds: new Map<string, Slots.Slots>(),
    // One project's shards may not take every task slot, so other projects can always start.
    tasks: Slots.make({ capacity: config.jobs.slots.tasks, perProject: Math.max(1, config.jobs.slots.tasks - 1), lane }),
    actions: Slots.make({ capacity: config.jobs.slots.actions, lane }),
    // Agents limit themselves; this only orders their jobs.
    agents: Slots.make({ capacity: 64 }),
  }
  const cancels = new Map<string, Deferred.Deferred<string>>()
  const signal = (map: Map<string, Deferred.Deferred<string>>) => (runId: string) => {
    let d = map.get(runId)
    if (d === undefined) {
      d = Deferred.makeUnsafe<string>()
      map.set(runId, d)
    }
    return d
  }
  const cancelSignal = signal(cancels)
  const supersedes = new Map<string, Deferred.Deferred<string>>()
  const supersedeSignal = signal(supersedes)
  /** One latch per run and step, dropped when the run finishes. */
  const latches = () => {
    const runs = new Map<string, Map<string, Deferred.Deferred<void>>>()
    return {
      get: (runId: string, name: string) => {
        const steps = runs.get(runId) ?? new Map<string, Deferred.Deferred<void>>()
        runs.set(runId, steps)
        let latch = steps.get(name)
        if (latch === undefined) {
          latch = Deferred.makeUnsafe<void>()
          steps.set(name, latch)
        }
        return latch
      },
      drop: (runId: string) => runs.delete(runId),
      /** The latch if one exists, without making one. */
      peek: (runId: string, name: string) => runs.get(runId)?.get(name),
      /** A step that runs again opens its latch anew. */
      reset: (runId: string, name: string) => void runs.get(runId)?.delete(name),
    }
  }
  /** Opens when `step` of the step returned. */
  const stepped = latches()
  /** The latch of each step whose `step` runs right now, by run and step. */
  const attempts = new Map<string, Deferred.Deferred<void>>()
  /** Opens when a task that starts from the setup runs. */
  const wanted = latches()

  /** Each builder host of another system gets as many build slots as this host. */
  const builders = buildersOf(existsSync("/etc/nix/machines") ? readFileSync("/etc/nix/machines", "utf8") : "")
  const buildSlots = (system: string | null) => {
    if (system === null || system === config.system) return slots.builds
    const hosts = Math.max(1, builders.filter((b) => b.systems.includes(system)).length)
    const pool = slots.remoteBuilds.get(system) ?? Slots.make({ capacity: config.jobs.slots.builds * hosts, lane })
    slots.remoteBuilds.set(system, pool)
    return pool
  }

  const { flying, landing, has: inFlight } = InFlight.make()
  const workspaces = new Map<string, Set<number>>()
  // Workers adopted after a restart keep their slot and workspace until they finish, so no new job
  // lands in a workspace that is still in use.
  for (const adopted of jobs.adopted()) {
    const { spec } = adopted
    const pool: Pool = spec.run.trust === "pr" ? "pr" : "trusted"
    const index = spec.workspace === null ? null : Number(/slot-(\d+)$/.exec(spec.workspace)?.[1] ?? Number.NaN)
    const key = `local/${pool}/${spec.run.project}`
    if (index !== null && !Number.isNaN(index)) {
      workspaces.set(key, (workspaces.get(key) ?? new Set<number>()).add(index))
    }
    // Taken before any run is driven again, or the run would claim the same slots for new jobs. A build's
    // job holds a build slot, also before its derivation is known, and evaluating builds a plan slot.
    const row = yield* Rows.loadStep(spec.run.id, spec.step).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    const build = row === undefined ? null : Rows.spec(row).build
    const held = spec.evaluate !== undefined ? slots.plans : build === null ? slots.tasks : buildSlots(build.system)
    const release = held.reserve(spec.run.project)
    yield* jobs.settled(adopted.id).pipe(
      Effect.ensuring(release),
      Effect.ensuring(Effect.sync(() => index !== null && workspaces.get(key)?.delete(index))),
      Effect.forkScoped,
    )
  }
  /** An agent's worker gets the path relative to its agent's workspace directory. */
  const workspace = (pool: Pool, project: string, remote: boolean) => {
    const key = `${remote ? "agent" : "local"}/${pool}/${project}`
    return Effect.acquireRelease(
      Effect.sync(() => {
        const used = workspaces.get(key) ?? new Set<number>()
        workspaces.set(key, used)
        let i = 0
        while (used.has(i)) i++
        used.add(i)
        const relative = join(pool, project, `slot-${i}`)
        return { index: i, path: remote ? relative : join(config.stateDir, "workspaces", relative) }
      }),
      (slot) => Effect.sync(() => workspaces.get(key)?.delete(slot.index)),
    )
  }

  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  // Runs that ended while the controller was down keep no roots for their derivations.
  const active = yield* db(sql<{ id: string }>`select id from runs where ${sql.in("status", activeStatuses)}`)
  yield* Outputs.sweepDerivations(config.stateDir, new Set(active.map((r) => r.id))).pipe(
    Effect.catch((e) => Effect.logWarning("could not drop the derivation roots of ended runs", e)),
  )

  /** Records what a step waits for, or that it no longer waits (null). */
  const waiting = (runId: string, name: string, reason: string | null) =>
    db(sql`update steps set waiting = ${reason} where run_id = ${runId} and name = ${name}`).pipe(
      Effect.andThen(publishStep(runId, name)),
    )

  const repoOf = (project: string) => projects.get(project)!.repo
  const link = (runId: string) => `${config.publicUrl.replace(/\/$/, "")}/#/run/${runId}`
  const poolOf = (run: Rows.RunRow): Pool => (run.trust === "pr" ? "pr" : "trusted")
  const largeEvaluations = (run: Rows.RunRow) => projects.get(run.project)?.largeEvaluations === true

  const publishRun = (runId: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadRun(runId))
      if (row === undefined) return
      const [run] = yield* db(Rows.runsWithCounts([row]))
      yield* live.publish({ _tag: "RunChanged", run: run! })
    })
  const publishStep = (runId: string, name: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadStep(runId, name))
      const run = yield* db(Rows.loadRun(runId))
      if (row === undefined || run === undefined) return
      yield* estimates.stepSettled(run.project, row)
      const estimate = (yield* estimates.steps(run.project)).get(name) ?? null
      const failingTests = row.status === "failed" ? yield* db(Rows.failingTests(runId, name)) : []
      yield* live.publish({ _tag: "StepChanged", step: Rows.step(row, estimate), failingTests })
      yield* comments.touch(runId)
    })

  const status = (run: Rows.RunRow, context: string, state: StatusState, description: string) =>
    gitea.status(repoOf(run.project), run.sha, { context, state, description, targetUrl: link(run.id) })

  const runInfo = (run: Rows.RunRow, pipelineDir: string): RunInfo => ({
    id: run.id,
    project: run.project,
    number: run.number,
    revision: run.sha,
    branch: run.branch,
    trust: run.trust,
    event: JSON.parse(run.event) as Domain.Event,
    flake: mirror.flake(run.project, run.sha),
    mirror: mirror.path(run.project),
    mirrors: mirror.byUrl(),
    pipelineDir,
    system: config.system,
  })

  const logTo = (run: Rows.RunRow, step: string, spanId: string, shard: number | null) => (event: JobEvent) =>
    Effect.gen(function*() {
      if (event._tag !== "Log") return
      const text = plain(event.text)
      const level: Domain.LogLine["level"] = event.stream === "calder" ? "info" : event.stream === "stderr" && /\berror\b/i.test(text) ? "error" : "info"
      live.append(run.id, { step, shard, stream: event.stream, level, timestamp: event.timestamp, text })
      yield* telemetry.log({
        parent: { traceId: run.trace_id, spanId },
        timestamp: event.timestamp,
        text,
        level,
        attributes: {
          "calder.project": run.project,
          "calder.run": run.id,
          "calder.step": step,
          "calder.stream": event.stream,
          ...(shard === null ? {} : { "calder.shard": String(shard) }),
        },
      })
    })

  // ------------------------------------------------------------------------------------------- plan

  /**
   * How long a plan may take before it ends the run. Infra's six hosts plan in about three minutes on the
   * tower and ten on srv-2; a plan stuck far past that would otherwise hold its project's slot for the
   * worker's four hours.
   */
  const planTimeout = Duration.minutes(30)
  const timedOut: JobResult = { _tag: "Died", message: `planning took longer than ${Duration.toMinutes(planTimeout)} minutes, so it was stopped` }

  /** Ends a run that could not be planned, unless a cancel came in first. */
  const unplanned = (run: Rows.RunRow, message: string) =>
    Effect.gen(function*() {
      const ended = yield* db(sql`update runs set status = 'errored', error = ${message}, finished_at = ${Date.now()}
        where id = ${run.id} and status in ('queued', 'planning') returning id`)
      if (ended.length === 0) return null
      yield* status(run, "calder", "error", message.split("\n")[0]!)
      yield* telemetry.exportSpan({
        traceId: run.trace_id,
        spanId: run.span_id,
        parentId: null,
        name: `${run.project} #${run.number}`,
        start: run.created_at,
        end: Date.now(),
        error: true,
        attributes: { "calder.project": run.project, "calder.run": run.id, "calder.error": message },
      })
      yield* publishRun(run.id)
      return null
    })

  /**
   * A push to a branch no rule names, for example: nothing to run, keep or report on the commit. Whoever
   * follows the run, such as `calder trigger`, still sees it end and why.
   */
  const matchesNoRule = (run: Rows.RunRow, event: Domain.Event) =>
    Effect.gen(function*() {
      const reason = `no rule of ${run.project} runs anything for ${Event.describe(event)}`
      yield* db(sql`update runs set status = 'cancelled', error = ${reason}, finished_at = ${Date.now()} where id = ${run.id}`)
      yield* publishRun(run.id)
      yield* db(sql`delete from runs where id = ${run.id}`)
      yield* Effect.logInfo(`${run.id} matches no rule, dropped`)
      return null
    })

  const plan = (runId: string) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      if (run === undefined || run.status === "cancelled") return null
      if (run.plan !== null) return JSON.parse(run.plan) as PlanSpec
      const now = Date.now()
      yield* db(sql`update runs set status = 'planning', started_at = ${now} where id = ${runId}`)
      yield* publishRun(runId)

      const pipelineDir = yield* mirror.fetch(run.project).pipe(
        Effect.andThen(mirror.pipelineDir(run.project, run.sha)),
        Effect.map((dir) => ({ dir, error: null })),
        Effect.catch((e) => Effect.succeed({ dir: null, error: e._tag === "NoPipeline" ? "no .calder/ci.ts at this revision" : e.message })),
      )
      if (pipelineDir.dir === null) return yield* unplanned(run, pipelineDir.error ?? "could not read the revision")

      const event = JSON.parse(run.event) as Domain.Event
      // A plan of the same pipeline already said which branches its push rules name. A push to another
      // branch, such as one with a pull request open, which has its own run, gets no plan job.
      const tree = yield* mirror.pipelineTree(run.project, run.sha)
      if (event._tag === "Push" && event.branch !== projects.get(run.project)?.defaultBranch && tree !== null) {
        const known = yield* db(sql<{ branches: string }>`select branches from pipeline_pushes where project = ${run.project} and tree = ${tree}`)
        const pushes = known[0] === undefined ? undefined : JSON.parse(known[0].branches) as ReadonlyArray<string>
        if (pushes !== undefined && !pushes.some((pattern) => On.matchesBranch(pattern, event.branch))) return yield* matchesNoRule(run, event)
      }

      const required = run.trust === "trusted" && run.branch !== null ? yield* gitea.requiredChecks(repoOf(run.project), run.branch) : []
      const job: Job = { _tag: "Plan", run: runInfo(run, pipelineDir.dir), requiredChecks: required, earlier: yield* db(Rows.earlierPlan(run, projects.get(run.project)?.defaultBranch)) }
      const claim: Slots.Claim = {
        project: run.project,
        expected: 0,
        run: run.created_at,
        // A push to the default branch goes before every plan that isn't one, so it waits for at most the
        // plan that runs, which the timeout bounds.
        critical: event._tag === "Push" && event.branch === projects.get(run.project)?.defaultBranch,
        label: `${run.id}'s plan`,
      }
      const log = logTo(run, "plan", run.span_id, null)
      const waits = slots.plans.waitsFor(claim)
      if (waits !== null) yield* log({ _tag: "Log", stream: "calder", text: `waiting for a plan slot (${waits})`, timestamp: Date.now() })
      const planned = yield* Effect.raceFirst(
        // Records are read once the plan has its slot, so it sees what the plan ahead of it recorded.
        slots.plans.with(
          claim,
          Effect.flatMap(db(Rows.records(run)), (records) =>
            jobs.run({ ...job, ...(records === undefined ? {} : { records }) }, { pool: poolOf(run), onEvent: log, large: largeEvaluations(run) }).pipe(
              Effect.timeoutOption(planTimeout),
            )),
        ).pipe(
          Effect.map((done) => Option.some(Option.getOrElse(done, () => ({ result: timedOut })))),
        ),
        Effect.raceFirst(Deferred.await(cancelSignal(runId)), Deferred.await(supersedeSignal(runId))).pipe(Effect.as(Option.none())),
      )
      live.finish(runId, "plan")
      if (Option.isNone(planned)) return null
      const { result } = planned.value
      if (result._tag !== "Planned") {
        return yield* unplanned(run, result._tag === "PlanFailed" ? result.message : result._tag === "Died" ? result.message : "planning failed")
      }

      // Footprints go to their own tables, not into the stored plan.
      const { recorded, mismatches: _, ...planned_ } = result.plan
      if (recorded !== undefined) yield* db(Rows.keepRecords(run, projects.get(run.project)?.defaultBranch, recorded))
      for (const [attr, evaluation] of Object.entries(result.plan.fromRecords ?? {})) {
        yield* db(sql`insert into run_records (run_id, attr, evaluation) values (${run.id}, ${attr}, ${evaluation}) on conflict do nothing`)
      }
      const spec = { ...planned_, steps: Rows.criticalPath(result.plan.steps, run.fork === 1) }
      // A pull request's plan job runs the pull request's code, so only a trusted plan's answer is kept.
      if (tree !== null && run.trust === "trusted" && spec.pushes !== undefined) {
        yield* db(sql`insert into pipeline_pushes (project, tree, branches) values (${run.project}, ${tree}, ${JSON.stringify(spec.pushes)})
          on conflict do update set branches = excluded.branches`)
      }
      // The default branch's plan says which schedules exist, even when its push runs nothing.
      if (event._tag === "Push" && event.branch === projects.get(run.project)?.defaultBranch) {
        yield* db(sql.withTransaction(Effect.gen(function*() {
          yield* sql`delete from schedules where project = ${run.project}`
          for (const cron of spec.schedules) yield* sql`insert into schedules (project, cron) values (${run.project}, ${cron})`
        })))
      }
      if (spec.steps.length === 0) return yield* matchesNoRule(run, event)
      // A cancel that came in while the plan job ran wins.
      const stored = yield* db(sql.withTransaction(Effect.gen(function*() {
        const updated = yield* sql`update runs set plan = ${JSON.stringify(spec)}, status = 'running', planned_at = ${Date.now()}
          where id = ${runId} and status = 'planning' returning id`
        if (updated.length === 0) return false
        for (const [position, step] of spec.steps.entries()) {
          yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
            values (${runId}, ${step.name}, ${step.kind}, 'pending', ${JSON.stringify(step)}, ${position}, ${Telemetry.spanId()})
            on conflict do nothing`
        }
        return true
      })))
      if (!stored) return null
      yield* rootDerivations(run, [
        ...spec.steps.flatMap((s) => (s.build?.drv == null ? [] : [s.build.drv])),
        ...Object.values(spec.derivations ?? {}).flatMap((d) => (d === null ? [] : [d.drv])),
      ])
      yield* status(run, "calder", "pending", `${spec.steps.filter((s) => s.kind !== "output").length} steps`)
      yield* Effect.forEach(spec.steps.filter((s) => s.kind !== "output"), (s) => status(run, `calder/${s.name}`, "pending", "waiting"), {
        concurrency: 4,
        discard: true,
      })
      yield* publishRun(runId)
      return spec
    }).pipe(
      // Gitea failing past its retries, for example: the run still ends, and the merge queue stops waiting for it.
      Effect.catchDefect((defect) =>
        Effect.gen(function*() {
          yield* Effect.logError(`planning ${runId} failed`, defect)
          const run = yield* db(Rows.loadRun(runId))
          if (run === undefined) return null
          return yield* unplanned(run, `Calder could not plan the run: ${defect instanceof Error ? defect.message : String(defect)}`)
        })
      ),
      Effect.catchCause((cause) => Effect.logError("plan failed", cause).pipe(Effect.as(null))),
    )

  // ------------------------------------------------------------------------------------------- step

  const outcomeOf = (row: Rows.StepRow): Outcome => {
    switch (row.status) {
      case "passed":
      case "reused":
        return { _tag: "Passed", value: row.value === null ? null : JSON.parse(row.value) }
      case "failed":
        return { _tag: "Failed", error: row.error_json === null ? null : JSON.parse(row.error_json) }
      case "died":
        return { _tag: "Died", message: row.error_message ?? "" }
      default:
        return { _tag: "Blocked" }
    }
  }

  interface Settled {
    readonly status: Domain.StepStatus
    readonly value?: unknown
    readonly outputs?: Record<string, string>
    readonly key?: string | null
    readonly reusedFrom?: string | null
    readonly error?: { readonly tag: string; readonly message: string; readonly json: unknown } | null
    readonly usage?: Usage
    readonly tests?: ReadonlyArray<Extract<JobEvent, { _tag: "Tests" }>["results"][number]>
    readonly attempts?: number
    readonly files?: { readonly total: number; readonly ran: number; readonly flaky: number }
    /** A setup no task asked for. */
    readonly unneeded?: boolean
  }

  const describe = (s: Settled, row: Rows.StepRow): [StatusState, string] => {
    const took = row.started_at === null ? "" : ` in ${duration(Date.now() - row.started_at)}`
    switch (s.status) {
      case "passed":
        return ["success", `passed${took}`]
      case "reused":
        return [
          "success",
          row.kind === "build" ? "already built"
          : s.files?.total === 0 ? "no files to check"
          : row.kind !== "setup" ? "reused an identical result"
          : s.unneeded === true ? "not needed: no task that starts from it ran"
          : "already set up",
        ]
      case "failed":
        return ["failure", s.error?.message.split("\n")[0] ?? "failed"]
      case "died":
        return ["error", s.error?.message.split("\n")[0] ?? "died"]
      case "blocked":
        return ["failure", "blocked by a failed step"]
      case "skipped":
        return ["warning", `skipped: ${s.error?.message.split("\n")[0] ?? ""}`]
      default:
        return ["error", s.status]
    }
  }

  /** Outputs stay in the store while a run inside retention or a reusable result names them (`Outputs.sweep`). */
  const keep = (outputs: Record<string, string> | undefined) =>
    Effect.forEach(Object.values(outputs ?? {}), (path) =>
      Outputs.root(config.stateDir, path).pipe(
        Effect.provideService(Exec.SpawnerTag, spawner),
        Effect.catch((e) => Effect.logWarning(`could not keep ${path} from the garbage collector`, e)),
      ), { discard: true })

  const settle = (run: Rows.RunRow, stale: Rows.StepRow, s: Settled) =>
    Effect.gen(function*() {
      // The step's row changed while it ran (started_at, attempts); read it again.
      const row = (yield* db(Rows.loadStep(run.id, stale.name))) ?? stale
      const now = Date.now()
      const failed = s.status === "failed" || s.status === "died"
      // A timeout or a worker that died leaves no trace in the output itself.
      if (failed && s.error) yield* logTo(run, row.name, row.span_id, null)({ _tag: "Log", stream: "calder", text: s.error.message, timestamp: now })
      const excerpt = failed ? live.excerpt(run.id, row.name) : null
      const tests = Tests.outcomes(s.tests ?? [])
      const counts = tests.length > 0 ? Tests.count(tests) : null
      const outcome = row.kind === "task" && (s.status === "passed" || s.status === "failed") && s.key ? { key: s.key, status: s.status } : null
      // A task that never reuses depends on more than its key, so another outcome for its key says nothing.
      const [contradicts] = outcome === null || Rows.spec(row).neverReuse ? [] : yield* db(sql<{ run_id: string }>`select run_id from results
        where key = ${outcome.key} and status != ${outcome.status} and run_id != ${run.id} order by created_at desc limit 1`)
      yield* db(sql`update steps set
        status = ${s.status},
        finished_at = ${now},
        value = ${s.value === undefined ? null : JSON.stringify(s.value)},
        outputs = ${s.outputs === undefined ? null : JSON.stringify(s.outputs)},
        key = coalesce(${s.key ?? null}, key),
        reused_from = ${s.reusedFrom ?? null},
        error_tag = ${s.error?.tag ?? null},
        error_message = ${s.error?.message ?? null},
        error_json = ${s.error === undefined || s.error === null ? null : JSON.stringify(s.error.json)},
        excerpt = ${excerpt},
        cpu_seconds = ${s.usage?.cpuSeconds ?? null},
        memory_peak = ${s.usage?.memoryPeakBytes ?? null},
        attempts = max(attempts, ${s.attempts ?? 0}),
        tests_passed = ${counts?.passed ?? null},
        tests_failed = ${counts?.failed ?? null},
        tests_skipped = ${counts?.skipped ?? null},
        tests_flaky = ${counts?.flaky ?? null},
        files_total = ${s.files?.total ?? null},
        files_ran = ${s.files?.ran ?? null},
        files_flaky = ${s.files?.flaky ?? null},
        contradicts = ${contradicts?.run_id ?? null}
        where run_id = ${run.id} and name = ${row.name}`)
      if (counts !== null) {
        yield* db(Rows.inChunks(tests, (chunk) =>
          sql.withTransaction(Effect.forEach(chunk, (t) =>
            sql`insert into tests (run_id, project, step, suite, name, file, status, duration_ms, message, created_at, superseded)
              values (${run.id}, ${run.project}, ${row.name}, ${t.suite}, ${t.name}, ${t.file}, ${t.status}, ${t.durationMs}, ${t.message}, ${now},
                ${t.superseded ? 1 : 0})`, { discard: true }))))
      }
      if (outcome !== null) {
        yield* db(sql`insert into results (key, run_id, step, trust, value, outputs, created_at, status)
          values (${outcome.key}, ${run.id}, ${row.name}, ${run.trust}, ${JSON.stringify(s.value ?? null)}, ${JSON.stringify(s.outputs ?? {})}, ${now},
            ${outcome.status})`)
      }
      yield* keep(s.outputs)
      live.finish(run.id, row.name)
      yield* publishStep(run.id, row.name)
      if (row.kind !== "output") {
        const [state, description] = describe(s, row)
        yield* status(run, `calder/${row.name}`, state, description)
      }
      // Gitea's combined state fails with the first failed step; the run's own status says it goes on.
      if (failed) {
        const steps = (yield* db(Rows.loadSteps(run.id))).filter((x) => x.kind !== "output")
        const left = steps.filter((x) => !Rows.terminal(x.status)).length
        const failing = steps.filter((x) => x.status === "failed" || x.status === "died").map((x) => x.name)
        if (left > 0) yield* status(run, "calder", "pending", `${left} steps left; failed: ${failing.join(", ")}`)
      }
      if (row.started_at !== null || s.status === "reused") {
        yield* telemetry.exportSpan({
          traceId: run.trace_id,
          spanId: row.span_id,
          parentId: run.span_id,
          name: row.name,
          start: row.started_at ?? now,
          end: now,
          error: failed,
          attributes: {
            "calder.project": run.project,
            "calder.run": run.id,
            "calder.step": row.name,
            "calder.kind": row.kind,
            "calder.status": s.status,
            ...(s.key ? { "calder.key": s.key } : {}),
          },
        })
      }
      return s.status
    })

  const fromResult = (result: JobResult, usage: Usage, extra: Partial<Settled> = {}): Settled => {
    switch (result._tag) {
      case "Passed":
        return { status: "passed", value: result.value, outputs: result.outputs, key: result.key, usage, ...extra }
      case "Failed":
        return {
          status: "failed",
          error: { tag: result.tag, message: result.message, json: result.error },
          key: result.key,
          ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
          usage,
          ...extra,
        }
      case "Died":
      case "Lost":
        return { status: "died", error: { tag: "Died", message: result.message, json: null }, usage, ...extra }
      case "Skipped":
        return { status: "skipped", error: { tag: "Skipped", message: result.reason, json: null }, usage, ...extra }
      default:
        return { status: "died", error: { tag: "Died", message: `unexpected ${result._tag}`, json: null }, usage, ...extra }
    }
  }

  /**
   * A step of another platform runs on an agent of it, and only trusted runs may use those: an agent
   * runs every worker as one user, without the pull-request sandbox's egress allowlist, private network
   * and private /tmp.
   */
  const refuses = (run: Rows.RunRow, platform: string | null) => platform !== null && platform !== config.system && run.trust !== "trusted"

  /**
   * Where a job runs: here, or on an agent, whose workers fetch what local ones read from disk. A job
   * of another platform needs an agent of it. Other jobs of trusted runs go to a connected agent of this
   * platform with a free slot, which is there to take load off this host, unless they are to run `here`.
   */
  const place = (run: Rows.RunRow, info: RunInfo, platform: string | null, here = false) => {
    const foreign = platform !== null && platform !== config.system
    const offload = !foreign && !here && run.trust === "trusted" &&
      agents.usage().some((a) => a.connected && a.current && a.platform === config.system && a.running < a.slots)
    const remote = foreign || offload
    const system = platform ?? config.system
    const where = remote ? { ...info, flake: "", mirror: `${config.url.replace(/\/$/, "")}/git/${run.project}.git`, mirrors: {}, pipelineDir: "", system } : info
    return { remote, offload, where, platform: remote ? system : platform }
  }
  type Placement = ReturnType<typeof place>

  /**
   * Runs a job where `place` puts it. A job runs once more, here unless its platform needs an agent,
   * when an agent lost it or none took it, when its worker died on an agent (which can't always reach
   * this host), and for setups, when it failed on an agent it was only offloaded to.
   */
  const placed = <R extends { readonly result: JobResult; readonly startedAt: number | null }, E, Q>(
    run: Rows.RunRow,
    row: Rows.StepRow,
    info: RunInfo,
    platform: string | null,
    shard: number | null,
    attempt: (placement: Placement) => Effect.Effect<R, E, Q>,
    options: { readonly setup?: boolean; readonly here?: boolean } = {},
  ) =>
    Effect.gen(function*() {
      const placement = place(run, info, platform, options.here)
      const first = yield* attempt(placement)
      const { result } = first
      const why = stopped(first)
        ? null
        : result._tag === "Lost"
        ? result.message
        : (placement.remote && result._tag === "Died") || (options.setup === true && placement.offload && result._tag === "Failed")
        ? `on the agent: ${result.message.split("\n")[0]}`
        : null
      if (why === null) return first
      // An offloaded job no agent took never started; it simply runs here.
      if (first.startedAt !== null) {
        yield* logTo(run, row.name, row.span_id, shard)({ _tag: "Log", stream: "calder", text: `${why}, so it runs again`, timestamp: Date.now() })
      }
      return yield* attempt(place(run, info, platform, true))
    })
  const agentsRefuse = (platform: string | null): Settled => ({
    status: "died",
    error: { tag: "Died", message: `${platform} steps run on agents, which only take trusted runs`, json: null },
  })

  type Executed = Effect.Success<ReturnType<typeof execute>>
  /** A job that never ran to a result: its run was cancelled, or replaced before the job started. */
  const stopped = (r: object) => "cancelled" in r || "withdrawn" in r
  const preparing = new Map<string, Deferred.Deferred<Option.Option<Executed>>>()
  /**
   * Runs a setup once for concurrent runs that need the same prepared workspace: the others wait and
   * reuse it, or try themselves if it didn't pass.
   */
  const once = <E, R>(key: string, setup: Effect.Effect<Executed, E, R>): Effect.Effect<{ readonly executed: Executed; readonly reused: boolean }, E, R> =>
    Effect.suspend(() => {
      const running = preparing.get(key)
      if (running !== undefined) {
        return Deferred.await(running).pipe(Effect.flatMap(Option.match({
          onNone: () => once(key, setup),
          onSome: (executed) => Effect.succeed({ executed, reused: true }),
        })))
      }
      const done = Deferred.makeUnsafe<Option.Option<Executed>>()
      preparing.set(key, done)
      return setup.pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            preparing.delete(key)
            const passed = Exit.isSuccess(exit) && !stopped(exit.value) && exit.value.result._tag === "Passed"
            return Deferred.succeed(done, passed ? Option.some(exit.value) : Option.none())
          })
        ),
        Effect.map((executed) => ({ executed, reused: false })),
      )
    })

  /**
   * Runs a job in a slot unless the run is cancelled first. Tasks get their workspace only once they
   * hold a slot, so waiting tasks don't each claim (and warm up) a workspace. Actions are never cut short.
   */
  const execute = (
    run: Rows.RunRow,
    row: Rows.StepRow,
    job: (workspace: string | null) => Job,
    options: {
      readonly slots: Slots.Slots
      /** What the slots are, for the reason a step waits, such as `a task slot`. */
      readonly what: string
      /** Expected run time in ms, which orders the slot's queue. */
      readonly expected: number
      readonly action: boolean
      readonly shard: number | null
      readonly workspace: boolean
      readonly platform?: string | null
      /** Runs on an agent, of `platform` or of this host's. */
      readonly remote?: boolean
      /** Runs on an agent of this host's platform only if one has a free slot when the job starts. */
      readonly offload?: boolean
      /** Completing it takes the job out of the queue if it hasn't started; a started job runs on. */
      readonly withdraw?: Deferred.Deferred<void>
      /**
       * Completes once the job's work is of no use to the runs that go on, given the derivations it builds
       * right now. A started job of a superseded run then stops; without it, a started job runs on.
       */
      readonly obsolete?: (building: () => ReadonlyArray<string>) => Effect.Effect<void>
      /** The pool when it isn't the run's, such as a preview's trusted job in a pull-request run. */
      readonly pool?: Pool
      /** Whether the job is on a deploy's or preview's critical path, when the step's own spec doesn't say. */
      readonly critical?: boolean
      /** Evaluates the project's flake, in the larger pull-request unit where the project asks for it (Jobs `large`). */
      readonly evaluates?: boolean
    },
    collect: { tests: Array<Extract<JobEvent, { _tag: "Tests" }>["results"][number]>; attempts: number },
  ) =>
    Effect.gen(function*() {
      /** The derivations the job's Nix builds right now, by activity. */
      const building = new Map<number, string>()
      const onEvent = (event: JobEvent) =>
        Effect.gen(function*() {
          if (event._tag === "Activity" && event.activity.type === "build" && event.activity.drv) {
            if (event.activity.end === null) building.set(event.activity.id, event.activity.drv)
            else building.delete(event.activity.id)
          }
          yield* logTo(run, row.name, row.span_id, options.shard)(event)
          if (event._tag === "Tests") collect.tests.push(...event.results)
          if (event._tag === "Attempt") collect.attempts = Math.max(collect.attempts, event.attempt)
          if (event._tag === "Activity" && event.activity.end !== null) {
            yield* telemetry.exportSpan({
              traceId: run.trace_id,
              spanId: Telemetry.spanId(),
              parentId: row.span_id,
              name: `nix ${event.activity.type} ${event.activity.drv?.replace(/^\/nix\/store\/[a-z0-9]{32}-/, "") ?? event.activity.text}`,
              start: event.activity.start,
              end: event.activity.end,
              error: event.activity.failed,
              attributes: { "nix.activity": event.activity.type, ...(event.activity.drv ? { "nix.drv": event.activity.drv } : {}) },
            })
          }
        })
      const started = Effect.gen(function*() {
        yield* db(sql`update steps set status = 'running', started_at = coalesce(started_at, ${Date.now()}), attempts = max(attempts, 1),
          waiting = null where run_id = ${run.id} and name = ${row.name}`)
        yield* publishStep(run.id, row.name)
        yield* status(run, `calder/${row.name}`, "pending", "running")
      })
      let startedAt: number | null = null
      // A worker that ran on while the controller restarted already holds its slot and workspace.
      const adopted = options.action
        ? undefined
        : jobs.adopted().find((a) => a.spec.run.id === run.id && a.spec.step === row.name && (a.spec.shard?.index ?? null) === options.shard)
      const reattached = adopted === undefined ? undefined : Effect.gen(function*() {
        startedAt = adopted.startedAt
        yield* started
        const done = yield* jobs.reattach(adopted.id, onEvent)
        return { ...done, startedAt: adopted.startedAt }
      })
      const pool = options.pool ?? poolOf(run)
      const running = Effect.scoped(Effect.gen(function*() {
        const ws = options.workspace ? (yield* workspace(pool, run.project, options.remote === true)).path : null
        const done = yield* jobs.run(job(ws), {
          pool,
          onEvent,
          // A job that waits for an agent, or that none takes, stays queued.
          onStart: Effect.suspend(() => {
            startedAt = Date.now()
            return started
          }),
          uninterruptible: options.action,
          platform: options.platform ?? null,
          large: options.evaluates === true && largeEvaluations(run),
          agent: options.remote === true,
          offload: options.offload === true,
          adoptable: !options.action,
          onWaiting: (reason) => waiting(run.id, row.name, reason),
        })
        return { ...done, startedAt }
      }))
      const event = JSON.parse(run.event) as Domain.Event
      const background = event._tag === "Check" && event.background === true
      const claim = {
        project: run.project,
        expected: options.expected,
        run: run.created_at,
        background,
        critical: options.critical ?? Rows.spec(row).critical === true,
        label: `${run.id} ${row.name}`,
      }
      const work = reattached ??
        options.slots.with(claim, running, (busy) => waiting(run.id, row.name, `${options.what}: ${busy}`))
      if (options.action) return yield* work
      const none = { usage: { cpuSeconds: null, memoryPeakBytes: null }, id: "", startedAt: null }
      const cancelled = Deferred.await(cancelSignal(run.id)).pipe(
        Effect.map((reason) => ({ ...none, result: { _tag: "Died", message: reason } satisfies JobResult, cancelled: true as const })),
      )
      const withdrawal = options.withdraw === undefined
        ? Deferred.await(supersedeSignal(run.id))
        : Effect.raceFirst(Deferred.await(options.withdraw), Deferred.await(supersedeSignal(run.id)))
      const withdrawn = withdrawal.pipe(
        Effect.andThen(Effect.suspend(() => startedAt === null ? Effect.void : options.obsolete?.(() => [...building.values()]) ?? Effect.never)),
        Effect.as({ ...none, result: { _tag: "Died", message: "withdrawn" } satisfies JobResult, withdrawn: true as const }),
      )
      return yield* Effect.raceFirst(work, Effect.raceFirst(cancelled, withdrawn))
    })

  /**
   * Whether the run needs the setup. Tasks that start from it ask once they know they run, so the setup
   * waits for the first of them, or until all of them settled without asking. It runs at once when one
   * of them runs whatever earlier results exist, or when another kind of step waits for it.
   */
  const asked = (run: Rows.RunRow, setup: string, steps: ReadonlyArray<Rows.StepRow>) => {
    const reuse = (JSON.parse(run.plan ?? "{}") as PlanSpec).reuse
    const kinds = new Map(steps.map((s) => [s.name, s.kind]))
    const dependents = steps.map(Rows.spec).filter((s) => [...s.needs, ...s.exits, ...s.after].includes(setup))
    const starters = dependents.filter((s) => Rows.setupsOf(s, (name) => kinds.get(name)).includes(setup))
    const eager = starters.length < dependents.length ||
      starters.some((s) => !Rows.reusable(s, reuse) || (s.task?.each?.some((e) => e.always) ?? false))
    if (eager) return Effect.succeed(true)
    return Effect.raceFirst(
      Deferred.await(wanted.get(run.id, setup)).pipe(Effect.as(true)),
      Effect.forEach(starters, (s) => Deferred.await(stepped.get(run.id, s.name)), { discard: true }).pipe(Effect.as(false)),
    )
  }

  /**
   * Asks for the setups a task starts from once it knows it runs, and waits for them. Returns how the
   * task settles instead of running, when the run was cancelled meanwhile or a setup didn't pass.
   */
  const ready = (run: Rows.RunRow, row: Rows.StepRow, setups: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      if (setups.length === 0) return null
      yield* Effect.forEach(setups, (s) => Deferred.succeed(wanted.get(run.id, s), undefined), { discard: true })
      // A task whose setup still runs isn't waiting for a slot yet, so its queue time starts after.
      const waits = (yield* db(Rows.loadSteps(run.id))).some((s) => setups.includes(s.name) && !Rows.terminal(s.status))
      if (waits) {
        yield* db(sql`update steps set status = 'pending', waiting = ${`setup ${setups.join(", ")}`} where run_id = ${run.id} and name = ${row.name}`)
        yield* publishStep(run.id, row.name)
      }
      yield* Effect.forEach(setups, (s) => Deferred.await(stepped.get(run.id, s)), { discard: true })
      if (waits) {
        yield* db(sql`update steps set status = 'queued', queued_at = ${Date.now()}, waiting = null where run_id = ${run.id} and name = ${row.name}`)
        yield* publishStep(run.id, row.name)
      }
      const cancelled = (yield* db(Rows.loadRun(run.id)))?.status === "cancelled"
      const failed = (yield* db(Rows.loadSteps(run.id))).some((s) => setups.includes(s.name) && !Rows.succeeded(s.status))
      const instead: Settled | null = cancelled ? { status: "cancelled" } : failed ? { status: "blocked" } : null
      return instead
    })

  /** Why an evaluation job came back without derivations. */
  const why = (result: JobResult) => (result._tag === "Died" ? result.message.split("\n")[0] : result._tag)

  /**
   * One job that evaluates builds (Steps.ts `evaluate`) for `row`'s step. It is plan work and takes a plan
   * slot, so one project's flake is evaluated once at a time, as the worker's cache lock would have it
   * anyway, in the larger pull-request unit where the project asks for it, and no build slot sits idle
   * for the minutes it takes.
   */
  const evaluateBuilds = (run: Rows.RunRow, row: Rows.StepRow, job: Job, critical: boolean) =>
    execute(run, row, () => job, {
      slots: slots.plans,
      what: "a plan slot",
      expected: 0,
      action: false,
      shard: null,
      workspace: false,
      critical,
      evaluates: true,
    }, { tests: [], attempts: 0 })

  /**
   * Gives the evaluated builds' steps their derivations, the edges between builds a plan would have given
   * and the critical path those make, in the steps and the run's plan, and keeps what they recorded.
   */
  const applyEvaluated = (run: Rows.RunRow, result: Extract<JobResult, { _tag: "Evaluated" }>) =>
    Effect.gen(function*() {
      const { derivations, uses, recorded } = result
      yield* rootDerivations(run, Object.values(derivations).flatMap((d) => (d === null ? [] : [d.drv])))
      if (recorded !== undefined) yield* db(Rows.keepRecords(run, projects.get(run.project)?.defaultBranch, recorded))
      const changed = yield* db(sql.withTransaction(Effect.gen(function*() {
        const stored = (yield* Rows.loadRun(run.id))?.plan
        if (stored === null || stored === undefined) return []
        const plan = JSON.parse(stored) as PlanSpec
        const deps = new Map(plan.steps.map((s) => [s.name, new Set([...s.needs, ...s.after, ...s.exits])]))
        // Whether `from` waits for `to`, directly or through other steps.
        const waitsFor = (from: string, to: string, seen = new Set<string>()): boolean => {
          if (from === to) return true
          if (seen.has(from)) return false
          seen.add(from)
          return [...(deps.get(from) ?? [])].some((d) => waitsFor(d, to, seen))
        }
        const steps = Rows.criticalPath(plan.steps.map((s): PlannedStep => {
          const derivation = s.build === null ? undefined : derivations[s.name] ?? undefined
          // A use that would close a cycle with the plan's own order (a worker's mistake, or a rule that
          // put a build after one that uses it) is left out: the run would wait forever.
          const more = (uses[s.name] ?? []).filter((n) => !s.needs.includes(n) && deps.has(n) && !waitsFor(n, s.name))
          for (const n of more) deps.get(s.name)!.add(n)
          return {
            ...s,
            needs: [...s.needs, ...more],
            build: derivation === undefined || s.build === null ? s.build : { ...s.build, drv: derivation.drv, out: derivation.out, system: derivation.system },
          }
        }), run.fork === 1)
        const attrs = Object.fromEntries(plan.steps.flatMap((s) => (s.build === null || !(s.name in derivations) ? [] : [[s.build.attr, derivations[s.name] ?? null]])))
        yield* sql`update runs set plan = ${JSON.stringify({ ...plan, steps, derivations: { ...plan.derivations, ...attrs } })} where id = ${run.id}`
        const updated = steps.filter((s, i) => JSON.stringify(s) !== JSON.stringify(plan.steps[i]))
        for (const s of updated) yield* sql`update steps set spec = ${JSON.stringify(s)} where run_id = ${run.id} and name = ${s.name}`
        return updated.map((s) => s.name)
      })))
      yield* Effect.forEach(changed, (n) => publishStep(run.id, n), { discard: true })
    })

  /** Per run, once its first build without a derivation runs: the builds whose attributes were too large, with why. */
  const evaluations = new Map<string, Deferred.Deferred<ReadonlyMap<string, string>>>()

  /**
   * Evaluates the builds the run's plan left unevaluated (Resolve.ts `resolve`) in one job of the first
   * of them that runs, as its plan would have: in one evaluator while they fit, recording their
   * footprints. The others wait for it, not each evaluating the flake. Their steps then get the
   * derivations and the edges between builds a plan gives, so they build where their system builds and
   * an output that exists is reused; the run's plan gets them for later plans of the same tree. Where the
   * evaluation fails, each build evaluates its attribute itself.
   */
  const evaluation = (
    run: Rows.RunRow,
    name: string,
    job: (step: string, evaluate: NonNullable<Extract<Job, { _tag: "Step" }>["evaluate"]>) => Job,
  ) =>
    Effect.gen(function*() {
      const pending = evaluations.get(run.id)
      if (pending !== undefined) {
        yield* waiting(run.id, name, "the run's builds to be evaluated")
        return yield* Deferred.await(pending).pipe(Effect.ensuring(waiting(run.id, name, null)))
      }
      const done = Deferred.makeUnsafe<ReadonlyMap<string, string>>()
      evaluations.set(run.id, done)
      const evaluate = Effect.gen(function*() {
        const steps = (yield* db(Rows.loadSteps(run.id))).map(Rows.spec)
        const builds = steps.flatMap((s) => (s.build === null ? [] : [{ name: s.name, build: s.build, critical: s.critical === true }]))
        const order = (JSON.parse((yield* db(Rows.loadRun(run.id)))?.plan ?? "{}") as PlanSpec).deferred ?? []
        const rank = (attr: string) => (order.includes(attr) ? order.indexOf(attr) : order.length)
        const what = {
          builds: builds.flatMap((b) => (b.build.drv === null ? [{ name: b.name, attr: b.build.attr }] : []))
            .sort((a, b) => rank(a.attr) - rank(b.attr)),
          planned: builds.flatMap((b) => (b.build.drv === null ? [] : [{ name: b.name, drv: b.build.drv }])),
        }
        // A worker that was evaluating when the controller restarted goes on, as its step's job.
        const by = jobs.adopted().find((a) => a.spec.run.id === run.id && a.spec.evaluate !== undefined)?.spec.step ?? name
        const row = (yield* db(Rows.loadStep(run.id, by)))!
        const critical = builds.some((b) => b.build.drv === null && b.critical)
        const say = (text: string) => logTo(run, row.name, row.span_id, null)({ _tag: "Log", stream: "calder", text, timestamp: Date.now() })
        let r = yield* evaluateBuilds(run, row, job(by, what), critical)
        // It fails mostly when the host is short of memory, as when a worker's unit times out starting.
        if (r.result._tag !== "Evaluated" && !stopped(r)) {
          yield* say(`evaluating the builds together failed, so it tries once more: ${why(r.result)}`)
          r = yield* evaluateBuilds(run, row, job(by, what), critical)
        }
        if (r.result._tag !== "Evaluated") {
          if (!stopped(r)) yield* say(`evaluating the builds together failed again, so each evaluates its own attribute: ${why(r.result)}`)
          return new Map<string, string>()
        }
        yield* applyEvaluated(run, r.result)
        return new Map(Object.entries(r.result.tooLarge))
      })
      return yield* evaluate.pipe(
        Effect.catchCause((cause) => Effect.logError(`evaluating ${run.id}'s builds failed`, cause).pipe(Effect.as(new Map<string, string>()))),
        Effect.tap((tooLarge) => Deferred.succeed(done, tooLarge)),
        Effect.onInterrupt(() => Deferred.succeed(done, new Map())),
      )
    })

  /**
   * A rerun redoes only what didn't pass (F46). A step that passed in the run it repeats, or took that
   * run's result, settles as reused from it when it would do the same again: a task with the same key,
   * an action with the same inputs. That includes steps that otherwise never take a result, such as
   * deploys and OTA publishes, whose effect the earlier run already had; `calder rerun --force` runs
   * them again.
   */
  const fromRerun = (
    run: Rows.RunRow,
    name: string,
    same: { readonly key: string } | { readonly inputs: Record<string, Outcome> },
    granted: {
      /** The secrets the step gets: one that changed, such as a rotated token, has to ship. */
      readonly secrets: Record<string, string>
      /** The step's deploy lease, if it takes one (WorkerServer.ts `leaseOf`). */
      readonly lease: string | undefined
    },
  ) =>
    Effect.gen(function*() {
      // Recorded for every step, so a rerun of this run can compare. Without the controller's key a digest
      // would be an unkeyed hash, which gives a short secret away, so a step with secrets records none and
      // runs again on every rerun.
      const secrets = Object.keys(granted.secrets).length > 0
      const digest = secrets && config.placementKey !== null ? secretsDigest(config.placementKey, granted.secrets) : null
      yield* db(sql`update steps set secrets_digest = ${digest} where run_id = ${run.id} and name = ${name}`)
      const of = run.rerun_of
      if (of == null) return undefined
      const earlier = yield* db(Rows.loadStep(of, name))
      if (earlier === undefined || !Rows.succeeded(earlier.status)) return undefined
      if ("key" in same && earlier.key !== same.key) return undefined
      if (secrets ? digest === null || earlier.secrets_digest !== digest : (earlier.secrets_digest ?? null) !== null) return undefined
      // A newer run deployed the same step since, so what this one deployed no longer runs there.
      const origin = earlier.reused_from ?? of
      if (granted.lease !== undefined) {
        const [newest] = yield* db(sql<{ run: number }>`select run from lease_steps where project = ${granted.lease} and step = ${name}`)
        const deployed = yield* db(Rows.loadRun(origin))
        if (newest === undefined || deployed === undefined || newest.run !== deployed.number) return undefined
      }
      if ("inputs" in same) {
        const steps = new Map((yield* db(Rows.loadSteps(of))).map((s) => [s.name, s]))
        const changed = Object.entries(same.inputs).some(([n, outcome]) => {
          const was = steps.get(n)
          return was === undefined || JSON.stringify(outcomeOf(was)) !== JSON.stringify(outcome)
        })
        if (changed) return undefined
      }
      const outputs = JSON.parse(earlier.outputs ?? "{}") as Record<string, string>
      // An output that left the store can't stand in for running the step.
      if (!Object.values(outputs).every((path) => existsSync(path))) return undefined
      return {
        status: "reused",
        value: earlier.value === null ? null : JSON.parse(earlier.value),
        outputs,
        key: earlier.key,
        reusedFrom: origin,
      } satisfies Settled
    })

  const step = (runId: string, name: string) => {
    // The latch of this attempt. A step's row ends before its Gitea status and telemetry do, so a retry
    // (`retry`) waits for this attempt to return before it puts the step back and opens a new latch.
    const latch = stepped.get(runId, name)
    const attempt = `${runId}\0${name}`
    return Effect.gen(function*() {
      attempts.set(attempt, latch)
      const run = yield* db(Rows.loadRun(runId))
      const row = yield* db(Rows.loadStep(runId, name))
      if (run === undefined || row === undefined) return "died" as const
      if (Rows.terminal(row.status)) return row.status
      if (run.status === "cancelled") return yield* settle(run, row, { status: "cancelled" })

      const spec = Rows.spec(row)
      if (spec.build !== null && spec.build.drv !== null && spec.build.out !== null && (yield* available(spec.build.out))) {
        yield* share(run, name, spec.build.out)
        return yield* settle(run, row, { status: "reused", value: spec.build.out, key: spec.build.drv })
      }
      let all = yield* db(Rows.loadSteps(runId))
      let byName = new Map(all.map((s) => [s.name, s]))
      const setups = Rows.setupsOf(spec, (n) => byName.get(n)?.kind)
      // Builds the run's evaluation found this step uses (see `evaluation`) came after the plan, which the
      // run waited for.
      // A dependency that runs again (`retry`) after this step's driver saw it end is late the same way.
      const late = upstream(spec).filter((n) => !setups.includes(n) && byName.has(n) && !Rows.terminal(byName.get(n)!.status))
      if (late.length > 0) {
        yield* Effect.forEach(late, (n) => Deferred.await(stepped.get(runId, n)), { discard: true })
        all = yield* db(Rows.loadSteps(runId))
        byName = new Map(all.map((s) => [s.name, s]))
      }
      const deps = [...spec.needs, ...spec.after].filter((n) => !setups.includes(n)).map((n) => byName.get(n)?.status ?? "blocked")
      if (deps.some((status) => !Rows.succeeded(status) && status !== "skipped")) return yield* settle(run, row, { status: "blocked" })
      const skippedDep = [...spec.needs, ...spec.after].find((n) => byName.get(n)?.status === "skipped")
      if (skippedDep !== undefined) {
        return yield* settle(run, row, { status: "skipped", error: { tag: "Skipped", message: `${skippedDep} was skipped`, json: null } })
      }
      if (spec.setup !== null && !(yield* asked(run, name, all))) {
        const cancelled = (yield* db(Rows.loadRun(runId)))?.status === "cancelled"
        return yield* settle(run, row, cancelled ? { status: "cancelled" } : { status: "reused", key: spec.setup.deps, unneeded: true })
      }
      yield* db(sql`update steps set status = 'queued', queued_at = ${Date.now()} where run_id = ${runId} and name = ${name}`)
      yield* publishStep(runId, name)

      // An action reads the outcomes of its exits; a task's (`afterEnded`) only order it.
      const read = [...spec.needs.filter((n) => !setups.includes(n)), ...(spec.action === null ? [] : spec.exits)]
      const inputs = Object.fromEntries(read.map((n) => [n, outcomeOf(byName.get(n)!)]))
      const expected = Estimates.of(yield* estimates.steps(run.project), name)
      const plan = JSON.parse(run.plan ?? "{}") as PlanSpec
      // The dev shells the plan evaluated, which a task or setup enters without evaluating the flake again.
      const shells = spec.task === null && spec.setup === null ? {} : {
        shells: Object.fromEntries(Object.entries(plan.derivations ?? {}).flatMap(([attr, d]) => (attr.startsWith("devShells.") && d !== null ? [[attr, d.drv]] : []))),
      }
      const pipelineDir = yield* mirror.pipelineDir(run.project, run.sha).pipe(Effect.orDie)
      const info = runInfo(run, pipelineDir)
      const collect = { tests: [] as Array<Extract<JobEvent, { _tag: "Tests" }>["results"][number]>, attempts: 0 }
      const stepJob = (extra: Partial<Extract<Job, { _tag: "Step" }>> = {}): Job => ({
        _tag: "Step",
        run: info,
        step: name,
        shard: null,
        attempt: 1,
        workspace: null,
        inputs,
        secrets: {},
        derivation: null,
        deps: null,
        files: null,
        ...shells,
        ...extra,
      })

      if (spec.output !== null) {
        const task = byName.get(spec.output.task)!
        const outputs = JSON.parse(task.outputs ?? "{}") as Record<string, string>
        const path = outputs[spec.output.output]
        return yield* settle(run, row, path === undefined
          ? { status: "died", error: { tag: "Died", message: `${spec.output.task} did not produce ${spec.output.output}`, json: null } }
          : { status: "passed", value: path, key: path })
      }

      if (spec.build !== null) {
        let build = spec.build
        if (build.drv === null) {
          const tooLarge = yield* evaluation(run, name, (step, evaluate) => stepJob({ step, inputs: {}, evaluate }))
          const now = (yield* db(Rows.loadStep(runId, name))) ?? row
          if ((yield* db(Rows.loadRun(runId)))?.status === "cancelled") return yield* settle(run, now, { status: "cancelled" })
          const large = tooLarge.get(name)
          if (large !== undefined) return yield* settle(run, now, { status: "failed", error: { tag: "TooLarge", message: large, json: null } })
          let evaluated = Rows.spec(now)
          build = evaluated.build ?? build
          if (build.drv === null) {
            // The run's evaluation failed: this build evaluates its attribute alone, still as plan work.
            const alone = yield* evaluateBuilds(run, now, stepJob({ inputs: {}, evaluate: { builds: [{ name, attr: build.attr }], planned: [] } }), spec.critical === true)
            if (stopped(alone)) return yield* settle(run, now, { status: "cancelled" })
            if (alone.result._tag === "Evaluated") yield* applyEvaluated(run, alone.result)
            evaluated = Rows.spec((yield* db(Rows.loadStep(runId, name))) ?? now)
            build = evaluated.build ?? build
            if (build.drv === null) {
              const [tag, message] = alone.result._tag !== "Evaluated" ? ["EvaluationFailed", `${build.attr} did not evaluate: ${why(alone.result)}`]
                : alone.result.tooLarge[name] !== undefined ? ["TooLarge", alone.result.tooLarge[name]]
                : ["EvaluationFailed", `${build.attr} did not evaluate: ${alone.result.errors?.[name] ?? "it threw"}`]
              return yield* settle(run, now, { status: "failed", error: { tag, message, json: null } })
            }
          }
          // The builds it turned out to use, as a plan that evaluated it would have had it wait for.
          const uses = evaluated.needs.filter((n) => !spec.needs.includes(n))
          yield* Effect.forEach(uses, (n) => Deferred.await(stepped.get(runId, n)), { discard: true })
          const after = new Map((yield* db(Rows.loadSteps(runId))).map((s) => [s.name, s.status]))
          if (uses.some((n) => !Rows.succeeded(after.get(n) ?? "blocked"))) return yield* settle(run, now, { status: "blocked" })
          if (build.drv !== null && build.out !== null && (yield* available(build.out))) {
            yield* share(run, name, build.out)
            return yield* settle(run, now, { status: "reused", value: build.out, key: build.drv })
          }
        }
        const { drv, system } = build
        // A rerun of a run that ended has no roots left; one the plan made holds already.
        if (drv !== null) yield* rootDerivations(run, [drv])
        const once = () =>
          execute(run, row, () => stepJob({ derivation: drv }), {
            slots: buildSlots(system),
            what: system === null || system === config.system ? "a build slot" : `a build slot for ${system}`,
            expected,
            action: false,
            shard: null,
            workspace: false,
            ...(drv === null ? {} : { obsolete: obsoleteBuild(run, name, drv) }),
          }, collect)
        // A build the controller restarted in the middle of goes on from the attempt it was at.
        let attempt = Math.max(1, row.attempts)
        let r = yield* once()
        // An infrastructure failure, such as a builder that couldn't be reached, gets more attempts, each
        // after a wait without a slot. The step fails only once the last attempt failed the same way.
        for (const wait of infrastructureRetries.slice(attempt - 1)) {
          if (stopped(r) || r.result._tag !== "Failed" || r.result.tag !== "Infrastructure") break
          attempt++
          // The worker's Calder.Infrastructure, as Values encodes it.
          const failure = Values.decode(r.result.error) as { readonly cause?: unknown } | null
          const cause = typeof failure?.cause === "string" ? failure.cause : r.result.message
          const text = `${cause}; an infrastructure failure, so it runs again in ${Duration.format(Duration.fromInputUnsafe(wait))} ` +
            `(attempt ${attempt} of ${infrastructureRetries.length + 1})`
          yield* logTo(run, name, row.span_id, null)({ _tag: "Log", stream: "calder", text, timestamp: Date.now() })
          yield* db(sql`update steps set status = 'queued', waiting = ${`another attempt after an infrastructure failure: ${cause}`},
            attempts = max(attempts, ${attempt}) where run_id = ${runId} and name = ${name}`)
          yield* publishStep(runId, name)
          const ended = yield* Effect.raceFirst(
            Effect.sleep(wait).pipe(Effect.as(false)),
            Effect.raceFirst(Deferred.await(cancelSignal(runId)), Deferred.await(supersedeSignal(runId))).pipe(Effect.as(true)),
          )
          if (ended) return yield* settle(run, row, { status: "cancelled" })
          r = yield* once()
        }
        if (stopped(r)) return yield* settle(run, row, { status: "cancelled" })
        if (r.result._tag === "Passed" && typeof r.result.value === "string") yield* share(run, name, r.result.value)
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: Math.max(collect.attempts, attempt) }))
      }

      if (spec.setup !== null) {
        const { deps, platform } = spec.setup
        if (refuses(run, platform)) return yield* settle(run, row, agentsRefuse(platform))
        const executed = yield* placed(run, row, info, platform, null, (p) =>
          once(
            `${p.remote ? "agent" : "local"}/${poolOf(run)}/${run.project}/${p.platform ?? config.system}/${deps}`,
            execute(run, row, (ws) => stepJob({ run: p.where, workspace: ws, deps }), {
              slots: p.remote ? slots.agents : slots.tasks,
              what: p.remote ? "an agent's slot" : "a task slot",
              // Every task of the run waits for it.
              expected: 0,
              action: false,
              shard: null,
              workspace: true,
              platform: p.platform,
              remote: p.remote,
              offload: p.offload,
            }, collect),
          ).pipe(Effect.map(({ executed, reused }) => ({ ...executed, reused }))), { setup: true })
        const { reused } = executed
        if (stopped(executed)) return yield* settle(run, row, { status: "cancelled" })
        const settled = fromResult(executed.result, executed.usage, { attempts: collect.attempts })
        const fresh = executed.result._tag === "Passed" && (executed.result.value as { readonly fresh?: boolean } | null)?.fresh === true
        // Nothing ran when a prepared copy existed or another run prepared it.
        return yield* settle(run, row, settled.status === "passed" && (reused || !fresh) ? { status: "reused", key: deps } : settled)
      }

      if (spec.action !== null) {
        const secrets = run.trust === "trusted" ? readSecrets(run.project, spec.action.secrets) : {}
        const lease = spec.action.deploy ? leaseOf(info, undefined).key : undefined
        const again = yield* fromRerun(run, name, { inputs }, { secrets, lease })
        if (again !== undefined) return yield* settle(run, row, again)
        // A same-repo pull request's preview action, such as one that waits for the preview's readiness,
        // runs as a trusted job for the network, but keeps the pull request's trust and services.
        const event = JSON.parse(run.event) as Domain.Event
        const preview = spec.action.preview === true && run.trust === "pr" && run.fork === 0 && event._tag === "PullRequest" && event.fork === false
        const r = yield* execute(run, row, () => stepJob({ secrets }), {
          slots: slots.actions,
          what: "an action slot",
          expected,
          action: true,
          shard: null,
          workspace: false,
          ...(preview ? { pool: "trusted" as const } : {}),
        }, collect)
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: collect.attempts }))
      }

      const task = spec.task!
      const values = Object.fromEntries(task.interpolates.map((n) => [n, JSON.parse(byName.get(n)?.value ?? "null")]))
      const prepared = ready(run, row, setups)
      if (task.each !== null) return yield* eachTask(run, row, task, task.each, values, { plan, info, stepJob, collect, prepared })
      const count = task.shards ?? 1
      const shardKeys = count === 1 ? [taskKey(task.keyBase, values, null)] : Array.from({ length: count }, (_, i) => taskKey(task.keyBase, values, { index: i + 1, count }))
      const key = count === 1 ? shardKeys[0]! : sha256(shardKeys)
      yield* db(sql`update steps set key = ${key} where run_id = ${runId} and name = ${name}`)
      // A same-repo pull request grants a preview task its secrets. It then runs as a trusted job: in
      // the trusted pool, whose network and home it needs. It never goes to an agent, which only
      // takes trusted runs.
      const event = JSON.parse(run.event) as Domain.Event
      const preview = task.preview === true && run.trust === "pr" && run.fork === 0 &&
        event._tag === "PullRequest" && event.fork === false
      const secrets = run.trust === "trusted" || preview ? readSecrets(run.project, task.secrets) : {}
      const again = yield* fromRerun(run, name, { key }, { secrets, lease: Rows.leased(task) ? leaseOf(info, task.lease).key : undefined })
      if (again !== undefined) return yield* settle(run, row, again)

      const reusable = Rows.reusable(spec, plan.reuse)
      // Pull-request runs take any result. Trusted runs take trusted ones, and with reuse "all" also
      // those of same-repo pull requests, which the same people push.
      const prResults = run.trust === "pr" || plan.reuse === "all"
      const lookup = (k: string) =>
        db(sql<{ run_id: string; value: string | null; outputs: string | null }>`select results.run_id, results.value,
            results.outputs from results join runs on runs.id = results.run_id
          where results.key = ${k} and results.status = 'passed'
            and (results.trust = 'trusted' or (${prResults ? 1 : 0} = 1 and runs.fork = 0))
          order by results.created_at desc limit 1`).pipe(
          // A result whose outputs left the store, such as one from before Calder kept them, is no use.
          Effect.map((rows) => rows.find((hit) => Object.values(JSON.parse(hit.outputs ?? "{}") as Record<string, string>).every((path) => existsSync(path)))),
        )
      const reused = (hit: { run_id: string; value: string | null; outputs: string | null }): Settled => ({
        status: "reused",
        value: hit.value === null ? null : JSON.parse(hit.value),
        outputs: JSON.parse(hit.outputs ?? "{}") as Record<string, string>,
        key,
        reusedFrom: hit.run_id,
      })
      if (reusable) {
        yield* landing(count === 1 ? [key] : shardKeys)
        const hit = yield* lookup(key)
        if (hit !== undefined) return yield* settle(run, row, reused(hit))
      }

      if (refuses(run, task.platform)) return yield* settle(run, row, agentsRefuse(task.platform))
      const sharded = count > 1
      // Shards that passed with the same key before don't run again.
      const shardHits = reusable && sharded ? yield* Effect.forEach(shardKeys, lookup) : shardKeys.map(() => undefined)
      for (const [i, hit] of shardHits.entries()) {
        if (hit === undefined) continue
        yield* db(sql`insert or replace into shards (run_id, step, shard, key, status, reused_from)
          values (${runId}, ${name}, ${i + 1}, ${shardKeys[i]!}, 'reused', ${hit.run_id})`)
      }
      const perShard = sharded ? (yield* estimates.shards(run.project)).get(name) ?? expected : expected
      const withdraw = Deferred.makeUnsafe<void>()
      let failed = false
      const pending = shardHits.flatMap((hit, i) => (hit === undefined ? [i + 1] : []))
      const instead = pending.length === 0 ? null : yield* prepared
      if (instead !== null) return yield* settle(run, row, instead)
      const shards = yield* Effect.forEach(pending, (index) =>
        Effect.gen(function*() {
          const r = yield* flying([count === 1 ? key : shardKeys[index - 1]!], placed(run, row, info, task.platform, sharded ? index : null, (p) =>
            execute(
              run,
              row,
              (ws) =>
                stepJob({
                  run: preview ? { ...p.where, trust: "trusted" } : p.where,
                  workspace: ws,
                  secrets,
                  shard: sharded ? { index, count } : null,
                  deps: task.deps,
                }),
              {
                slots: p.remote ? slots.agents : slots.tasks,
                what: p.remote ? "an agent's slot" : "a task slot",
                expected: perShard,
                ...(preview ? { pool: "trusted" as const } : {}),
                action: false,
                shard: sharded ? index : null,
                workspace: true,
                platform: p.platform,
                remote: p.remote,
                offload: p.offload,
                withdraw,
              },
              collect,
            ), { here: task.offload === false }))
          if (!sharded || stopped(r)) return r
          const passed = r.result._tag === "Passed"
          const now = Date.now()
          yield* db(sql`insert or replace into shards (run_id, step, shard, key, status, started_at, finished_at, cpu_seconds, memory_peak)
            values (${runId}, ${name}, ${index}, ${shardKeys[index - 1]!}, ${passed ? "passed" : "failed"}, ${r.startedAt}, ${now},
              ${r.usage.cpuSeconds}, ${r.usage.memoryPeakBytes})`)
          if (r.startedAt !== null) yield* estimates.shardSettled(run.project, { run: runId, step: name, index, startedAt: r.startedAt, finishedAt: now })
          if (r.result._tag === "Passed") {
            yield* db(sql`insert into results (key, run_id, step, trust, value, outputs, created_at)
              values (${shardKeys[index - 1]!}, ${runId}, ${name}, ${run.trust}, ${JSON.stringify(r.result.value ?? null)},
                ${JSON.stringify(r.result.outputs ?? {})}, ${now})`)
            yield* keep(r.result.outputs)
          } else if (!failed) {
            // Shards still waiting stay out of it; running ones finish, so a rerun repeats only what failed.
            failed = true
            yield* Deferred.succeed(withdraw, undefined)
            yield* status(run, `calder/${name}`, "failure", `shard ${index} of ${count} failed; the running shards finish first`)
          }
          return r
        }), { concurrency: "unbounded" })
      // Withdrawn shards without a failure mean the run was replaced.
      if (shards.some((r) => "cancelled" in r) || (!failed && shards.some((r) => "withdrawn" in r))) {
        return yield* settle(run, row, { status: "cancelled" })
      }
      const ran = shards.filter((r) => !("withdrawn" in r))
      const usage: Usage = {
        cpuSeconds: ran.reduce((sum, r) => sum + (r.usage.cpuSeconds ?? 0), 0),
        memoryPeakBytes: Math.max(0, ...ran.map((r) => r.usage.memoryPeakBytes ?? 0)),
      }
      const failure = ran.find((r) => r.result._tag !== "Passed")
      if (failure !== undefined) return yield* settle(run, row, { ...fromResult(failure.result, usage, { attempts: collect.attempts, tests: collect.tests }), key })
      const first = shardHits[0]
      if (ran.length === 0 && first !== undefined) return yield* settle(run, row, reused(first))
      // A sharded step's value is its first shard's.
      const { value, outputs } = first === undefined ? fromResult(ran[0]!.result, usage) : reused(first)
      return yield* settle(run, row, {
        status: "passed",
        value,
        ...(outputs === undefined ? {} : { outputs }),
        key,
        usage,
        attempts: collect.attempts,
        tests: collect.tests,
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          yield* Effect.logError(`step ${name} of ${runId} crashed`, cause)
          const run = yield* db(Rows.loadRun(runId))
          const row = yield* db(Rows.loadStep(runId, name))
          if (run === undefined || row === undefined) return "died" as const
          return yield* settle(run, row, { status: "died", error: { tag: "Died", message: `Calder failed to run the step: ${String(cause)}`, json: null } })
        })
      ),
      Effect.ensuring(Effect.suspend(() => {
        if (attempts.get(attempt) === latch) attempts.delete(attempt)
        return Deferred.succeed(latch, undefined)
      })),
    )
  }

  type TaskSpec = NonNullable<PlannedStep["task"]>
  type TestRow = Extract<JobEvent, { _tag: "Tests" }>["results"][number]

  /**
   * A task with `each`: where the run may reuse the task, files whose key passed before don't run,
   * except `always` files. The rest run in up to `shards` jobs split by their recorded durations; files
   * that fail run once more, and a pass then counts as flaky. A nightly run without reuse checks that
   * the keys still cover what files read.
   */
  const eachTask = (
    run: Rows.RunRow,
    row: Rows.StepRow,
    task: TaskSpec,
    each: NonNullable<TaskSpec["each"]>,
    values: Record<string, unknown>,
    context: {
      readonly plan: PlanSpec
      readonly info: RunInfo
      readonly stepJob: (extra: Partial<Extract<Job, { _tag: "Step" }>>) => Job
      readonly collect: { tests: Array<TestRow>; attempts: number }
      /** Waits for the task's setups; how the task settles instead, if it can't run. */
      readonly prepared: Effect.Effect<Settled | null>
    },
  ) =>
    Effect.gen(function*() {
      const keys = new Map(each.map((e) => [e.file, task.interpolates.length === 0 ? e.key : taskKey(e.key, values, null)]))
      const key = sha256([...keys.values()])
      yield* db(sql`update steps set key = ${key} where run_id = ${run.id} and name = ${row.name}`)
      const secrets = run.trust === "trusted" ? readSecrets(run.project, task.secrets) : {}
      const lease = Rows.leased(task) ? leaseOf(context.info, task.lease).key : undefined
      const again = yield* fromRerun(run, row.name, { key }, { secrets, lease })
      if (again !== undefined) return yield* settle(run, row, again)
      const reusable = Rows.reusable(Rows.spec(row), context.plan.reuse)
      const prResults = run.trust === "pr" || context.plan.reuse === "all"

      const passed = new Map<string, string>()
      const look = (wanted: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          for (let i = 0; i < wanted.length; i += 400) {
            const hits = yield* db(sql<{ key: string; run_id: string }>`select file_results.key, file_results.run_id
              from file_results join runs on runs.id = file_results.run_id
              where ${sql.in("file_results.key", wanted.slice(i, i + 400))} and file_results.status in ('passed', 'flaky')
                and (file_results.trust = 'trusted' or (${prResults ? 1 : 0} = 1 and runs.fork = 0))`)
            for (const hit of hits) passed.set(hit.key, hit.run_id)
          }
        })
      if (reusable) {
        yield* look([...keys.values()])
        // Files another run is checking right now: wait for them rather than check them twice.
        const inAir = each.filter((e) => !passed.has(keys.get(e.file)!) && inFlight(keys.get(e.file)!)).map((e) => keys.get(e.file)!)
        if (inAir.length > 0) {
          yield* landing(inAir)
          yield* look(inAir)
        }
      }
      const misses = each.filter((e) => e.always || !passed.has(keys.get(e.file)!)).map((e) => e.file)
      if (misses.length === 0) {
        const from = passed.values().next().value ?? null
        return yield* settle(run, row, { status: "reused", value: null, key, reusedFrom: from, files: { total: each.length, ran: 0, flaky: 0 } })
      }

      if (refuses(run, task.platform)) return yield* settle(run, row, agentsRefuse(task.platform))
      const instead = yield* context.prepared
      if (instead !== null) return yield* settle(run, row, instead)

      const history = yield* db(sql<{ file: string; duration_ms: number }>`select file, duration_ms from (
          select file, duration_ms, row_number() over (partition by file order by created_at desc) as n
          from file_results where project = ${run.project} and step = ${row.name} and status != 'failed'
        ) where n <= 5`)
      const duration = Each.durations(history.map((h) => ({ file: h.file, durationMs: h.duration_ms })))
      const bins = Each.split(misses, duration, task.shards ?? 1)
      const count = bins.length

      const job = (files: ReadonlyArray<string>, index: number, total: number, ms: number) =>
        Effect.gen(function*() {
          const mine = { tests: [] as Array<TestRow>, attempts: 0 }
          const r = yield* flying(files.map((f) => keys.get(f)!), placed(run, row, context.info, task.platform, index, (p) =>
            execute(
              run,
              row,
              (ws) => context.stepJob({ run: p.where, workspace: ws, secrets, shard: { index, count: total }, deps: task.deps, files }),
              {
                slots: p.remote ? slots.agents : slots.tasks,
                what: p.remote ? "an agent's slot" : "a task slot",
                expected: ms,
                action: false,
                shard: index,
                workspace: true,
                platform: p.platform,
                remote: p.remote,
                offload: p.offload,
              },
              mine,
            ), { here: task.offload === false }))
          context.collect.tests.push(...mine.tests)
          context.collect.attempts = Math.max(context.collect.attempts, mine.attempts)
          return { r, tests: mine.tests, files }
        })
      const outcomes = (done: { readonly r: { readonly result: JobResult }; readonly tests: ReadonlyArray<TestRow>; readonly files: ReadonlyArray<string> }) =>
        Each.outcomes(done.files, done.tests, done.r.result._tag === "Passed")

      const first = yield* Effect.forEach(bins.map((b, i) => [b, i] as const), ([b, i]) => job(b.files, i + 1, count, b.ms), { concurrency: "unbounded" })
      const jobOf = new Map(first.flatMap((d, i) => d.files.map((f) => [f, i + 1] as const)))
      // Jobs that finished keep their results even when the run was cancelled or replaced meanwhile.
      const results = new Map(first.filter((d) => !stopped(d.r)).flatMap((d) => [...outcomes(d)]))
      const failing = [...results].filter(([, o]) => o.status === "failed").map(([file]) => file)
      let retry: (typeof first)[number] | undefined
      const interrupted = first.some((d) => stopped(d.r))
      if (!interrupted && failing.length > 0 && failing.length <= 10) {
        retry = yield* job(failing, count + 1, count, failing.reduce((sum, f) => sum + duration(f), 0))
        for (const [file, o] of stopped(retry.r) ? [] : outcomes(retry)) {
          if (o.status === "passed" || o.status === "flaky") results.set(file, { ...o, status: "flaky" })
        }
      }
      const flaky = [...results].filter(([, o]) => o.status === "flaky").map(([file]) => file)

      const now = Date.now()
      const known = [...results].filter(([, o]) => o.status !== "unknown")
      yield* db(Rows.inChunks(known, (chunk) =>
        sql.withTransaction(Effect.forEach(chunk, ([file, o]) =>
          sql`insert into file_results (key, project, step, file, run_id, trust, status, duration_ms, created_at, job)
            values (${keys.get(file)!}, ${run.project}, ${row.name}, ${file}, ${run.id}, ${run.trust},
              ${o.status}, ${o.ms}, ${now}, ${jobOf.get(file) ?? null})`, { discard: true }))))
      if (interrupted || (retry !== undefined && stopped(retry.r))) return yield* settle(run, row, { status: "cancelled" })

      const jobs = retry === undefined ? first : [...first, retry]
      const usage: Usage = {
        cpuSeconds: jobs.reduce((sum, d) => sum + (d.r.usage.cpuSeconds ?? 0), 0),
        memoryPeakBytes: Math.max(0, ...jobs.map((d) => d.r.usage.memoryPeakBytes ?? 0)),
      }
      const extra = { attempts: context.collect.attempts, tests: context.collect.tests, files: { total: each.length, ran: misses.length, flaky: flaky.length } }
      const bad = [...results].filter(([, o]) => o.status === "failed" || o.status === "unknown").map(([file]) => file)
      if (bad.length > 0) {
        const failed = jobs.find((d) => d.r.result._tag !== "Passed" && d.files.some((f) => bad.includes(f)))
        const result: JobResult = failed?.r.result ?? { _tag: "Died", message: `no result for ${bad.join(", ")}` }
        return yield* settle(run, row, { ...fromResult(result, usage, extra), key })
      }
      if (flaky.length > 0) yield* Effect.logInfo(`${run.id} ${row.name}: ${flaky.join(", ")} passed on retry`)
      return yield* settle(run, row, { status: "passed", value: null, key, usage, ...extra })
    })

  /**
   * Completes once a build of `drv` is `obsolete` for the runs that go on, saying so in the step's log.
   * Superseded runs' builds otherwise ran on for whoever would reuse them: infra-587's and 588's builds of
   * srv-1's old closure held every build slot for hours, while srv-1 of the run that replaced them, another
   * derivation, waited. It asks again every 30 s, since a newer run that still plans or evaluates may need
   * the same derivation, and the build may move on to what the newer runs need.
   */
  const obsoleteBuild = (run: Rows.RunRow, name: string, drv: string) => (building: () => ReadonlyArray<string>) =>
    Effect.gen(function*() {
      while (true) {
        const live = yield* db(Rows.liveBuilds(run.project))
        const now = building()
        const asks = !live.unknown && !live.drvs.includes(drv) && now.length > 0 && live.drvs.length > 0
        const closure = !asks ? new Set<string>() : yield* Exec.run(["nix-store", "--query", "--requisites", ...live.drvs]).pipe(
          Effect.map((out) => new Set(out.split("\n").filter(Boolean))),
          Effect.provideService(Exec.SpawnerTag, spawner),
          Effect.orElseSucceed(() => null),
        )
        if (obsolete(drv, live, now, closure)) break
        yield* Effect.sleep(neededEvery)
      }
      const row = yield* db(Rows.loadStep(run.id, name))
      if (row === undefined) return
      const text = `stopped this superseded run's build: no run that goes on builds ${drv} or what it was building`
      yield* logTo(run, name, row.span_id, null)({ _tag: "Log", stream: "calder", text, timestamp: Date.now() })
    })

  /** Roots the run's derivations until it ends (Outputs `rootDerivations`); a build whose derivation is gone evaluates it again. */
  const rootDerivations = (run: Rows.RunRow, drvs: ReadonlyArray<string>) =>
    Outputs.rootDerivations(config.stateDir, run.id, drvs).pipe(
      Effect.provideService(Exec.SpawnerTag, spawner),
      Effect.catch((e) => Effect.logWarning(`could not keep ${run.id}'s derivations from the garbage collector`, e)),
    )

  /** Whether a build output exists here or in the binary cache, which means its derivation built before. */
  const available = (out: string) =>
    Effect.gen(function*() {
      const local = yield* Exec.exec(["nix-store", "--check-validity", out]).pipe(Effect.provideService(Exec.SpawnerTag, spawner))
      return local.exitCode === 0 || (yield* cache.has(out))
    }).pipe(Effect.timeout("20 seconds"), Effect.orElseSucceed(() => false))

  /**
   * Publishes a build output for the other hosts, in the background. Sharing is a convenience: a cache that can't
   * take the output slows no run down and fails none, but the step says so. Promotes to other hosts publish their
   * release themselves.
   */
  const share = (run: Rows.RunRow, step: string, out: string) =>
    Effect.gen(function*() {
      if (yield* cache.has(out)) return
      yield* cache.publish(out)
    }).pipe(
      Effect.catch((e) =>
        Effect.gen(function*() {
          yield* Effect.logWarning(`${run.project} #${run.number} ${step}: publishing ${out} to the binary cache failed`, e)
          yield* db(sql`update steps set publish_error = ${publishFailure(e)} where run_id = ${run.id} and name = ${step}`)
          yield* publishStep(run.id, step)
        })
      ),
      Effect.forkDetach,
      Effect.asVoid,
    )

  /** The project's secrets as their files hold them: a key's format can need its final newline. */
  const readSecrets = (project: string, names: ReadonlyArray<string>) =>
    Object.fromEntries(names.flatMap((name) => {
      const file = projects.get(project)?.secrets[name]
      if (file !== undefined) return [[name, readFileSync(file, "utf8")]]
      if (name === "placement-token" && config.placementKey !== null) return [[name, placementToken(config.placementKey, project)]]
      return []
    }))

  // ----------------------------------------------------------------------------------------- finish

  const finish = (runId: string) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      if (run === undefined) return
      const steps = yield* db(Rows.loadSteps(runId))
      const failed = steps.some((s) => s.status === "failed" || s.status === "died" || s.status === "blocked")
      const cancelled = run.status === "cancelled" || steps.some((s) => s.status === "cancelled")
      const final: Domain.RunStatus = run.status === "errored" ? "errored" : failed ? "failed" : cancelled ? "cancelled" : "passed"
      const now = Date.now()
      yield* db(sql`update runs set status = ${final}, finished_at = coalesce(finished_at, ${now}) where id = ${runId}`)
      // A run cancelled across a restart or while planning can leave steps that never settled.
      const left = yield* db(sql<{ name: string; kind: string }>`update steps set status = 'cancelled', finished_at = ${now}
        where run_id = ${runId} and status in ('pending', 'queued', 'running') returning name, kind`)
      yield* Effect.forEach(left, (s) =>
        Effect.gen(function*() {
          live.finish(runId, s.name)
          yield* publishStep(runId, s.name)
          if (s.kind !== "output") yield* status(run, `calder/${s.name}`, "error", "cancelled")
        }), { concurrency: 4, discard: true })
      const failing = steps.filter((s) => s.status === "failed" || s.status === "died").map((s) => s.name)
      yield* status(
        run,
        "calder",
        final === "passed" ? "success" : final === "failed" ? "failure" : "error",
        final === "passed" ? `passed in ${duration(now - (run.started_at ?? run.created_at))}` : failing.length > 0 ? `failed: ${failing.join(", ")}` : final,
      )
      yield* telemetry.exportSpan({
        traceId: run.trace_id,
        spanId: run.span_id,
        parentId: null,
        name: `${run.project} #${run.number}`,
        start: run.created_at,
        end: now,
        error: final !== "passed",
        attributes: { "calder.project": run.project, "calder.run": run.id, "calder.status": final, "vcs.revision": run.sha },
      })
      cancels.delete(runId)
      supersedes.delete(runId)
      stepped.drop(runId)
      wanted.drop(runId)
      evaluations.delete(runId)
      yield* Outputs.unrootDerivations(config.stateDir, runId).pipe(Effect.catch((e) => Effect.logWarning(`could not drop ${runId}'s derivation roots`, e)))
      yield* publishRun(runId)
      yield* comments.touch(runId)
    }).pipe(Effect.catchCause((cause) => Effect.logError("finish failed", cause)))

  const cancel = (runId: string, reason: string) =>
    Effect.gen(function*() {
      const rows = yield* db(sql<{ id: string }>`update runs set status = 'cancelled', error = ${reason}
        where id = ${runId} and ${sql.in("status", activeStatuses)} returning id`)
      if (rows.length === 0) return
      yield* Deferred.succeed(cancelSignal(runId), reason)
      yield* publishRun(runId)
    })

  const supersede = (runId: string, reason: string) =>
    Effect.gen(function*() {
      const rows = yield* db(sql<{ id: string }>`update runs set status = 'cancelled', error = ${reason}
        where id = ${runId} and ${sql.in("status", activeStatuses)} returning id`)
      if (rows.length === 0) return
      yield* Deferred.succeed(supersedeSignal(runId), reason)
      yield* publishRun(runId)
    })

  const retry = (runId: string, reason: string, options: { readonly only?: ReadonlyArray<string>; readonly quiet?: boolean } = {}) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      if (run === undefined || run.plan === null || run.status === "cancelled") return []
      const ended = (yield* db(Rows.loadSteps(runId))).filter((r) => Rows.terminal(r.status))
      const names = options.only ?? retryable(ended.map((r) => ({ name: r.name, status: r.status, spec: Rows.spec(r) })))
      // An attempt whose row ended still reports it; its status would land after the retry's.
      yield* Effect.forEach(names, (n) => {
        const tail = attempts.get(`${runId}\0${n}`)
        return tail === undefined ? Effect.void : Deferred.await(tail)
      }, { discard: true })
      const reset = yield* db(sql.withTransaction(Effect.gen(function*() {
        const rows = (yield* Rows.loadSteps(runId)).filter((r) => names.includes(r.name) && Rows.terminal(r.status))
        if (rows.length === 0) return []
        const reopened = yield* sql`update runs set status = 'running', finished_at = null, error = null,
            retries = retries + ${options.quiet === true ? 0 : 1}
          where id = ${runId} and status != 'cancelled' returning id`
        if (reopened.length === 0) return []
        const picked = rows.map((r) => r.name)
        // A build counts its infrastructure attempts on from `attempts` (`step`), so one that runs again gets them all again.
        yield* sql`update steps set status = 'pending', started_at = null, finished_at = null, queued_at = null, waiting = null,
            value = null, outputs = null, reused_from = null, error_tag = null, error_message = null, error_json = null, excerpt = null,
            contradicts = null, tests_passed = null, tests_failed = null, tests_skipped = null, tests_flaky = null,
            files_total = null, files_ran = null, files_flaky = null,
            attempts = 0
          where run_id = ${runId} and ${sql.in("name", picked)}`
        yield* sql`delete from tests where run_id = ${runId} and ${sql.in("step", picked)}`
        yield* sql`delete from shards where run_id = ${runId} and ${sql.in("step", picked)} and status != 'passed'`
        return rows
      })))
      if (reset.length === 0) return []
      // A batch evaluation that ended gave what it could; a build that still lacks its derivation evaluates again.
      const evaluated = evaluations.get(runId)
      if (evaluated !== undefined && Deferred.isDoneUnsafe(evaluated)) evaluations.delete(runId)
      for (const r of reset) {
        stepped.reset(runId, r.name)
        yield* publishStep(runId, r.name)
        if (options.quiet === true) continue
        yield* logTo(run, r.name, r.span_id, null)({ _tag: "Log", stream: "calder", text: `runs again: ${reason}`, timestamp: Date.now() })
        if (r.kind !== "output") yield* status(run, `calder/${r.name}`, "pending", "runs again")
      }
      const picked = reset.map((r) => r.name)
      if (options.quiet !== true) yield* status(run, "calder", "pending", `running again: ${picked.join(", ")}`)
      yield* publishRun(runId)
      return picked
    })

  const unblocked = (runId: string) =>
    Effect.gen(function*() {
      const rows = yield* db(Rows.loadSteps(runId))
      const status = new Map(rows.map((r) => [r.name, r.status]))
      // What blocks a step, as `step` decides it: a dependency that ended without passing or being skipped.
      return rows.filter((r) => {
        const spec = Rows.spec(r)
        return r.status === "blocked" &&
          ![...spec.needs, ...spec.after].some((d) => ["failed", "died", "blocked", "cancelled"].includes(status.get(d) ?? "blocked"))
      }).map((r) => r.name)
    })

  const built = (runId: string, name: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadStep(runId, name))
      const build = row === undefined ? null : Rows.spec(row).build
      return build !== null && build.out !== null && (yield* available(build.out))
    })

  /**
   * Plans the default branch's head of `project` afresh, ignoring its footprint records, and drops each
   * record the fresh evaluation contradicts: an attribute whose record held there but evaluated to another
   * derivation. Each mismatch is logged with what the fresh evaluation read that the record didn't, and
   * kept for the UI. The fresh evaluation's own records are kept like a push's.
   */
  const audit = (project: string) =>
    Effect.gen(function*() {
      const p = projects.get(project)
      if (p === undefined) return []
      const branch = p.defaultBranch
      const sha = yield* gitea.head(p.repo, branch)
      yield* mirror.fetch(project)
      const dir = yield* mirror.pipelineDir(project, sha)
      const info: RunInfo = {
        id: `${project}-audit`,
        project,
        number: 0,
        revision: sha,
        branch,
        trust: "trusted",
        event: { _tag: "Push", branch },
        flake: mirror.flake(project, sha),
        mirror: mirror.path(project),
        mirrors: mirror.byUrl(),
        pipelineDir: dir,
        system: config.system,
      }
      const records = yield* db(Rows.records({ project, trust: "trusted", fork: 0 }))
      const job: Job = { _tag: "Plan", run: info, requiredChecks: [], earlier: null, ...(records === undefined ? {} : { records }), audit: true }
      const claim: Slots.Claim = { project, expected: 0, run: Date.now(), label: `${project}'s audit` }
      const { result } = yield* slots.plans.with(claim, jobs.run(job, { pool: "trusted", onEvent: () => Effect.void }))
      if (result._tag !== "Planned") {
        yield* Effect.logWarning(`the audit of ${project} could not plan: ${"message" in result ? result.message : result._tag}`)
        return []
      }
      const mismatches = result.plan.mismatches ?? []
      for (const m of mismatches) {
        // The runs whose plans took this record, such as deploys that may have shipped the wrong derivation.
        const used = m.record === undefined ? [] : yield* db(sql<{ run_id: string }>`select run_id from run_records
          where evaluation = ${m.record} order by run_id`)
        // Until its footprint changes, the attribute isn't recorded again: it would be wrong again.
        if (m.record !== undefined) {
          yield* db(sql`insert into record_blocks (project, attr, digest) select project, attr, digest from evaluations
            where id = ${m.record} on conflict do nothing`)
        }
        yield* db(sql`delete from evaluations where project = ${project} and attr = ${m.attr}`)
        yield* db(sql`insert into audit_mismatches (project, attr, revision, detail, at)
          values (${project}, ${m.attr}, ${sha}, ${JSON.stringify({ ...m, runs: used.map((u) => u.run_id) })}, ${Date.now()})`)
        // infra's CalderFootprintRecordWrong alert matches this line (modules/features/calder/alerts.nix).
        yield* Effect.logError(
          `footprint record wrong: ${project} ${m.attr} at ${sha.slice(0, 12)} evaluated to ${m.evaluated?.drv ?? "nothing"} where its ` +
            `record said ${m.recorded?.drv ?? "nothing"}; runs that took it: ${used.map((u) => u.run_id).join(", ") || "none"}; ` +
            `the fresh evaluation also read ${m.missed.join(", ") || "nothing the record didn't"}`,
        )
      }
      yield* Effect.logInfo(`audited ${project}@${sha.slice(0, 12)}: ${mismatches.length} records contradicted`)
      return mismatches
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`the audit of ${project} failed`, cause).pipe(Effect.as([]))))

  // Every night, each project's default branch head is audited, one project at a time.
  const nextNight = () => {
    const at = new Date()
    at.setHours(3, 30, 0, 0)
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
    return at.getTime() - Date.now()
  }
  yield* Effect.suspend(() => Effect.sleep(nextNight())).pipe(
    Effect.andThen(Effect.forEach(projects.all(), (p) => audit(p.name), { discard: true })),
    Effect.forever,
    Effect.forkScoped,
  )

  return { plan, step, built, finish, cancel, supersede, audit, retry, unblocked }
})).pipe(Layer.provideMerge(Estimates.layer))

