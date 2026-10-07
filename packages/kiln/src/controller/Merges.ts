import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Exec from "../Exec.ts"
import { Gitea } from "./Gitea.ts"
import { Mirror } from "./Mirror.ts"
import { Projects } from "./Projects.ts"

export type MergeStatus = "waiting" | "updating" | "merged" | "failed" | "closed"

export interface MergeRequest {
  readonly project: string
  readonly pr: number
  readonly status: MergeStatus
  readonly message: string | null
  readonly requestedAt: number
}

/**
 * Pull requests to merge once they are green. One per base branch at a time: a pull request behind its
 * base gets the base merged in, which starts a run that only repeats what the update can affect; one
 * whose run on its current head passed is merged. A failed run, a conflict or a refused merge ends the
 * request with a comment on the pull request.
 */
export class MergeRefused extends Schema.TaggedError<MergeRefused>("kiln/MergeRefused")("MergeRefused", { reason: Schema.String }) {}

export class Merges extends Context.Service<Merges, {
  readonly request: (project: string, pr: number) => Effect.Effect<MergeRequest, MergeRefused>
  readonly list: (project: string) => Effect.Effect<ReadonlyArray<MergeRequest>>
}>()("kiln/controller/Merges") {}

interface Row {
  readonly project: string
  readonly pr: number
  /** The base branch when the merge was requested. */
  readonly base: string
  readonly status: MergeStatus
  readonly message: string | null
  readonly requested_at: number
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
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const settle = (row: Row, status: MergeStatus, message: string | null) =>
    db(sql`update merges set status = ${status}, message = ${message} where project = ${row.project} and pr = ${row.pr}`)

  const contains = (project: string, ancestor: string, head: string) =>
    Exec.exec(["git", "--git-dir", mirror.path(project), "merge-base", "--is-ancestor", ancestor, head]).pipe(
      Effect.provideService(Exec.SpawnerTag, spawner),
      Effect.map((r) => r.exitCode === 0),
      Effect.orElseSucceed(() => false),
    )

  /** Moves one request forward; returns the base branch it holds, so later requests for it wait. */
  const advance = (row: Row) =>
    Effect.gen(function*() {
      const project = projects.get(row.project)
      if (project === undefined) return yield* settle(row, "failed", "the project is gone").pipe(Effect.as(null))
      const { repo } = project
      const pull = yield* gitea.pull(repo, row.pr)
      if (pull.merged) return yield* settle(row, "merged", null).pipe(Effect.as(null))
      if (!pull.open) return yield* settle(row, "closed", null).pipe(Effect.as(null))
      if (pull.fork) return yield* settle(row, "failed", "Kiln merges pull requests from this repository only").pipe(Effect.as(null))
      const holds = `${row.project}/${pull.base}`
      const fail = (message: string) =>
        Effect.gen(function*() {
          yield* settle(row, "failed", message)
          yield* gitea.comment(repo, row.pr, `Kiln didn't merge this: ${message}`, null)
          return null
        })

      yield* mirror.fetch(row.project).pipe(Effect.ignore)
      const base = yield* gitea.head(repo, pull.base)
      if (!(yield* contains(row.project, base, pull.sha))) {
        const updated = yield* gitea.updatePull(repo, row.pr).pipe(Effect.as(null), Effect.catch((message) => Effect.succeed(message)))
        if (updated !== null) return yield* fail(`merging ${pull.base} into it failed: ${updated}`)
        yield* settle(row, "updating", null)
        return holds
      }
      const runs = yield* db(sql<{ id: string; status: string }>`select id, status from runs
        where project = ${row.project} and pr = ${row.pr} and sha = ${pull.sha} order by created_at desc limit 1`)
      const run = runs[0]
      if (run === undefined || ["queued", "planning", "running"].includes(run.status)) {
        if (row.status !== "waiting") yield* settle(row, "waiting", null)
        return holds
      }
      if (run.status !== "passed") return yield* fail(`its run ${run.id} ${run.status}`)
      const merged = yield* gitea.mergePull(repo, row.pr).pipe(Effect.as(null), Effect.catch((message) => Effect.succeed(message)))
      if (merged !== null) return yield* fail(`Gitea refused the merge: ${merged}`)
      yield* settle(row, "merged", null)
      return null
    })

  const tick = Effect.gen(function*() {
    const pending = yield* db(sql<Row>`select * from merges where status in ('waiting', 'updating') order by requested_at`)
    // Requests are taken in order; one that holds its base branch makes later ones for it wait.
    const held = new Set<string>()
    for (const row of pending) {
      if (held.has(`${row.project}/${row.base}`)) continue
      const holds = yield* advance(row)
      if (holds !== null) held.add(holds)
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
          on conflict (project, pr) do update set base = excluded.base, status = 'waiting', message = null, requested_at = excluded.requested_at`)
        const rows = yield* db(sql<Row>`select * from merges where project = ${project} and pr = ${pr}`)
        return toRequest(rows[0]!)
      }),
    list: (project) =>
      Effect.map(db(sql<Row>`select * from merges where project = ${project} order by requested_at desc limit 50`), (rows) => rows.map(toRequest)),
  }
}))
