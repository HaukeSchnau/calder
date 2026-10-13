import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { vi } from "vitest"
import * as Outputs from "../src/controller/Outputs.ts"
import { insertRun, insertStep, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

// None of these paths is in the store, so the sweep only removes roots and never runs nix-store.
const noProcesses = ChildProcessSpawner.make(() => Effect.die(new Error("no processes in this test")))
const path = (name: string) => `/nix/store/${"0".repeat(32)}-${name}`

describe("output roots", () => {
  it.live("drops the roots of outputs that neither a kept step nor a passed result names", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("p-1", { at: 1 })
      yield* insertStep("p-1", "e2e")
      yield* sql`update steps set outputs = ${JSON.stringify({ screenshots: path("screenshots") })} where run_id = 'p-1'`
      const result = (key: string, outputs: Record<string, string>, status: string) =>
        sql`insert into results (key, run_id, step, trust, value, outputs, created_at, status)
          values (${key}, 'p-1', 'build', 'trusted', 'null', ${JSON.stringify(outputs)}, 1, ${status})`
      yield* result("reusable", { dist: path("dist") }, "passed")
      yield* result("failed", { log: path("log") }, "failed")

      const stateDir = mkdtempSync(join(tmpdir(), "kiln-roots-"))
      mkdirSync(join(stateDir, "gcroots"))
      for (const name of ["screenshots", "dist", "log", "pruned"]) symlinkSync(path(name), join(stateDir, "gcroots", basename(path(name))))

      yield* Outputs.sweep(stateDir).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses))
      expect(readdirSync(join(stateDir, "gcroots")).sort()).toEqual([basename(path("dist")), basename(path("screenshots"))])
    }).pipe(Effect.provide(layer)))
})
