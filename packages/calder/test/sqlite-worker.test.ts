import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const hasBun = spawnSync("bun", ["--version"]).status === 0

describe("the controller's SQLite client", () => {
  // bun/sqlite.ts drives the client under Bun, which has bun:sqlite and workers.
  it.skipIf(!hasBun)("runs statements beside the event loop, and rolls back a failed transaction", () => {
    const ran = spawnSync("bun", [join(import.meta.dirname, "bun", "sqlite.ts")], { encoding: "utf8" })
    expect(ran.status, ran.stderr).toBe(0)
    const result = JSON.parse(ran.stdout.trim().split("\n").at(-1)!)
    expect(result.n).toBe(3000000)
    // A client on the event loop's thread runs no timer while a statement does.
    expect(result.ticks).toBeGreaterThan(0)
    expect(result.reason).toBe("UniqueViolation")
    expect(result.rows).toBe(0)
  })
})
