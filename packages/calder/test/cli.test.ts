import { describe, expect, it } from "@effect/vitest";
import type { Domain } from "@calder-ci/api";
import { Event } from "@calder-ci/core";
import { Effect, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { spawnSync } from "node:child_process";
import * as Cli from "../src/Cli.ts";

const queued: Domain.Run = {
  id: "calder-7",
  project: "calder",
  number: 7,
  event: { _tag: "Push", branch: "feature" },
  commit: {
    sha: "0123456789abcdef",
    changeId: null,
    title: "a change",
    author: "hauke",
    timestamp: 0,
  },
  title: null,
  trust: "trusted",
  status: "queued",
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  traceId: null,
  counts: {},
};

describe("calder plan --event", () => {
  it.effect("reads every form, with JSON inputs that contain colons", () =>
    Effect.gen(function* () {
      expect(yield* Cli.parseEvent("push")).toEqual(Event.push("main"));
      expect(yield* Cli.parseEvent("pr:12")).toEqual(Event.pullRequest({ number: 12 }));
      expect(yield* Cli.parseEvent("schedule:0 3 * * *")).toEqual(Event.schedule("0 3 * * *"));
      expect(yield* Cli.parseEvent("check")).toEqual(Event.check({ ref: "calder/check/local" }));
      expect(yield* Cli.parseEvent(`manual:{"url":"https://example.com"}`)).toEqual(
        Event.manual({ url: "https://example.com" }),
      );
    }),
  );

  it.effect("rejects a mistyped event and lists the forms", () =>
    Effect.gen(function* () {
      for (const text of ["pus:main", "pr:abc", "schedule", "manual:main", "manual:[1]"]) {
        const error = yield* Effect.flip(Cli.parseEvent(text));
        expect(error.message).toContain(`--event ${text} is not an event`);
        expect(error.message).toContain("push[:<branch>]");
      }
    }),
  );
});

describe("calder with an unknown subcommand", () => {
  it("names the closest subcommand first", () => {
    expect(Cli.closest("stauts", ["trigger", "runs", "status", "logs"])[0]).toBe("status");
    expect(Cli.closest("run", ["trigger", "rerun", "runs"])[0]).toBe("runs");
  });
});

describe("following a run", () => {
  it.effect("ends with the reason when the run ended before the change feed started", () =>
    Effect.gen(function* () {
      const errored = {
        ...queued,
        status: "errored" as const,
        error: "no rule runs pushes to feature",
      };

      const client = {
        changes: () => Stream.never,
        run: () =>
          Effect.succeed({
            seq: 1,
            run: errored,
            steps: [],
            failingTests: [],
            retried: [],
            siblings: [],
          }),
      };

      const ended = yield* Cli.follow(client, queued);
      expect(ended.status).toBe("errored");
      expect(yield* TestConsole.logLines).toContain("errored: no rule runs pushes to feature");
    }).pipe(Effect.provide(TestConsole.layer)),
  );
});

describe("the steps a failed run names", () => {
  const step = (name: string, kind: Domain.StepKind, status: Domain.StepStatus) =>
    ({ name, kind, status }) as Domain.StepRun;

  it("are those that failed or died, not those blocked behind them", () => {
    expect(
      Cli.failedSteps([
        step("lint", "build", "failed"),
        step("qa", "task", "died"),
        step("deploy-mbp", "task", "blocked"),
        step("mbp", "build", "passed"),
        step("report", "output", "failed"),
      ]),
    ).toEqual(["lint", "qa"]);
  });
});

describe("calder status", () => {
  it("names where a running step's workers run and how long ago each last logged a line", () => {
    const now = 10_000_000;

    // infra-2416's mbp on 2026-11-27: a local build on srv-2, which looked lost while it waited on m1's auto-GC.
    const running = {
      kind: "build",
      status: "running",
      name: "mbp",
      queuedAt: now - 60_000,
      startedAt: now - 60_000,
      finishedAt: null,
      error: null,
      workers: [
        {
          job: "dd11110ebd63d712",
          agent: false,
          on: "srv-2",
          unit: "calder-job-pr@dd11110ebd63d712.service",
          shard: null,
          said: now - 41_000,
        },
      ],
    } as unknown as Domain.StepRun;

    const sharded = {
      ...running,
      name: "test",
      kind: "task",
      workers: [
        { job: "a1", agent: true, on: "tower", unit: null, shard: 1, said: now - 192_000 },
        { job: "b2", agent: false, on: "srv-2", unit: null, shard: 2, said: null },
      ],
    } as unknown as Domain.StepRun;

    expect(Cli.timings([running, sharded], now).map((row) => row.at(-1))).toEqual([
      "on srv-2 in calder-job-pr@dd11110ebd63d712.service, last line 41 s ago",
      "#1 on agent tower as job a1, last line 3m 12s ago; #2 on srv-2 in job b2, no line yet",
    ]);
  });
});

describe("calder rerun", () => {
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  it.skipIf(spawnSync("bun", ["--version"]).status !== 0)("takes a run without --force", () => {
    // Port 9 refuses the connection, after the arguments parsed.
    const ran = spawnSync("bun", [main, "rerun", "app-1", "--url", "http://127.0.0.1:9"], {
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(`${ran.stdout}${ran.stderr}`).not.toContain("Missing required flag");
  });
});

describe("calder agent", () => {
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  it.skipIf(spawnSync("bun", ["--version"]).status !== 0)(
    "starts without --portable-only, --units or --evaluator",
    () => {
      // The missing token file fails it, after the arguments parsed.
      const ran = spawnSync(
        "bun",
        [
          main,
          "agent",
          "--url",
          "http://127.0.0.1:9",
          "--token-file",
          "/nonexistent",
          "--name",
          "a",
          "--workspaces",
          "/tmp",
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );

      expect(`${ran.stdout}${ran.stderr}`).not.toContain("Missing required flag");
      expect(`${ran.stdout}${ran.stderr}`).toContain("/nonexistent");
    },
  );
});
