import type { Domain } from "@calder-ci/api"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Exec from "../Exec.ts"
import { Gitea } from "./Gitea.ts"
import { Mirror, type TrainHead } from "./Mirror.ts"
import { Projects } from "./Projects.ts"
import { Runs } from "./Workflow.ts"

export type MergeStatus = "waiting" | "updating" | "merged" | "failed" | "closed"

export interface MergeRequest {
  readonly project: string
  readonly pr: number
  readonly status: MergeStatus
  readonly message: string | null
  readonly requestedAt: number
}

/**
 * Pull requests to merge once they are green, in the order they turn green. A pull request whose run on
 * its current head passed is merged, pinned to that head, when it contains its base. Green ones behind
 * their base go in a train: the base with each of their heads merged in, which gets one run, and the base
 * moves forward to it once that run passes. A single stale pull request, or the first of a failed train
 * whose heads still wait, gets its own update instead: the base merged into its branch, which starts a
 * run that only repeats what the update can affect. While a train's or an update's run is pending,
 * requests for the same base wait, so that none of them merges in between and makes it stale. A failed
 * run keeps the request, with one comment on the pull request, until a rerun of it or the run of a new
 * push passes. A conflict or a refused merge ends the request with a comment. Any other error, such as a
 * branch or repository that is gone, ends only that request, and the queue goes on.
 */
export class MergeRefused extends Schema.TaggedError<MergeRefused>("calder/MergeRefused")("MergeRefused", { reason: Schema.String }) {}

export class Merges extends Context.Service<Merges, {
  readonly request: (project: string, pr: number) => Effect.Effect<MergeRequest, MergeRefused>
  readonly list: (project: string) => Effect.Effect<ReadonlyArray<MergeRequest>>
}>()("calder/controller/Merges") {}

interface Row {
  readonly project: string
  readonly pr: number
  /** The base branch when the merge was requested. */
  readonly base: string
  readonly status: MergeStatus
  readonly message: string | null
  readonly requested_at: number
}

/** A request whose pull request is green but behind its base. */
interface Stale {
  readonly row: Row
  readonly repo: string
  readonly head: TrainHead
}

const toRequest = (row: Row): MergeRequest => ({
  project: row.project,
  pr: row.pr,
  status: row.status,
  message: row.message,
  requestedAt: row.requested_at,
})

export const layer = Layer.effect(Merges)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const gitea = yield* Gitea
  const mirror = yield* Mirror
  const projects = yield* Projects
  const spawner = yield* Exec.SpawnerTag
  const runs = yield* Runs
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  /** A request that already ended keeps its outcome. */
  const settle = (row: Row, status: MergeStatus, message: string | null) =>
    db(sql`update merges set status = ${status}, message = ${message}
      where project = ${row.project} and pr = ${row.pr} and status in ('waiting', 'updating')`)

  const contains = (project: string, ancestor: string, head: string) =>
    Exec.exec(["git", "--git-dir", mirror.path(project), "merge-base", "--is-ancestor", ancestor, head]).pipe(
      Effect.provideService(Exec.SpawnerTag, spawner),
      Effect.map((r) => r.exitCode === 0),
      Effect.orElseSucceed(() => false),
    )

  /**
   * Moves one request forward. Returns the base branch it holds while its update's run is pending, so
   * later requests for it wait, or the pull request when it is green but behind its base.
   */
  const advance = (row: Row): Effect.Effect<string | Stale | null> =>
    Effect.gen(function*() {
      const project = projects.get(row.project)
      if (project === undefined) return yield* settle(row, "failed", "the project is gone").pipe(Effect.as(null))
      const { repo } = project
      const pull = yield* gitea.pull(repo, row.pr)
      if (pull.merged) return yield* settle(row, "merged", null).pipe(Effect.as(null))
      if (!pull.open) return yield* settle(row, "closed", null).pipe(Effect.as(null))
      if (pull.fork) return yield* settle(row, "failed", "Calder merges pull requests from this repository only").pipe(Effect.as(null))
      const holds = `${row.project}/${pull.base}`
      const fail = (message: string) =>
        Effect.gen(function*() {
          yield* settle(row, "failed", message)
          yield* gitea.comment(repo, row.pr, `Calder didn't merge this: ${message}`, null)
          return null
        })

      const runs = yield* db(sql<{ id: string; status: string }>`select id, status from runs
        where project = ${row.project} and pr = ${row.pr} and sha = ${pull.sha} order by created_at desc limit 1`)
      const run = runs[0]
      const pending = run === undefined || ["queued", "planning", "running"].includes(run.status)
      // A failed run keeps the request, before anything updates its head: a rerun of that run that passes,
      // or a new push whose run does, merges it. Meanwhile it holds no base, so the others go on.
      if (!pending && run.status !== "passed") {
        const held = `its run ${run.id} ${run.status}; Calder merges this once a rerun of it or a run of a new push passes`
        if (row.message === held && row.status === "waiting") return null
        yield* settle(row, "waiting", held)
        if (row.message !== held) yield* gitea.comment(repo, row.pr, `Calder didn't merge this yet: ${held}.`, null)
        return null
      }

      yield* mirror.fetch(row.project).pipe(Effect.ignore)
      const base = yield* gitea.head(repo, pull.base)
      // A train landed it: Gitea closes it on its own (autodetect_manual_merge), and merging it again would
      // only add an empty merge and a run.
      if (yield* contains(row.project, pull.sha, base)) return yield* settle(row, "merged", null).pipe(Effect.as(null))
      if (!(yield* contains(row.project, base, pull.sha))) {
        // Its own run goes first; once that passes, an update or a train brings it up to date.
        if (pending) return row.status === "updating" ? holds : null
        return { row, repo, head: { pr: row.pr, sha: pull.sha } } satisfies Stale
      }
      if (pending) {
        if (row.message !== null) yield* db(sql`update merges set message = null where project = ${row.project} and pr = ${row.pr}`)
        return row.status === "updating" ? holds : null
      }
      const merged = yield* gitea.mergePull(repo, row.pr, pull.sha).pipe(Effect.as(null), Effect.catch((message) => Effect.succeed(message)))
      if (merged !== null) return yield* fail(`Gitea refused the merge: ${merged}`)
      yield* settle(row, "merged", null)
      return null
    })

  /** Merges the base into one pull request's branch, the way without a train. */
  const update = ({ row, repo }: Stale) =>
    Effect.gen(function*() {
      const updated = yield* gitea.updatePull(repo, row.pr).pipe(Effect.as(null), Effect.catch((message) => Effect.succeed(message)))
      if (updated !== null) {
        yield* settle(row, "failed", `merging ${row.base} into it failed: ${updated}`)
        yield* gitea.comment(repo, row.pr, `Calder didn't merge this: merging ${row.base} into it failed: ${updated}`, null)
        return
      }
      yield* settle(row, "updating", null)
    })

  const trainRef = (base: string) => `refs/calder/check/train-${base}`
  /** Bases whose branch refused a train's push, until the controller restarts. */
  const refusing = new Set<string>()

  /** The newest train run of a base, with the base it started from and the heads it merged. */
  const lastTrain = (project: string, base: string) =>
    Effect.gen(function*() {
      const rows = yield* db(sql<{ id: string; status: string; sha: string }>`select id, status, sha from runs
        where project = ${project} and branch = ${trainRef(base).slice("refs/".length)} and event like ${'{"_tag":"Check"%'}
        order by created_at desc limit 1`)
      const run = rows[0]
      if (run === undefined) return null
      const of = yield* mirror.trainOf(project, run.sha).pipe(Effect.orDie)
      return { ...run, ...of }
    })

  /**
   * Lands a train whose run passed, while the base and its pull requests' heads are as it merged them.
   * Returns whether a train holds the base: one whose run is pending.
   */
  const stepTrain = (project: string, repo: string, base: string) =>
    Effect.gen(function*() {
      const train = yield* lastTrain(project, base)
      if (train === null || !["queued", "planning", "running", "passed"].includes(train.status)) return false
      const current = (yield* gitea.head(repo, base)) === train.base &&
        (yield* Effect.forEach(train.heads, (h) => gitea.pull(repo, h.pr))).every((pull, i) => pull.open && pull.sha === train.heads[i]!.sha)
      if (train.status !== "passed") {
        if (current) return true
        yield* runs.cancel(train.id, "the base or a pull request in the train moved")
        return false
      }
      if (!current || refusing.has(`${project}/${base}`)) return false
      // The push only moves the base forward, so it fails if the base moved since; then the next tick
      // builds a new train. Anything else, such as a protected branch, means no trains for this base.
      const refused = yield* mirror.push(project, train.sha, `refs/heads/${base}`).pipe(Effect.as(null), Effect.catch((e) => Effect.succeed(e)))
      if (refused !== null && (yield* gitea.head(repo, base)) === train.base) {
        yield* Effect.logWarning(`pushing train ${train.id} to ${project}'s ${base} failed, so its requests merge one at a time`, refused)
        refusing.add(`${project}/${base}`)
      }
      return false
    })

  /** Puts green pull requests behind their base in a train, or updates one the way without a train. */
  const startTrain = (project: string, base: string, stale: ReadonlyArray<Stale>) =>
    Effect.gen(function*() {
      const { repo } = stale[0]!
      if (stale.length === 1 || refusing.has(`${project}/${base}`)) return yield* update(stale[0]!)
      // A train failed and its heads still wait: its first goes alone, and the rest get a train after it.
      const last = yield* lastTrain(project, base)
      const waiting = (h: TrainHead) => stale.find((s) => s.head.pr === h.pr && s.head.sha === h.sha)
      if (last !== null && ["failed", "errored"].includes(last.status) && last.heads.length > 0 && last.heads.every(waiting)) {
        return yield* update(waiting(last.heads[0]!)!)
      }
      const baseSha = yield* gitea.head(repo, base)
      const built = yield* mirror.train(project, baseSha, stale.map((s) => s.head)).pipe(Effect.orDie)
      if (built.sha === null) return yield* update(stale[0]!)
      yield* mirror.push(project, built.sha, trainRef(base), { force: true }).pipe(Effect.orDie)
      const event: Domain.Event = { _tag: "Check", ref: trainRef(base).slice("refs/".length), base }
      const run = yield* runs.create({ project, event, sha: built.sha }).pipe(Effect.orDie)
      const members = stale.filter((s) => !built.conflicts.includes(s.head.pr))
      for (const s of members) {
        const others = members.filter((o) => o !== s).map((o) => `#${o.head.pr}`)
        yield* gitea.comment(repo, s.row.pr, `Calder lands this in a train${others.length === 0 ? "" : ` with ${others.join(", ")}`}: run ${run.id}.`, null)
      }
    })

  const tick = Effect.gen(function*() {
    const pending = yield* db(sql<Row>`select * from merges where status in ('waiting', 'updating') order by requested_at`)
    // Requests are taken in order; one that holds its base branch makes later ones for it wait.
    const held = new Set<string>()
    for (const key of new Set(pending.map((row) => `${row.project}/${row.base}`))) {
      const row = pending.find((r) => `${r.project}/${r.base}` === key)!
      const repo = projects.get(row.project)?.repo
      if (repo === undefined) continue
      const holds = yield* stepTrain(row.project, repo, row.base).pipe(
        Effect.catchDefect((defect) => Effect.logWarning(`the merge train for ${key} failed`, defect).pipe(Effect.as(false))),
      )
      if (holds) held.add(key)
    }
    const stale = new Map<string, Array<Stale>>()
    for (const row of pending) {
      const key = `${row.project}/${row.base}`
      if (held.has(key)) continue
      const result = yield* advance(row).pipe(
        Effect.catchDefect((defect) =>
          Effect.gen(function*() {
            yield* Effect.logWarning(`merging ${row.project}#${row.pr} failed`, defect)
            yield* settle(row, "failed", defect instanceof Error ? defect.message : String(defect))
            return null
          })
        ),
      )
      if (typeof result === "string") held.add(result)
      else if (result !== null) stale.set(key, [...(stale.get(key) ?? []), result])
    }
    for (const [key, list] of stale) {
      if (held.has(key)) continue
      yield* startTrain(list[0]!.row.project, list[0]!.row.base, list).pipe(
        Effect.catchDefect((defect) => Effect.logWarning(`starting a merge train for ${key} failed`, defect)),
      )
    }
  }).pipe(Effect.catchCause((cause) => Effect.logError("merge queue tick failed", cause)))
  yield* tick.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

  return {
    request: (project, pr) =>
      Effect.gen(function*() {
        const repo = projects.get(project)?.repo
        if (repo === undefined) return yield* new MergeRefused({ reason: `no project ${project}` })
        const pull = yield* gitea.pull(repo, pr)
        if (!pull.open) return yield* new MergeRefused({ reason: `pull request #${pr} is ${pull.merged ? "merged" : "closed"}` })
        yield* db(sql`insert into merges (project, pr, base, status, message, requested_at)
          values (${project}, ${pr}, ${pull.base}, 'waiting', null, ${Date.now()})
          on conflict (project, pr) do update set base = excluded.base, message = null,
            status = case when merges.status = 'updating' then 'updating' else 'waiting' end,
            requested_at = case when merges.status in ('waiting', 'updating') then merges.requested_at else excluded.requested_at end`)
        const rows = yield* db(sql<Row>`select * from merges where project = ${project} and pr = ${pr}`)
        return toRequest(rows[0]!)
      }),
    list: (project) =>
      Effect.map(db(sql<Row>`select * from merges where project = ${project} order by requested_at desc limit 50`), (rows) => rows.map(toRequest)),
  }
}))
