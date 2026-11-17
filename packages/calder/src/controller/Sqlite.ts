import { Context, Effect, Layer, Semaphore, Stream } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"

export type Request =
  | { readonly _tag: "Open"; readonly id: number; readonly filename: string; readonly busyTimeout: number }
  | { readonly _tag: "Close"; readonly id: number }
  | {
    readonly _tag: "Run"
    readonly id: number
    readonly sql: string
    readonly params: ReadonlyArray<unknown>
    readonly values: boolean
    readonly safeIntegers: boolean
  }

export type Reply =
  | { readonly _tag: "Done"; readonly id: number; readonly rows: ReadonlyArray<unknown>; readonly inTransaction: boolean }
  | {
    readonly _tag: "Failed"
    readonly id: number
    readonly error: { readonly name: string | undefined; readonly message: string; readonly code: unknown; readonly errno: unknown }
    readonly inTransaction: boolean
  }

/**
 * `@effect/sql-sqlite-bun`'s client with its one connection on a worker thread (SqliteWorker.ts), so no
 * statement blocks the event loop: on srv-2's busy disk, reads of cold pages stopped it for seconds, which
 * dropped every agent's connection and stalled `/health`. Statements still run one at a time, in order.
 */
export const make = (options: { readonly filename: string }) =>
  Effect.gen(function*() {
    const worker = new Worker(new URL("./SqliteWorker.ts", import.meta.url).href)
    const pending = new Map<number, (reply: Reply) => void>()
    let next = 0
    let inTransaction = false
    // Without its database the controller can do nothing, so a dead worker ends it and systemd restarts it.
    worker.addEventListener("error", (event) => {
      console.error("the SQLite worker failed:", event.message)
      process.exit(1)
    })
    worker.onmessage = ({ data: reply }: MessageEvent<Reply>) => {
      inTransaction = reply.inTransaction
      const resume = pending.get(reply.id)
      pending.delete(reply.id)
      resume?.(reply)
    }

    const send = (request: Request, operation: string) =>
      Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
        pending.set(request.id, (reply) =>
          resume(
            reply._tag === "Done"
              ? Effect.succeed(reply.rows as ReadonlyArray<any>)
              : Effect.fail(
                new SqlError({
                  reason: classifySqliteError(Object.assign(new Error(reply.error.message), reply.error), {
                    message: "Failed to execute statement",
                    operation,
                  }),
                }),
              ),
          ))
        worker.postMessage(request)
      })

    yield* send({ _tag: "Open", id: next++, filename: options.filename, busyTimeout: 5_000 }, "open").pipe(Effect.orDie)
    yield* Effect.addFinalizer(() =>
      send({ _tag: "Close", id: next++ }, "close").pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => worker.terminate())))
    )

    const run = (sql: string, params: ReadonlyArray<unknown> = [], values = false) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) =>
        send({
          _tag: "Run",
          id: next++,
          sql,
          params,
          values,
          safeIntegers: Context.get(fiber.context, Client.SafeIntegers),
        }, values ? "executeValues" : "execute")
      )

    const connection: Connection = {
      execute: (sql, params, transformRows) => transformRows ? Effect.map(run(sql, params), transformRows) : run(sql, params),
      executeRaw: (sql, params) => run(sql, params),
      executeValues: (sql, params) => run(sql, params, true),
      executeValuesUnprepared: (sql, params) => run(sql, params, true),
      executeUnprepared: (sql, params, transformRows) =>
        transformRows ? Effect.map(run(sql, params), transformRows) : run(sql, params),
      executeStream: () => Stream.die("executeStream not implemented"),
    }
    const { acquirer, onCommitFailure, transactionAcquirer } = Client.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore: yield* Semaphore.make(1),
      isTransaction: () => inTransaction,
    })
    return yield* Client.make({
      acquirer,
      compiler: Statement.makeCompilerSqlite(),
      transactionAcquirer,
      onCommitFailure,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      beginTransaction: "BEGIN IMMEDIATE",
      spanAttributes: [["db.system.name", "sqlite"]],
    })
  })

export const layer = (options: { readonly filename: string }): Layer.Layer<Client.SqlClient> =>
  Layer.effect(Client.SqlClient)(make(options)).pipe(Layer.provide(Reactivity.layer))
