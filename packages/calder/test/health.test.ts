import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { vi } from "vite-plus/test";
import {
  anchored,
  failing,
  lastPassed,
  load,
  type Streak,
  streaks,
} from "../src/controller/Health.ts";
import { insertRun, insertStep, layer } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const push = '{"_tag":"Push","branch":"main"}';
const schedule = '{"_tag":"Schedule","cron":"0 * * * *"}';

/** Runs of `p` on main at 1, 2, 3, ..., each planned with the given step statuses. */
const runs = (
  ...list: ReadonlyArray<{
    readonly event?: string;
    readonly steps: Record<string, string>;
    readonly errored?: boolean;
  }>
) =>
  Effect.gen(function* () {
    for (const [i, run] of list.entries()) {
      const id = `p-${i + 1}`;
      yield* insertRun(id, {
        at: i + 1,
        branch: "main",
        event: run.event ?? push,
        planned: run.errored !== true,
        status: run.errored === true ? "errored" : "passed",
      });

      for (const [name, status] of Object.entries(run.steps))
        yield* insertStep(id, name, { status, finished: i + 1 });
    }

    return streaks(yield* load("p", "main", 0));
  });

describe("streaks", () => {
  it.effect(
    "counts a step's failed runs in a row until it passes, and leaves blocked and skipped steps out",
    () =>
      Effect.gen(function* () {
        const result = yield* runs(
          { steps: { build: "passed", placement: "failed", publish: "blocked" } },
          { steps: { build: "reused", placement: "died", publish: "blocked" } },
          { steps: { build: "reused", placement: "skipped", publish: "skipped" } },
          { steps: { build: "reused", placement: "failed", publish: "blocked" } },
        );

        expect(result).toEqual([
          { step: "placement", since: 1, firstRun: "p-1", runs: 3, endedAt: null, settled: false },
        ]);
        // Read a run at a time, it follows the streak back past the newest runs.
        expect(streaks(yield* load("p", "main", 0, 1))).toEqual(result);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("ends a streak when the step passes, and starts a new one when it fails again", () =>
    Effect.gen(function* () {
      const result = yield* runs(
        { steps: { deploy: "failed" } },
        { steps: { deploy: "failed" } },
        { steps: { deploy: "passed" } },
        { steps: { deploy: "failed" } },
        { steps: { deploy: "reused" } },
      );

      expect(result).toEqual([
        { step: "deploy", since: 4, firstRun: "p-4", runs: 1, endedAt: 5, settled: true },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "ends a step's streak once a newer run of the same event plans without it, but not one of another event",
    () =>
      Effect.gen(function* () {
        const result = yield* runs(
          { steps: { "deploy-old": "failed", "deploy-gitea": "failed" } },
          { event: schedule, steps: { "deploy-gitea": "failed" } },
          { steps: { "deploy-new": "passed", "deploy-gitea": "failed" } },
          { steps: { "deploy-new": "passed", "deploy-gitea": "failed" } },
        );

        expect(result).toEqual([
          {
            step: "deploy-gitea",
            since: 1,
            firstRun: "p-1",
            runs: 4,
            endedAt: null,
            settled: false,
          },
          { step: "deploy-old", since: 1, firstRun: "p-1", runs: 1, endedAt: 3, settled: false },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("counts a run that failed before it planned as its plan failing", () =>
    Effect.gen(function* () {
      const result = yield* runs(
        { steps: { test: "passed" } },
        { errored: true, steps: {} },
        { errored: true, steps: {} },
      );

      expect(result).toEqual([
        { step: "(plan)", since: 2, firstRun: "p-2", runs: 2, endedAt: null, settled: true },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads only trusted runs of the branch", () =>
    Effect.gen(function* () {
      yield* insertRun("p-1", { at: 1, branch: "main", planned: true });
      yield* insertStep("p-1", "test", { status: "passed" });
      yield* insertRun("p-2", { at: 2, branch: "feature", planned: true });
      yield* insertStep("p-2", "test", { status: "failed" });
      yield* insertRun("p-3", {
        at: 3,
        branch: "main",
        trust: "pr",
        planned: true,
        event: '{"_tag":"Check","ref":"x","base":"main"}',
      });
      yield* insertStep("p-3", "test", { status: "failed" });
      expect(streaks(yield* load("p", "main", 0))).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps where a streak started once retention pruned that run, and not once a pass ended it",
    () =>
      Effect.gen(function* () {
        const failing = { step: "deploy", runs: 2, endedAt: null };
        const keep = (streak: Streak) => anchored("p", [streak], 100);
        expect(yield* keep({ ...failing, since: 1, firstRun: "p-1", settled: false })).toEqual([
          { ...failing, since: 1, firstRun: "p-1", settled: false },
        ]);
        // p-1 left the runs read: the oldest failure there is p-2 now, which can't tell where the streak started.
        expect(yield* keep({ ...failing, since: 2, firstRun: "p-2", settled: false })).toEqual([
          { ...failing, since: 1, firstRun: "p-1", settled: false },
        ]);
        expect(
          yield* keep({ ...failing, since: 2, firstRun: "p-2", settled: false, endedAt: 5 }),
        ).toEqual([{ ...failing, since: 1, firstRun: "p-1", settled: false, endedAt: 5 }]);
        // Months without a run: the next failure is all the runs read hold, and starts a streak of its own.
        expect(yield* keep({ ...failing, since: 90, firstRun: "p-9", settled: false })).toEqual([
          { ...failing, since: 90, firstRun: "p-9", settled: false },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  /** p-1's testflight passed and p-2's failed; `tick` is one export of the gauge, `set` changes a run's testflight. */
  const rerun = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRun("p-1", { at: 1, branch: "main", planned: true });
    yield* insertStep("p-1", "testflight", { status: "passed", finished: 1 });
    yield* insertRun("p-2", { at: 2, branch: "main", planned: true });
    yield* insertStep("p-2", "testflight", { status: "failed", finished: 2 });

    return {
      tick: failing("p", "main", 0, 100),
      set: (run: string, status: string, finished: number | null) =>
        sql`update steps set status = ${status}, finished_at = ${finished} where run_id = ${run} and name = 'testflight'`,
      first: { step: "testflight", firstRun: "p-2", since: 2, settled: true },
    };
  });

  it.effect("keeps a streak's labels while its first failed step is rerun and fails again", () =>
    Effect.gen(function* () {
      const { tick, set, first } = yield* rerun;
      expect(yield* tick).toEqual([{ ...first, runs: 1, endedAt: null }]);

      // While the rerun waits or runs, a newer run's failure doesn't start the streak over.
      yield* set("p-2", "pending", null);
      yield* insertRun("p-3", { at: 3, branch: "main", planned: true });
      yield* insertStep("p-3", "testflight", { status: "failed", finished: 3 });
      expect(yield* tick).toEqual([{ ...first, runs: 2, endedAt: null }]);

      // The rerun fails later than the first attempt did.
      yield* set("p-2", "failed", 5);
      expect(yield* tick).toEqual([{ ...first, runs: 2, endedAt: null }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ends a streak under its labels when a rerun of its only failure passes", () =>
    Effect.gen(function* () {
      const { tick, set, first } = yield* rerun;
      expect(yield* tick).toEqual([{ ...first, runs: 1, endedAt: null }]);
      yield* set("p-2", "pending", null);
      expect(yield* tick).toEqual([{ ...first, runs: 1, endedAt: null }]);
      yield* set("p-2", "passed", 6);
      const recovered = { ...first, runs: 0, endedAt: 100 };
      expect(yield* tick).toEqual([recovered]);
      // Its 0 holds while a recovered streak is exported, though no run shows the failure any more.
      expect(yield* tick).toEqual([recovered]);

      // A failure after that pass is a streak of its own, even in the same run.
      yield* set("p-2", "failed", 8);
      expect(yield* tick).toEqual([{ ...first, since: 8, runs: 1, endedAt: null }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a recovered streak's labels when its first failure is rerun", () =>
    Effect.gen(function* () {
      const { tick, set, first } = yield* rerun;
      yield* insertRun("p-3", { at: 3, branch: "main", planned: true });
      yield* insertStep("p-3", "testflight", { status: "passed", finished: 3 });
      const recovered = { ...first, runs: 1, endedAt: 3 };
      expect(yield* tick).toEqual([recovered]);
      yield* set("p-2", "pending", null);
      expect(yield* tick).toEqual([{ ...recovered, runs: 0 }]);
      yield* set("p-2", "passed", 6);
      expect(yield* tick).toEqual([{ ...recovered, runs: 0 }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a recovered streak's labels when a rerun moves its first failure", () =>
    Effect.gen(function* () {
      const { tick, set, first } = yield* rerun;

      for (const [i, status] of [
        [3, "failed"],
        [4, "passed"],
      ] as const) {
        yield* insertRun(`p-${i}`, { at: i, branch: "main", planned: true });
        yield* insertStep(`p-${i}`, "testflight", { status, finished: i });
      }

      expect(yield* tick).toEqual([{ ...first, runs: 2, endedAt: 4 }]);
      yield* set("p-2", "pending", null);
      expect(yield* tick).toEqual([{ ...first, runs: 1, endedAt: 4 }]);
      yield* set("p-2", "failed", 9);
      expect(yield* tick).toEqual([{ ...first, runs: 2, endedAt: 4 }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "ends the newest streak under its labels when a rerun passes it, though an older one shows again",
    () =>
      Effect.gen(function* () {
        const { tick, set } = yield* rerun;

        // Runs overlap: p-3's testflight passed after p-4's failed.
        for (const [i, status, finished] of [
          [3, "passed", 5],
          [4, "failed", 4],
        ] as const) {
          yield* insertRun(`p-${i}`, { at: i, branch: "main", planned: true });
          yield* insertStep(`p-${i}`, "testflight", { status, finished });
        }

        const newest = { step: "testflight", firstRun: "p-4", since: 4, settled: true };
        expect(yield* tick).toEqual([{ ...newest, runs: 1, endedAt: null }]);
        yield* set("p-4", "pending", null);
        expect(yield* tick).toEqual([{ ...newest, runs: 1, endedAt: null }]);
        yield* set("p-4", "passed", 9);
        expect(yield* tick).toEqual([{ ...newest, runs: 0, endedAt: 100 }]);
        expect(yield* tick).toEqual([{ ...newest, runs: 0, endedAt: 100 }]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("follows a failing step that only older runs have, until it passes", () =>
    Effect.gen(function* () {
      yield* insertRun("p-1", { at: 1, branch: "main", planned: true, event: schedule });
      yield* insertStep("p-1", "nightly", { status: "passed" });
      yield* insertRun("p-2", { at: 2, branch: "main", planned: true, event: schedule });
      yield* insertStep("p-2", "nightly", { status: "failed" });

      for (const i of [3, 4, 5]) {
        yield* insertRun(`p-${i}`, { at: i, branch: "main", planned: true });
        yield* insertStep(`p-${i}`, "test", { status: "passed" });
      }

      expect(streaks(yield* load("p", "main", 0, 2))).toEqual([]);
      expect(streaks(yield* load("p", "main", 0, 2, ["nightly"]))).toEqual([
        { step: "nightly", since: 2, firstRun: "p-2", runs: 1, endedAt: null, settled: true },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("lastPassed", () => {
  it.effect(
    "says when each step of the newest runs last passed, from the window's start for one that didn't",
    () =>
      Effect.gen(function* () {
        yield* insertRun("p-1", { at: 10, branch: "main", planned: true });
        yield* insertStep("p-1", "deploy-a", { status: "passed", finished: 11 });
        yield* insertStep("p-1", "deploy-old", { status: "passed", finished: 11 });
        yield* insertRun("p-2", { at: 20, branch: "main", planned: true, event: schedule });
        yield* insertStep("p-2", "deploy-a", { status: "skipped", finished: 21 });
        yield* insertStep("p-2", "deploy-b", { status: "skipped", finished: 21 });
        yield* insertRun("p-3", { at: 30, branch: "main", planned: true });
        yield* insertStep("p-3", "deploy-a", { status: "skipped", finished: 31 });
        yield* insertStep("p-3", "deploy-b", { status: "skipped", finished: 31 });
        // A pull request's run of the same branch doesn't count.
        yield* insertRun("p-4", { at: 40, branch: "main", trust: "pr", planned: true });
        yield* insertStep("p-4", "deploy-b", { status: "passed", finished: 41 });
        // A weekly schedule's run doesn't hide the hourly one's steps.
        yield* insertRun("p-5", {
          at: 50,
          branch: "main",
          planned: true,
          event: '{"_tag":"Schedule","cron":"17 7 * * 1"}',
        });
        yield* insertStep("p-5", "skill-upstreams", { status: "passed", finished: 51 });
        expect(yield* lastPassed("p", "main", 5)).toEqual([
          { step: "deploy-a", at: 11 },
          { step: "deploy-b", at: 5 },
          { step: "skill-upstreams", at: 51 },
        ]);
      }).pipe(Effect.provide(layer)),
  );
});
