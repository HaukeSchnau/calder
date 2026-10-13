import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { Gitea } from "../src/controller/Gitea.ts"
import * as Projects from "../src/controller/Projects.ts"
import { config } from "./config.ts"
import { insertRun, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const unused = () => Effect.die("unused")

/** Gitea where `files` lists the `repo@ref:path` that exist. */
const gitea = (files: ReadonlyArray<string>) =>
  Layer.succeed(Gitea)({
    status: unused,
    requiredChecks: unused,
    head: unused,
    pullTitle: unused,
    comment: unused,
    dispatch: unused,
    repos: () => Effect.succeed([]),
    hasFile: (repo, ref, path) => Effect.succeed(files.includes(`${repo}@${ref}:${path}`)),
    pull: unused,
    updatePull: unused,
    mergePull: unused,
    openPulls: unused,
  })

const projects = (files: ReadonlyArray<string>) =>
  Projects.layer.pipe(Layer.provide([
    gitea(files),
    config({ owners: ["schnau"], projects: { configured: { repo: "schnau/configured" } } }),
  ]))

/** Lets the startup scan, which runs in the background, finish. */
const scanned = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

describe("Projects", () => {
  it.effect("enrols a repository once the pushed revision or its default branch carries ci.ts", () =>
    Effect.gen(function*() {
      const enrolled = yield* Effect.gen(function*() {
        const p = yield* Projects.Projects
        yield* scanned
        return [
          yield* p.byRepo("schnau/pushed", { sha: "abc" }),
          yield* p.byRepo("schnau/default", { defaultBranch: "trunk" }),
          yield* p.byRepo("schnau/none", { sha: "abc" }),
          yield* p.byRepo("other/pushed", { sha: "abc" }),
        ].map((project) => project?.name)
      }).pipe(Effect.provide(projects(["schnau/pushed@abc:.kiln/ci.ts", "schnau/default@trunk:.kiln/ci.ts", "other/pushed@abc:.kiln/ci.ts"])))
      expect(enrolled).toEqual(["pushed", "default", undefined, undefined])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql<{ name: string }>`select name from projects order by name`).toEqual([{ name: "default" }, { name: "pushed" }])
    }).pipe(Effect.provide(layer)))

  it.effect("forgets enrolled projects that never ran and whose default branch carries no ci.ts", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (const name of ["idle", "ran", "carries", "configured"]) {
        yield* sql`insert into projects (name, repo, default_branch, created_at) values (${name}, ${`schnau/${name}`}, 'main', 0)`
      }
      yield* insertRun("ran-1", { at: 0 })
      const left = yield* Effect.gen(function*() {
        const p = yield* Projects.Projects
        yield* scanned
        return p.all().map((project) => project.name)
      }).pipe(Effect.provide(projects(["schnau/carries@main:.kiln/ci.ts"])))
      expect(left).toEqual(["carries", "configured", "ran"])
      expect(yield* sql<{ name: string }>`select name from projects order by name`).toEqual([
        { name: "carries" },
        { name: "configured" },
        { name: "ran" },
      ])
    }).pipe(Effect.provide(layer)))
})
