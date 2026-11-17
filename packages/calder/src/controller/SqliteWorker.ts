// The controller's SQLite connection, on its own thread (Sqlite.ts): a statement that reads cold pages or a
// commit that syncs can take seconds on a busy disk, and here it waits without stopping the event loop.
import { Database } from "bun:sqlite"
import type { Reply, Request } from "./Sqlite.ts"

declare const self: Worker

let db: Database | undefined

const reply = (message: Reply) => postMessage(message)

self.onmessage = ({ data: request }: MessageEvent<Request>) => {
  try {
    switch (request._tag) {
      case "Open": {
        db = new Database(request.filename, { create: true, readwrite: true })
        db.run(`pragma busy_timeout = ${request.busyTimeout}`)
        db.run("pragma journal_mode = wal")
        return reply({ _tag: "Done", id: request.id, rows: [], inTransaction: false })
      }
      case "Close": {
        db?.close()
        db = undefined
        return reply({ _tag: "Done", id: request.id, rows: [], inTransaction: false })
      }
      case "Run": {
        const statement = db!.query(request.sql)
        // @ts-ignore bun-types lacks safeIntegers (oven-sh/bun#26627), as in @effect/sql-sqlite-bun.
        statement.safeIntegers(request.safeIntegers)
        const params = request.params as Array<never>
        const rows = (request.values ? statement.values(...params) : statement.all(...params)) ?? []
        return reply({ _tag: "Done", id: request.id, rows, inTransaction: db!.inTransaction })
      }
    }
  } catch (cause) {
    const e = cause as { name?: string; message?: string; code?: unknown; errno?: unknown }
    reply({
      _tag: "Failed",
      id: request.id,
      error: { name: e.name, message: e.message ?? String(cause), code: e.code, errno: e.errno },
      inTransaction: db?.inTransaction ?? false,
    })
  }
}
