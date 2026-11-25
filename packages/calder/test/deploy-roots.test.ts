import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { vi } from "vite-plus/test";
import * as Outputs from "../src/controller/Outputs.ts";
import type { JobResult, PlannedStep } from "../src/Protocol.ts";
import { drive, step } from "./drive.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

// The runtime running this test lives in the store, so this store holds it.
const held = realpathSync(process.execPath).split("/").slice(0, 4).join("/");

const closure: PlannedStep = {
  ...step,
  name: "closure",
  kind: "build",
  needs: [],
  detail: "checks.tower",
  build: { attr: "checks.tower", drv: `${held}.drv`, out: held, system: null },
};

/** infra's deploy of a host: a task that holds a lease of its own and interpolates the host's closure. */
const deployTower: PlannedStep = {
  ...step,
  name: "deploy-tower",
  kind: "task",
  needs: ["closure"],
  neverReuse: true,
  detail: "deploy-tower",
  task: {
    shell: null,
    keyBase: "deploy-tower",
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [],
    platform: null,
    lease: "deploy-tower",
  },
};

const release: PlannedStep = {
  ...closure,
  name: "release",
  detail: "packages.projectRelease",
  build: { ...closure.build!, attr: "packages.projectRelease" },
};

/** `Release.promote`: an action with the deploy grant that reads the release. */
const promote: PlannedStep = {
  ...step,
  name: "promote",
  kind: "action",
  needs: ["release"],
  detail: "promote",
  action: { deploy: true, secrets: [] },
};

const asleep: JobResult = {
  _tag: "Skipped",
  reason: "tower is asleep; the first run while it is awake deploys it",
};

const unreachable: JobResult = {
  _tag: "Failed",
  tag: "FleetRejected",
  message: "tower answered 502",
  error: null,
  key: null,
};

/** The runs, by number, whose builds `step` keeps after they ended. */
const kept = (stateDir: string, step: string) => {
  const dir = join(stateDir, "deploys", "app", step);

  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
};

/** Drives run `number` of `steps`, building `held`, whose `deploy` step ends with `ended` or passes. */
const deployRun = (
  stateDir: string,
  number: number,
  steps: ReadonlyArray<PlannedStep>,
  deploy: string,
  ended?: JobResult,
  seed?: Effect.Effect<void, unknown, SqlClient.SqlClient>,
) =>
  drive({
    steps,
    number,
    stateDir,
    valid: (path) => path === held || path === `${held}.drv`,
    value: (s) => (s === deploy ? null : held),
    result: (s) => (s === deploy ? ended : undefined),
    ...(seed === undefined ? {} : { seed }),
  });

describe("what a deploy reads stays in the store until the step deploys", () => {
  it.live(
    "keeps a skipped host deploy's closure after its run, and drops it once a later run deployed it",
    () =>
      Effect.gen(function* () {
        const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));
        const first = yield* deployRun(stateDir, 2, [closure, deployTower], "deploy-tower", asleep);
        expect(first.steps.get("deploy-tower")?.status).toBe("skipped");
        expect(first.commands).toContainEqual([
          "nix-store",
          "--option",
          "substitute",
          "false",
          "--add-root",
          join(stateDir, "deploys", "app", "deploy-tower", "2", basename(held)),
          "--realise",
          held,
        ]);
        // The run's own roots went with it; the deploy's stay for the hourly run.
        expect(existsSync(join(stateDir, "derivations", "app-2"))).toBe(false);
        expect(kept(stateDir, "deploy-tower")).toEqual(["2"]);

        const later = yield* deployRun(stateDir, 5, [closure, deployTower], "deploy-tower");
        expect(later.steps.get("deploy-tower")?.status).toBe("passed");
        expect(kept(stateDir, "deploy-tower")).toEqual([]);
      }),
  );

  it.live("keeps a failed promotion's release for the run that promotes it later", () =>
    Effect.gen(function* () {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));
      yield* deployRun(stateDir, 2, [release, promote], "promote", unreachable);
      expect(kept(stateDir, "promote")).toEqual(["2"]);

      const later = yield* deployRun(stateDir, 3, [release, promote], "promote");
      expect(later.steps.get("promote")?.status).toBe("passed");
      expect(kept(stateDir, "promote")).toEqual([]);
    }),
  );

  it.live("keeps only the newest run's: a newer skipped deploy replaces an older one's", () =>
    Effect.gen(function* () {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));
      yield* deployRun(stateDir, 2, [closure, deployTower], "deploy-tower", asleep);
      yield* deployRun(stateDir, 3, [closure, deployTower], "deploy-tower", asleep);
      expect(kept(stateDir, "deploy-tower")).toEqual(["3"]);
    }),
  );

  it.live("keeps nothing for an older run once the same step of a newer run held the lease", () =>
    Effect.gen(function* () {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));

      const replaced: JobResult = {
        _tag: "Skipped",
        reason: "#7 took deploy-tower's deploy lease, so this older run doesn't deploy",
      };

      const newer = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into lease_steps (project, step, run) values ('app#deploy-tower', 'deploy-tower', 7)`;
      });

      yield* deployRun(stateDir, 2, [closure, deployTower], "deploy-tower", replaced, newer);
      expect(kept(stateDir, "deploy-tower")).toEqual([]);
    }),
  );

  it.live("keeps nothing for a pull request's run", () =>
    Effect.gen(function* () {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));

      const preview: PlannedStep = {
        ...deployTower,
        name: "preview",
        task: { ...deployTower.task!, lease: true, preview: true },
      };

      yield* drive({
        steps: [closure, preview],
        stateDir,
        event: { _tag: "PullRequest", number: 4, base: "main", head: "feature", fork: false },
        value: (s) => (s === "preview" ? null : held),
        result: (s) => (s === "preview" ? unreachable : undefined),
      });
      expect(kept(stateDir, "preview")).toEqual([]);
    }),
  );
});

describe("deploy roots", () => {
  const noProcesses = ChildProcessSpawner.make(() =>
    Effect.die(new Error("no processes in this test")),
  );

  it.live(
    "an older run leaves a newer run's alone, and a deploy drops only its own run's and older ones",
    () =>
      Effect.gen(function* () {
        const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));
        mkdirSync(join(stateDir, "deploys", "app", "promote", "9"), { recursive: true });
        // No path to root, so only the directories change.
        yield* Outputs.holdDeploy(stateDir, "app", "promote", 4, []).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses),
        );
        expect(kept(stateDir, "promote")).toEqual(["9"]);
        yield* Outputs.releaseDeploy(stateDir, "app", "promote", 4);
        expect(kept(stateDir, "promote")).toEqual(["9"]);
        yield* Outputs.releaseDeploy(stateDir, "app", "promote", 9);
        expect(kept(stateDir, "promote")).toEqual([]);
      }),
  );

  it.live(
    "the sweep drops what no run reached within the retention, such as a host's that left the fleet",
    () =>
      Effect.gen(function* () {
        const stateDir = mkdtempSync(join(tmpdir(), "calder-deploy-roots-"));
        const old = join(stateDir, "deploys", "app", "deploy-gone", "3");
        mkdirSync(old, { recursive: true });
        mkdirSync(join(stateDir, "deploys", "app", "deploy-tower", "8"), { recursive: true });
        const longAgo = new Date(Date.now() - 31 * 86_400_000);
        utimesSync(old, longAgo, longAgo);
        yield* Outputs.sweepDeploys(stateDir, 30);
        expect(kept(stateDir, "deploy-gone")).toEqual([]);
        expect(kept(stateDir, "deploy-tower")).toEqual(["8"]);
      }),
  );
});
