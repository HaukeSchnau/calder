import type { Domain } from "@kiln/api"
import { Context, Deferred, Duration, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256, taskKey } from "../Keys.ts"
import type { Job, JobEvent, JobResult, Outcome, PlannedStep, PlanSpec, RunInfo } from "../Protocol.ts"
import { Config } from "./Config.ts"
import { Gitea, type StatusState } from "./Gitea.ts"
import { type Pool, Jobs, type Usage } from "./Jobs.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import * as Rows from "./Rows.ts"
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
  readonly finish: (runId: string) => Effect.Effect<void>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
}>()("kiln/controller/RunsCore") {}

export const layerCore = Layer.effect(RunsCore)(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* Jobs
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const telemetry = yield* Telemetry.Telemetry
  const slots = {
    plans: Semaphore.makeUnsafe(config.jobs.slots.plans),
    builds: Semaphore.makeUnsafe(config.jobs.slots.builds),
    tasks: Semaphore.makeUnsafe(config.jobs.slots.tasks),
    actions: Semaphore.makeUnsafe(config.jobs.slots.actions),
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
  const workspace = (pool: Pool, project: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const key = `${pool}/${project}`
        const used = workspaces.get(key) ?? new Set<number>()
        workspaces.set(key, used)
        let i = 0
        while (used.has(i)) i++
        used.add(i)
        return { index: i, path: join(config.stateDir, "workspaces", pool, project, String(i)) }
      }),
      (slot) => Effect.sync(() => workspaces.get(`${pool}/${project}`)?.delete(slot.index)),
    )

  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const repoOf = (project: string) => config.projects[project]!.repo
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
      if (row !== undefined) yield* live.publish({ _tag: "StepChanged", step: Rows.step(row) })
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
      const level: Domain.LogLine["level"] = event.stream === "kiln" ? "info" : event.stream === "stderr" && /\berror\b/i.test(event.text) ? "error" : "info"
      live.append(run.id, { step, shard, stream: event.stream, level, timestamp: event.timestamp, text: event.text })
      yield* telemetry.log({
        parent: { traceId: run.trace_id, spanId },
        timestamp: event.timestamp,
        text: event.text,
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
      const { result } = yield* slots.plans.withPermits(1)(
        jobs.run(job, { pool: poolOf(run), onEvent: logTo(run, "plan", run.span_id, null) }),
      )
      live.finish(runId, "plan")
      if (result._tag !== "Planned") {
        return yield* fail(result._tag === "PlanFailed" ? result.message : result._tag === "Died" ? result.message : "planning failed")
      }

      const spec = result.plan
      yield* db(sql.withTransaction(Effect.gen(function*() {
        yield* sql`update runs set plan = ${JSON.stringify(spec)}, status = 'running' where id = ${runId}`
        for (const [position, step] of spec.steps.entries()) {
          yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
            values (${runId}, ${step.name}, ${step.kind}, 'pending', ${JSON.stringify(step)}, ${position}, ${Telemetry.spanId()})
            on conflict do nothing`
        }
        const event = JSON.parse(run.event) as Domain.Event
        if (event._tag === "Push" && event.branch === config.projects[run.project]!.defaultBranch) {
          yield* sql`delete from schedules where project = ${run.project}`
          for (const cron of spec.schedules) yield* sql`insert into schedules (project, cron) values (${run.project}, ${cron})`
        }
      })))
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
  }

  const describe = (s: Settled, row: Rows.StepRow): [StatusState, string] => {
    const took = row.started_at === null ? "" : ` in ${duration(Date.now() - row.started_at)}`
    switch (s.status) {
      case "passed":
        return ["success", `passed${took}`]
      case "reused":
        return ["success", "reused an identical result"]
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
        tests_skipped = ${counted ? tests.filter((t) => t.status === "skipped").length : null}
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

  /** Runs a job unless the run is cancelled first. Actions are never cut short. */
  const execute = (
    run: Rows.RunRow,
    row: Rows.StepRow,
    job: Job,
    options: { readonly slot: Semaphore.Semaphore; readonly action: boolean; readonly shard: number | null },
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
      const work = options.slot.withPermits(1)(
        Effect.andThen(started, jobs.run(job, { pool: poolOf(run), onEvent, uninterruptible: options.action })),
      )
      if (options.action) return yield* work
      const cancelled = Deferred.await(cancelSignal(run.id)).pipe(
        Effect.map((reason) => ({ result: { _tag: "Died", message: reason } satisfies JobResult, usage: { cpuSeconds: null, memoryPeakBytes: null }, id: "", cancelled: true })),
      )
      return yield* Effect.raceFirst(work, cancelled)
    })

  const step = (runId: string, name: string) =>
    Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      const row = yield* db(Rows.loadStep(runId, name))
      if (run === undefined || row === undefined) return "died" as const
      if (Rows.terminal(row.status)) return row.status
      if (run.status === "cancelled") return yield* settle(run, row, { status: "cancelled" })

      const spec = Rows.spec(row)
      const all = yield* db(Rows.loadSteps(runId))
      const byName = new Map(all.map((s) => [s.name, s]))
      if ([...spec.needs, ...spec.after].some((n) => !Rows.succeeded(byName.get(n)?.status ?? "blocked"))) {
        return yield* settle(run, row, { status: "blocked" })
      }
      yield* db(sql`update steps set status = 'queued', queued_at = ${Date.now()} where run_id = ${runId} and name = ${name}`)
      yield* publishStep(runId, name)

      const inputs = Object.fromEntries([...spec.needs, ...spec.exits].map((n) => [n, outcomeOf(byName.get(n)!)]))
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
        const r = yield* execute(run, row, stepJob(), { slot: slots.builds, action: false, shard: null }, collect)
        if ("cancelled" in r) return yield* settle(run, row, { status: "cancelled" })
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: collect.attempts }))
      }

      if (spec.action !== null) {
        const secrets = run.trust === "trusted" ? readSecrets(run.project, spec.action.secrets) : {}
        const r = yield* execute(run, row, stepJob({ secrets }), { slot: slots.actions, action: true, shard: null }, collect)
        return yield* settle(run, row, fromResult(r.result, r.usage, { attempts: collect.attempts }))
      }

      const task = spec.task!
      const values = Object.fromEntries(task.interpolates.map((n) => [n, JSON.parse(byName.get(n)?.value ?? "null")]))
      const count = task.shards ?? 1
      const shardKeys = count === 1 ? [taskKey(task.keyBase, values, null)] : Array.from({ length: count }, (_, i) => taskKey(task.keyBase, values, { index: i + 1, count }))
      const key = count === 1 ? shardKeys[0]! : sha256(shardKeys)
      yield* db(sql`update steps set key = ${key} where run_id = ${runId} and name = ${name}`)

      const reusable = !spec.neverReuse && (plan.reuse === "all" || (plan.reuse === "builds" && task.outputs.length > 0))
      if (reusable) {
        const found = yield* db(sql<{ run_id: string; value: string | null; outputs: string | null }>`select run_id, value, outputs from results
          where key = ${key} and (${run.trust} = 'pr' or trust = 'trusted') order by created_at desc limit 1`)
        const hit = found[0]
        if (hit !== undefined) {
          return yield* settle(run, row, {
            status: "reused",
            value: hit.value === null ? null : JSON.parse(hit.value),
            outputs: JSON.parse(hit.outputs ?? "{}") as Record<string, string>,
            key,
            reusedFrom: hit.run_id,
          })
        }
      }

      const secrets = run.trust === "trusted" ? readSecrets(run.project, task.secrets) : {}
      const shards = yield* Effect.forEach(Array.from({ length: count }, (_, i) => i + 1), (index) =>
        Effect.scoped(Effect.gen(function*() {
          const ws = yield* workspace(poolOf(run), run.project)
          return yield* execute(
            run,
            row,
            stepJob({ workspace: ws.path, secrets, shard: count === 1 ? null : { index, count } }),
            { slot: slots.tasks, action: false, shard: count === 1 ? null : index },
            collect,
          )
        })), { concurrency: "unbounded" })
      if (shards.some((r) => "cancelled" in r)) return yield* settle(run, row, { status: "cancelled" })
      const usage: Usage = {
        cpuSeconds: shards.reduce((sum, r) => sum + (r.usage.cpuSeconds ?? 0), 0),
        memoryPeakBytes: Math.max(0, ...shards.map((r) => r.usage.memoryPeakBytes ?? 0)),
      }
      const failure = shards.find((r) => r.result._tag !== "Passed")
      const settled = fromResult(failure?.result ?? shards[0]!.result, usage, { attempts: collect.attempts, tests: collect.tests })
      return yield* settle(run, row, { ...settled, key })
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

  const readSecrets = (project: string, names: ReadonlyArray<string>) =>
    Object.fromEntries(names.flatMap((name) => {
      const file = config.projects[project]?.secrets[name]
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

  return { plan, step, finish, cancel }
}))

