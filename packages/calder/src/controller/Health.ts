import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Config } from "./Config.ts"
import { Projects } from "./Projects.ts"
import { Telemetry } from "./Telemetry.ts"

/** One run of a default branch, oldest first, with the outcome of each step that ended. */
export interface RunOutcomes {
  readonly id: string
  readonly at: number
  /** The event's tag: a step that left the pipeline is gone once a newer run of the same tag planned without it. */
  readonly tag: string
  /** Planned: its steps are all there. Errored: it failed before it planned. */
  readonly plan: "planned" | "errored" | "pending"
  /** Loaded with only some of its steps, so a step it lacks may not have left the pipeline. */
  readonly partial: boolean
  /** Its steps, with whether each passed, failed, or neither (yet). */
  readonly steps: ReadonlyMap<string, { readonly outcome: "passed" | "failed" | null; readonly at: number | null }>
}

/** A step's failures in a row, from the first failed run to the newest, and whether a pass ended them. */
export interface Streak {
  readonly step: string
  readonly since: number
  readonly firstRun: string
  readonly runs: number
  /** A pass of the step comes before it in the runs read, so it can't have started earlier. */
  readonly settled: boolean
  /** When it passed again or left the pipeline; null while it still fails. */
  readonly endedAt: number | null
}

/** What a run that failed before it planned counts as, in parentheses so that no step of a ci.ts is likely to share it. */
export const planStep = "(plan)"

const outcomeOf = (status: string) =>
  status === "passed" || status === "reused" ? "passed" : status === "failed" || status === "died" ? "failed" : null

/**
 * Each step's newest streak of failures over the runs of a default branch. Skipped and blocked steps
 * neither fail nor pass, so a deploy blocked by a failed build counts the build only.
 */
export const streaks = (runs: ReadonlyArray<RunOutcomes>): ReadonlyArray<Streak> => {
  const current = new Map<string, Streak & { readonly tag: string }>()
  const passed = new Set<string>()
  for (const run of runs) {
    const outcomes = [...run.steps].map(([step, s]) => [step, s.outcome, s.at ?? run.at] as const)
    if (run.plan !== "pending") outcomes.push([planStep, run.plan === "planned" ? "passed" : "failed", run.at])
    for (const [step, outcome, at] of outcomes) {
      const streak = current.get(step)
      if (outcome === "failed") {
        current.set(step, streak === undefined || streak.endedAt !== null
          ? { step, since: at, firstRun: run.id, runs: 1, endedAt: null, settled: passed.has(step), tag: run.tag }
          : { ...streak, runs: streak.runs + 1, tag: run.tag })
      } else if (outcome === "passed") {
        passed.add(step)
        if (streak !== undefined && streak.endedAt === null) current.set(step, { ...streak, endedAt: at })
      }
    }
    // A step that left the pipeline ends its streak with the first run of the same event planned without it.
    if (run.plan === "planned" && !run.partial) {
      for (const streak of current.values()) {
        if (streak.endedAt === null && streak.tag === run.tag && streak.step !== planStep && !run.steps.has(streak.step)) {
          current.set(streak.step, { ...streak, endedAt: run.at })
        }
      }
    }
  }
  return [...current.values()].map(({ tag: _, ...streak }) => streak)
}

type Loaded = RunOutcomes & { steps: Map<string, { outcome: "passed" | "failed" | null; at: number | null }> }

/**
 * The steps whose oldest outcome among `runs` is a failure, so their streak may have started earlier, and
 * those of `follow` without an outcome there yet.
 */
const unsettled = (runs: ReadonlyArray<Loaded>, follow: ReadonlyArray<string>) => {
  const oldest = new Map<string, "passed" | "failed">()
  for (const run of runs.toReversed()) {
    if (run.plan !== "pending") oldest.set(planStep, run.plan === "planned" ? "passed" : "failed")
    for (const [step, s] of run.steps) if (s.outcome !== null) oldest.set(step, s.outcome)
  }
  return [
    ...[...oldest].flatMap(([step, outcome]) => (outcome === "failed" ? [step] : [])),
    ...follow.filter((step) => !oldest.has(step)),
  ]
}

/**
 * The trusted runs of a project's default branch since `from`, oldest first: the newest `page` with all
 * their steps, and older ones with only the steps that failed in the oldest run loaded so far, until each
 * of those passed or the runs end. Most steps passed in the newest runs, so this reads little. `follow` are
 * steps to find even when the newest runs lack them, such as a failing step only a nightly schedule runs.
 */
export const load = (project: string, branch: string, from: number, page = 30, follow: ReadonlyArray<string> = []) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    let runs: Array<Loaded> = []
    let wanted: ReadonlyArray<string> | null = null
    while (wanted === null || wanted.length > 0) {
      const before = runs[0]?.at ?? Number.MAX_SAFE_INTEGER
      const names = wanted?.filter((name) => name !== planStep)
      const rows = yield* sql<{
        id: string
        created_at: number
        status: string
        planned_at: number | null
        tag: string
        name: string | null
        step_status: string | null
        finished_at: number | null
      }>`select r.id, r.created_at, r.status, r.planned_at, json_extract(r.event, '$._tag') as tag,
          s.name, s.status as step_status, s.finished_at
        from (select * from runs where project = ${project} and branch = ${branch} and trust = 'trusted'
          and created_at >= ${from} and created_at < ${before} order by created_at desc limit ${wanted === null ? page : page * 4}) r
        left join steps s on s.run_id = r.id ${names === undefined ? sql`` : names.length === 0 ? sql`and 0` : sql`and ${sql.in("s.name", names)}`}
        order by r.created_at, r.id, s.position, s.name`
      if (rows.length === 0) break
      const older: Array<Loaded> = []
      for (const row of rows) {
        let run = older.at(-1)
        if (run?.id !== row.id) {
          run = {
            id: row.id,
            at: row.created_at,
            tag: row.tag,
            plan: row.planned_at !== null ? "planned" : row.status === "errored" ? "errored" : "pending",
            partial: wanted !== null,
            steps: new Map(),
          }
          older.push(run)
        }
        if (row.name !== null) run.steps.set(row.name, { outcome: outcomeOf(row.step_status ?? ""), at: row.finished_at })
      }
      runs = [...older, ...runs]
      wanted = unsettled(runs, follow)
    }
    return runs
  })

/**
 * Gives each streak the start recorded for its step while the runs read can't tell where it started, so
 * a streak older than retention keeps its labels, and records each streak's start and end. Open streaks
 * that `list` lacks, whose step had no outcome in the runs read, end at `now`.
 */
export const anchored = (project: string, list: ReadonlyArray<Streak>, now: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ step: string; first_run: string; since: number; ended_at: number | null }>`select step, first_run, since, ended_at
      from streak_starts where project = ${project}`
    const stored = new Map(rows.map((row) => [row.step, row]))
    const result = yield* Effect.forEach(list, (streak) =>
      Effect.gen(function*() {
        const row = stored.get(streak.step)
        // A row of a streak that ended before this one started says nothing about this one.
        const same = row !== undefined && !streak.settled && (row.ended_at === null || row.ended_at === streak.endedAt)
        const start = same ? { firstRun: row.first_run, since: row.since } : { firstRun: streak.firstRun, since: streak.since }
        if (row?.first_run !== start.firstRun || row.ended_at !== streak.endedAt) {
          yield* sql`insert into streak_starts (project, step, first_run, since, ended_at)
            values (${project}, ${streak.step}, ${start.firstRun}, ${start.since}, ${streak.endedAt})
            on conflict (project, step) do update set first_run = excluded.first_run, since = excluded.since, ended_at = excluded.ended_at`
        }
        return { ...streak, ...start }
      }))
    const listed = new Set(list.map((s) => s.step))
    const lost = rows.filter((row) => row.ended_at === null && !listed.has(row.step)).map((row) => row.step)
    if (lost.length > 0) yield* sql`update streak_starts set ended_at = ${now} where project = ${project} and ${sql.in("step", lost)}`
    return result
  })

/**
 * When each step of the default branch's pipeline last passed or was reused in a trusted run since `from`,
 * or `from` for one that didn't. The steps are those of the newest planned run of each event, each cron
 * its own, so a step that left the pipeline drops out. A deploy that passes only when its target runs the
 * default branch's build says how long that target has lagged.
 */
export const lastPassed = (project: string, branch: string, from: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ step: string; at: number }>`with trusted as (
        select id, created_at, planned_at, json_extract(event, '$._tag') || coalesce(json_extract(event, '$.cron'), '') as tag from runs
        where project = ${project} and branch = ${branch} and trust = 'trusted' and created_at >= ${from}),
      newest as (
        select t.id from trusted t where t.planned_at is not null
          and t.created_at = (select max(n.created_at) from trusted n where n.planned_at is not null and n.tag = t.tag)),
      current as (select distinct name from steps where run_id in (select id from newest))
      select c.name as step, coalesce((select max(s.finished_at) from steps s join trusted t on t.id = s.run_id
          where s.name = c.name and s.status in ('passed', 'reused')), ${from}) as at
      from current c order by c.name`
  })

/** A recovered streak's series stays at 0 this long, so the alert resolves even if a scrape missed the change. */
const keepRecovered = 86_400_000

const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

/**
 * Exports `calder_failing_runs` per step of each default branch: how many of its trusted runs in a row the
 * step failed in, 0 once it passed again. Infra's alert on it messages Hauke once per streak and once more
 * when it ends. Its labels name when and where the streak started, so they hold still while it lasts.
 */
export const layer = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* Config
  const projects = yield* Projects
  const telemetry = yield* Telemetry
  const sql = yield* SqlClient.SqlClient
  const link = (run: string) => `${config.publicUrl.replace(/\/$/, "")}/#/run/${run}`

  const tick = Effect.gen(function*() {
    const now = Date.now()
    const points = []
    const passes = []
    for (const project of projects.all()) {
      const open = yield* sql<{ step: string }>`select step from streak_starts where project = ${project.name} and ended_at is null`
      const from = now - config.retention.days * 86_400_000
      const list = yield* load(project.name, project.defaultBranch, from, 30, open.map((row) => row.step)).pipe(
        Effect.flatMap((runs) => anchored(project.name, streaks(runs), now)),
        Effect.provideService(SqlClient.SqlClient, sql),
      )
      for (const { step, at } of yield* lastPassed(project.name, project.defaultBranch, from).pipe(Effect.provideService(SqlClient.SqlClient, sql))) {
        passes.push({ attributes: { project: project.name, step }, value: Math.floor(at / 1000) })
      }
      for (const streak of list) {
        if (streak.endedAt !== null && now - streak.endedAt > keepRecovered) continue
        points.push({
          attributes: {
            project: project.name,
            step: streak.step,
            since: when.format(streak.since),
            first_run: streak.firstRun,
            url: link(streak.firstRun),
          },
          value: streak.endedAt === null ? streak.runs : 0,
        })
      }
    }
    yield* telemetry.gauge("calder.failing_runs", "Runs of the default branch in a row in which the step failed; 0 once it passed again", points)
    yield* telemetry.gauge("calder.step.last_passed", "Unix seconds when the step last passed in a trusted run of the default branch; the retention window's start if it didn't", passes)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("exporting failing steps failed", cause)))

  yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("20 seconds"), Effect.forkScoped)
}))
