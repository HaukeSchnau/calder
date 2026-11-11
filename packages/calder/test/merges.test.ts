import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, PlatformError, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { Gitea } from "../src/controller/Gitea.ts"
import { layer as merges, Merges } from "../src/controller/Merges.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import { unused } from "./drive.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/** Pull requests 1 and 2 of app, both up to date with main. Returns the pull requests Gitea merged. */
const setup = (options: { readonly contained?: boolean } = {}) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const merged: Array<number> = []
  const comments: Array<string> = []
  const updated: Array<number> = []
  const project = { name: "app", repo: "o/app", defaultBranch: "main", targets: null, secrets: {} }
  // Every `git merge-base --is-ancestor` answers yes, unless the heads don't contain their base.
  const spawner = ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "git"
      ? Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.contained === false ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }))
      : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "spawn" }))
  )
  const layer = merges.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient)(sql),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
    Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: unused }),
    Layer.succeed(Mirror)({
      path: () => "/mirror",
      fetch: () => Effect.void,
      hasPipeline: unused,
      pipelineTree: unused,
      commit: unused,
      between: unused,
      contains: unused,
      pipelineDir: unused,
      flake: () => "",
      byUrl: () => ({}),
    }),
    Layer.succeed(Gitea)({
      pull: (_repo, pr) => Effect.succeed({ open: !merged.includes(pr), merged: merged.includes(pr), sha: `sha-${pr}`, base: "main", fork: false }),
      head: () => Effect.succeed("main-sha"),
      mergePull: (_repo, pr) => Effect.sync(() => void merged.push(pr)),
      comment: (_repo, pr, body) => Effect.sync(() => comments.push(`#${pr}: ${body}`)).pipe(Effect.as(1)),
      status: unused, requiredChecks: unused, pullTitle: unused, dispatch: unused, repos: unused, hasFile: unused,
      updatePull: (_repo, pr) => Effect.sync(() => void updated.push(pr)), mergedPull: unused, openPulls: unused,
    }),
  )))
  return { sql, merged, comments, updated, layer }
})

describe("the merge queue", () => {
  it.live("merges a green pull request while one requested before it still runs", () =>
    Effect.gen(function*() {
      const { sql, merged, layer } = yield* setup()
      yield* insertRun("app-1", { at: 1, status: "running", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      yield* Effect.gen(function*() {
        yield* Merges
        yield* Effect.sleep("200 millis")
      }).pipe(Effect.provide(layer))
      expect(merged).toEqual([2])
    }).pipe(Effect.provide(sqlite)))

  it.live("keeps a request's place when it is requested again", () =>
    Effect.gen(function*() {
      const { sql, layer } = yield* setup()
      yield* sql`insert into merges (project, pr, base, status, message, requested_at) values ('app', 1, 'main', 'updating', null, 1)`
      const request = yield* Effect.gen(function*() {
        return yield* (yield* Merges).request("app", 1)
      }).pipe(Effect.provide(layer))
      expect(request).toMatchObject({ status: "updating", requestedAt: 1 })
    }).pipe(Effect.provide(sqlite)))

  it.effect("keeps a request whose run failed, without holding its base, and merges it once a rerun passes", () =>
    Effect.gen(function*() {
      const { sql, merged, comments, layer } = yield* setup()
      yield* insertRun("app-1", { at: 1, status: "failed", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      const request = yield* Effect.gen(function*() {
        const queue = yield* Merges
        yield* TestClock.adjust("1 second")
        // Ticks every 30 s: the request stays, and Calder said why once.
        yield* TestClock.adjust("30 seconds")
        const held = (yield* queue.list("app")).find((r) => r.pr === 1)
        // The rerun in place passed.
        yield* sql`update runs set status = 'passed' where id = 'app-1'`
        yield* TestClock.adjust("30 seconds")
        return held
      }).pipe(Effect.provide(layer))
      expect(request).toMatchObject({ status: "waiting", message: expect.stringContaining("its run app-1 failed") })
      expect(merged).toEqual([2, 1])
      expect(comments).toEqual([
        "#1: Calder didn't merge this yet: its run app-1 failed; Calder merges this once a rerun of it or a run of a new push passes.",
      ])
    }).pipe(Effect.provide(sqlite)))

  it.effect("doesn't merge the base into a pull request whose run failed, so a rerun of that run can still merge it", () =>
    Effect.gen(function*() {
      const { sql, comments, updated, layer } = yield* setup({ contained: false })
      yield* insertRun("app-1", { at: 1, status: "failed", sha: "sha-1" })
      yield* sql`update runs set pr = 1`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at) values ('app', 1, 'main', 'waiting', null, 1)`
      const request = yield* Effect.gen(function*() {
        const queue = yield* Merges
        yield* TestClock.adjust("31 seconds")
        return (yield* queue.list("app"))[0]
      }).pipe(Effect.provide(layer))
      expect(updated).toEqual([])
      expect(request).toMatchObject({ status: "waiting", message: expect.stringContaining("its run app-1 failed") })
      expect(comments).toHaveLength(1)
    }).pipe(Effect.provide(sqlite)))
})
