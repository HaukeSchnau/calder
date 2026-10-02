import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** What we assume for a step that never ran: long enough not to jump ahead of known short ones. */
const unknown = 10 * 60_000

const median = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Median duration of each step's last ten finished executions in a project, in ms. */
export const forProject = (project: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ name: string; ms: number }>`select name, ms from (
        select steps.name, steps.finished_at - steps.started_at as ms,
          row_number() over (partition by steps.name order by steps.finished_at desc) as n
        from steps join runs on runs.id = steps.run_id
        where runs.project = ${project} and steps.status in ('passed', 'failed') and steps.started_at is not null
      ) where n <= 10`
    const byName = new Map<string, Array<number>>()
    for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.ms])
    return new Map([...byName].map(([name, ms]) => [name, median(ms)!]))
  })

export const of = (estimates: ReadonlyMap<string, number>, step: string) => estimates.get(step) ?? unknown
