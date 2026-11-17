// Run by sqlite-worker.test.ts under Bun, whose bun:sqlite and workers vitest's Node lacks: drives the
// controller's SQLite client (Sqlite.ts) and prints what happened.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Sqlite from "../../src/controller/Sqlite.ts"

const dir = mkdtempSync(join(tmpdir(), "calder-sqlite-"))

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`create table t (id integer primary key, name text not null unique)`

  // Timer callbacks that ran while one slow statement did.
  let ticks = 0
  let counting = true
  const tick = () => {
    if (!counting) return
    ticks++
    setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
  const [count] = yield* sql<{ n: number }>`with recursive c(x) as (select 1 union all select x + 1 from c where x < 3000000)
    select count(*) as n from c`
  counting = false

  const failed = yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`insert into t (id, name) values (1, 'a')`
    yield* sql`insert into t (id, name) values (2, 'a')`
  })).pipe(Effect.flip)
  const [left] = yield* sql<{ rows: number }>`select count(*) as rows from t`

  return { n: count?.n, ticks, reason: failed.reason._tag, rows: left?.rows }
})

const result = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(Sqlite.layer({ filename: join(dir, "calder.db") })))))
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(result))
