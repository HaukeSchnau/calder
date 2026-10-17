import { Context, Effect, Layer } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { StepRow } from "./Rows.ts"

/** What we assume for a step that never ran: long enough not to jump ahead of known short ones. */
const unknown = 10 * 60_000

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

interface Execution {
  readonly name: string
  /** Its run, and for a shard its index, so an execution counts once. */
  readonly id: string
  readonly finishedAt: number
  readonly ms: number
}

/** The last `window` durations of each name in a project: read once, then kept current as executions finish. */
const recent = (window: number, read: (project: string) => Effect.Effect<ReadonlyArray<Execution>, SqlError.SqlError>) => {
  const projects = new Map<string, Map<string, Array<Execution>>>()
  const add = (byName: Map<string, Array<Execution>>, execution: Execution) => {
    const known = byName.get(execution.name) ?? []
    if (known.some((e) => e.id === execution.id)) return
    byName.set(execution.name, [...known, execution].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, window))
  }
  const load = (project: string) =>
    Effect.gen(function*() {
      const loaded = projects.get(project)
      if (loaded !== undefined) return loaded
      const rows = yield* read(project).pipe(Effect.orDie)
      // Another fiber may have read the project meanwhile and added executions that finished since.
      const raced = projects.get(project)
      if (raced !== undefined) return raced
      const byName = new Map<string, Array<Execution>>()
      for (const row of rows) add(byName, row)
      projects.set(project, byName)
      return byName
    })
  return {
    medians: (project: string): Effect.Effect<ReadonlyMap<string, number>> =>
      Effect.map(load(project), (byName) => new Map([...byName].map(([name, executions]) => [name, median(executions.map((e) => e.ms))]))),
    add: (project: string, execution: Execution) => Effect.map(load(project), (byName) => add(byName, execution)),
  }
}

/** How long steps take, in ms, which orders the queues of slots and shows in the UI. */
export class Estimates extends Context.Service<Estimates, {
  /** Median duration of each step's last ten finished executions in a project. */
  readonly steps: (project: string) => Effect.Effect<ReadonlyMap<string, number>>
  /** Median duration of one shard of each sharded step, over its last thirty shards. */
  readonly shards: (project: string) => Effect.Effect<ReadonlyMap<string, number>>
  /** Counts a step once it passed or failed. */
  readonly stepSettled: (project: string, step: Pick<StepRow, "run_id" | "name" | "status" | "started_at" | "finished_at">) => Effect.Effect<void>
  /** Counts a shard that passed or failed. */
  readonly shardSettled: (project: string, shard: {
    readonly run: string
    readonly step: string
    readonly index: number
    readonly startedAt: number
    readonly finishedAt: number
  }) => Effect.Effect<void>
}>()("calder/controller/Estimates") {}

export const layer = Layer.effect(Estimates)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const steps = recent(10, (project) =>
    sql<Execution>`select name, run_id as id, finished_at as finishedAt, ms from (
        select steps.name, steps.run_id, steps.finished_at, steps.finished_at - steps.started_at as ms,
          row_number() over (partition by steps.name order by steps.finished_at desc) as n
        from steps join runs on runs.id = steps.run_id
        where runs.project = ${project} and steps.status in ('passed', 'failed') and steps.started_at is not null
      ) where n <= 10`)
  const shards = recent(30, (project) =>
    sql<Execution>`select name, id, finished_at as finishedAt, ms from (
        select shards.step as name, shards.run_id || '/' || shards.shard as id, shards.finished_at,
          shards.finished_at - shards.started_at as ms,
          row_number() over (partition by shards.step order by shards.finished_at desc) as n
        from shards join runs on runs.id = shards.run_id
        where runs.project = ${project} and shards.status in ('passed', 'failed') and shards.started_at is not null
          and shards.finished_at is not null
      ) where n <= 30`)
  return {
    steps: steps.medians,
    shards: shards.medians,
    stepSettled: (project, step) =>
      (step.status === "passed" || step.status === "failed") && step.started_at !== null && step.finished_at !== null
        ? steps.add(project, { name: step.name, id: step.run_id, finishedAt: step.finished_at, ms: step.finished_at - step.started_at })
        : Effect.void,
    shardSettled: (project, shard) =>
      shards.add(project, {
        name: shard.step,
        id: `${shard.run}/${shard.index}`,
        finishedAt: shard.finishedAt,
        ms: shard.finishedAt - shard.startedAt,
      }),
  }
}))

export const of = (estimates: ReadonlyMap<string, number>, step: string) => estimates.get(step) ?? unknown
