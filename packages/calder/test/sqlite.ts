import { Effect, Layer, Semaphore, Stream } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { Migrator, SqlClient, SqlError, Statement } from "effect/sql"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { migrations } from "../src/controller/Db.ts"

/**
 * A fresh in-memory database with the controller's schema. Vitest runs on Node, so this goes through
 * node:sqlite where the controller uses bun:sqlite; test files mock `@effect/sql-sqlite-bun` away.
 */
export const layer = Layer.effect(SqlClient.SqlClient)(Effect.gen(function*() {
  const db = new DatabaseSync(":memory:")
  yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
  const all = (sql: string, params: ReadonlyArray<unknown>) =>
    Effect.try({
      try: () => db.prepare(sql).all(...(params as ReadonlyArray<SQLInputValue>)),
      catch: (cause) => new SqlError.SqlError({ reason: SqlError.classifySqliteError(cause, { message: sql, operation: "execute" }) }),
    })
  const values = (sql: string, params: ReadonlyArray<unknown>) => Effect.map(all(sql, params), (rows) => rows.map(Object.values))
  const execute = (sql: string, params: ReadonlyArray<unknown>, transform?: <A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) =>
    transform === undefined ? all(sql, params) : Effect.map(all(sql, params), transform)
  const connection = {
    execute,
    executeRaw: all,
    executeUnprepared: execute,
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: () => Stream.die("not supported"),
  }
  const { acquirer, transactionAcquirer, onCommitFailure } = SqlClient.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore: yield* Semaphore.make(1),
    isTransaction: () => db.isTransaction,
  })
  const client = yield* SqlClient.make({
    acquirer,
    transactionAcquirer,
    onCommitFailure,
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  })
  yield* Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: "calder_migrations" }).pipe(
    Effect.provideService(SqlClient.SqlClient, client),
    Effect.orDie,
  )
  return client
})).pipe(Layer.provide(Reactivity.layer))

/** A finished run `<project>-<number>` of a push to main, created and finished `at`. */
export const insertRun = (id: string, options: { readonly at: number; readonly event?: string }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const project = id.slice(0, id.lastIndexOf("-"))
    yield* sql`insert into runs (id, project, number, event, sha, commit_title, author, commit_time, trust, status, created_at,
        finished_at, trace_id, span_id, plan)
      values (${id}, ${project}, ${Number(id.slice(id.lastIndexOf("-") + 1))}, ${options.event ?? '{"_tag":"Push","branch":"main"}'},
        ${id}, 'title', 'hauke', ${options.at}, 'trusted', 'passed', ${options.at}, ${options.at}, 't', 's', '{}')`
  })

export const insertStep = (runId: string, name: string, options: {
  readonly status?: string
  readonly started?: number
  readonly finished?: number
  readonly key?: string
  readonly reusedFrom?: string
} = {}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id, started_at, finished_at, key, reused_from)
      values (${runId}, ${name}, 'task', ${options.status ?? "passed"}, '{}', 0, 's', ${options.started ?? null},
        ${options.finished ?? null}, ${options.key ?? null}, ${options.reusedFrom ?? null})`
  })
