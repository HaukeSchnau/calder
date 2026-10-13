import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { StepRow } from "./Rows.ts"

/** What we assume for a step that never ran: long enough not to jump ahead of known short ones. */
const unknown = 10 * 60_000

/** How many of a step's last executions its estimate takes the median of. */
const window = 10

const median = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const byName = (rows: ReadonlyArray<{ readonly name: string; readonly ms: number }>) => {
  const grouped = new Map<string, Array<number>>()
  for (const row of rows) grouped.set(row.name, [...(grouped.get(row.name) ?? []), row.ms])
  return new Map([...grouped].map(([name, ms]) => [name, median(ms)!]))
}

interface Execution {
  readonly name: string
  readonly run: string
  readonly finishedAt: number
  readonly ms: number
}

const recent = (project: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<Execution>`select name, run_id as run, finished_at as finishedAt, ms from (
        select steps.name, steps.run_id, steps.finished_at, steps.finished_at - steps.started_at as ms,
          row_number() over (partition by steps.name order by steps.finished_at desc) as n
        from steps join runs on runs.id = steps.run_id
        where runs.project = ${project} and steps.status in ('passed', 'failed') and steps.started_at is not null
      ) where n <= ${window}`
  })

/** Median duration of each step's last ten finished executions in a project, in ms. */
export const forProject = (project: string) => Effect.map(recent(project), byName)

/** Median duration of one shard of each sharded step, over its last thirty shards, in ms. */
export const shardsForProject = (project: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return byName(yield* sql<{ name: string; ms: number }>`select name, ms from (
        select shards.step as name, shards.finished_at - shards.started_at as ms,
          row_number() over (partition by shards.step order by shards.finished_at desc) as n
        from shards join runs on runs.id = shards.run_id
        where runs.project = ${project} and shards.status in ('passed', 'failed') and shards.started_at is not null
          and shards.finished_at is not null
      ) where n <= 30`)
  })

/**
 * `forProject` read once per project and then kept current as steps settle, since every change of a
 * step asks for it.
 */
export const make = () => {
  const projects = new Map<string, Map<string, Array<Execution>>>()
  const add = (steps: Map<string, Array<Execution>>, execution: Execution) => {
    const known = steps.get(execution.name) ?? []
    if (known.some((e) => e.run === execution.run)) return
    steps.set(execution.name, [...known, execution].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, window))
  }
  const load = (project: string) =>
    Effect.gen(function*() {
      const loaded = projects.get(project)
      if (loaded !== undefined) return loaded
      const rows = yield* recent(project)
      // Another fiber may have read the project meanwhile and added steps that settled since.
      const raced = projects.get(project)
      if (raced !== undefined) return raced
      const steps = new Map<string, Array<Execution>>()
      for (const row of rows) add(steps, row)
      projects.set(project, steps)
      return steps
    })
  return {
    forProject: (project: string) => Effect.map(load(project), (steps) => byName([...steps.values()].flat())),
    /** Counts a step's execution once it passed or failed; the same execution counts once. */
    settled: (project: string, step: Pick<StepRow, "run_id" | "name" | "status" | "started_at" | "finished_at">) =>
      Effect.gen(function*() {
        if (step.status !== "passed" && step.status !== "failed") return
        if (step.started_at === null || step.finished_at === null) return
        const steps = yield* load(project)
        add(steps, { name: step.name, run: step.run_id, finishedAt: step.finished_at, ms: step.finished_at - step.started_at })
      }),
  }
}

export const of = (estimates: ReadonlyMap<string, number>, step: string) => estimates.get(step) ?? unknown
