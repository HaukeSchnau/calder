import type { Domain } from "@kiln/api"
import { Context, Deferred, Duration, Effect, Exit, Layer, Option } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { sha256, taskKey } from "../Keys.ts"
import type { Job, JobEvent, JobResult, Outcome, PlannedStep, PlanSpec, RunInfo } from "../Protocol.ts"
import { Config } from "./Config.ts"
import * as Each from "./Each.ts"
import * as Estimates from "./Estimates.ts"
import { Gitea, type StatusState } from "./Gitea.ts"
import { type Pool, Jobs, type Usage } from "./Jobs.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"
import * as Slots from "./Slots.ts"
import * as Telemetry from "./Telemetry.ts"

const activeStatuses = ["queued", "planning", "running"] as const

const short = (sha: string) => sha.slice(0, 12)

const duration = (ms: number) => Duration.format(Duration.millis(Math.round(ms / 1000) * 1000))

/**
 * What the run workflow's activities do: plan a revision, execute one step, finish the run. Each reads
 * and writes the journal, so a resumed workflow sees what already happened.
 */
export class RunsCore extends Context.Service<RunsCore, {
  readonly plan: (runId: string) => Effect.Effect<PlanSpec | null>
  readonly step: (runId: string, name: string) => Effect.Effect<Domain.StepStatus>
  /** A build whose output already exists settles at once, without waiting for the builds it uses. */
  readonly built: (runId: string, name: string) => Effect.Effect<boolean>
  readonly finish: (runId: string) => Effect.Effect<void>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
}>()("kiln/controller/RunsCore") {}

/** Terminal colours and titles some tools write even without a terminal; the UI styles lines itself. */
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")

export const layerCore = Layer.effect(RunsCore)(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* Jobs
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const telemetry = yield* Telemetry.Telemetry
  const projects = yield* Projects
  const spawner = yield* Exec.SpawnerTag
  const http = yield* HttpClient.HttpClient
  const slots = {
    plans: Slots.make({ capacity: config.jobs.slots.plans }),
    builds: Slots.make({ capacity: config.jobs.slots.builds }),
    // One project's shards may not take every task slot, so other projects can always start.
    tasks: Slots.make({ capacity: config.jobs.slots.tasks, perProject: Math.max(1, config.jobs.slots.tasks - 1) }),
    actions: Slots.make({ capacity: config.jobs.slots.actions }),
    // Agents limit themselves; this only orders their jobs.
    agents: Slots.make({ capacity: 64 }),
  }
  const cancels = new Map<string, Deferred.Deferred<string>>()
  const cancelSignal = (runId: string) => {
    let d = cancels.get(runId)
    if (d === undefined) {
      d = Deferred.makeUnsafe<string>()
      cancels.set(runId, d)
    }
    return d
  }
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
    // Taken before any run is driven again, or the run would claim the same slots for new jobs.
    const release = (spec.derivation === null ? slots.tasks : slots.builds).reserve(spec.run.project)
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

  const repoOf = (project: string) => projects.get(project)!.repo
  const link = (runId: string) => `${config.publicUrl.replace(/\/$/, "")}/#/run/${runId}`
  const poolOf = (run: Rows.RunRow): Pool => (run.trust === "pr" ? "pr" : "trusted")

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
      const estimates = yield* db(Estimates.forProject(run.project))
      const failingTests = row.status === "failed" ? yield* db(Rows.failingTests(runId, name)) : []
      yield* live.publish({ _tag: "StepChanged", step: Rows.step(row, estimates.get(name) ?? null), failingTests })
    })

  const status = (run: Rows.RunRow, context: string, state: StatusState, description: string) =>
    gitea.status(repoOf(run.project), run.sha, { context, state, description, targetUrl: link(run.id) })

  const runInfo = (run: Rows.RunRow, kilnDir: string): RunInfo => ({
    id: run.id,
    project: run.project,
    number: run.number,
    revision: run.sha,
    branch: run.branch,
    trust: run.trust,
    event: JSON.parse(run.event) as Domain.Event,
    flake: mirror.flake(run.project, run.sha),
    mirror: mirror.path(run.project),
    kilnDir,
    system: config.system,
  })

  const logTo = (run: Rows.RunRow, step: string, spanId: string, shard: number | null) => (event: JobEvent) =>
    Effect.gen(function*() {
      if (event._tag !== "Log") return
      const text = plain(event.text)
      const level: Domain.LogLine["level"] = event.stream === "kiln" ? "info" : event.stream === "stderr" && /\berror\b/i.test(text) ? "error" : "info"
      live.append(run.id, { step, shard, stream: event.stream, level, timestamp: event.timestamp, text })
      yield* telemetry.log({
        parent: { traceId: run.trace_id, spanId },
        timestamp: event.timestamp,
        text,
        level,
        attributes: {
          "kiln.project": run.project,
          "kiln.run": run.id,
          "kiln.step": step,
          "kiln.stream": event.stream,
          ...(shard === null ? {} : { "kiln.shard": String(shard) }),
        },
      })
    })

  // ------------------------------------------------------------------------------------------- plan

  const plan = (runId: string) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      if (run === undefined || run.status === "cancelled") return null
      if (run.plan !== null) return JSON.parse(run.plan) as PlanSpec
      const now = Date.now()
      yield* db(sql`update runs set status = 'planning', started_at = ${now} where id = ${runId}`)
      yield* publishRun(runId)

      const fail = (message: string) =>
        Effect.gen(function*() {
          yield* db(sql`update runs set status = 'errored', error = ${message}, finished_at = ${Date.now()} where id = ${runId}`)
          yield* status(run, "kiln", "error", message.split("\n")[0]!)
          yield* telemetry.exportSpan({
            traceId: run.trace_id,
            spanId: run.span_id,
            parentId: null,
            name: `${run.project} #${run.number}`,
            start: run.created_at,
            end: Date.now(),
            error: true,
            attributes: { "kiln.project": run.project, "kiln.run": run.id, "kiln.error": message },
          })
          yield* publishRun(runId)
          return null
        })

      const kilnDir = yield* mirror.fetch(run.project).pipe(
        Effect.andThen(mirror.kilnDir(run.project, run.sha)),
        Effect.map((dir) => ({ dir, error: null })),
        Effect.catch((e) => Effect.succeed({ dir: null, error: e._tag === "NoPipeline" ? "no .kiln/ci.ts at this revision" : e.message })),
      )
      if (kilnDir.dir === null) return yield* fail(kilnDir.error ?? "could not read the revision")

      const required = run.trust === "trusted" && run.branch !== null ? yield* gitea.requiredChecks(repoOf(run.project), run.branch) : []
      const job: Job = { _tag: "Plan", run: runInfo(run, kilnDir.dir), requiredChecks: required }
      const planned = yield* Effect.raceFirst(
        slots.plans.with(
          { project: run.project, expected: 0, run: run.created_at },
          jobs.run(job, { pool: poolOf(run), onEvent: logTo(run, "plan", run.span_id, null) }),
        ).pipe(Effect.map(Option.some)),
        Deferred.await(cancelSignal(runId)).pipe(Effect.as(Option.none())),
      )
      live.finish(runId, "plan")
      if (Option.isNone(planned)) return null
      const { result } = planned.value
      if (result._tag !== "Planned") {
        return yield* fail(result._tag === "PlanFailed" ? result.message : result._tag === "Died" ? result.message : "planning failed")
      }

      const spec = result.plan
      const event = JSON.parse(run.event) as Domain.Event
      // The default branch's plan says which schedules exist, even when its push runs nothing.
      if (event._tag === "Push" && event.branch === projects.get(run.project)?.defaultBranch) {
        yield* db(sql.withTransaction(Effect.gen(function*() {
          yield* sql`delete from schedules where project = ${run.project}`
          for (const cron of spec.schedules) yield* sql`insert into schedules (project, cron) values (${run.project}, ${cron})`
        })))
      }
      // A push to a branch no rule names, for example: nothing to run, nothing to report.
      if (spec.steps.length === 0) {
        yield* db(sql`delete from runs where id = ${runId}`)
        yield* Effect.logInfo(`${runId} matches no rule, dropped`)
        return null
      }
      // A cancel that came in while the plan job ran wins.
      const stored = yield* db(sql.withTransaction(Effect.gen(function*() {
        const updated = yield* sql`update runs set plan = ${JSON.stringify(spec)}, status = 'running'
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
      yield* status(run, "kiln", "pending", `${spec.steps.filter((s) => s.kind !== "output").length} steps`)
      yield* Effect.forEach(spec.steps.filter((s) => s.kind !== "output"), (s) => status(run, `kiln/${s.name}`, "pending", "waiting"), {
        concurrency: 4,
        discard: true,
      })
      yield* publishRun(runId)
      return spec
    }).pipe(Effect.catchCause((cause) => Effect.logError("plan failed", cause).pipe(Effect.as(null))))

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
  }

  const describe = (s: Settled, row: Rows.StepRow): [StatusState, string] => {
    const took = row.started_at === null ? "" : ` in ${duration(Date.now() - row.started_at)}`
    switch (s.status) {
      case "passed":
        return ["success", `passed${took}`]
      case "reused":
        return ["success", row.kind === "build" ? "already built" : row.kind === "setup" ? "already set up" : "reused an identical result"]
      case "failed":
        return ["failure", s.error?.message.split("\n")[0] ?? "failed"]
      case "died":
        return ["error", s.error?.message.split("\n")[0] ?? "died"]
      case "blocked":
        return ["failure", "blocked by a failed step"]
      default:
        return ["error", s.status]
    }
  }

  const settle = (run: Rows.RunRow, stale: Rows.StepRow, s: Settled) =>
    Effect.gen(function*() {
      // The step's row changed while it ran (started_at, attempts); read it again.
      const row = (yield* db(Rows.loadStep(run.id, stale.name))) ?? stale
      const now = Date.now()
      const failed = s.status === "failed" || s.status === "died"
      const excerpt = failed ? live.excerpt(run.id, row.name) : null
      const tests = s.tests ?? []
      const counted = tests.length > 0
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
        tests_passed = ${counted ? tests.filter((t) => t.status === "passed").length : null},
        tests_failed = ${counted ? tests.filter((t) => t.status === "failed" || t.status === "timeout").length : null},
        tests_skipped = ${counted ? tests.filter((t) => t.status === "skipped").length : null},
        files_total = ${s.files?.total ?? null},
        files_ran = ${s.files?.ran ?? null},
        files_flaky = ${s.files?.flaky ?? null}
        where run_id = ${run.id} and name = ${row.name}`)
      if (counted) {
        yield* db(sql.withTransaction(Effect.forEach(tests, (t) =>
          sql`insert into tests (run_id, project, step, suite, name, file, status, duration_ms, message, created_at)
            values (${run.id}, ${run.project}, ${row.name}, ${t.suite}, ${t.name}, ${t.file}, ${t.status}, ${t.durationMs}, ${t.message}, ${now})`, { discard: true })))
      }
      if (s.status === "passed" && s.key !== undefined && s.key !== null && row.kind === "task") {
        yield* db(sql`insert into results (key, run_id, step, trust, value, outputs, created_at)
          values (${s.key}, ${run.id}, ${row.name}, ${run.trust}, ${JSON.stringify(s.value ?? null)}, ${JSON.stringify(s.outputs ?? {})}, ${now})`)
      }
      live.finish(run.id, row.name)
      yield* publishStep(run.id, row.name)
      if (row.kind !== "output") {
        const [state, description] = describe(s, row)
        yield* status(run, `kiln/${row.name}`, state, description)
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
            "kiln.project": run.project,
            "kiln.run": run.id,
            "kiln.step": row.name,
            "kiln.kind": row.kind,
            "kiln.status": s.status,
            ...(s.key ? { "kiln.key": s.key } : {}),
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
        return { status: "failed", error: { tag: result.tag, message: result.message, json: result.error }, key: result.key, usage, ...extra }
      case "Died":
        return { status: "died", error: { tag: "Died", message: result.message, json: null }, usage, ...extra }
      default:
        return { status: "died", error: { tag: "Died", message: `unexpected ${result._tag}`, json: null }, usage, ...extra }
    }
  }

  /** Where a step of `platform` runs: here, or on an agent, whose workers fetch what local ones read from disk. */
  const place = (run: Rows.RunRow, info: RunInfo, platform: string | null) => {
    const remote = platform !== null && platform !== config.system
    if (remote && run.trust !== "trusted") return null
    const where = remote ? { ...info, flake: "", mirror: `${config.publicUrl}/git/${run.project}.git`, kilnDir: "", system: platform } : info
    return { remote, where }
  }
  const agentsRefuse = (platform: string | null): Settled => ({
    status: "died",
    error: { tag: "Died", message: `${platform} steps run on agents, which only take trusted runs`, json: null },
  })

  type Executed = Effect.Success<ReturnType<typeof execute>>
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
            const passed = Exit.isSuccess(exit) && !("cancelled" in exit.value) && exit.value.result._tag === "Passed"
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
      /** Expected run time in ms, which orders the slot's queue. */
      readonly expected: number
      readonly action: boolean
      readonly shard: number | null
      readonly workspace: boolean
      readonly platform?: string | null
      /** Completing it takes the job out of the queue if it hasn't started; a started job runs on. */
      readonly withdraw?: Deferred.Deferred<void>
    },
    collect: { tests: Array<Extract<JobEvent, { _tag: "Tests" }>["results"][number]>; attempts: number },
  ) =>
    Effect.gen(function*() {
      const onEvent = (event: JobEvent) =>
        Effect.gen(function*() {
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
        yield* db(sql`update steps set status = 'running', started_at = coalesce(started_at, ${Date.now()}), attempts = max(attempts, 1)
          where run_id = ${run.id} and name = ${row.name}`)
        yield* publishStep(run.id, row.name)
        yield* status(run, `kiln/${row.name}`, "pending", "running")
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
      const running = Effect.scoped(Effect.gen(function*() {
        const remote = options.platform != null && options.platform !== config.system
        const ws = options.workspace ? (yield* workspace(poolOf(run), run.project, remote)).path : null
        startedAt = Date.now()
        yield* started
        const done = yield* jobs.run(job(ws), {
          pool: poolOf(run),
          onEvent,
          uninterruptible: options.action,
          platform: options.platform ?? null,
          adoptable: !options.action,
        })
        return { ...done, startedAt }
      }))
      const work = reattached ?? options.slots.with({ project: run.project, expected: options.expected, run: run.created_at }, running)
      if (options.action) return yield* work
      const stopped = { usage: { cpuSeconds: null, memoryPeakBytes: null }, id: "", startedAt: null }
      const cancelled = Deferred.await(cancelSignal(run.id)).pipe(
        Effect.map((reason) => ({ ...stopped, result: { _tag: "Died", message: reason } satisfies JobResult, cancelled: true as const })),
      )
      const withdrawn = options.withdraw === undefined ? Effect.never : Deferred.await(options.withdraw).pipe(
        Effect.andThen(Effect.suspend(() => startedAt === null ? Effect.void : Effect.never)),
        Effect.as({ ...stopped, result: { _tag: "Died", message: "withdrawn" } satisfies JobResult, withdrawn: true as const }),
      )
      return yield* Effect.raceFirst(work, Effect.raceFirst(cancelled, withdrawn))
    })

  const step = (runId: string, name: string) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      const row = yield* db(Rows.loadStep(runId, name))
      if (run === undefined || row === undefined) return "died" as const
      if (Rows.terminal(row.status)) return row.status
      if (run.status === "cancelled") return yield* settle(run, row, { status: "cancelled" })

      const spec = Rows.spec(row)
      if (spec.build !== null && spec.build.drv !== null && spec.build.out !== null && (yield* available(spec.build.out))) {
        return yield* settle(run, row, { status: "reused", value: spec.build.out, key: spec.build.drv })
      }
      const all = yield* db(Rows.loadSteps(runId))
      const byName = new Map(all.map((s) => [s.name, s]))
      if ([...spec.needs, ...spec.after].some((n) => !Rows.succeeded(byName.get(n)?.status ?? "blocked"))) {
        return yield* settle(run, row, { status: "blocked" })
      }
      yield* db(sql`update steps set status = 'queued', queued_at = ${Date.now()} where run_id = ${runId} and name = ${name}`)
      yield* publishStep(runId, name)

      const inputs = Object.fromEntries([...spec.needs, ...spec.exits].map((n) => [n, outcomeOf(byName.get(n)!)]))
      const expected = Estimates.of(yield* db(Estimates.forProject(run.project)), name)
      const plan = JSON.parse(run.plan ?? "{}") as PlanSpec
      const kilnDir = yield* mirror.kilnDir(run.project, run.sha).pipe(Effect.orDie)
      const info = runInfo(run, kilnDir)
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
        const { drv } = spec.build
        const r = yield* execute(run, row, () => stepJob({ derivation: drv }), { slots: slots.builds, expected, action: false, shard: null, workspace: false }, collect)
        if ("cancelled" in r) return yield* settle(run, row, { status: "cancelled" })
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: collect.attempts }))
      }

      if (spec.setup !== null) {
        const { deps, platform } = spec.setup
        const placed = place(run, info, platform)
        if (placed === null) return yield* settle(run, row, agentsRefuse(platform))
        const { executed, reused } = yield* once(
          `${poolOf(run)}/${run.project}/${platform ?? config.system}/${deps}`,
          execute(run, row, (ws) => stepJob({ run: placed.where, workspace: ws, deps }), {
            slots: placed.remote ? slots.agents : slots.tasks,
            // Every task of the run waits for it.
            expected: 0,
            action: false,
            shard: null,
            workspace: true,
            platform,
          }, collect),
        )
        if ("cancelled" in executed) return yield* settle(run, row, { status: "cancelled" })
        const settled = fromResult(executed.result, executed.usage, { attempts: collect.attempts })
        const fresh = executed.result._tag === "Passed" && (executed.result.value as { readonly fresh?: boolean } | null)?.fresh === true
        // Nothing ran when a prepared copy existed or another run prepared it.
        return yield* settle(run, row, settled.status === "passed" && (reused || !fresh) ? { status: "reused", key: deps } : settled)
      }

      if (spec.action !== null) {
        const secrets = run.trust === "trusted" ? readSecrets(run.project, spec.action.secrets) : {}
        const r = yield* execute(run, row, () => stepJob({ secrets }), { slots: slots.actions, expected, action: true, shard: null, workspace: false }, collect)
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: collect.attempts }))
      }

      const task = spec.task!
      const values = Object.fromEntries(task.interpolates.map((n) => [n, JSON.parse(byName.get(n)?.value ?? "null")]))
      if (task.each !== null) return yield* eachTask(run, row, task, task.each, values, { plan, info, stepJob, collect })
      const count = task.shards ?? 1
      const shardKeys = count === 1 ? [taskKey(task.keyBase, values, null)] : Array.from({ length: count }, (_, i) => taskKey(task.keyBase, values, { index: i + 1, count }))
      const key = count === 1 ? shardKeys[0]! : sha256(shardKeys)
      yield* db(sql`update steps set key = ${key} where run_id = ${runId} and name = ${name}`)

      const reusable = !spec.neverReuse && (plan.reuse === "all" || (plan.reuse === "builds" && task.outputs.length > 0))
      // Pull-request runs take any result. Trusted runs take trusted ones, and with reuse "all" also
      // those of same-repo pull requests, which the same people push.
      const prResults = run.trust === "pr" || plan.reuse === "all"
      const lookup = (k: string) =>
        db(sql<{ run_id: string; value: string | null; outputs: string | null }>`select results.run_id, results.value,
            results.outputs from results join runs on runs.id = results.run_id
          where results.key = ${k} and (results.trust = 'trusted' or (${prResults ? 1 : 0} = 1 and runs.fork = 0))
          order by results.created_at desc limit 1`).pipe(Effect.map((rows) => rows[0]))
      const reused = (hit: { run_id: string; value: string | null; outputs: string | null }): Settled => ({
        status: "reused",
        value: hit.value === null ? null : JSON.parse(hit.value),
        outputs: JSON.parse(hit.outputs ?? "{}") as Record<string, string>,
        key,
        reusedFrom: hit.run_id,
      })
      if (reusable) {
        const hit = yield* lookup(key)
        if (hit !== undefined) return yield* settle(run, row, reused(hit))
      }

      const secrets = run.trust === "trusted" ? readSecrets(run.project, task.secrets) : {}
      const placed = place(run, info, task.platform)
      if (placed === null) return yield* settle(run, row, agentsRefuse(task.platform))
      const { remote, where } = placed
      const sharded = count > 1
      // Shards that passed with the same key before don't run again.
      const shardHits = reusable && sharded ? yield* Effect.forEach(shardKeys, lookup) : shardKeys.map(() => undefined)
      for (const [i, hit] of shardHits.entries()) {
        if (hit === undefined) continue
        yield* db(sql`insert or replace into shards (run_id, step, shard, key, status, reused_from)
          values (${runId}, ${name}, ${i + 1}, ${shardKeys[i]!}, 'reused', ${hit.run_id})`)
      }
      const perShard = sharded ? (yield* db(Estimates.shardsForProject(run.project))).get(name) ?? expected : expected
      const withdraw = Deferred.makeUnsafe<void>()
      let failed = false
      const pending = shardHits.flatMap((hit, i) => (hit === undefined ? [i + 1] : []))
      const shards = yield* Effect.forEach(pending, (index) =>
        Effect.gen(function*() {
          const r = yield* execute(
            run,
            row,
            (ws) => stepJob({ run: where, workspace: ws, secrets, shard: sharded ? { index, count } : null, deps: task.deps }),
            {
              slots: remote ? slots.agents : slots.tasks,
              expected: perShard,
              action: false,
              shard: sharded ? index : null,
              workspace: true,
              platform: task.platform,
              withdraw,
            },
            collect,
          )
          if (!sharded || "cancelled" in r || "withdrawn" in r) return r
          const passed = r.result._tag === "Passed"
          const now = Date.now()
          yield* db(sql`insert or replace into shards (run_id, step, shard, key, status, started_at, finished_at, cpu_seconds, memory_peak)
            values (${runId}, ${name}, ${index}, ${shardKeys[index - 1]!}, ${passed ? "passed" : "failed"}, ${r.startedAt}, ${now},
              ${r.usage.cpuSeconds}, ${r.usage.memoryPeakBytes})`)
          if (r.result._tag === "Passed") {
            yield* db(sql`insert into results (key, run_id, step, trust, value, outputs, created_at)
              values (${shardKeys[index - 1]!}, ${runId}, ${name}, ${run.trust}, ${JSON.stringify(r.result.value ?? null)},
                ${JSON.stringify(r.result.outputs ?? {})}, ${now})`)
          } else if (!failed) {
            // Shards still waiting stay out of it; running ones finish, so a rerun repeats only what failed.
            failed = true
            yield* Deferred.succeed(withdraw, undefined)
            yield* status(run, `kiln/${name}`, "failure", `shard ${index} of ${count} failed; the running shards finish first`)
          }
          return r
        }), { concurrency: "unbounded" })
      if (shards.some((r) => "cancelled" in r)) return yield* settle(run, row, { status: "cancelled" })
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
          return yield* settle(run, row, { status: "died", error: { tag: "Died", message: `Kiln failed to run the step: ${String(cause)}`, json: null } })
        })
      ),
    )

  type TaskSpec = NonNullable<PlannedStep["task"]>
  type TestRow = Extract<JobEvent, { _tag: "Tests" }>["results"][number]

  /**
   * A task with `each`: files whose key passed before don't run, except `always` files. The rest run in
   * up to `shards` jobs split by their recorded durations; files that fail run once more, and a pass
   * then counts as flaky. A nightly run without reuse checks that the keys still cover what files read.
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
    },
  ) =>
    Effect.gen(function*() {
      const keys = new Map(each.map((e) => [e.file, task.interpolates.length === 0 ? e.key : taskKey(e.key, values, null)]))
      const key = sha256([...keys.values()])
      yield* db(sql`update steps set key = ${key} where run_id = ${run.id} and name = ${row.name}`)
      const reusable = !Rows.spec(row).neverReuse && context.plan.reuse !== "none"
      const prResults = run.trust === "pr" || context.plan.reuse === "all"

      const passed = new Map<string, string>()
      if (reusable) {
        const all = [...keys.values()]
        for (let i = 0; i < all.length; i += 400) {
          const hits = yield* db(sql<{ key: string; run_id: string }>`select file_results.key, file_results.run_id
            from file_results join runs on runs.id = file_results.run_id
            where ${sql.in("file_results.key", all.slice(i, i + 400))} and file_results.status in ('passed', 'flaky')
              and (file_results.trust = 'trusted' or (${prResults ? 1 : 0} = 1 and runs.fork = 0))`)
          for (const hit of hits) passed.set(hit.key, hit.run_id)
        }
      }
      const misses = each.filter((e) => e.always || !passed.has(keys.get(e.file)!)).map((e) => e.file)
      if (misses.length === 0) {
        const from = passed.values().next().value ?? null
        return yield* settle(run, row, { status: "reused", value: null, key, reusedFrom: from, files: { total: each.length, ran: 0, flaky: 0 } })
      }

      const placed = place(run, context.info, task.platform)
      if (placed === null) return yield* settle(run, row, agentsRefuse(task.platform))
      const secrets = run.trust === "trusted" ? readSecrets(run.project, task.secrets) : {}

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
          const r = yield* execute(
            run,
            row,
            (ws) => context.stepJob({ run: placed.where, workspace: ws, secrets, shard: { index, count: total }, deps: task.deps, files }),
            { slots: placed.remote ? slots.agents : slots.tasks, expected: ms, action: false, shard: index, workspace: true, platform: task.platform },
            mine,
          )
          context.collect.tests.push(...mine.tests)
          context.collect.attempts = Math.max(context.collect.attempts, mine.attempts)
          return { r, tests: mine.tests, files }
        })
      const outcomes = (done: { readonly r: { readonly result: JobResult }; readonly tests: ReadonlyArray<TestRow>; readonly files: ReadonlyArray<string> }) =>
        Each.outcomes(done.files, done.tests, done.r.result._tag === "Passed")

      const first = yield* Effect.forEach(bins.map((b, i) => [b, i] as const), ([b, i]) => job(b.files, i + 1, count, b.ms), { concurrency: "unbounded" })
      if (first.some((d) => "cancelled" in d.r)) return yield* settle(run, row, { status: "cancelled" })
      const results = new Map(first.flatMap((d) => [...outcomes(d)]))
      const failing = [...results].filter(([, o]) => o.status === "failed").map(([file]) => file)
      const flaky = new Set<string>()
      let retry: (typeof first)[number] | undefined
      if (failing.length > 0 && failing.length <= 10) {
        retry = yield* job(failing, count + 1, count, failing.reduce((sum, f) => sum + duration(f), 0))
        if ("cancelled" in retry.r) return yield* settle(run, row, { status: "cancelled" })
        for (const [file, o] of outcomes(retry)) {
          if (o.status === "passed") flaky.add(file)
          results.set(file, o.status === "passed" ? { ...o, status: "passed" } : results.get(file)!)
        }
      }

      const now = Date.now()
      const known = [...results].filter(([, o]) => o.status !== "unknown")
      yield* db(sql.withTransaction(Effect.forEach(known, ([file, o]) =>
        sql`insert into file_results (key, project, step, file, run_id, trust, status, duration_ms, created_at)
          values (${keys.get(file)!}, ${run.project}, ${row.name}, ${file}, ${run.id}, ${run.trust},
            ${flaky.has(file) ? "flaky" : o.status}, ${o.ms}, ${now})`, { discard: true })))

      const jobs = retry === undefined ? first : [...first, retry]
      const usage: Usage = {
        cpuSeconds: jobs.reduce((sum, d) => sum + (d.r.usage.cpuSeconds ?? 0), 0),
        memoryPeakBytes: Math.max(0, ...jobs.map((d) => d.r.usage.memoryPeakBytes ?? 0)),
      }
      const extra = { attempts: context.collect.attempts, tests: context.collect.tests, files: { total: each.length, ran: misses.length, flaky: flaky.size } }
      const bad = [...results].filter(([, o]) => o.status !== "passed").map(([file]) => file)
      if (bad.length > 0) {
        const failed = jobs.find((d) => d.r.result._tag !== "Passed" && d.files.some((f) => bad.includes(f)))
        const result: JobResult = failed?.r.result ?? { _tag: "Died", message: `no result for ${bad.join(", ")}` }
        return yield* settle(run, row, { ...fromResult(result, usage, extra), key })
      }
      if (flaky.size > 0) yield* Effect.logInfo(`${run.id} ${row.name}: ${[...flaky].join(", ")} passed on retry`)
      return yield* settle(run, row, { status: "passed", value: null, key, usage, ...extra })
    })

  /** Whether a build output exists here or in the binary cache, which means its derivation built before. */
  const available = (out: string) =>
    Effect.gen(function*() {
      const local = yield* Exec.exec(["nix-store", "--check-validity", out]).pipe(Effect.provideService(Exec.SpawnerTag, spawner))
      if (local.exitCode === 0) return true
      const hash = /^\/nix\/store\/([a-z0-9]{32})-/.exec(out)?.[1]
      if (hash === undefined) return false
      const response = yield* http.head(`${config.cacheUrl.replace(/\/$/, "")}/${hash}.narinfo`)
      return response.status === 200
    }).pipe(Effect.timeout("20 seconds"), Effect.orElseSucceed(() => false))

  const readSecrets = (project: string, names: ReadonlyArray<string>) =>
    Object.fromEntries(names.flatMap((name) => {
      const file = projects.get(project)?.secrets[name]
      return file === undefined ? [] : [[name, readFileSync(file, "utf8").trim()]]
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
          if (s.kind !== "output") yield* status(run, `kiln/${s.name}`, "error", "cancelled")
        }), { concurrency: 4, discard: true })
      const failing = steps.filter((s) => s.status === "failed" || s.status === "died").map((s) => s.name)
      yield* status(
        run,
        "kiln",
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
        attributes: { "kiln.project": run.project, "kiln.run": run.id, "kiln.status": final, "vcs.revision": run.sha },
      })
      cancels.delete(runId)
      yield* publishRun(runId)
    }).pipe(Effect.catchCause((cause) => Effect.logError("finish failed", cause)))

  const cancel = (runId: string, reason: string) =>
    Effect.gen(function*() {
      const rows = yield* db(sql<{ id: string }>`update runs set status = 'cancelled', error = ${reason}
        where id = ${runId} and ${sql.in("status", activeStatuses)} returning id`)
      if (rows.length === 0) return
      yield* Deferred.succeed(cancelSignal(runId), reason)
      yield* publishRun(runId)
    })

  const built = (runId: string, name: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadStep(runId, name))
      const build = row === undefined ? null : Rows.spec(row).build
      return build !== null && build.out !== null && (yield* available(build.out))
    })

  return { plan, step, built, finish, cancel }
}))

