import { describe, expect, it } from "@effect/vitest"
import { Context, Data, Deferred, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { Agents } from "../src/controller/Agents.ts"
import { Cache } from "../src/controller/Cache.ts"
import { Comments } from "../src/controller/Comments.ts"
import * as Fleet from "../src/controller/Fleet.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Jobs, layer as jobs } from "../src/controller/Jobs.ts"
import * as Leases from "../src/controller/Leases.ts"
import { Live } from "../src/controller/Live.ts"
import { Projects } from "../src/controller/Projects.ts"
import { handlers } from "../src/controller/WorkerServer.ts"
import { type Job, WorkerRpcs } from "../src/Protocol.ts"
import { reconnecting } from "../src/worker/Client.ts"
import { config } from "./config.ts"
import { step } from "./drive.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))
// On a Calder host the test's user may not hand files to the pools' groups, which the controller does.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), chownSync: () => {} }))

const unused = () => Effect.die(new Error("not used by this test"))

/** What the worker's socket gives a call while no controller listens. */
class Disconnected extends Data.TaggedError("RpcClientError")<{}> {}

/**
 * systemd as the controller sees it: every worker's unit starts and keeps running, and stopping one never
 * returns, as on srv-2, where the host switch that restarts the controller stops polkit at the same moment.
 */
const systemd = ChildProcessSpawner.make((command) => {
  const args = ChildProcess.isStandardCommand(command) ? command.args : []
  const stdout = args.includes("ActiveState") ? "ActiveState=active\nResult=success\n" : ""
  return Effect.succeed(ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: args[0] === "stop" ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  }))
})

/** Run `run`'s deploy task `name` of project app. */
const deployStep = (run: number, name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const task = {
      shell: null, keyBase: "k", inputs: [], interpolates: [], shards: null, each: null, deps: "d", outputs: [],
      secrets: [], platform: null, lease: true,
    }
    yield* sql`insert into runs (id, project, number, event, sha, commit_title, author, commit_time, trust, status, created_at, trace_id, span_id, plan)
      values (${`app-${run}`}, 'app', ${run}, '{"_tag":"Push","branch":"main"}', ${`rev-${run}`}, 'title', 'hauke', 1, 'trusted', 'running', 1, 't', 's', '{}')
      on conflict do nothing`
    yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
      values (${`app-${run}`}, ${name}, 'task', 'running', ${JSON.stringify({ ...step, name, kind: "task", needs: [], detail: name, task })}, 0, 's')`
    return {
      _tag: "Step",
      run: {
        id: `app-${run}`, project: "app", number: run, revision: `rev-${run}`, branch: "main", trust: "trusted",
        event: { _tag: "Push", branch: "main" }, flake: "", mirror: "", mirrors: {}, pipelineDir: "", system: "x86_64-linux",
      },
      step: name, shard: null, attempt: 1, workspace: null, inputs: {}, secrets: {}, derivation: null, deps: null, files: null,
    } as Job
  })

/**
 * Two controllers, one after the other, behind one worker connection: deploy-srv-2 of run 10 holds the
 * lease, deploy-srv-1 waits for it, and deploy-srv-2's switch restarts the controller.
 */
const restarted = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const runtimeDir = mkdtempSync(join(tmpdir(), "calder-restart-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(runtimeDir, { recursive: true, force: true })))
  // Jobs learns from SIGTERM that the controller stops rather than cancels its jobs; only its listeners hear this test's signal.
  const signals = (["SIGTERM", "SIGINT"] as const).map((signal) => ({ signal, listeners: process.listeners(signal) }))
  for (const { signal } of signals) process.removeAllListeners(signal)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { signal, listeners } of signals) {
        process.removeAllListeners(signal)
        for (const listener of listeners) process.on(signal, listener)
      }
    })
  )

  // One worker connection that outlives the controllers behind it, as the worker's socket reconnects.
  let server: RpcServer.RpcServer<any> | undefined
  const { client, write } = yield* RpcClient.makeNoSerialization(WorkerRpcs, {
    supportsAck: true,
    onFromClient: ({ message }) => server === undefined ? Effect.fail(new Disconnected()) : server.write(0, message),
  })
  const published: Array<{ readonly path: string; readonly pin: string | undefined }> = []
  const cache = {
    has: (path: string) => Effect.succeed(published.some((p) => p.path === path)),
    publish: (path: string, options?: { readonly pin?: string }) => Effect.sync(() => void published.push({ path, pin: options?.pin })),
  }
  const start = Effect.gen(function*() {
    const scope = yield* Scope.make()
    const services = yield* Layer.build(Leases.layer.pipe(
      Layer.provideMerge(jobs),
      Layer.provideMerge(Layer.mergeAll(
        config({ runtimeDir, jobs: { mode: "systemd", slots: { plans: 1, builds: 1, tasks: 1, actions: 1 } } }),
        Layer.succeed(Agents)({} as unknown as Agents["Service"]),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(systemd),
        Layer.succeed(SqlClient.SqlClient)(sql),
      )),
    )).pipe(Scope.provide(scope))
    server = yield* RpcServer.makeNoSerialization(WorkerRpcs, { onFromServer: write }).pipe(
      Effect.provide(handlers.pipe(Layer.provide(Layer.mergeAll(
        Layer.succeedContext(services),
        Layer.succeed(Fleet.Fleet)({ deployTargets: unused } as unknown as Fleet.Fleet["Service"]),
        Layer.succeed(Live)({} as unknown as Live["Service"]),
        Layer.succeed(Gitea)({ head: () => Effect.succeed("rev-10") } as unknown as Gitea["Service"]),
        Layer.succeed(Projects)({ get: () => ({ name: "app", repo: "schnau/app" }) } as unknown as Projects["Service"]),
        Layer.succeed(Cache)(cache as unknown as Cache["Service"]),
        Layer.succeed(Comments)({} as unknown as Comments["Service"]),
      )))),
      Scope.provide(scope),
    )
    return {
      jobs: Context.get(services, Jobs),
      leases: Context.get(services, Leases.Leases),
      scope,
      stop: Effect.suspend(() => {
        server = undefined
        return Scope.close(scope, Exit.void)
      }),
    }
  })

  const before = yield* start
  for (const name of ["deploy-srv-2", "deploy-srv-1"]) {
    const spec = yield* deployStep(10, name)
    yield* before.jobs.run(spec, { pool: "trusted", adoptable: true, onEvent: () => Effect.void }).pipe(Effect.forkIn(before.scope))
  }
  // A plan, which no controller adopts.
  const plan = { ...(yield* deployStep(11, "plan")), _tag: "Plan", requiredChecks: [] } as unknown as Job
  yield* before.jobs.run(plan, { pool: "trusted", onEvent: () => Effect.void }).pipe(Effect.forkIn(before.scope))
  yield* Effect.yieldNow
  const job = (name: string) => before.jobs.active().find((j) => j.spec._tag === "Step" && j.spec.step === name)!.id
  const auth = (id: string) => ({ job: id, token: readFileSync(join(runtimeDir, "jobs", `${id}.token`), "utf8") })
  const srv2 = job("deploy-srv-2")
  const srv1 = job("deploy-srv-1")
  expect((yield* client.fleetAcquire({ ...auth(srv2), project: "app" }))._tag).toBe("Held")

  const waiting = yield* reconnecting(client.fleetAcquire({ ...auth(srv1), project: "app" })).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  process.emit("SIGTERM")
  // The stop leaves every worker to the next controller instead of waiting for systemd.
  const stopped = yield* before.stop.pipe(Effect.forkChild)
  yield* TestClock.adjust("1 second")
  expect(stopped.pollUnsafe()).toBeDefined()

  // The next controller adopts both workers; deploy-srv-2 still holds the lease, and deploy-srv-1 waits again.
  const after = yield* start
  yield* TestClock.adjust("5 seconds")
  expect(after.leases.holder("app")?.job).toBe(srv2)
  expect(waiting.pollUnsafe()).toBeUndefined()
  return { client, auth, srv1, srv2, waiting, after, published }
})

describe("a controller restart", () => {
  it.effect("keeps the deploy lease with the step whose deploy restarted it, and the waiting step gets it once that step ends", () =>
    Effect.gen(function*() {
      const { srv1, srv2, waiting, after } = yield* restarted

      // Once deploy-srv-2's worker ends, the lease goes to deploy-srv-1.
      const reattached = yield* after.jobs.reattach(srv2, () => Effect.void).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(after.jobs.get(srv2)!.result, { _tag: "Skipped", reason: "deployed" })
      yield* Fiber.join(reattached)
      expect((yield* Fiber.join(waiting))._tag).toBe("Held")
      expect(after.leases.holder("app")?.job).toBe(srv1)
    }).pipe(Effect.provide(sqlite), Effect.scoped))

  it.effect("lets the step that holds the lease go on deploying, and hand the lease on, after the restart", () =>
    Effect.gen(function*() {
      const { client, auth, srv1, srv2, waiting, after, published } = yield* restarted

      // deploy-srv-2's release goes to the cache as its artifact's release.
      const path = "/nix/store/0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c-app"
      yield* client.cachePublish({ ...auth(srv2), path, artifact: "APP" })
      expect(published).toEqual([{ path, pin: "app-deploy-srv-2-app" }])

      // Done deploying, it lets go of the lease, which goes to deploy-srv-1 while deploy-srv-2's worker still runs.
      yield* client.fleetRelease(auth(srv2))
      expect((yield* Fiber.join(waiting))._tag).toBe("Held")
      expect(after.leases.holder("app")?.job).toBe(srv1)
    }).pipe(Effect.provide(sqlite), Effect.scoped))

  it.effect("logs a batch of events that the worker sent again once", () =>
    Effect.gen(function*() {
      const { client, auth, srv2, after } = yield* restarted
      const logged: Array<string> = []
      const reattached = yield* after.jobs.reattach(srv2, (event) => Effect.sync(() => void (event._tag === "Log" && logged.push(event.text))))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const send = (batch: number, text: string) =>
        client.events({ ...auth(srv2), events: [{ _tag: "Log", stream: "calder", text, timestamp: 1 }], batch })
      // The connection dropped before the controller answered, so the worker sends batch 1 again.
      yield* send(1, "Still evaluating after 7 min 0 s")
      yield* send(1, "Still evaluating after 7 min 0 s")
      yield* send(2, "Still evaluating after 10 min 0 s")
      expect(logged).toEqual(["Still evaluating after 7 min 0 s", "Still evaluating after 10 min 0 s"])
      yield* Deferred.succeed(after.jobs.get(srv2)!.result, { _tag: "Skipped", reason: "deployed" })
      yield* Fiber.join(reattached)
    }).pipe(Effect.provide(sqlite), Effect.scoped))

  it.effect("gives each loss of the controller a fresh 15 minutes, once a controller took a try for a minute", () =>
    Effect.gen(function*() {
      let tries = 0
      // The controller is away, then a restarted one takes the call for 10 minutes, as a lease wait, and stops; no other comes back.
      const call = Effect.suspend(() => {
        tries++
        return tries === 2 ? Effect.sleep("10 minutes").pipe(Effect.andThen(Effect.interrupt)) : Effect.fail(new Disconnected())
      })
      const result = yield* reconnecting(call).pipe(Effect.forkChild)
      yield* TestClock.adjust("24 minutes")
      expect(result.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("2 minutes")
      expect(Exit.isFailure(result.pollUnsafe()!)).toBe(true)
    }))

  it.effect("lets a cancelled worker stop a call that may be interrupted at once", () =>
    Effect.gen(function*() {
      const call = yield* reconnecting(Effect.never).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(call)
      expect(Exit.hasInterrupts(call.pollUnsafe()!)).toBe(true)
    }))
})
