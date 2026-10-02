import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Increments and returns a named counter. */
export const next = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ value: number }>`insert into counters (name, value) values (${name}, 1)
      on conflict (name) do update set value = value + 1 returning value`
    return rows[0]!.value
  })

/**
 * Increments a counter to at least `min`. Fencing tokens use the clock as `min`, so they keep rising even
 * if this database is replaced, and a promotion endpoint never sees an older token from a newer lease.
 */
export const nextAtLeast = (name: string, min: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ value: number }>`insert into counters (name, value) values (${name}, ${min})
      on conflict (name) do update set value = max(value + 1, ${min}) returning value`
    return rows[0]!.value
  })
