import { Domain, NotFound, Refused, UiRpcs } from "@kiln/api"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { Agents } from "./Agents.ts"
import { Config } from "./Config.ts"
import * as Fleet from "./Fleet.ts"
import { Gitea } from "./Gitea.ts"
import { Jobs } from "./Jobs.ts"
import { Leases } from "./Leases.ts"
import { Live } from "./Live.ts"
import * as Rows from "./Rows.ts"
import * as Telemetry from "./Telemetry.ts"
import * as Estimates from "./Estimates.ts"
import { type Project, Projects } from "./Projects.ts"
import { Runs } from "./Workflow.ts"


export const handlers = UiRpcs.toLayer(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const live = yield* Live
  const jobs = yield* Jobs
  const agents = yield* Agents
  const leases = yield* Leases
  const fleet = yield* Fleet.Fleet
  const gitea = yield* Gitea
  const runs = yield* Runs
  const enrolled = yield* Projects
  const telemetry = yield* Telemetry.Telemetry
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const statusCache = new Map<string, { at: number; value: Fleet.Status | null }>()
  const cachedStatus = (target: string, project: string) =>
    Effect.gen(function*() {
      const key = `${target}/${project}`
      const hit = statusCache.get(key)
      if (hit !== undefined && Date.now() - hit.at < 15_000) return hit.value
      const value = yield* fleet.status(target, project)
      statusCache.set(key, { at: Date.now(), value })
      return value
    })

  /** The app the project's latest planned release deploys as. */
  const appOf = (project: string) =>
    Effect.map(
      db(sql<{ plan: string }>`select plan from runs where project = ${project} and plan is not null order by created_at desc limit 1`),
      (rows) => (rows[0] === undefined ? null : (JSON.parse(rows[0].plan) as { app?: string | null }).app) ?? project,
    )

  const deployments = (project: Project) =>
    Effect.gen(function*() {
      const app = yield* appOf(project.name)
      return yield* fleet.targets(project, app)
    }).pipe(Effect.flatMap((targets) => Effect.forEach(targets, (target) =>
      Effect.gen(function*() {
        const host = Fleet.hostOf(target)
        const status = yield* cachedStatus(target, project.name)
        const last = yield* db(sql<{ revision: string; store_path: string; at: number }>`select revision, store_path, at from deployments
          where project = ${project.name} and host = ${host} order by at desc limit 1`)
        const holder = leases.holder(project.name)
        const holderJob = holder === undefined ? undefined : jobs.get(holder.job)
        return {
          project: project.name,
          host,
          revision: status?.revision ?? last[0]?.revision ?? null,
          storePath: status?.storePath ?? last[0]?.store_path ?? null,
          pending: status?.pending ?? null,
          previous: status?.previous ?? null,
          since: status?.since ?? last[0]?.at ?? null,
          healthy: status?.healthy ?? null,
          url: null,
          deployingRun: holderJob?.spec.run.id ?? null,
        } satisfies Domain.Deployment
      }), { concurrency: "unbounded" })))

  const flakyKeys = (project: string, tests: ReadonlyArray<{ readonly suite: string; readonly name: string }>) =>
    Effect.gen(function*() {
      const flaky = new Set<string>()
      for (const t of tests) {
        const history = yield* db(sql<{ status: string }>`select status from tests where project = ${project} and suite = ${t.suite}
          and name = ${t.name} order by created_at desc limit 20`)
        const statuses = new Set(history.map((h) => (h.status === "timeout" ? "failed" : h.status)))
        if (statuses.has("passed") && statuses.has("failed")) flaky.add(`${t.suite}\u0000${t.name}`)
      }
      return flaky
    })


  const detail = (id: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadRun(id))
      if (row === undefined) return yield* new NotFound({ what: `run ${id}` })
      const seq = live.seq()
      const [run] = yield* db(Rows.runsWithCounts([row]))
      const estimates = yield* db(Estimates.forProject(row.project))
      const steps = (yield* db(Rows.loadSteps(id))).map((s) => Rows.step(s, estimates.get(s.name) ?? null))
      const failing = yield* db(sql<Rows.TestRow>`select * from tests where run_id = ${id} and status in ('failed', 'timeout') limit 200`)
      const flaky = yield* flakyKeys(row.project, failing)
      const siblings = yield* db(
        row.pr !== null
          ? sql<Rows.RunRow>`select * from runs where project = ${row.project} and pr = ${row.pr} and id != ${id} order by created_at desc limit 10`
          : row.change_id !== null
          ? sql<Rows.RunRow>`select * from runs where project = ${row.project} and change_id = ${row.change_id} and id != ${id}
              order by created_at desc limit 10`
          : sql<Rows.RunRow>`select * from runs where project = ${row.project} and sha = ${row.sha} and id != ${id} order by created_at desc limit 10`,
      )
      return {
        seq,
        run: run!,
        steps,
        failingTests: failing.map((t) => Rows.testResult(t, flaky.has(`${t.suite}\u0000${t.name}`))),
        siblings: yield* db(Rows.runsWithCounts(siblings)),
      } satisfies Domain.RunDetail
    })

  /** Spans from the journal, for when Tempo hasn't ingested the trace yet. */
  const journalSpans = (id: string) =>
    Effect.gen(function*() {
      const row = yield* db(Rows.loadRun(id))
      if (row === undefined) return []
      const steps = yield* db(Rows.loadSteps(id))
      const runSpan: Domain.Span = {
        spanId: row.span_id,
        parentId: null,
        name: `${row.project} #${row.number}`,
        start: row.created_at,
        end: row.finished_at ?? Date.now(),
        status: row.status === "passed" ? "ok" : row.status === "failed" || row.status === "errored" ? "error" : "unset",
        attributes: { "kiln.run": row.id },
      }
      return [
        runSpan,
        ...steps.filter((s) => s.started_at !== null).map((s): Domain.Span => ({
          spanId: s.span_id,
          parentId: row.span_id,
          name: s.name,
          start: s.started_at!,
          end: s.finished_at ?? Date.now(),
          status: s.status === "passed" || s.status === "reused" ? "ok" : s.status === "failed" || s.status === "died" ? "error" : "unset",
          attributes: { "kiln.step": s.name, "kiln.kind": s.kind, "kiln.status": s.status },
        })),
      ]
    })

  return {
    overview: () =>
      Effect.gen(function*() {
        const seq = live.seq()
        const projects = yield* Effect.forEach(enrolled.all(), (project) =>
          Effect.gen(function*() {
            const name = project.name
            const history = yield* db(sql<Rows.RunRow>`select * from runs where project = ${name} and branch = ${project.defaultBranch}
              and pr is null order by created_at desc limit 20`)
            const main = history[0] === undefined ? null : (yield* db(Rows.runsWithCounts([history[0]])))[0]!
            return {
              name,
              repo: project.repo,
              defaultBranch: project.defaultBranch,
              main,
              deployments: yield* deployments(project),
              history: [...history].reverse().map((r) => ({
                id: r.id,
                status: r.status,
                durationMs: r.finished_at === null || r.started_at === null ? null : r.finished_at - r.started_at,
              })),
            } satisfies Domain.Project
          }), { concurrency: "unbounded" })
        const active = yield* db(sql<Rows.RunRow>`select * from runs where status in ('queued', 'planning', 'running') order by created_at desc`)
        const recent = yield* db(sql<Rows.RunRow>`select * from runs order by created_at desc limit 40`)
        const running = jobs.active()
        return {
          seq,
          projects,
          active: yield* db(Rows.runsWithCounts(active)),
          recent: yield* db(Rows.runsWithCounts(recent)),
          slots: {
            tasks: running.filter((j) => !j.remote && j.spec._tag === "Step" && j.spec.workspace !== null).length,
            tasksMax: config.jobs.slots.tasks,
            builds: running.filter((j) => j.spec._tag === "Step" && j.spec.workspace === null).length,
            buildsMax: config.jobs.slots.builds,
          },
          agents: agents.usage(),
        } satisfies Domain.Overview
      }),
    changes: () => live.changes,
    runs: ({ project, pullRequest, limit, before }) =>
      Effect.gen(function*() {
        const rows = yield* db(sql<Rows.RunRow>`select * from runs where 1 = 1
          ${project === undefined ? sql`` : sql`and project = ${project}`}
          ${pullRequest === undefined ? sql`` : sql`and pr = ${pullRequest}`}
          ${before === undefined ? sql`` : sql`and created_at < ${before}`}
          order by created_at desc limit ${Math.min(limit ?? 50, 200)}`)
        return { seq: live.seq(), runs: yield* db(Rows.runsWithCounts(rows)) }
      }),
    run: ({ id }) => detail(id),
    logs: ({ runId, step, follow, limit, before }) =>
      Stream.unwrap(Effect.gen(function*() {
        const row = yield* db(Rows.loadRun(runId))
        if (row === undefined) return Stream.fail(new NotFound({ what: `run ${runId}` }))
        const recent = live.lines(runId, step)
        const all = recent.length > 0 ? recent : yield* telemetry.logs({ run: runId, ...(step === undefined ? {} : { step }) })
        const end = Math.min(before ?? all.length, all.length)
        const start = Math.max(0, end - (limit ?? 5000))
        const page = all.slice(start, end).map((line, i): Domain.LogEntry => ({ ...line, index: start + i }))
        const tail = follow === true && before === undefined && live.running(runId, step)
          ? live.follow(runId, step).pipe(Stream.mapAccum(() => all.length, (index, line) => [index + 1, [{ ...line, index }]] as const))
          : Stream.empty
        return Stream.concat(Stream.fromIterable(page), tail)
      })),
    deployments: ({ project, host, limit }) =>
      db(sql<Rows.DeploymentRow>`
        select * from deployments where project = ${project} ${host === undefined ? sql`` : sql`and host = ${host}`}
        order by at desc limit ${Math.min(limit ?? 50, 500)}`).pipe(Effect.map((rows) => rows.map(Rows.deployment))),
    trace: ({ runId }) =>
      Effect.gen(function*() {
        const row = yield* db(Rows.loadRun(runId))
        if (row === undefined) return yield* new NotFound({ what: `run ${runId}` })
        const spans = yield* telemetry.trace(row.trace_id)
        return spans.length > 0 ? spans : yield* journalSpans(runId)
      }),
    stepStats: ({ project, step }) =>
      Effect.gen(function*() {
        const rows = yield* db(sql<{ run_id: string; status: Domain.StepStatus; started_at: number | null; finished_at: number; queued_at: number | null }>`
          select steps.run_id, steps.status, steps.started_at, steps.finished_at, steps.queued_at from steps
          join runs on runs.id = steps.run_id
          where runs.project = ${project} and steps.name = ${step} and steps.finished_at is not null
          order by steps.finished_at desc limit 50`)
        return {
          project,
          step,
          samples: [...rows].reverse().map((r) => ({
            runId: r.run_id,
            status: r.status,
            durationMs: r.started_at === null ? null : r.finished_at - r.started_at,
            queueMs: r.queued_at === null || r.started_at === null ? null : r.started_at - r.queued_at,
            reused: r.status === "reused",
            finishedAt: r.finished_at,
          })),
        } satisfies Domain.StepStats
      }),
    stepMetrics: ({ runId, step }) =>
      Effect.succeed({
        samples: jobs.active()
          .filter((j) => j.spec._tag === "Step" && j.spec.run.id === runId && j.spec.step === step)
          .flatMap((j) => j.samples),
      } satisfies Domain.Metrics),
    testHistory: ({ project, suite, name }) =>
      Effect.gen(function*() {
        const rows = yield* db(sql<Rows.TestRow>`select * from tests where project = ${project} and suite = ${suite} and name = ${name}
          order by created_at desc limit 30`)
        const flaky = (yield* flakyKeys(project, [{ suite, name }])).size > 0
        return rows.map((r) => Rows.testResult(r, flaky))
      }),
    trigger: ({ project, branch, inputs }) =>
      Effect.gen(function*() {
        const p = enrolled.get(project)
        if (p === undefined) return yield* new NotFound({ what: `project ${project}` })
        const target = branch ?? p.defaultBranch
        const sha = yield* gitea.head(p.repo, target)
        const event: Domain.Event = inputs === undefined ? { _tag: "Push", branch: target } : { _tag: "Manual", inputs }
        return yield* runs.create({ project, event, sha }).pipe(Effect.mapError((e) => new Refused({ reason: e.message })))
      }),
    check: ({ repo, ref, sha }) =>
      Effect.gen(function*() {
        if (!ref.startsWith("kiln/check/")) return yield* new Refused({ reason: "checks are pushed under kiln/check/" })
        const p = yield* enrolled.byRepo(repo)
        if (p === undefined) return yield* new NotFound({ what: `a project for ${repo}` })
        const event: Domain.Event = { _tag: "Check", ref, base: p.defaultBranch }
        return yield* runs.create({ project: p.name, event, sha }).pipe(Effect.mapError((e) => new Refused({ reason: e.message })))
      }),
    cancel: ({ runId }) =>
      Effect.gen(function*() {
        const row = yield* db(Rows.loadRun(runId))
        if (row === undefined) return yield* new NotFound({ what: `run ${runId}` })
        if (!["queued", "planning", "running"].includes(row.status)) return yield* new Refused({ reason: `run is ${row.status}` })
        yield* runs.cancel(runId, "cancelled from the UI")
      }),
    rerun: ({ runId }) =>
      runs.rerun(runId).pipe(Effect.mapError((e) => (e.message.startsWith("no run") ? new NotFound({ what: runId }) : new Refused({ reason: e.message })))),
  }
}))
