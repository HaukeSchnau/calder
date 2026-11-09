import { Domain } from "@calder-ci/api"
import { Context, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { span } from "../Cli.ts"
import { Config } from "./Config.ts"
import { Gitea } from "./Gitea.ts"
import { Mirror } from "./Mirror.ts"
import { type Project, Projects } from "./Projects.ts"
import type * as Rows from "./Rows.ts"
import { Runs } from "./Workflow.ts"

const day = 86_400_000

/** Where a run failed, for people: its failed steps with the first line of why, or why it couldn't plan. */
export const failure = (run: Pick<Rows.RunRow, "error">, steps: ReadonlyArray<{ readonly name: string; readonly error_message: string | null }>) => {
  if (steps.length === 0) return run.error === null ? "failed" : `failed before it planned: ${run.error.split("\n")[0]!.slice(0, 200)}`
  const [first, ...rest] = steps
  const why = first!.error_message === null ? "" : `: ${first!.error_message.split("\n")[0]!.slice(0, 200)}`
  return `failed at \`${first!.name}\`${why}${rest.length === 0 ? "" : ` (and ${rest.map((s) => `\`${s.name}\``).join(", ")})`}`
}

/**
 * The newest passed run of the default branch that deployed. A push runs the branch's whole pipeline. A
 * schedule or manual run, such as a nightly, may run only checks, and a closed pull request's run at the
 * merge only cleans up: they count when they deploy.
 */
export const deployedRun = (project: Project) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string; sha: string; finished_at: number }>`select id, sha, finished_at from runs
      where project = ${project.name} and branch = ${project.defaultBranch} and trust = 'trusted' and status = 'passed'
        and (event like ${'{"_tag":"Push"%'} or ((event like ${'{"_tag":"Schedule"%'} or event like ${'{"_tag":"Manual"%'})
          and exists (select 1 from steps where steps.run_id = runs.id and json_extract(steps.spec, '$.critical') = 1)))
      order by created_at desc limit 1`
    return rows[0]
  })

/** How long after the head's `attempt`th failed run Calder reruns it: 10 minutes, doubling up to 6 hours. */
export const backoff = (attempt: number) => Math.min(10 * 60_000 * 2 ** (attempt - 1), 6 * 3_600_000)

/**
 * Where a project whose pushes deploy stands, null for one whose don't: what is deployed and how far the
 * head is ahead, and whether the head's push run ended without deploying it. While it failed on its deploy's critical path, it
 * reruns that run once its backoff passed, unless the project opts out; a failed check isn't retried.
 */
export const converge = (project: Project, now: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const gitea = yield* Gitea
    const mirror = yield* Mirror
    const runs = yield* Runs
    const pushes = sql`project = ${project.name} and branch = ${project.defaultBranch} and trust = 'trusted' and event like ${'{"_tag":"Push"%'}`
    /** Whether the run has a step on a deploy's critical path, one that ended `failing` if given. */
    const critical = (run: string, failing = false) =>
      Effect.map(sql`select 1 from steps where run_id = ${run} and json_extract(spec, '$.critical') = 1
        ${failing ? sql`and status in ('failed', 'died')` : sql``} limit 1`, (rows) => rows.length > 0)

    const [planned] = yield* sql<{ id: string }>`select id from runs where ${pushes} and planned_at is not null order by created_at desc limit 1`
    if (planned === undefined || !(yield* critical(planned.id))) return null
    const head = yield* gitea.head(project.repo, project.defaultBranch)
    const deployed = yield* deployedRun(project)
    const delivery = { head, revision: deployed?.sha ?? null, behind: null, stalled: false, retry: null }
    if (deployed?.sha === head) return delivery

    const ahead = deployed === undefined ? [] : yield* mirror.between(project.name, deployed.sha, head).pipe(
      Effect.catch(() => mirror.fetch(project.name).pipe(Effect.andThen(mirror.between(project.name, deployed.sha, head)))),
      Effect.orElseSucceed(() => []),
    )
    const behind = ahead.length === 0 ? null : { commits: ahead.length, since: ahead.at(-1)!.at }

    const tries = yield* sql<{ id: string; status: Domain.RunStatus; finished_at: number | null }>`select id, status, finished_at from runs
      where ${pushes} and sha = ${head} order by created_at desc`
    const last = tries[0]
    const stalled = last !== undefined && Domain.ended.has(last.status)
    const state = { ...delivery, behind, stalled }
    if (last === undefined || last.finished_at === null || (last.status !== "failed" && last.status !== "errored") || project.retryDeploys === false) {
      return state
    }
    // A rerun that failed before it planned, such as when its plan's worker died, repeats the last one that ran.
    const ran = last.status === "failed" ? last : tries.find((t) => t.status === "failed")
    if (ran === undefined || !(yield* critical(ran.id, true))) return state
    const attempt = tries.filter((t) => t.status === "failed" || t.status === "errored").length
    const at = last.finished_at + backoff(attempt)
    if (now < at) return { ...state, retry: { runId: ran.id, at, attempt } }
    const again = yield* runs.rerun(ran.id)
    yield* Effect.logInfo(`${project.name}'s deploy of ${head.slice(0, 12)} failed ${attempt} times; rerunning ${ran.id} as ${again.id}`)
    return state
  })

/**
 * Comments on a merged pull request whose run on the default branch failed, so "merged" doesn't read as
 * "shipped", and edits the comment once a run that includes the merge passes.
 */
export const tick = (now: number, looked: Set<string> = new Set()) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const config = yield* Config
    const gitea = yield* Gitea
    const mirror = yield* Mirror
    const projects = yield* Projects
    const link = (run: string) => `[run ${run.slice(run.lastIndexOf("-") + 1)}](${config.publicUrl.replace(/\/$/, "")}/#/run/${run})`

    for (const project of projects.all()) {
      yield* Effect.gen(function*() {
        const passed = yield* deployedRun(project)
        const shipped = (sha: string) => passed === undefined ? Effect.succeed(false) : mirror.contains(project.name, passed.sha, sha)

        // Only failures of the last day: a controller that starts doesn't comment on merges long past.
        const failed = yield* sql<Rows.RunRow>`select * from runs
          where project = ${project.name} and branch = ${project.defaultBranch} and trust = 'trusted'
            and event like ${'{"_tag":"Push"%'} and status in ('failed', 'errored') and finished_at >= ${now - day}
            and sha not in (select sha from shipments where project = ${project.name})
          order by created_at`
        for (const run of failed) {
          // A direct push has no pull request to tell, and asking Gitea once per run is enough.
          if (looked.has(run.id)) continue
          yield* Effect.gen(function*() {
            if (yield* shipped(run.sha)) return
            const pr = yield* gitea.mergedPull(project.repo, run.sha)
            if (pr === null) {
              looked.add(run.id)
              return
            }
            const steps = yield* sql<{ name: string; error_message: string | null }>`select name, error_message from steps
              where run_id = ${run.id} and status in ('failed', 'died') order by position`
            const body = `**Merged, not shipped yet.** ${link(run.id)} of this merge on \`${project.defaultBranch}\` ${failure(run, steps)}.\n\n` +
              "Calder edits this comment once a run that includes this merge passes."
            const id = yield* gitea.comment(project.repo, pr, body, null)
            yield* sql`insert into shipments (project, sha, pr, run_id, comment_id) values (${project.name}, ${run.sha}, ${pr}, ${run.id}, ${id})
              on conflict do nothing`
          }).pipe(Effect.catchCause((cause) => Effect.logWarning(`telling the pull request of ${run.id} failed`, cause)))
        }

        if (passed === undefined) return
        const open = yield* sql<{ sha: string; pr: number; run_id: string; comment_id: number }>`select sha, pr, run_id, comment_id
          from shipments where project = ${project.name} and shipped_run is null`
        for (const row of open) {
          yield* Effect.gen(function*() {
            if (!(yield* shipped(row.sha))) return
            const [failedRun] = yield* sql<{ finished_at: number | null }>`select finished_at from runs where id = ${row.run_id}`
            const after = failedRun?.finished_at == null ? "" : `, ${span(passed.finished_at - failedRun.finished_at)} after ${link(row.run_id)} failed`
            yield* gitea.comment(project.repo, row.pr, `**Shipped.** ${link(passed.id)} passed with this merge${after}.`, row.comment_id)
            yield* sql`update shipments set shipped_run = ${passed.id} where project = ${project.name} and sha = ${row.sha}`
          }).pipe(Effect.catchCause((cause) => Effect.logWarning(`telling pull request #${row.pr} of ${project.name} it shipped failed`, cause)))
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`following ${project.name}'s merges failed`, cause)))
    }
  })

/** Where each deploying project's default branch stands, as of the last minute. */
export class Delivery extends Context.Service<Delivery, {
  readonly status: (project: string) => Domain.Delivery | null
}>()("calder/controller/Delivery") {}

export const layer = Layer.effect(Delivery)(Effect.gen(function*() {
  const context = yield* Effect.context<SqlClient.SqlClient | Config | Gitea | Mirror | Projects | Runs>()
  const projects = yield* Projects
  const looked = new Set<string>()
  const states = new Map<string, Domain.Delivery | null>()
  const round = Effect.gen(function*() {
    const now = Date.now()
    yield* tick(now, looked)
    for (const project of projects.all()) {
      yield* converge(project, now).pipe(
        Effect.tap((state) => Effect.sync(() => states.set(project.name, state))),
        Effect.catchCause((cause) => Effect.logWarning(`following ${project.name}'s deploys failed`, cause)),
      )
    }
  })
  yield* round.pipe(Effect.provide(context), Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("30 seconds"), Effect.forkScoped)
  return { status: (project) => states.get(project) ?? null }
}))
