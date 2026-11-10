import { describe, expect, it } from "@effect/vitest"
import { Data, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { RpcClient, RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { Cache } from "../src/controller/Cache.ts"
import { Comments } from "../src/controller/Comments.ts"
import * as Fleet from "../src/controller/Fleet.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { type ActiveJob, Jobs } from "../src/controller/Jobs.ts"
import * as Leases from "../src/controller/Leases.ts"
import { Live } from "../src/controller/Live.ts"
import { Projects } from "../src/controller/Projects.ts"
import { handlers } from "../src/controller/WorkerServer.ts"
import { type JobResult, WorkerRpcs } from "../src/Protocol.ts"
import { reconnecting } from "../src/worker/Client.ts"
import { config } from "./config.ts"
import { step } from "./drive.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const unused = () => Effect.die(new Error("not used by this test"))

/** What the worker's socket gives a call while no controller listens. */
class Disconnected extends Data.TaggedError("RpcClientError")<{}> {}

/** Run `run`'s deploy task `name` of project app, adopted by every controller of the test. */
const deployJob = (run: number, name: string) =>
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
      id: `${name}@${run}`,
      tokenHash: "",
      spec: {
        _tag: "Step",
        run: {
          id: `app-${run}`, project: "app", number: run, revision: `rev-${run}`, branch: "main", trust: "trusted",
          event: { _tag: "Push", branch: "main" }, flake: "", mirror: "", mirrors: {}, pipelineDir: "", system: "x86_64-linux",
        },
        step: name, shard: null, attempt: 1, workspace: null, inputs: {}, secrets: {}, derivation: null, deps: null, files: null,
      } as ActiveJob["spec"],
      pool: "trusted" as ActiveJob["pool"],
      template: "calder-job-trusted",
      remote: false,
      onEvent: () => Effect.void,
      result: yield* Deferred.make<JobResult>(),
      samples: [],
      scope: yield* Scope.make(),
      lease: undefined,
    } satisfies ActiveJob
  })

describe("a controller restart", () => {
  it.effect("leaves a worker waiting for the deploy lease waiting, and the next controller grants it", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const jobs = new Map<string, ActiveJob>()
      let fence = 0
      const store: Leases.Store = { nextFence: () => Effect.sync(() => ++fence), held: () => Effect.void, released: () => Effect.void }
      const controller = (leases: Leases.Leases["Service"]) =>
        handlers.pipe(Layer.provide(Layer.mergeAll(
          config(),
          Layer.succeed(Jobs)({ authorize: (id: string) => Effect.succeed(jobs.get(id)!) } as unknown as Jobs["Service"]),
          Layer.succeed(Leases.Leases)(leases),
          Layer.succeed(Fleet.Fleet)({ deployTargets: unused } as unknown as Fleet.Fleet["Service"]),
          Layer.succeed(Live)({} as unknown as Live["Service"]),
          Layer.succeed(Gitea)({ head: () => Effect.succeed("rev-10") } as unknown as Gitea["Service"]),
          Layer.succeed(Projects)({ get: () => ({ name: "app", repo: "schnau/app" }) } as unknown as Projects["Service"]),
          Layer.succeed(Cache)({ has: unused, publish: unused } as unknown as Cache["Service"]),
          Layer.succeed(Comments)({} as unknown as Comments["Service"]),
          Layer.succeed(SqlClient.SqlClient)(sql),
        )))

      // One worker connection that outlives the controllers behind it, as the worker's socket reconnects.
      let server: RpcServer.RpcServer<any> | undefined
      const { client, write } = yield* RpcClient.makeNoSerialization(WorkerRpcs, {
        supportsAck: true,
        onFromClient: ({ message }) => server === undefined ? Effect.fail(new Disconnected()) : server.write(0, message),
      })
      const start = (leases: Leases.Leases["Service"]) =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          server = yield* RpcServer.makeNoSerialization(WorkerRpcs, { onFromServer: write }).pipe(
            Effect.provide(controller(leases)),
            Scope.provide(scope),
          )
          return Effect.suspend(() => {
            server = undefined
            return Scope.close(scope, Exit.void)
          })
        })

      const srv2 = yield* deployJob(10, "deploy-srv-2")
      const srv1 = yield* deployJob(10, "deploy-srv-1")
      jobs.set(srv2.id, srv2).set(srv1.id, srv1)
      const before = Leases.make(store)
      const stop = yield* start(before)
      expect((yield* client.fleetAcquire({ job: srv2.id, token: "", project: "app" }))._tag).toBe("Held")

      // deploy-srv-1 of the same run waits for the lease, then deploy-srv-2's switch restarts the controller.
      const waiting = yield* reconnecting(client.fleetAcquire({ job: srv1.id, token: "", project: "app" })).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(before.holder("app")?.job).toBe(srv2.id)
      yield* stop
      yield* Effect.yieldNow
      expect(waiting.pollUnsafe()).toBeUndefined()

      // The next controller knows that deploy-srv-2 ended, and the waiting worker's next try gets the lease.
      yield* start(Leases.make(store))
      yield* TestClock.adjust("5 seconds")
      const grant = yield* Fiber.join(waiting)
      expect(grant._tag).toBe("Held")
    }).pipe(Effect.provide(sqlite), Effect.scoped))

  it.effect("still lets a cancelled worker stop its call at once", () =>
    Effect.gen(function*() {
      const call = yield* reconnecting(Effect.never).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(call)
      expect(Exit.hasInterrupts(call.pollUnsafe()!)).toBe(true)
    }))
})
