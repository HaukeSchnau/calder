import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** What we assume for a step that never ran: long enough not to jump ahead of known short ones. */
const unknown = 10 * 60_000

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

/** Median duration of each step's last ten finished executions in a project, in ms. */
export const forProject = (project: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return byName(yield* sql<{ name: string; ms: number }>`select name, ms from (
        select steps.name, steps.finished_at - steps.started_at as ms,
          row_number() over (partition by steps.name order by steps.finished_at desc) as n
        from steps join runs on runs.id = steps.run_id
        where runs.project = ${project} and steps.status in ('passed', 'failed') and steps.started_at is not null
      ) where n <= 10`)
  })

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

export const of = (estimates: ReadonlyMap<string, number>, step: string) => estimates.get(step) ?? unknown
