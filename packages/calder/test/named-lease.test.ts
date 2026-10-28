import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Scope } from "effect"
import { RpcTest } from "effect/rpc"
import { SqlClient } from "effect/sql"
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
import { config } from "./config.ts"
import { step } from "./drive.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const unused = () => Effect.die(new Error("not used by this test"))

/** A push run of `app` whose task `name` holds `lease`, as the plan wrote it. */
const deployStep = (run: number, name: string, lease: true | string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const spec = {
      ...step,
      name,
      kind: "task",
      needs: [],
      detail: name,
      task: {
        shell: null, keyBase: "k", inputs: [], interpolates: [], shards: null, each: null, deps: "d", outputs: [],
        secrets: [], platform: null, lease,
      },
    }
    yield* sql`insert into runs (id, project, number, event, sha, commit_title, author, commit_time, trust, status, created_at, trace_id, span_id, plan)
      values (${`app-${run}`}, 'app', ${run}, '{"_tag":"Push","branch":"main"}', ${`rev-${run}`}, 'title', 'hauke', 1, 'trusted', 'running', 1, 't', 's', '{}')
      on conflict do nothing`
    yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id)
      values (${`app-${run}`}, ${name}, 'task', 'running', ${JSON.stringify(spec)}, 0, 's')`
    const active: ActiveJob = {
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
      remote: false,
      onEvent: () => Effect.void,
      result: yield* Deferred.make<JobResult>(),
      samples: [],
      scope: yield* Scope.make(),
      lease: undefined,
    }
    return active
  })

describe("a task with a named lease", () => {
  it.effect("acquires it through the controller, and a beta deploy goes ahead while a store build holds its own", () =>
    Effect.gen(function*() {
      const jobs = new Map<string, ActiveJob>()
      let head = "rev-10"
      let fence = 0
      const leases = Leases.make({ nextFence: () => Effect.sync(() => ++fence), held: () => Effect.void, released: () => Effect.void })
      const services = Layer.mergeAll(
        config(),
        Layer.succeed(Jobs)({ authorize: (id: string) => Effect.succeed(jobs.get(id)!) } as unknown as Jobs["Service"]),
        Layer.succeed(Leases.Leases)(leases),
        Layer.succeed(Fleet.Fleet)({ deployTargets: unused } as unknown as Fleet.Fleet["Service"]),
        Layer.succeed(Live)({} as unknown as Live["Service"]),
        Layer.succeed(Gitea)({ head: () => Effect.sync(() => head) } as unknown as Gitea["Service"]),
        Layer.succeed(Projects)({ get: () => ({ name: "app", repo: "schnau/app" }) } as unknown as Projects["Service"]),
        Layer.succeed(Cache)({ has: unused, publish: unused } as unknown as Cache["Service"]),
        Layer.succeed(Comments)({} as unknown as Comments["Service"]),
      )
      const client = yield* RpcTest.makeClient(WorkerRpcs).pipe(Effect.provide(handlers.pipe(Layer.provide(services))))

      const testflight = yield* deployStep(10, "testflight", "testflight")
      jobs.set(testflight.id, testflight)
      const store = yield* client.fleetAcquire({ job: testflight.id, token: "", project: "app" })
      expect(store._tag).toBe("Held")
      expect(leases.holder("app#testflight")?.job).toBe("testflight@10")

      // The next push's beta deploy takes the project's lease at once, while run 10's TestFlight build holds its own.
      head = "rev-11"
      const beta = yield* deployStep(11, "deploy-beta", true)
      jobs.set(beta.id, beta)
      expect((yield* client.fleetAcquire({ job: beta.id, token: "", project: "app" }))._tag).toBe("Held")
      expect(leases.holder("app")?.job).toBe("deploy-beta@11")
    }).pipe(Effect.provide(sqlite), Effect.scoped))
})
