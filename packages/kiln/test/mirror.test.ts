import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "../src/Exec.ts"
import * as Mirror from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import { config } from "./config.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const { extract } = Mirror

const revision = () => join(mkdtempSync(join(tmpdir(), "kiln-revs-")), "project", "sha")

/** Writes `.kiln/ci.ts` first and `.kiln/flake.ts` after other fibers had a turn. */
const fill = (scratch: string) =>
  Effect.gen(function*() {
    mkdirSync(join(scratch, ".kiln"))
    writeFileSync(join(scratch, ".kiln", "ci.ts"), "")
    yield* Effect.yieldNow
    writeFileSync(join(scratch, ".kiln", "flake.ts"), "")
  })

describe("extract", () => {
  it.effect("leaves one complete copy when two runs extract the same revision at once", () =>
    Effect.gen(function*() {
      const root = revision()
      const seen: Array<ReadonlyArray<string>> = []
      const watching = (scratch: string) =>
        Effect.andThen(fill(scratch), Effect.sync(() => seen.push(existsSync(root) ? readdirSync(join(root, ".kiln")) : [])))
      yield* Effect.all([extract(root, watching), extract(root, watching)], { concurrency: 2 })
      expect(seen.every((files) => files.length === 0 || files.length === 2)).toBe(true)
      expect(readdirSync(join(root, ".kiln")).sort()).toEqual(["ci.ts", "flake.ts"])
      expect(readdirSync(join(root, ".."))).toEqual(["sha"])
    }))

  it.effect("replaces a revision that was left without ci.ts", () =>
    Effect.gen(function*() {
      const root = revision()
      mkdirSync(join(root, ".kiln"), { recursive: true })
      writeFileSync(join(root, ".kiln", "flake.ts"), "")
      yield* extract(root, fill)
      expect(readdirSync(join(root, ".kiln")).sort()).toEqual(["ci.ts", "flake.ts"])
    }))

  it.effect("leaves nothing behind when the extraction fails", () =>
    Effect.gen(function*() {
      const root = revision()
      const failed = yield* extract(root, (scratch) => Effect.andThen(fill(scratch), Effect.fail("tar failed"))).pipe(Effect.flip)
      expect(failed).toBe("tar failed")
      expect(readdirSync(join(root, ".."))).toEqual([])
    }))
})

/** Starts the mirror, which sweeps once before it is ready, with `kept` as the only project. */
const sweptOnce = (state: string) =>
  Effect.gen(function*() {
    const projects = Layer.succeed(Projects)({
      get: (name) => (name === "kept" ? { name, repo: "schnau/kept", defaultBranch: "main", targets: null, secrets: {} } : undefined),
      all: () => [],
      byRepo: () => Effect.die("unused"),
    })
    const spawner = Layer.succeed(Exec.SpawnerTag)(ChildProcessSpawner.make(() => Effect.die("unused")))
    yield* Effect.asVoid(Mirror.Mirror).pipe(
      Effect.provide(Mirror.layer.pipe(Layer.provide([config({ stateDir: state }), projects, spawner]))),
    )
  })

const directories = (state: string, dirs: ReadonlyArray<string>) => {
  for (const dir of dirs) mkdirSync(join(state, dir), { recursive: true })
}

describe("Mirror", () => {
  it.effect("removes the mirror and revisions of a repository that is no longer a project", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "kiln-state-"))
      directories(state, ["mirrors/kept.git", "mirrors/gone.git", "revs/kept/sha", "revs/gone/sha"])
      yield* sweptOnce(state)
      expect(readdirSync(join(state, "mirrors"))).toEqual(["kept.git"])
      expect(readdirSync(join(state, "revs"))).toEqual(["kept"])
    }).pipe(Effect.provide(sqlite)))

  it.effect("removes revisions no run used for a day, unless a run of them is still going", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "kiln-state-"))
      const revisions = ["idle", "idle.scratch", "running", "fresh"]
      directories(state, revisions.map((sha) => `revs/kept/${sha}`))
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      for (const sha of ["idle", "idle.scratch", "running"]) utimesSync(join(state, "revs/kept", sha), twoDaysAgo, twoDaysAgo)
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("kept-1", { at: 0 })
      yield* sql`update runs set sha = 'running', status = 'running', finished_at = null where id = 'kept-1'`
      yield* sweptOnce(state)
      expect(readdirSync(join(state, "revs/kept")).sort()).toEqual(["fresh", "running"])
    }).pipe(Effect.provide(sqlite)))
})
