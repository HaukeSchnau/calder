import type { Domain } from "@kiln/api"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Kiln } from "@kiln/core"
import type { PlannedStep } from "../Protocol.ts"
import * as Values from "../Values.ts"

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
  readonly span_id: string
  readonly tests_passed: number | null
  readonly tests_failed: number | null
  readonly tests_skipped: number | null
}

export const terminal = (status: Domain.StepStatus) =>
  status === "passed" || status === "reused" || status === "failed" || status === "died" || status === "blocked" || status === "cancelled"

export const succeeded = (status: Domain.StepStatus) => status === "passed" || status === "reused"

export const spec = (row: StepRow): PlannedStep => JSON.parse(row.spec) as PlannedStep

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
  finishedAt: row.finished_at,
  error: row.error,
  traceId: row.trace_id,
  counts,
})

const value = (json: string | null): Domain.Value | null => {
  if (json === null) return null
  const parsed = JSON.parse(json) as unknown
  if (parsed === null) return null
  const id = typeof parsed === "object" && parsed !== null && "$kiln" in parsed ? String((parsed as { $kiln: unknown }).$kiln) : null
  const render = id === null ? undefined : Kiln.registry.get(id)?.render
  return {
    type: id,
    render: render?.render ?? null,
    label: render?.label ?? null,
    text: Values.describe(parsed),
    json: parsed,
  }
}

/** Run ids are `<project>-<number>`. */
const runNumber = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1))

export const step = (row: StepRow, expectedMs: number | null = null): Domain.StepRun => {
  const s = spec(row)
  return {
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    key: row.key,
    reusedFrom: row.reused_from === null ? null : { id: row.reused_from, number: runNumber(row.reused_from) },
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
    attempts: row.attempts,
    shards: s.task?.shards ?? null,
    value: value(row.value),
    error: row.error_tag === null ? null : { tag: row.error_tag, message: row.error_message ?? "", excerpt: row.excerpt ?? "" },
    cpuSeconds: row.cpu_seconds,
    memoryPeakBytes: row.memory_peak,
    spanId: row.span_id,
    tests: row.tests_passed === null
      ? null
      : { passed: row.tests_passed, failed: row.tests_failed ?? 0, skipped: row.tests_skipped ?? 0 },
  }
}

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
    const rows = yield* sql<{ run_id: string; status: string; n: number }>`select run_id, status, count(*) as n from steps
      where ${sql.in("run_id", runIds)} and kind != 'output' group by run_id, status`
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
      and status in ('failed', 'timeout') limit 200`
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
