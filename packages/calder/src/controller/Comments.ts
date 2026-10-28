import type { Domain } from "@calder-ci/api"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { took } from "../Cli.ts"
import { Config } from "./Config.ts"
import { Gitea } from "./Gitea.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"

/** What a step of a pull request's run said through `PullRequest.comment`, newest per step. */
export interface Note {
  readonly step: string
  readonly run: { readonly id: string; readonly number: number }
  readonly markdown: string
  readonly at: number
}


const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")

/** A step's status for people: what it waits for, how it failed, or how it ended. */
const statusOf = (step: Domain.StepRun) => {
  if (step.status === "pending" || step.status === "queued") return step.waiting == null ? "waiting" : `waiting for ${step.waiting}`
  if (step.error !== null && step.status !== "passed") return `${step.status}: ${step.error.message.split("\n")[0]!.slice(0, 120)}`
  return step.status
}

/**
 * Calder's comment on a pull request: what its steps said, such as a preview's URL, with how long after
 * the push each said it, then the newest run's steps with how long each waited and ran, and what that
 * run spent planning and queueing on its critical path.
 */
export const render = (input: {
  readonly run: Domain.Run
  readonly steps: ReadonlyArray<Domain.StepRun>
  readonly notes: ReadonlyArray<Note>
  readonly link: string
  readonly now: number
}) => {
  const { run, now } = input
  const steps = Rows.withReasons(input.steps.filter((s) => s.kind !== "output" && !(s.kind === "setup" && s.queuedAt === null && s.status === "reused")))
  const notes = input.notes.map((note) =>
    note.run.id === run.id
      ? `${note.markdown}\n<sub>${took(note.at - run.createdAt)} after the push</sub>`
      : `${note.markdown}\n<sub>from run ${note.run.number}; run ${run.number} hasn't said it yet</sub>`
  )
  const ended = run.finishedAt !== null
  const total = took((run.finishedAt ?? now) - run.createdAt)
  const planned = run.plannedAt == null ? "planning" : `planned in ${took(run.plannedAt - run.createdAt)}`
  const header = `**Run ${run.number}** ${ended ? `${run.status} in ${total}` : `${run.status}, ${total} so far`} · \`${run.commit.sha.slice(0, 12)}\` · ${planned} · [steps](${input.link})`
  const ran = steps.filter((s) => s.status !== "reused")
  const reused = steps.filter((s) => s.status === "reused")
  const row = (s: Domain.StepRun) => {
    const waited = s.queuedAt !== null && s.startedAt !== null ? took(s.startedAt - s.queuedAt) : ""
    const time = s.startedAt === null ? "" : s.finishedAt === null ? `${took(now - s.startedAt)} so far` : took(s.finishedAt - s.startedAt)
    return `| ${cell(s.name)}${s.critical === true ? " ·" : ""} | ${cell(statusOf(s))} | ${waited} | ${time} |`
  }
  const table = ran.length === 0 ? [] : ["| Step | Status | Waited | Took |", "| --- | --- | ---: | ---: |", ...ran.map(row)]
  const critical = ran.filter((s) => s.critical === true && s.queuedAt !== null && s.startedAt !== null)
  const queued = critical.reduce((sum, s) => sum + (s.startedAt! - s.queuedAt!), 0)
  const footer = [
    ...(critical.length === 0 ? [] : [`Steps marked · are on the preview's or deploy's critical path; they waited ${took(queued)} for slots in all.`]),
    ...(reused.length === 0 ? [] : [`Reused ${reused.length} identical result${reused.length === 1 ? "" : "s"}: ${reused.slice(0, 12).map((s) => s.name).join(", ")}${reused.length > 12 ? ", ..." : ""}.`]),
  ]
  return [...notes.flatMap((n) => [n, ""]), header, "", ...table, ...(footer.length === 0 ? [] : ["", ...footer])].join("\n")
}

/** Calder's one comment per pull request, which steps' notes start and every change of its newest run updates. */
export class Comments extends Context.Service<Comments, {
  /** Keeps what a step of a pull request's run says and updates the pull request's comment. */
  readonly note: (runId: string, step: string, markdown: string) => Effect.Effect<void>
  /** Updates the comment of the run's pull request a moment later, if Calder has one there. */
  readonly touch: (runId: string) => Effect.Effect<void>
}>()("calder/controller/Comments") {}

/** The `comments` row of Calder's own comment, which no step's name can take. */
const own = ""

export const layer = Layer.effect(Comments)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const gitea = yield* Gitea
  const config = yield* Config
  const projects = yield* Projects
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const newestOf = (project: string, pr: number) =>
    Effect.map(db(sql<Rows.RunRow>`select * from runs where project = ${project} and pr = ${pr} order by created_at desc limit 1`), (rows) => rows[0])

  /** What the comment last showed, per pull request: an edit goes to Gitea only when it changed. */
  const shown = new Map<string, string>()

  const update = (project: string, pr: number) =>
    Effect.gen(function*() {
      const newest = yield* newestOf(project, pr)
      const repo = projects.get(project)?.repo
      if (newest === undefined || repo === undefined) return
      const [run] = yield* db(Rows.runsWithCounts([newest]))
      const steps = (yield* db(Rows.loadSteps(newest.id))).map((s) => Rows.step(s))
      const notes = yield* db(sql<{ step: string; run_id: string; markdown: string; at: number }>`select step, run_id, markdown, at from pr_notes
        where project = ${project} and pr = ${pr} order by at`)
      // Times that only count up don't make an edit; a step's status, reason or a note do.
      const state = JSON.stringify([run!.id, run!.status, steps.map((s) => [s.name, s.status, s.waiting ?? null]), notes])
      const key = `${project}#${pr}`
      if (shown.get(key) === state) return
      const body = render({
        run: run!,
        steps,
        notes: notes.map((n) => ({ step: n.step, run: { id: n.run_id, number: Rows.runNumber(n.run_id) }, markdown: n.markdown, at: n.at })),
        link: `${config.publicUrl.replace(/\/$/, "")}/#/run/${newest.id}`,
        now: Date.now(),
      })
      const existing = yield* db(sql<{ comment_id: number }>`select comment_id from comments where project = ${project} and pr = ${pr} and step = ${own}`)
      const id = yield* gitea.comment(repo, pr, body, existing[0]?.comment_id ?? null)
      yield* db(sql`insert into comments (project, pr, step, comment_id) values (${project}, ${pr}, ${own}, ${id})
        on conflict (project, pr, step) do update set comment_id = ${id}`)
      shown.set(key, state)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`updating the comment on ${project} #${pr} failed`, cause)))

  // Steps change in bursts; one update a few seconds after the first change covers the burst.
  const pending = new Set<string>()
  const schedule = (project: string, pr: number) =>
    Effect.suspend(() => {
      const key = `${project}#${pr}`
      if (pending.has(key)) return Effect.void
      pending.add(key)
      return Effect.sleep("3 seconds").pipe(
        Effect.andThen(Effect.sync(() => pending.delete(key))),
        Effect.andThen(update(project, pr)),
        Effect.forkDetach,
        Effect.asVoid,
      )
    })

  const pullRequestOf = (runId: string) => Effect.map(db(Rows.loadRun(runId)), (run) => (run?.pr == null ? undefined : { project: run.project, pr: run.pr }))

  return {
    note: (runId, step, markdown) =>
      Effect.gen(function*() {
        const at = yield* pullRequestOf(runId)
        if (at === undefined) return
        // A run a newer one replaced keeps its say to itself, such as the URL of a preview it no longer deploys.
        if ((yield* newestOf(at.project, at.pr))?.id !== runId) return
        yield* db(sql`insert into pr_notes (project, pr, step, run_id, markdown, at) values (${at.project}, ${at.pr}, ${step}, ${runId}, ${markdown}, ${Date.now()})
          on conflict (project, pr, step) do update set run_id = ${runId}, markdown = ${markdown}, at = ${Date.now()}`)
        yield* schedule(at.project, at.pr)
      }),
    touch: (runId) =>
      Effect.gen(function*() {
        const at = yield* pullRequestOf(runId)
        if (at === undefined) return
        const noted = yield* db(sql`select 1 from pr_notes where project = ${at.project} and pr = ${at.pr} limit 1`)
        if (noted.length > 0) yield* schedule(at.project, at.pr)
      }),
  }
}))
