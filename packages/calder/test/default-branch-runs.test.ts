import { Domain } from "@calder-ci/api";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import type { AgentUsage } from "../src/controller/Agents.ts";
import * as Rows from "../src/controller/Rows.ts";
import { Runs } from "../src/controller/Workflow.ts";
import { compatibility, type PlannedStep } from "../src/Protocol.ts";
import { drive, step } from "./drive.ts";
import { insertStep } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const secret = (name: string, value: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "calder-secret-")), name);
  writeFileSync(path, value);

  return path;
};

const task = (
  name: string,
  secrets: ReadonlyArray<string> = [],
  platform: string | null = null,
): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [],
  detail: name,
  task: {
    shell: null,
    keyBase: name,
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [...secrets],
    platform,
  },
});

const project = {
  defaultBranchSecrets: { "app-store-connect": secret("app-store-connect", "store-key") },
};

const main = "a".repeat(40);
const older = "b".repeat(40);
const elsewhere = "c".repeat(40);

/**
 * Asks for a run of a push to main at `sha`, as Gitea's webhook does, while Gitea's main is at `main`
 * and descends from `older`. Returns whether it started and, once it ended, the jobs it handed out.
 */
const pushed = (sha: string) =>
  Effect.gen(function* () {
    let started: Exit.Exit<unknown, { readonly message: string }> | undefined;

    const { handed } = yield* drive({
      steps: [task("qa"), task("testflight", ["app-store-connect"])],
      project,
      defaultBranch: { head: main, ancestors: [older] },
      plan: { reuse: "none" },
      // drive's runs are app-1 and app-2, so the push's is app-3.
      seed: Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`insert into counters (name, value) values ('run:app', 2)`,
      ),
      meanwhile: Effect.gen(function* () {
        const runs = yield* Runs;
        started = yield* Effect.exit(
          runs.ensure({ project: "app", event: { _tag: "Push", branch: "main" }, sha }),
        );

        if (Exit.isFailure(started)) return;

        yield* Rows.loadRun("app-3").pipe(
          Effect.repeat({
            until: (r) => r !== undefined && Domain.ended.has(r.status),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
      }).pipe(Effect.orDie),
    });

    return {
      started: started!,
      jobs: handed
        .filter((h) => h.run === "app-3")
        .map((h) => ({ job: h.job, pool: h.pool, ...(h.secrets ? { secrets: h.secrets } : {}) })),
    };
  });

describe("a push to the default branch", () => {
  it.live(
    "of its head at Gitea plans and runs in the default branch's pool, with its secrets",
    () =>
      Effect.gen(function* () {
        const { started, jobs } = yield* pushed(main);

        expect(Exit.isSuccess(started)).toBe(true);
        expect(jobs).toEqual([
          { job: "plan", pool: "default-branch" },
          { job: "qa", pool: "default-branch", secrets: {} },
          {
            job: "testflight",
            pool: "default-branch",
            secrets: { "app-store-connect": "store-key" },
          },
        ]);
      }),
  );

  it.live("of a commit its head descends from, as a late webhook names, runs too", () =>
    Effect.gen(function* () {
      const { started, jobs } = yield* pushed(older);

      expect(Exit.isSuccess(started)).toBe(true);
      expect(jobs.map((j) => j.pool)).toEqual(Array(3).fill("default-branch"));
    }),
  );

  it.live(
    "of a commit that isn't on it at Gitea, as a webhook signed with a leaked secret could name, starts no run",
    () =>
      Effect.gen(function* () {
        const { started, jobs } = yield* pushed(elsewhere);

        expect(started).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [
              {
                error: {
                  message: `push to main of app names ${elsewhere.slice(0, 12)}, which isn't on main at Gitea (its head is ${main.slice(0, 12)})`,
                },
              },
            ],
          },
        });
        expect(jobs).toEqual([]);
      }),
  );

  // 64 hex digits are a branch name in a SHA-1 repository, which git resolves as one.
  for (const ref of ["refs/heads/main", "d".repeat(64)]) {
    it.live(`that names ${ref.slice(0, 16)}, not a commit, which could move, starts no run`, () =>
      Effect.gen(function* () {
        const { started, jobs } = yield* pushed(ref);

        expect(started).toMatchObject({
          cause: { reasons: [{ error: { message: `${ref} is no full commit id` } }] },
        });
        expect(jobs).toEqual([]);
      }),
    );
  }
});

describe("a run of the default branch that didn't pass through the check", () => {
  it.live(
    "is cancelled when a restart finds it unfinished and its commit isn't on that branch",
    () =>
      Effect.gen(function* () {
        // app-2, a push to main from before Calder checked, at a commit main doesn't hold.
        const { status, jobs } = yield* drive({
          steps: [task("testflight", ["app-store-connect"])],
          project,
          defaultBranch: { head: main },
        });

        expect(status).toBe("cancelled");
        expect(jobs).not.toContain("testflight");
      }),
  );

  it.live("doesn't run again in place when it names no commit on that branch", () =>
    Effect.gen(function* () {
      let rerun: Exit.Exit<unknown, { readonly message: string }> | undefined;

      yield* drive({
        steps: [task("qa")],
        project,
        // app-1, a push to main from before Calder checked, at "app-1", which names no commit, failed a step.
        seed: insertStep("app-1", "testflight", { status: "failed" }),
        meanwhile: Effect.gen(function* () {
          rerun = yield* Effect.exit((yield* Runs).rerun("app-1"));
        }),
      });

      expect(rerun).toMatchObject({
        cause: {
          reasons: [
            {
              error: {
                message: "app-1 is no full commit id",
              },
            },
          ],
        },
      });
    }),
  );
});

/** A Mac agent that runs pull requests sandboxed and the default branch's jobs as its user, as m1 does. */
const mac: AgentUsage = {
  name: "m1",
  platform: "aarch64-darwin",
  slots: 1,
  running: 0,
  connected: true,
  build: "b",
  compatibility,
  current: true,
  evaluator: false,
  portableOnly: false,
  pools: ["pr", "default-branch"],
  free: 1,
};

describe("a step for an agent of another platform", () => {
  it.live("of the default branch's run goes to one that takes the default branch's jobs", () =>
    Effect.gen(function* () {
      const { status, pools, placements } = yield* drive({
        steps: [task("testflight", [], "aarch64-darwin")],
        agents: () => [mac],
      });

      expect(status).toBe("passed");
      expect(pools.get("testflight")).toBe("default-branch");
      expect(placements.get("testflight")?.remote).toBe(true);
    }),
  );

  it.live(
    "of the default branch's run isn't refused while that platform's agents still take other pools, as during a rollout",
    () =>
      Effect.gen(function* () {
        // The test's jobs run wherever Calder places them, so a step Calder lets wait for an agent passes here.
        const { steps } = yield* drive({
          steps: [task("testflight", [], "aarch64-darwin")],
          agents: () => [{ ...mac, pools: ["pr", "trusted"] }],
        });

        expect(steps.get("testflight")?.status).toBe("passed");
      }),
  );

  it.live(
    "of another branch's trusted run dies when that platform's agents take no trusted jobs, rather than wait",
    () =>
      Effect.gen(function* () {
        const { steps, jobs } = yield* drive({
          steps: [task("desktop", [], "aarch64-darwin")],
          event: { _tag: "Push", branch: "feature" },
          agents: () => [mac],
        });

        expect(jobs).not.toContain("desktop");
        expect(steps.get("desktop")).toMatchObject({
          status: "died",
          error: {
            message:
              "no agent of aarch64-darwin takes jobs of the trusted pool, which this push to feature runs in",
          },
        });
      }),
  );
});
