import type { Domain } from "@calder-ci/api"
import { Array as Arr, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Calder } from "@calder-ci/core"
import type { PlannedStep, PlanSpec, Records } from "../Protocol.ts"
import * as Values from "../Values.ts"

/**
 * bun:sqlite blocks the event loop while a statement runs, and a worker drops its connection after five
 * seconds without a ping. Large writes go in pieces with this pause between them, so pings get through.
 */
export const pause = Effect.sleep("50 millis")

/** Writes `rows` a thousand at a time, pausing in between. */
export const inChunks = <A, E, R>(rows: ReadonlyArray<A>, write: (chunk: ReadonlyArray<A>) => Effect.Effect<unknown, E, R>) =>
  Effect.forEach(Arr.chunksOf(rows, 1000), (chunk, i) => Effect.andThen(i === 0 ? Effect.void : pause, write(chunk)), { discard: true })

export interface RunRow {
  readonly id: string
  readonly project: string
  readonly number: number
  readonly event: string
  readonly sha: string
  readonly branch: string | null
  readonly pr: number | null
  readonly title: string | null
  readonly commit_title: string
  readonly author: string
  readonly change_id: string | null
  readonly commit_time: number
  readonly trust: Domain.Trust
  readonly status: Domain.RunStatus
  readonly created_at: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly error: string | null
  readonly trace_id: string
  readonly span_id: string
  readonly plan: string | null
  readonly fork: number
  /** Absent in rows read before migration 0016. */
  readonly planned_at?: number | null
  readonly tree?: string | null
}

export interface StepRow {
  readonly run_id: string
  readonly name: string
  readonly kind: Domain.StepKind
  readonly status: Domain.StepStatus
  readonly spec: string
  readonly position: number
  readonly key: string | null
  readonly reused_from: string | null
  readonly queued_at: number | null
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly attempts: number
  readonly value: string | null
  readonly outputs: string | null
  readonly error_tag: string | null
  readonly error_message: string | null
  readonly error_json: string | null
  readonly excerpt: string | null
  readonly cpu_seconds: number | null
  readonly memory_peak: number | null
  readonly publish_error: string | null
  readonly span_id: string
  readonly tests_passed: number | null
  readonly tests_failed: number | null
  readonly tests_skipped: number | null
  readonly tests_flaky: number | null
  readonly contradicts: string | null
  /** Absent in rows read before migration 0008. */
  readonly files_total?: number | null
  readonly files_ran?: number | null
  readonly files_flaky?: number | null
  /** Absent in rows read before migration 0016. */
  readonly waiting?: string | null
}

export const terminal = (status: Domain.StepStatus) =>
  status === "passed" || status === "reused" || status === "failed" || status === "died" || status === "blocked" || status === "cancelled" ||
  status === "skipped"

export const succeeded = (status: Domain.StepStatus) => status === "passed" || status === "reused"

type Task = NonNullable<PlannedStep["task"]>
type Build = NonNullable<PlannedStep["build"]>

/** Steps planned before setups or per-file tasks existed lack those fields. */
export const spec = (row: StepRow): PlannedStep => {
  const planned = JSON.parse(row.spec) as Omit<PlannedStep, "setup" | "task" | "build"> & {
    readonly setup?: PlannedStep["setup"]
    readonly task: (Omit<Task, "each"> & { readonly each?: Task["each"] }) | null
    readonly build: (Omit<Build, "system"> & { readonly system?: Build["system"] }) | null
  }
  return {
    ...planned,
    setup: planned.setup ?? null,
    task: planned.task === null ? null : { ...planned.task, each: planned.task.each ?? null },
    build: planned.build === null ? null : { ...planned.build, system: planned.build.system ?? null },
  }
}

/**
 * The setups a task starts from. A task asks for them only once it knows it runs, so the workflow
 * doesn't wait for them before the task's step starts.
 */
export const setupsOf = (
  step: { readonly kind: Domain.StepKind; readonly needs: ReadonlyArray<string> },
  kindOf: (name: string) => Domain.StepKind | undefined,
) => (step.kind === "task" ? step.needs.filter((name) => kindOf(name) === "setup") : [])

/**
 * Whether a task, or a file of a task with `each`, may take an earlier result with its key.
 * `reuse: "builds"` runs tasks without outputs again.
 */
export const reusable = (
  step: { readonly neverReuse: boolean; readonly task: { readonly outputs: ReadonlyArray<string> } | null },
  reuse: PlanSpec["reuse"],
) =>
  !step.neverReuse && (reuse === "all" || (reuse === "builds" && (step.task?.outputs.length ?? 0) > 0))

export const run = (row: RunRow, counts: Record<string, number> = {}): Domain.Run => ({
  id: row.id,
  project: row.project,
  number: row.number,
  event: JSON.parse(row.event) as Domain.Event,
  commit: {
    sha: row.sha,
    changeId: row.change_id,
    title: row.commit_title,
    author: row.author,
    timestamp: row.commit_time,
  },
  title: row.title,
  trust: row.trust,
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  plannedAt: row.planned_at ?? null,
  finishedAt: row.finished_at,
  error: row.error,
  traceId: row.trace_id,
  counts,
})

const value = (json: string | null): Domain.Value | null => {
  if (json === null) return null
  const parsed = JSON.parse(json) as unknown
  if (parsed === null) return null
  const id = typeof parsed === "object" && parsed !== null && "$calder" in parsed ? String((parsed as { $calder: unknown }).$calder) : null
  const render = id === null ? undefined : Calder.registry.get(id)?.render
  return {
    type: id,
    render: render?.render ?? null,
    label: render?.label ?? null,
    text: Values.describe(parsed),
    json: parsed,
  }
}

/** Run ids are `<project>-<number>`. */
export const runNumber = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1))

export const step = (row: StepRow, expectedMs: number | null = null): Domain.StepRun => {
  const s = spec(row)
  return {
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    key: row.key,
    reusedFrom: row.reused_from === null ? null : { id: row.reused_from, number: runNumber(row.reused_from) },
    contradicts: row.contradicts === null ? null : { id: row.contradicts, number: runNumber(row.contradicts) },
    needs: s.needs,
    exits: s.exits,
    after: s.after,
    required: s.required,
    target: s.target,
    deploys: s.action?.deploy ?? false,
    detail: s.detail,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    expectedMs,
    platform: s.task?.platform ?? null,
    attempts: row.attempts,
    shards: s.task?.shards ?? null,
    value: value(row.value),
    error: row.error_tag === null ? null : { tag: row.error_tag, message: row.error_message ?? "", excerpt: row.excerpt ?? "" },
    publishError: row.publish_error,
    cpuSeconds: row.cpu_seconds,
    memoryPeakBytes: row.memory_peak,
    spanId: row.span_id,
    tests: row.tests_passed === null
      ? null
      : { passed: row.tests_passed, failed: row.tests_failed ?? 0, skipped: row.tests_skipped ?? 0, flaky: row.tests_flaky ?? 0 },
    files: row.files_total == null ? null : { total: row.files_total, ran: row.files_ran ?? 0, flaky: row.files_flaky ?? 0 },
    outputs: Object.entries(JSON.parse(row.outputs ?? "{}") as Record<string, string>).map(([name, path]) => ({ name, path })),
    waiting: terminal(row.status) ? null : row.waiting ?? null,
    critical: s.critical ?? false,
  }
}

/**
 * Fills in what pending steps wait for, the steps they depend on that haven't settled, where the journal
 * holds no reason of its own.
 */
export const withReasons = (steps: ReadonlyArray<Domain.StepRun>): ReadonlyArray<Domain.StepRun> => {
  const byName = new Map(steps.map((s) => [s.name, s]))
  return steps.map((step) => {
    if (step.status !== "pending" || (step.waiting ?? null) !== null) return step
    const open = [...step.needs, ...step.exits, ...step.after].filter((name) => {
      const dep = byName.get(name)
      return dep !== undefined && !terminal(dep.status) && dep.kind !== "setup"
    })
    return open.length === 0 ? step : { ...step, waiting: `${open.join(", ")} to pass` }
  })
}

/** Whether a task holds a deploy lease: the project's (`true`), or one of the project's named leases. */
export const leased = (task: PlannedStep["task"] | undefined) => (task?.lease ?? false) !== false

/** Whether a step deploys: holds a lease, has a deploy grant, or is a preview's. */
const deploys = (step: PlannedStep) =>
  leased(step.task) || step.task?.preview === true || step.action?.deploy === true || step.action?.preview === true

/**
 * Marks the steps that deploy, those whose values they read, and those they are gated on (a task's
 * `gate`, such as a preview's smoke test) as `critical`: they take the latency lane. Checks a deploy
 * only waits for (`after`) are not, or a push's every check would be. The controller decides this
 * rather than taking the plan's word, and a fork's run has no critical steps.
 */
export const criticalPath = (steps: ReadonlyArray<PlannedStep>, fork: boolean): ReadonlyArray<PlannedStep> => {
  const byName = new Map(steps.map((s) => [s.name, s]))
  const critical = new Set<string>()
  const visit = (name: string) => {
    const step = byName.get(name)
    if (step === undefined || critical.has(name)) return
    critical.add(name)
    for (const dep of [...step.needs, ...(step.gates ?? [])]) visit(dep)
  }
  if (!fork) for (const step of steps) if (deploys(step)) visit(step.name)
  return steps.map((step) => ({ ...step, critical: critical.has(step.name) }))
}

/**
 * The newest plan of another commit with the run's tree, from runs whose results it may reuse: trusted
 * ones and those of same-repo pull requests, which the same people push. A fork's plan never counts,
 * since its sandbox could have written what it likes.
 */
export const earlierPlan = (run: RunRow) =>
  Effect.gen(function*() {
    if (run.tree == null) return null
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ sha: string; plan: string }>`select sha, plan from runs
      where project = ${run.project} and tree = ${run.tree} and sha != ${run.sha} and plan is not null and (trust = 'trusted' or fork = 0)
      order by created_at desc limit 5`
    for (const row of rows) {
      const spec = JSON.parse(row.plan) as PlanSpec
      if (spec.derivations !== undefined) return { revision: row.sha, derivations: spec.derivations, app: spec.app }
    }
    return null
  }).pipe(Effect.orDie)

/**
 * The footprint records a run may trust, newest first, with their footprints. A trusted run and a fork's
 * take only trusted runs' records, since a pull request's ci.ts runs in the worker that records; a
 * same-repo pull request also takes those of same-repo pull requests.
 */
export const records = (run: Pick<RunRow, "project" | "trust" | "fork">) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const trustedOnly = run.trust === "trusted" || run.fork === 1
    const rows = yield* sql<{ id: number; attr: string; footprint: number; count: number; digest: string; derivation: string | null; app: string | null }>`
      select id, attr, footprint, count, digest, derivation, app from evaluations
      where project = ${run.project} and (${trustedOnly ? 1 : 0} = 0 or trust = 'trusted')
      order by created_at desc, id desc`
    if (rows.length === 0) return undefined
    const ids = [...new Set(rows.map((r) => r.footprint))]
    const footprints = yield* sql<{ id: number; revision: string; entries: string }>`select id, revision, entries from footprints
      where ${sql.in("id", ids)}`
    return {
      footprints: footprints.map((f) => ({ id: String(f.id), revision: f.revision, entries: JSON.parse(f.entries) })),
      evaluations: rows.map((r) => ({
        id: r.id,
        attr: r.attr,
        footprint: String(r.footprint),
        count: r.count,
        digest: r.digest,
        derivation: r.derivation === null ? null : JSON.parse(r.derivation),
        ...(r.app === null ? {} : { app: JSON.parse(r.app) as string | null }),
      })),
    } as Records
  }).pipe(Effect.orDie)

/**
 * Whether a run's records may be kept: a pull request's (same-repo only) as pull-request trust, and of
 * trusted runs only the default branch's (its pushes, schedules and manual runs). A push to another branch
 * runs that branch's ci.ts in the trusted worker, so it could forge one.
 */
export const writesRecords = (run: Pick<RunRow, "fork" | "trust" | "event">, defaultBranch: string | undefined) => {
  if (run.fork === 1) return false
  if (run.trust === "pr") return true
  const event = JSON.parse(run.event) as Domain.Event
  return event._tag === "Schedule" || event._tag === "Manual" || (event._tag === "Push" && event.branch === defaultBranch)
}

/**
 * Keeps what a plan or build recorded, if its run may write records (`writesRecords`), except records an
 * audit blocked, and the newest three records per attribute of the project with them.
 */
export const keepRecords = (run: Pick<RunRow, "project" | "fork" | "trust" | "id" | "event">, defaultBranch: string | undefined, recorded: Records) =>
  Effect.gen(function*() {
    if (!writesRecords(run, defaultBranch) || recorded.evaluations.length === 0) return
    const sql = yield* SqlClient.SqlClient
    const blocked = new Set((yield* sql<{ attr: string; digest: string }>`select attr, digest from record_blocks
      where project = ${run.project}`).map((b) => `${b.attr}\0${b.digest}`))
    const now = Date.now()
    yield* sql.withTransaction(Effect.gen(function*() {
      const ids = new Map<string, number>()
      for (const footprint of recorded.footprints) {
        const [row] = yield* sql<{ id: number }>`insert into footprints (project, revision, entries, created_at)
          values (${run.project}, ${footprint.revision}, ${JSON.stringify(footprint.entries)}, ${now}) returning id`
        ids.set(footprint.id, row!.id)
      }
      for (const e of recorded.evaluations) {
        const footprint = ids.get(e.footprint)
        if (footprint === undefined || blocked.has(`${e.attr}\0${e.digest}`)) continue
        yield* sql`insert into evaluations (project, attr, footprint, count, digest, derivation, app, trust, run_id, created_at)
          values (${run.project}, ${e.attr}, ${footprint}, ${e.count}, ${e.digest},
            ${e.derivation === null ? null : JSON.stringify(e.derivation)}, ${e.app === undefined ? null : JSON.stringify(e.app)},
            ${run.trust}, ${run.id}, ${now})`
      }
      yield* sql`delete from evaluations where project = ${run.project} and id not in (select id from (
        select id, row_number() over (partition by attr order by created_at desc, id desc) as n from evaluations
        where project = ${run.project}) where n <= 3)`
      yield* sql`delete from footprints where project = ${run.project} and id not in (select footprint from evaluations
        where project = ${run.project})`
    }))
  }).pipe(Effect.orDie)

export const loadRun = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<RunRow>`select * from runs where id = ${id}`
    return rows[0]
  }).pipe(Effect.orDie)

export const loadSteps = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<StepRow>`select * from steps where run_id = ${runId} order by position`
  }).pipe(Effect.orDie)

export const loadStep = (runId: string, name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<StepRow>`select * from steps where run_id = ${runId} and name = ${name}`
    return rows[0]
  }).pipe(Effect.orDie)

export const counts = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (runIds.length === 0) return new Map<string, Record<string, number>>()
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ run_id: string; status: string; n: number }>`select run_id,
        case when status = 'reused' and files_total = 0 then 'no-files' else status end as status, count(*) as n from steps
      where ${sql.in("run_id", runIds)} and kind != 'output' group by 1, 2`
    const out = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const c = out.get(r.run_id) ?? {}
      c[r.status] = r.n
      out.set(r.run_id, c)
    }
    return out
  }).pipe(Effect.orDie)

export const runsWithCounts = (rows: ReadonlyArray<RunRow>) =>
  Effect.map(counts(rows.map((r) => r.id)), (c) => rows.map((r) => run(r, c.get(r.id) ?? {})))

export interface TestRow {
  readonly run_id: string
  readonly step: string
  readonly suite: string
  readonly name: string
  readonly file: string | null
  readonly status: Domain.TestResult["status"]
  readonly duration_ms: number
  readonly message: string | null
}

export const testResult = (row: TestRow, flaky: boolean): Domain.TestResult => ({
  runId: row.run_id,
  step: row.step,
  suite: row.suite,
  name: row.name,
  file: row.file,
  status: row.status,
  durationMs: row.duration_ms,
  message: row.message,
  flaky,
})

/** Failing tests of a step, without flakiness (that needs history; the run page computes it). */
export const failingTests = (runId: string, step: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<TestRow>`select * from tests where run_id = ${runId} and step = ${step}
      and status in ('failed', 'timeout') and superseded = 0 limit 200`
    return rows.map((r) => testResult(r, false))
  }).pipe(Effect.orDie)

export type DeploymentRow = {
  readonly project: string
  readonly host: string
  readonly revision: string
  readonly store_path: string
  readonly run_id: string
  readonly at: number
}

export const deployment = (row: DeploymentRow): Domain.DeploymentRecord => ({
  project: row.project,
  host: row.host,
  revision: row.revision,
  storePath: row.store_path,
  runId: row.run_id,
  runNumber: runNumber(row.run_id),
  at: row.at,
})
