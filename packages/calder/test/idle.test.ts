import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import { Agents } from "../src/controller/Agents.ts";
import { busy } from "../src/controller/Idle.ts";
import { Jobs, layer as jobs } from "../src/controller/Jobs.ts";
import type { Job } from "../src/Protocol.ts";
import { config } from "./config.ts";
import { layer as sqlite } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

// On a Calder host the test's user may not hand files to the pools' groups, which the controller does.
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  chownSync: () => {},
}));

/** systemd as the controller sees it: every worker's unit starts and keeps running. */
const systemd = ChildProcessSpawner.make((command) => {
  const args = ChildProcess.isStandardCommand(command) ? command.args : [];
  const stdout = args.includes("ActiveState") ? "ActiveState=active\nResult=success\n" : "";

  return Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.make(new TextEncoder().encode(stdout)),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  );
});

const run = {
  id: "infra-912",
  project: "infra",
  number: 912,
  revision: "rev",
  branch: "main",
  trust: "trusted",
  event: { _tag: "Push", branch: "main" },
  flake: "",
  mirror: "",
  mirrors: {},
  pipelineDir: "",
  system: "x86_64-linux",
} as const;

const step = (name: string) =>
  ({
    _tag: "Step",
    run,
    step: name,
    shard: null,
    attempt: 1,
    workspace: null,
    inputs: {},
    secrets: {},
    derivation: null,
    deps: null,
    files: null,
  }) as Job;

const plan = { _tag: "Plan", run, requiredChecks: [] } as Job;

/** m1 takes darwin jobs, and `placed` completes once it took one; no agent of another platform is there. */
const agents = (placed: Deferred.Deferred<void>) => ({
  run: (
    _: unknown,
    platform: string,
    options: { readonly onPlaced: (agent: string) => Effect.Effect<void> },
  ) =>
    platform === "aarch64-darwin"
      ? options
          .onPlaced("m1")
          .pipe(Effect.andThen(Deferred.succeed(placed, undefined)), Effect.andThen(Effect.never))
      : Effect.never,
  usage: () => [],
  stop: () => Effect.void,
});

const controller = (placed: Deferred.Deferred<void> = Deferred.makeUnsafe()) =>
  Effect.gen(function* () {
    const runtimeDir = mkdtempSync(join(tmpdir(), "calder-idle-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(runtimeDir, { recursive: true, force: true })),
    );

    return yield* Jobs.pipe(
      Effect.provide(
        jobs.pipe(
          Layer.provide(
            Layer.mergeAll(
              config({
                runtimeDir,
                jobs: { mode: "systemd", slots: { plans: 1, builds: 1, tasks: 1, actions: 1 } },
              }),
              Layer.succeed(Agents)(agents(placed) as unknown as Agents["Service"]),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(systemd),
              Layer.succeed(SqlClient.SqlClient)(yield* SqlClient.SqlClient),
            ),
          ),
        ),
      ),
    );
  });

describe("what a restart of the controller cuts off", () => {
  it.effect(
    "is nothing while only local steps' workers run, which the next controller adopts",
    () =>
      Effect.gen(function* () {
        const service = yield* controller();
        expect(busy(service.active())).toEqual([]);
        yield* service
          .run(step("lint"), { pool: "trusted", adoptable: true, onEvent: () => Effect.void })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(service.active()).toHaveLength(1);
        expect(busy(service.active())).toEqual([]);
      }).pipe(Effect.provide(sqlite), Effect.scoped),
  );

  it.effect("names plans, actions, agents' running jobs and deploys that hold their lease", () =>
    Effect.gen(function* () {
      const placed = yield* Deferred.make<void>();
      const service = yield* controller(placed);

      const start = (spec: Job, options: Partial<Parameters<typeof service.run>[1]>) =>
        service
          .run(spec, { pool: "trusted", onEvent: () => Effect.void, ...options })
          .pipe(Effect.forkScoped);

      yield* start(plan, {});
      yield* start(step("promote"), { uninterruptible: true, adoptable: false });
      yield* start(step("tests-darwin"), { adoptable: true, platform: "aarch64-darwin" });
      yield* start(step("bundle"), { adoptable: true, agent: true });
      yield* start(step("deploy-srv-1"), { adoptable: true });
      // The action finishes what it started, so it ends only with its result.
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          service.active(),
          (job) => Deferred.succeed(job.result, { _tag: "Skipped", reason: "done" }),
          { discard: true },
        ),
      );
      yield* Deferred.await(placed);
      service
        .active()
        .find((j) => j.spec._tag === "Step" && j.spec.step === "deploy-srv-1")!.lease = {
        project: "infra",
        app: "infra",
        targets: null,
      };
      expect(busy(service.active())).toEqual([
        "infra-912 plan starts over",
        "infra-912 promote starts over",
        "infra-912 tests-darwin on an agent starts over",
        "infra-912 deploy-srv-1 holds the deploy lease infra",
      ]);
    }).pipe(Effect.provide(sqlite), Effect.scoped),
  );
});
