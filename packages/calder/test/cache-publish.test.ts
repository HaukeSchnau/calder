import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { vi } from "vite-plus/test"
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
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const unused = () => Effect.die(new Error("not used by this test"))
const bundle = "/nix/store/0pnbk1rns4wk6azih0kcz7136aid5x6f-studienbuch-bundle"

/** Pull request #104's preview task of run studienbuch-987, holding the pull request's lease. */
const preview = Effect.gen(function*() {
  const active: ActiveJob = {
    id: "preview@987",
    tokenHash: "",
    spec: {
      _tag: "Step",
      run: {
        id: "studienbuch-987", project: "studienbuch", number: 987, revision: "rev", branch: "m1/sync-dataloss", trust: "trusted",
        event: { _tag: "PullRequest", number: 104, base: "main", head: "m1/sync-dataloss", fork: false }, flake: "", mirror: "", mirrors: {},
        pipelineDir: "", system: "x86_64-linux",
      },
      step: "preview", shard: null, attempt: 1, workspace: null, inputs: {}, secrets: {}, derivation: null, deps: null, files: null,
    } as ActiveJob["spec"],
    pool: "trusted" as ActiveJob["pool"],
    template: "calder-job-trusted",
    remote: false,
    persisted: true,
    running: true,
    onEvent: () => Effect.void,
    result: yield* Deferred.make<JobResult>(),
    samples: [],
    scope: yield* Scope.make(),
    lease: { project: "studienbuch#pr-104", app: "studienbuch", targets: null },
  }
  return active
})

/**
 * Publishes the preview's bundle, which this store lost, through the worker server. `fetch` is what
 * `nix-store --realise` does with it: get it back from the binary cache, fail as Nix does when no substituter
 * has it, or never end, as against a substituter that stalls. Returns the commands Calder ran, what it
 * published and how the call ended.
 */
const publish = (fetch: "substitutes" | "fails" | "stalls") =>
  Effect.gen(function*() {
    const stateDir = mkdtempSync(join(tmpdir(), "calder-publish-"))
    const ran: Array<ReadonlyArray<string>> = []
    const published: Array<string> = []
    const nix = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      ran.push(args)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: fetch === "stalls" ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(fetch === "substitutes" ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.make(new TextEncoder().encode(fetch === "fails" ? `error: path '${bundle}' is required, but there is no substituter that can build it\n` : "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }))
    })
    const job = yield* preview
    const services = Layer.mergeAll(
      config({ stateDir }),
      Layer.succeed(Jobs)({ authorize: () => Effect.succeed(job) } as unknown as Jobs["Service"]),
      Layer.succeed(Leases.Leases)({} as unknown as Leases.Leases["Service"]),
      Layer.succeed(Fleet.Fleet)({ deployTargets: unused } as unknown as Fleet.Fleet["Service"]),
      Layer.succeed(Live)({} as unknown as Live["Service"]),
      Layer.succeed(Gitea)({} as unknown as Gitea["Service"]),
      Layer.succeed(Projects)({} as unknown as Projects["Service"]),
      Layer.succeed(Cache)({
        has: (path) => Effect.succeed(published.includes(path)),
        publish: (path) => Effect.sync(() => void published.push(path)),
      }),
      Layer.succeed(Comments)({} as unknown as Comments["Service"]),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(nix),
    )
    const client = yield* RpcTest.makeClient(WorkerRpcs).pipe(Effect.provide(handlers.pipe(Layer.provide(services))))
    const call = yield* Effect.forkChild(Effect.exit(client.cachePublish({ job: job.id, token: "", path: bundle, artifact: "CALDER_BUNDLE" })))
    yield* TestClock.adjust("5 minutes")
    const exit = yield* Fiber.join(call)
    const why = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    return { ran, published, exit, why, root: join(stateDir, "derivations", "studienbuch-987", basename(bundle)) }
  }).pipe(Effect.provide(sqlite), Effect.scoped)

describe("publishing an artifact", () => {
  it.effect("gets a path this store lost back from the binary cache and keeps it for the run, before it signs it", () =>
    Effect.gen(function*() {
      const { ran, published, exit, root } = yield* publish("substitutes")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(ran).toEqual([["nix-store", "--add-root", root, "--realise", bundle]])
      expect(published).toEqual([bundle])
    }))

  it.effect("says it couldn't fetch a path from the binary cache, with Nix's reason, and publishes nothing", () =>
    Effect.gen(function*() {
      const { published, why } = yield* publish("fails")
      expect(published).toEqual([])
      expect(why).toContain(`${bundle} isn't in this store, and fetching it from the binary cache failed`)
      expect(why).toContain("there is no substituter that can build it")
    }))

  // The job holds its deploy lease while it publishes, so a stalled substituter would hold every other deploy up.
  it.effect("gives up fetching a path after 5 minutes, and publishes nothing", () =>
    Effect.gen(function*() {
      const { published, why } = yield* publish("stalls")
      expect(published).toEqual([])
      expect(why).toContain("fetching it from the binary cache failed")
      expect(why).toContain("timed out after 5 minutes")
    }))
})
