import { Domain } from "@kiln/api"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"
import { PlanSpec } from "../Protocol.ts"
import { Config } from "./Config.ts"
import * as Db from "./Db.ts"
import { Gitea } from "./Gitea.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import * as Rows from "./Rows.ts"
import { RunsCore } from "./Runs.ts"
import * as Telemetry from "./Telemetry.ts"

/** A run is a durable workflow: after a restart it continues where the journal says it was. */
export const RunWorkflow = Workflow.make("KilnRun", {
  payload: { runId: Schema.String },
  idempotencyKey: ({ runId }) => runId,
})

export const layerWorkflow = RunWorkflow.toLayer(Effect.fnUntraced(function*({ runId }) {
  const core = yield* RunsCore
  const plan = yield* Activity.make({ name: "plan", success: Schema.NullOr(PlanSpec), execute: core.plan(runId) })
  if (plan === null) return
  const done = new Map(plan.steps.map((s) => [s.name, Deferred.makeUnsafe<void>()]))
  yield* Effect.forEach(plan.steps, (step) =>
    Effect.gen(function*() {
      yield* Effect.forEach([...step.needs, ...step.exits, ...step.after], (dep) => Deferred.await(done.get(dep)!), { discard: true })
      yield* Activity.make({ name: `step:${step.name}`, success: Domain.StepStatus, execute: core.step(runId, step.name) })
      yield* Deferred.succeed(done.get(step.name)!, undefined)
    }), { concurrency: "unbounded", discard: true })
  yield* Activity.make({ name: "finish", execute: core.finish(runId) })
}))

export class RunError extends Schema.TaggedError<RunError>("kiln/RunError")("RunError", { message: Schema.String }) {}

/** Starting, cancelling and repeating runs. */
export class Runs extends Context.Service<Runs, {
  readonly create: (input: {
    readonly project: string
    readonly event: Domain.Event
    readonly sha: string
  }) => Effect.Effect<Domain.Run, RunError>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
  readonly rerun: (runId: string) => Effect.Effect<Domain.Run, RunError>
}>()("kiln/controller/Runs") {}

export const layerRuns = Layer.effect(Runs)(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const core = yield* RunsCore
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const engine = yield* WorkflowEngine.WorkflowEngine
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const create: Runs["Service"]["create"] = (input) =>
    Effect.gen(function*() {
      const project = config.projects[input.project]
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
      const number = yield* db(Db.next(`run:${input.project}`))
      const id = `${input.project}-${number}`
      const now = Date.now()
      yield* db(sql`insert into runs (id, project, number, event, sha, branch, pr, title, commit_title, author, change_id, commit_time,
          trust, status, created_at, trace_id, span_id)
        values (${id}, ${input.project}, ${number}, ${JSON.stringify(event)}, ${input.sha}, ${branch}, ${pr}, ${title}, ${commit.title},
          ${commit.author}, ${commit.changeId}, ${commit.timestamp}, ${trust}, 'queued', ${now}, ${Telemetry.traceId()}, ${Telemetry.spanId()})`)

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

      yield* RunWorkflow.execute({ runId: id }, { discard: true }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
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
        return yield* create({ project: row.project, event: JSON.parse(row.event) as Domain.Event, sha: row.sha })
      }),
  }
}))
