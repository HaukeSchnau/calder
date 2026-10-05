import { Domain } from "@kiln/api"
import { Context, Deferred, Effect, FiberMap, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Counters from "./Counters.ts"
import { Gitea } from "./Gitea.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"
import { RunsCore } from "./Runs.ts"
import * as Telemetry from "./Telemetry.ts"

export class RunError extends Schema.TaggedError<RunError>("kiln/RunError")("RunError", { message: Schema.String }) {}

/** Starting, cancelling and repeating runs. */
export class Runs extends Context.Service<Runs, {
  readonly create: (input: {
    readonly project: string
    readonly event: Domain.Event
    readonly sha: string
    /** A pull request whose head lives in another repository. */
    readonly fork?: boolean
  }) => Effect.Effect<Domain.Run, RunError>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
  readonly rerun: (runId: string) => Effect.Effect<Domain.Run, RunError>
}>()("kiln/controller/Runs") {}

export const layer = Layer.effect(Runs)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const core = yield* RunsCore
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const projects = yield* Projects
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  /**
   * Drives a run: its plan, each step once its dependencies settled, then the outcome. Every stage reads
   * and writes the journal and skips what already finished, so driving a run again after a restart
   * continues where it stopped.
   */
  const drive = (runId: string) =>
    Effect.gen(function*() {
      const plan = yield* core.plan(runId)
      if (plan === null) return
      const done = new Map(plan.steps.map((s) => [s.name, Deferred.makeUnsafe<void>()]))
      yield* Effect.forEach(plan.steps, (step) =>
        Effect.gen(function*() {
          yield* Effect.forEach([...step.needs, ...step.exits, ...step.after], (dep) => Deferred.await(done.get(dep)!), { discard: true })
          yield* core.step(runId, step.name)
          yield* Deferred.succeed(done.get(step.name)!, undefined)
        }), { concurrency: "unbounded", discard: true })
      yield* core.finish(runId)
    }).pipe(Effect.catchCause((cause) => Effect.logError(`driving ${runId} failed`, cause)))

  const drivers = yield* FiberMap.make<string>()
  const start = (runId: string) => FiberMap.run(drivers, runId, drive(runId), { onlyIfMissing: true })

  // A restart interrupted these; their steps that were running start over.
  const unfinished = yield* db(sql<{ id: string }>`select id from runs where status in ('queued', 'planning', 'running') order by created_at`)
  yield* Effect.forEach(unfinished, (r) => start(r.id), { discard: true })

  const create: Runs["Service"]["create"] = (input) =>
    Effect.gen(function*() {
      const project = projects.get(input.project)
      if (project === undefined) return yield* new RunError({ message: `unknown project ${input.project}` })
      const commit = yield* mirror.commit(input.project, input.sha).pipe(
        Effect.catch(() => mirror.fetch(input.project).pipe(Effect.andThen(mirror.commit(input.project, input.sha)))),
        Effect.mapError((e) => new RunError({ message: `revision ${input.sha} not found: ${e.message}` })),
      )
      const event = input.event
      const trust: Domain.Trust = event._tag === "PullRequest" ? "pr" : "trusted"
      const branch = event._tag === "Push" ? event.branch : event._tag === "PullRequest" ? event.head : project.defaultBranch
      const pr = event._tag === "PullRequest" ? event.number : null
      const title = pr === null ? null : yield* gitea.pullTitle(project.repo, pr)
      const number = yield* db(Counters.next(`run:${input.project}`))
      const id = `${input.project}-${number}`
      const now = Date.now()
      yield* db(sql`insert into runs (id, project, number, event, sha, branch, pr, title, commit_title, author, change_id, commit_time,
          trust, status, created_at, trace_id, span_id, fork)
        values (${id}, ${input.project}, ${number}, ${JSON.stringify(event)}, ${input.sha}, ${branch}, ${pr}, ${title}, ${commit.title},
          ${commit.author}, ${commit.changeId}, ${commit.timestamp}, ${trust}, 'queued', ${now}, ${Telemetry.traceId()}, ${Telemetry.spanId()},
          ${input.fork === true ? 1 : 0})`)

      // A newer revision of the same pull request or branch makes older runs pointless.
      const older = yield* db(
        pr !== null
          ? sql<{ id: string }>`select id from runs where project = ${input.project} and pr = ${pr} and id != ${id}
              and status in ('queued', 'planning', 'running')`
          : event._tag === "Push"
          ? sql<{ id: string }>`select id from runs where project = ${input.project} and branch = ${branch} and pr is null
              and event like '{"_tag":"Push"%' and id != ${id} and status in ('queued', 'planning', 'running')`
          : Effect.succeed([]),
      )
      yield* Effect.forEach(older, (r) => core.cancel(r.id, `superseded by #${number}`), { discard: true })

      yield* start(id)
      const row = yield* db(Rows.loadRun(id))
      const run = Rows.run(row!)
      yield* live.publish({ _tag: "RunChanged", run })
      return run
    })

  return {
    create,
    cancel: core.cancel,
    rerun: (runId) =>
      Effect.gen(function*() {
        const row = yield* db(Rows.loadRun(runId))
        if (row === undefined) return yield* new RunError({ message: `no run ${runId}` })
        return yield* create({ project: row.project, event: JSON.parse(row.event) as Domain.Event, sha: row.sha, fork: row.fork === 1 })
      }),
  }
}))
