import { Domain } from "@calder-ci/api"
import { Context, Deferred, Effect, FiberMap, FiberSet, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import * as Counters from "./Counters.ts"
import { Gitea } from "./Gitea.ts"
import { Live } from "./Live.ts"
import { Mirror } from "./Mirror.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"
import { RunsCore } from "./Runs.ts"
import * as Telemetry from "./Telemetry.ts"

export class RunError extends Schema.TaggedError<RunError>("calder/RunError")("RunError", { message: Schema.String }) {}

export interface RunInput {
  readonly project: string
  readonly event: Domain.Event
  readonly sha: string
  /** A pull request whose head lives in another repository. */
  readonly fork?: boolean
  /** The run this one reruns, whose passed steps it takes instead of running them again. */
  readonly rerunOf?: string
}

/** Starting, cancelling and repeating runs. */
export class Runs extends Context.Service<Runs, {
  readonly create: (input: RunInput) => Effect.Effect<Domain.Run, RunError>
  readonly cancel: (runId: string, reason: string) => Effect.Effect<void>
  /**
   * Runs what failed in a run again, in the same run, also while it still runs: its failed and died steps
   * and what they blocked. A run with nothing that failed, without a plan or cancelled gets a new run of
   * its revision and event that takes what passed in it; with `force`, a new run that runs everything.
   */
  readonly rerun: (runId: string, options?: { readonly force?: boolean; readonly reason?: string }) => Effect.Effect<Domain.Run, RunError>
  /**
   * `create`, unless a run of the same project, revision and event exists: what the webhook and the
   * catch-up after a restart use, so one push never starts two runs.
   */
  readonly ensure: (input: RunInput) => Effect.Effect<Domain.Run, RunError>
  /** Audits a project's footprint records (RunsCore's `audit`). */
  readonly audit: (project: string) => Effect.Effect<ReadonlyArray<Domain.AuditMismatch>>
}>()("calder/controller/Runs") {}

/**
 * The branch a run is of, which its deploy lease checks the revision against (WorkerServer `leaseOf`): a
 * manual run's is the branch it was triggered on, a schedule's the default branch.
 */
export const branchOf = (event: Domain.Event, defaultBranch: string) =>
  event._tag === "Push" ? event.branch
  : event._tag === "PullRequest" ? event.head
  : event._tag === "PullRequestClosed" ? event.base
  : event._tag === "Check" ? event.ref
  : event._tag === "Manual" ? event.branch ?? defaultBranch
  : defaultBranch

export const layer = Layer.effect(Runs)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const core = yield* RunsCore
  const mirror = yield* Mirror
  const gitea = yield* Gitea
  const live = yield* Live
  const projects = yield* Projects
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  /** Per run, what keeps a retry (`rerun`) from slipping past the end of the run's driver. */
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = (runId: string) => {
    let one = locks.get(runId)
    if (one === undefined) {
      one = Semaphore.makeUnsafe(1)
      locks.set(runId, one)
    }
    return one
  }
  /** Runs being driven, each with what starts steps that run again while it drives. */
  const driving = new Map<string, { relaunch: ((names: ReadonlyArray<string>) => Effect.Effect<void>) | null }>()

  /**
   * Drives a run: its plan, each step once its dependencies settled (a task asks for its setups itself
   * once it knows it runs), then the outcome. Every stage reads and writes the journal and skips what
   * already finished, so driving a run again after a restart continues where it stopped. Steps a retry
   * puts back start at once; a blocked step whose dependencies passed on a retry runs too before the run
   * finishes.
   */
  const drive = (runId: string, entry: { relaunch: ((names: ReadonlyArray<string>) => Effect.Effect<void>) | null }) =>
    Effect.gen(function*() {
      const plan = yield* core.plan(runId)
      if (plan === null) {
        yield* lock(runId).withPermits(1)(Effect.gen(function*() {
          const row = yield* db(Rows.loadRun(runId))
          if (row?.status === "cancelled") yield* core.finish(runId)
          driving.delete(runId)
        }))
        return
      }
      const done = new Map(plan.steps.map((s) => [s.name, Deferred.makeUnsafe<void>()]))
      const kinds = new Map(plan.steps.map((s) => [s.name, s.kind]))
      const byName = new Map(plan.steps.map((s) => [s.name, s]))
      const fibers = yield* FiberSet.make()
      const launch = (name: string) =>
        Effect.gen(function*() {
          // The latch of this launch: a retry that launches the step again gives it a new one.
          const mine = done.get(name)!
          const step = byName.get(name)!
          if (!(step.build !== null && (yield* core.built(runId, step.name)))) {
            const setups = Rows.setupsOf(step, (n) => kinds.get(n))
            const deps = [...step.needs, ...step.exits, ...step.after].filter((dep) => !setups.includes(dep))
            yield* Effect.forEach(deps, (dep) => Deferred.await(done.get(dep)!), { discard: true })
          }
          yield* core.step(runId, step.name)
          yield* Deferred.succeed(mine, undefined)
        })
      const relaunch = (names: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const known = names.filter((n) => byName.has(n))
          for (const n of known) done.set(n, Deferred.makeUnsafe<void>())
          yield* Effect.forEach(known, (n) => FiberSet.run(fibers, launch(n)), { discard: true })
        })
      // Under the lock, so a rerun either finds the relaunch or comes before the steps start, never both.
      yield* lock(runId).withPermits(1)(Effect.gen(function*() {
        yield* Effect.forEach(plan.steps, (s) => FiberSet.run(fibers, launch(s.name)), { discard: true })
        entry.relaunch = relaunch
      }))
      // Steps the driver ran again because what blocked them passed, so a step blocked for another reason runs once.
      const reconciled = new Set<string>()
      while (true) {
        yield* FiberSet.awaitEmpty(fibers)
        const ended = yield* lock(runId).withPermits(1)(Effect.gen(function*() {
          // A retry came in meanwhile.
          if ((yield* FiberSet.size(fibers)) > 0) return false
          const again = (yield* core.unblocked(runId)).filter((n) => !reconciled.has(n))
          if (again.length > 0) {
            for (const n of again) reconciled.add(n)
            const reset = yield* core.retry(runId, "what blocked it passed when it ran again", { only: again, quiet: true })
            yield* relaunch(reset)
            return false
          }
          yield* core.finish(runId)
          driving.delete(runId)
          return true
        }))
        if (ended) return
      }
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => Effect.logError(`driving ${runId} failed`, cause).pipe(Effect.andThen(Effect.sync(() => driving.delete(runId))))),
    )

  const drivers = yield* FiberMap.make<string>()
  /** Drives `runId` unless a driver already does. A driver that has finished but not exited yet is replaced. */
  const start = (runId: string) =>
    Effect.suspend(() => {
      if (driving.has(runId)) return Effect.void
      const entry: { relaunch: ((names: ReadonlyArray<string>) => Effect.Effect<void>) | null } = { relaunch: null }
      driving.set(runId, entry)
      return FiberMap.run(drivers, runId, drive(runId, entry)).pipe(Effect.asVoid)
    })

  // A restart interrupted these; their steps that were running start over. Cancelled ones only finish.
  const unfinished = yield* db(sql<{ id: string }>`select id from runs
    where status in ('queued', 'planning', 'running') or (status = 'cancelled' and finished_at is null) order by created_at`)
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
      const trust: Domain.Trust = event._tag === "PullRequest" || event._tag === "Check" ? "pr" : "trusted"
      const branch = branchOf(event, project.defaultBranch)
      const pr = event._tag === "PullRequest" || event._tag === "PullRequestClosed" ? event.number : null
      const title = pr === null ? null : yield* gitea.pullTitle(project.repo, pr)
      const number = yield* db(Counters.next(`run:${input.project}`))
      const id = `${input.project}-${number}`
      const now = Date.now()
      yield* db(sql`insert into runs (id, project, number, event, sha, branch, pr, title, commit_title, author, change_id, commit_time,
          trust, status, created_at, trace_id, span_id, fork, tree, rerun_of)
        values (${id}, ${input.project}, ${number}, ${JSON.stringify(event)}, ${input.sha}, ${branch}, ${pr}, ${title}, ${commit.title},
          ${commit.author}, ${commit.changeId}, ${commit.timestamp}, ${trust}, 'queued', ${now}, ${Telemetry.traceId()}, ${Telemetry.spanId()},
          ${input.fork === true ? 1 : 0}, ${commit.tree === "" ? null : commit.tree}, ${input.rerunOf ?? null})`)

      const older = yield* db(Rows.replaced({ project: input.project, event, branch, pr, sha: input.sha }))
      yield* Effect.forEach(older, (id) => core.supersede(id, `superseded by #${number}`), { discard: true })

      yield* start(id)
      const row = yield* db(Rows.loadRun(id))
      const run = Rows.run(row!)
      yield* live.publish({ _tag: "RunChanged", run })
      return run
    })

  const ensuring = new Set<string>()
  const ensure: Runs["Service"]["ensure"] = (input) =>
    Effect.gen(function*() {
      const event = JSON.stringify(input.event)
      const key = `${input.project}|${input.sha}|${event}`
      const existing = yield* db(sql<Rows.RunRow>`select * from runs where project = ${input.project} and sha = ${input.sha}
        and event = ${event} order by created_at desc limit 1`)
      if (existing[0] !== undefined) return Rows.run(existing[0])
      if (ensuring.has(key)) return yield* new RunError({ message: `a run of ${key} is starting` })
      ensuring.add(key)
      return yield* create(input).pipe(Effect.ensuring(Effect.sync(() => ensuring.delete(key))))
    })

  return {
    create,
    ensure,
    cancel: core.cancel,
    audit: (project) =>
      Effect.map(core.audit(project), (mismatches) =>
        mismatches.map((m) => ({ attr: m.attr, revision: "", at: Date.now(), recorded: m.recorded?.drv ?? null, evaluated: m.evaluated?.drv ?? null, missed: m.missed }))
      ),
    rerun: (runId, options = {}) =>
      Effect.gen(function*() {
        const row = yield* db(Rows.loadRun(runId))
        if (row === undefined) return yield* new RunError({ message: `no run ${runId}` })
        if (options.force !== true && row.plan !== null && row.status !== "cancelled") {
          const reason = options.reason ?? "calder rerun"
          // The steps it reset run again even when the caller goes away, such as a CLI interrupted while
          // Gitea is slow to take the statuses that say so: left pending, they would only end cancelled.
          const retried = yield* Effect.uninterruptible(lock(runId).withPermits(1)(Effect.gen(function*() {
            const names = yield* core.retry(runId, reason)
            if (names.length === 0) return names
            const entry = driving.get(runId)
            if (entry?.relaunch != null) yield* entry.relaunch(names)
            // A driver that hasn't launched its steps yet runs the reset ones with the rest.
            else if (entry === undefined) yield* start(runId)
            return names
          })))
          if (retried.length > 0) return Rows.run((yield* db(Rows.loadRun(runId)))!)
          if (!Domain.ended.has(row.status)) return yield* new RunError({ message: `nothing of ${runId} failed so far, so there is nothing to run again yet` })
        }
        return yield* create({
          project: row.project,
          event: JSON.parse(row.event) as Domain.Event,
          sha: row.sha,
          fork: row.fork === 1,
          ...(options.force === true ? {} : { rerunOf: runId }),
        })
      }),
  }
}))
