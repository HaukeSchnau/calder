import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, PlatformError, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import * as Exec from "../src/Exec.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { layer as merges, Merges } from "../src/controller/Merges.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import { Runs } from "../src/controller/Workflow.ts"
import { unused } from "./drive.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/**
 * Pull requests of app, up to date with main unless `contained` is false. Returns what Gitea merged,
 * updated and was told, and the trains Calder built, pushed and ran.
 */
const setup = (options: { readonly contained?: boolean; readonly conflicts?: ReadonlyArray<number>; readonly protected?: boolean } = {}) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const merged: Array<number> = []
  const comments: Array<string> = []
  const updated: Array<number> = []
  const pushed: Array<string> = []
  const cancelled: Array<string> = []
  const state = { base: "main-sha", heads: {} as Record<number, string> }
  const trains = new Map<string, { base: string; heads: ReadonlyArray<{ pr: number; sha: string }> }>()
  const project = { name: "app", repo: "o/app", defaultBranch: "main", targets: null, secrets: {} }
  // `git merge-base --is-ancestor <a> <b>`: a head is in the base once a train with it was pushed there,
  // and the base is in every head unless `contained` is false.
  const landed = new Set<string>()
  const spawner = ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "git"
      ? Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.sync(() => {
          const ancestor = command.args[command.args.length - 2] ?? ""
          const yes = ancestor.startsWith("sha-") ? landed.has(ancestor) : options.contained !== false
          return ChildProcessSpawner.ExitCode(yes ? 0 : 1)
        }),
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
      train: (_project, base, heads) =>
        Effect.sync(() => {
          const kept = heads.filter((h) => !(options.conflicts ?? []).includes(h.pr))
          const sha = `train-${trains.size + 1}`
          trains.set(sha, { base, heads: kept })
          return { sha: kept.length === 0 ? null : sha, conflicts: heads.filter((h) => !kept.includes(h)).map((h) => h.pr) }
        }),
      trainOf: (_project, sha) => Effect.succeed(trains.get(sha)!),
      push: (_project, sha, ref) =>
        options.protected === true && ref === "refs/heads/main"
          ? Effect.fail(new Exec.CommandFailed({ command: "git push", exitCode: 1, stderr: "protected branch" }))
          : Effect.sync(() => {
          pushed.push(`${sha} ${ref}`)
          if (ref === "refs/heads/main") {
            state.base = sha
            for (const head of trains.get(sha)!.heads) landed.add(head.sha)
          }
        }),
    }),
    Layer.succeed(Runs)({
      create: ({ project, event, sha }) =>
        Effect.gen(function*() {
          const id = `${project}-t${pushed.length}`
          const branch = event._tag === "Check" ? event.ref : null
          yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status, created_at,
              trace_id, span_id) values (${id}, ${project}, 0, ${JSON.stringify(event)}, ${sha}, ${branch}, 'title', 'hauke', 0, 'pr', 'running', 0, 't', 's')`
          return { id } as never
        }).pipe(Effect.orDie),
      cancel: (runId) => Effect.sync(() => void cancelled.push(runId)),
      rerun: unused,
      ensure: unused,
      audit: unused,
    }),
    Layer.succeed(Gitea)({
      pull: (_repo, pr) =>
        Effect.succeed({ open: !merged.includes(pr), merged: merged.includes(pr), sha: state.heads[pr] ?? `sha-${pr}`, base: "main", fork: false }),
      head: () => Effect.sync(() => state.base),
      mergePull: (_repo, pr) => Effect.sync(() => void merged.push(pr)),
      comment: (_repo, pr, body) => Effect.sync(() => comments.push(`#${pr}: ${body}`)).pipe(Effect.as(1)),
      status: unused, requiredChecks: unused, pullTitle: unused, dispatch: unused, repos: unused, hasFile: unused,
      updatePull: (_repo, pr) => Effect.sync(() => void updated.push(pr)), mergedPull: unused, openPulls: unused,
    }),
  )))
  return { sql, merged, comments, updated, pushed, cancelled, state, layer }
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
  it.effect("lands green pull requests behind their base in one train, with one run", () =>
    Effect.gen(function*() {
      const { sql, merged, comments, updated, pushed, layer } = yield* setup({ contained: false })
      yield* insertRun("app-1", { at: 1, status: "passed", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      const requests = yield* Effect.gen(function*() {
        const queue = yield* Merges
        yield* TestClock.adjust("1 second")
        // The train's run passes.
        yield* sql`update runs set status = 'passed' where id = 'app-t1'`
        yield* TestClock.adjust("30 seconds")
        return yield* queue.list("app")
      }).pipe(Effect.provide(layer))
      expect(updated).toEqual([])
      expect(pushed).toEqual(["train-1 refs/calder/check/train-main", "train-1 refs/heads/main"])
      expect(merged).toEqual([])
      expect(requests.map((r) => r.status)).toEqual(["merged", "merged"])
      expect(comments).toEqual(["#1: Calder lands this in a train with #2: run app-t1.", "#2: Calder lands this in a train with #1: run app-t1."])
    }).pipe(Effect.provide(sqlite)))

  it.effect("leaves a pull request that conflicts out of the train, and updates it alone once the others landed", () =>
    Effect.gen(function*() {
      const { sql, updated, layer } = yield* setup({ contained: false, conflicts: [2] })
      for (const pr of [1, 2, 3]) yield* insertRun(`app-${pr}`, { at: pr, status: "passed", sha: `sha-${pr}` })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2), ('app', 3, 'main', 'waiting', null, 3)`
      const requests = yield* Effect.gen(function*() {
        const queue = yield* Merges
        yield* TestClock.adjust("1 second")
        yield* sql`update runs set status = 'passed' where id = 'app-t1'`
        yield* TestClock.adjust("30 seconds")
        return yield* queue.list("app")
      }).pipe(Effect.provide(layer))
      expect(updated).toEqual([2])
      expect(Object.fromEntries(requests.map((r) => [r.pr, r.status]))).toEqual({ 1: "merged", 2: "updating", 3: "merged" })
    }).pipe(Effect.provide(sqlite)))

  it.effect("after a train fails, updates its first pull request alone instead of running the same train again", () =>
    Effect.gen(function*() {
      const { sql, updated, pushed, layer } = yield* setup({ contained: false })
      yield* insertRun("app-1", { at: 1, status: "passed", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      yield* Effect.gen(function*() {
        yield* Merges
        yield* TestClock.adjust("1 second")
        yield* sql`update runs set status = 'failed' where id = 'app-t1'`
        yield* TestClock.adjust("30 seconds")
      }).pipe(Effect.provide(layer))
      expect(pushed).toEqual(["train-1 refs/calder/check/train-main"])
      expect(updated).toEqual([1])
    }).pipe(Effect.provide(sqlite)))

  it.effect("cancels a train whose base moved and builds a new one on the new base", () =>
    Effect.gen(function*() {
      const { sql, cancelled, pushed, state, layer } = yield* setup({ contained: false })
      yield* insertRun("app-1", { at: 1, status: "passed", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      yield* Effect.gen(function*() {
        yield* Merges
        yield* TestClock.adjust("1 second")
        state.base = "pushed-sha"
        yield* TestClock.adjust("30 seconds")
      }).pipe(Effect.provide(layer))
      expect(cancelled).toEqual(["app-t1"])
      expect(pushed).toEqual(["train-1 refs/calder/check/train-main", "train-2 refs/calder/check/train-main"])
    }).pipe(Effect.provide(sqlite)))
  it.effect("after a train that left a conflicting pull request out failed, updates the train's first alone", () =>
    Effect.gen(function*() {
      const { sql, updated, pushed, layer } = yield* setup({ contained: false, conflicts: [2] })
      for (const pr of [1, 2, 3]) yield* insertRun(`app-${pr}`, { at: pr, status: "passed", sha: `sha-${pr}` })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2), ('app', 3, 'main', 'waiting', null, 3)`
      yield* Effect.gen(function*() {
        yield* Merges
        yield* TestClock.adjust("1 second")
        yield* sql`update runs set status = 'failed' where id = 'app-t1'`
        yield* TestClock.adjust("30 seconds")
      }).pipe(Effect.provide(layer))
      expect(pushed).toEqual(["train-1 refs/calder/check/train-main"])
      expect(updated).toEqual([1])
    }).pipe(Effect.provide(sqlite)))

  it.effect("merges one at a time once the base refuses a train's push", () =>
    Effect.gen(function*() {
      const { sql, updated, pushed, layer } = yield* setup({ contained: false, protected: true })
      yield* insertRun("app-1", { at: 1, status: "passed", sha: "sha-1" })
      yield* insertRun("app-2", { at: 2, status: "passed", sha: "sha-2" })
      yield* sql`update runs set pr = substr(id, 5)`
      yield* sql`insert into merges (project, pr, base, status, message, requested_at)
        values ('app', 1, 'main', 'waiting', null, 1), ('app', 2, 'main', 'waiting', null, 2)`
      yield* Effect.gen(function*() {
        yield* Merges
        yield* TestClock.adjust("1 second")
        yield* sql`update runs set status = 'passed' where id = 'app-t1'`
        yield* TestClock.adjust("30 seconds")
      }).pipe(Effect.provide(layer))
      expect(pushed).toEqual(["train-1 refs/calder/check/train-main"])
      expect(updated).toEqual([1])
    }).pipe(Effect.provide(sqlite)))
})
