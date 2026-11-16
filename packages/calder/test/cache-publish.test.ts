import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, Scope, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcTest } from "effect/rpc"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
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
    onEvent: () => Effect.void,
    result: yield* Deferred.make<JobResult>(),
    samples: [],
    scope: yield* Scope.make(),
    lease: { project: "studienbuch#pr-104", app: "studienbuch", targets: null },
  }
  return active
})

/**
 * Publishes the preview's bundle, which this store lost, through the worker server. `substitutes` says whether
 * `nix-store --realise` gets it back from the binary cache. Returns the commands Calder ran, what it published
 * and how the call ended.
 */
const publish = (substitutes: boolean) =>
  Effect.gen(function*() {
    const stateDir = mkdtempSync(join(tmpdir(), "calder-publish-"))
    const ran: Array<ReadonlyArray<string>> = []
    const published: Array<string> = []
    const nix = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      ran.push(args)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(substitutes ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.make(new TextEncoder().encode(substitutes ? "" : `error: path '${bundle}' is required, but there is no substituter that can build it\n`)),
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
    const exit = yield* Effect.exit(client.cachePublish({ job: job.id, token: "", path: bundle, artifact: "CALDER_BUNDLE" }))
    return { ran, published, exit, root: join(stateDir, "derivations", "studienbuch-987", basename(bundle)) }
  }).pipe(Effect.provide(sqlite), Effect.scoped)

describe("publishing an artifact", () => {
  it.live("gets a path this store lost back from the binary cache and keeps it for the run, before it signs it", () =>
    Effect.gen(function*() {
      const { ran, published, exit, root } = yield* publish(true)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(ran).toEqual([["nix-store", "--add-root", root, "--realise", bundle]])
      expect(published).toEqual([bundle])
    }))

  it.live("says so when neither this store nor the binary cache has the path, and publishes nothing", () =>
    Effect.gen(function*() {
      const { published, exit } = yield* publish(false)
      expect(published).toEqual([])
      expect(Exit.isFailure(exit) ? String(Exit.isFailure(exit) && exit.cause) : "").toContain(`${bundle} is in neither this store nor the binary cache`)
    }))
})
