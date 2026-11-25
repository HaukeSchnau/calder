import { Domain } from "@calder-ci/api";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schedule } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import * as Catchup from "../src/controller/Catchup.ts";
import { Closes, layer as closes } from "../src/controller/Closes.ts";
import { Gitea } from "../src/controller/Gitea.ts";
import { Mirror } from "../src/controller/Mirror.ts";
import { type Project, Projects } from "../src/controller/Projects.ts";
import * as Rows from "../src/controller/Rows.ts";
import { RunsCore } from "../src/controller/Runs.ts";
import * as Webhook from "../src/controller/Webhook.ts";
import { RunError, type RunInput, Runs, untrusted } from "../src/controller/Workflow.ts";
import type { PlannedStep } from "../src/Protocol.ts";
import { config } from "./config.ts";
import { type Drive, drive, step, unused } from "./drive.ts";
import { layer as sqlite } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const project: Project = {
  name: "app",
  repo: "schnau/app",
  defaultBranch: "main",
  targets: null,
  secrets: {},
};

/** A run the webhook, the catch-up or a closing asked for. */
interface Asked {
  readonly input: RunInput;
}

/** The pull request's head before a push to its branch. */
const older = "c".repeat(40);

/** A revision of main. */
const merged = "m".repeat(40);

/**
 * The webhook, the catch-up and the closings in front of a Gitea whose open pull requests are `open`, with
 * the controller's `trustedPushers`. Gitea names Calder's user by `self`, and the mirror a revision's
 * `parents`, by default those of main merged into `older`, and finds the second `onMain`. Returns the runs
 * they asked for.
 */
const world = (
  options: {
    readonly open?: ReadonlyArray<number>;
    readonly trustedPushers?: ReadonlyArray<string>;
    readonly self?: Effect.Effect<string, string>;
    readonly parents?: ReadonlyArray<string>;
    /** Whether the mirror finds a revision in main's history. */
    readonly onMain?: boolean;
    /** How many of the runs asked for fail to start, the first. */
    readonly failing?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const asked: Array<Asked> = [];

    const services = Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient)(sql),
      config({ trustedPushers: options.trustedPushers ?? [] }),
      Layer.succeed(Projects)({
        get: () => project,
        all: () => [project],
        byRepo: () => Effect.succeed(project),
      }),
      Layer.succeed(Mirror)({
        path: () => "/mirror",
        fetch: () => Effect.void,
        hasPipeline: () => Effect.succeed(true),
        pipelineTree: unused,
        commit: unused,
        between: unused,
        contains: () => Effect.succeed(options.onMain ?? true),
        parents: () => Effect.succeed(options.parents ?? [older, merged]),
        pipelineDir: unused,
        flake: () => "",
        byUrl: () => ({}),
        train: unused,
        trainOf: unused,
        push: unused,
      }),
      Layer.succeed(Runs)({
        create: (input) =>
          Effect.sync(() => void asked.push({ input })).pipe(Effect.as({} as never)),
        ensure: (input) =>
          Effect.suspend(() => {
            asked.push({ input });

            return asked.length <= (options.failing ?? 0)
              ? Effect.fail(RunError.make({ message: "Gitea is down" }))
              : Effect.succeed({} as never);
          }),
        cancel: () => Effect.void,
        rerun: unused,
        audit: unused,
      }),
      Layer.succeed(Gitea)({
        self: options.self ?? Effect.succeed("calder"),
        head: (_repo, branch) => Effect.succeed(`${branch}-head`),
        openPulls: () =>
          Effect.succeed(
            (options.open ?? []).map((number) => ({
              number,
              base: "main",
              head: `pr-${number}`,
              sha: `sha-${number}`,
              fork: false,
            })),
          ),
        closedPulls: () => Effect.succeed([]),
        status: unused,
        requiredChecks: unused,
        pullTitle: unused,
        comment: unused,
        dispatch: unused,
        repos: unused,
        hasFile: unused,
        pull: unused,
        mergedPull: unused,
        updatePull: unused,
        mergePull: unused,
      }),
    );

    const layer = closes.pipe(Layer.provideMerge(services));

    /** The runs asked for once there are `count`; the webhook asks in the background. */
    const runs = (count: number) =>
      Effect.sync(() => [...asked]).pipe(
        Effect.repeat({
          until: (all) => all.length >= count,
          schedule: Schedule.spaced("5 millis"),
        }),
        Effect.timeout("2 seconds"),
      );

    return { asked, runs, layer };
  });

/** Gitea's webhook, signed with the test config's empty secret. */
const hook = (event: "push" | "pull_request", payload: object) => {
  const body = JSON.stringify({
    repository: { full_name: project.repo, default_branch: "main" },
    ...payload,
  });

  return Webhook.handle(
    HttpServerRequest.fromWeb(
      new Request("http://calder.test/hooks/gitea", {
        method: "POST",
        headers: {
          "x-gitea-event": event,
          "x-gitea-signature": createHmac("sha256", "").update(body).digest("hex"),
        },
        body,
      }),
    ),
  );
};

/** The revision the pushes and pull request #7 of these tests are at. */
const head = "b".repeat(40);

/** Gitea's webhook of `pusher`'s push of `head` to `branch`, which was at `older`. */
const push = (branch: string, pusher: string | null) =>
  hook("push", {
    ref: `refs/heads/${branch}`,
    before: older,
    after: head,
    ...(pusher === null ? {} : { pusher: { login: pusher }, sender: { login: pusher } }),
  });

/**
 * Gitea's webhook of pull request #7 from `feature`, which `sender` acted on. A `synchronized` one says
 * `sender` pushed `after`, the head unless given, over `before`; null leaves `after` out.
 */
const pull = (
  action: string,
  sender: string,
  options: {
    readonly base?: string;
    readonly before?: string;
    readonly after?: string | null;
  } = {},
) =>
  hook("pull_request", {
    action,
    number: 7,
    sender: { login: sender },
    ...(action === "synchronized" && options.after !== null
      ? { before: options.before ?? older, after: options.after ?? head }
      : {}),
    pull_request: {
      closed_at: new Date().toISOString(),
      head: { ref: "feature", sha: head, repo: { full_name: project.repo } },
      base: { ref: options.base ?? "main", repo: { full_name: project.repo } },
    },
  });

/** What webhooks said of who pushed `sha`. */
const pushed = (sha: string, trusted: boolean) => Rows.pushed(project.name, sha, trusted);
const said = (sha: string) => Rows.pushedTrusted(project.name, sha);

type Seed = Effect.Effect<void, unknown, SqlClient.SqlClient>;

describe("a webhook says who pushed a revision", () => {
  const pushes: ReadonlyArray<[string, string | null, string, boolean]> = [
    ["renovate, a bot with write access", "renovate", "renovate/lockfile", false],
    ["renovate past main's branch protection", "renovate", "main", false],
    ["someone Gitea doesn't name", null, "feature", false],
    ["the repository's owner", "schnau", "feature", true],
    ["the repository's owner, to main", "schnau", "main", true],
    ["Calder, landing the merge train on main", "calder", "main", true],
    // Merges.ts `update`: the base merged into a pull request's branch, whose code is the pull request's.
    ["Calder, merging main into renovate's branch", "calder", "renovate/lockfile", false],
  ];

  for (const [who, pusher, branch, trusted] of pushes) {
    it.live(`of a push by ${who}: ${trusted ? "trusted" : "not trusted"}`, () =>
      Effect.gen(function* () {
        const { runs, layer } = yield* world();
        yield* push(branch, pusher).pipe(Effect.provide(layer));

        expect(yield* said(head)).toBe(trusted);
        expect(yield* runs(1)).toEqual([
          { input: { project: "app", event: { _tag: "Push", branch }, sha: head } },
        ]);
      }).pipe(Effect.provide(sqlite)),
    );
  }

  it.live("of a push by someone the controller's trustedPushers name: trusted", () =>
    Effect.gen(function* () {
      const { layer } = yield* world({ trustedPushers: ["maria"] });
      yield* push("redesign", "maria").pipe(Effect.provide(layer));

      expect(yield* said(head)).toBe(true);
    }).pipe(Effect.provide(sqlite)),
  );

  it.live(
    "of Calder landing the merge train on a main renovate pushed past its protection: not trusted",
    () =>
      Effect.gen(function* () {
        yield* pushed(older, false);
        const { layer } = yield* world();
        yield* push("main", "calder").pipe(Effect.provide(layer));

        expect(yield* said(head)).toBe(false);
      }).pipe(Effect.provide(sqlite)),
  );

  for (const [who, pusher, trusted] of [
    ["the owner", "schnau", true],
    ["Calder", "calder", false],
  ] as const) {
    it.live(
      `of a push to main by ${who} while Gitea doesn't say which user Calder is: ${trusted ? "trusted" : "not trusted"}`,
      () =>
        Effect.gen(function* () {
          const { runs, layer } = yield* world({ self: Effect.fail("Gitea is down") });
          yield* push("main", pusher).pipe(Effect.provide(layer));

          expect(yield* said(head)).toBe(trusted);
          expect((yield* runs(1)).map((r) => r.input.event)).toEqual([
            { _tag: "Push", branch: "main" },
          ]);
        }).pipe(Effect.provide(sqlite)),
    );
  }

  it.live("and once someone trusted pushed it, it stays trusted", () =>
    Effect.gen(function* () {
      yield* pushed(head, true);
      yield* pushed(head, false);

      expect(yield* said(head)).toBe(true);
    }).pipe(Effect.provide(sqlite)),
  );

  const pulls: ReadonlyArray<
    [
      string,
      Seed,
      string,
      string,
      object,
      boolean | undefined,
      { readonly parents?: ReadonlyArray<string>; readonly onMain?: boolean }?,
    ]
  > = [
    ["the owner pushed to a pull request", Effect.void, "synchronized", "schnau", {}, true],
    ["renovate pushed to one", Effect.void, "synchronized", "renovate", {}, false],
    // Gitea says who opened or reopened it, not who pushed its head.
    ["the owner opened one", Effect.void, "opened", "schnau", {}, undefined],
    [
      "the owner reopened one renovate pushed",
      pushed(head, false),
      "reopened",
      "schnau",
      {},
      false,
    ],
    // Without `after`, the head may be another push's than the sender's.
    [
      "the owner pushed, without the revision",
      Effect.void,
      "synchronized",
      "schnau",
      { after: null },
      undefined,
    ],
    [
      "Calder merged main into one the owner pushed",
      pushed(older, true),
      "synchronized",
      "calder",
      {},
      true,
    ],
    [
      "Calder merged main, which renovate pushed past its protection, into one the owner pushed",
      Effect.all([pushed(older, true), pushed(merged, false)]),
      "synchronized",
      "calder",
      {},
      false,
    ],
    [
      "Calder pushed to one the owner pushed what isn't main merged into it",
      pushed(older, true),
      "synchronized",
      "calder",
      {},
      false,
      { parents: [older] },
    ],
    // Gitea says so to each pull request of the branch, also one into main when Calder merged another base.
    [
      "Calder merged another branch into one the owner pushed, which a pull request into main shares",
      pushed(older, true),
      "synchronized",
      "calder",
      {},
      false,
      { onMain: false },
    ],
    [
      "Calder merged main into one renovate pushed",
      pushed(older, false),
      "synchronized",
      "calder",
      {},
      false,
    ],
    [
      "Calder merged main into one nobody said who pushed",
      Effect.void,
      "synchronized",
      "calder",
      {},
      false,
    ],
    // The base, which Calder merged in, may be anyone's.
    [
      "Calder merged another base into one the owner pushed",
      pushed(older, true),
      "synchronized",
      "calder",
      { base: "feature-base" },
      false,
    ],
  ];

  for (const [what, seed, action, sender, options, trusted, mirror = {}] of pulls) {
    it.live(
      `when ${what}: ${trusted === undefined ? "nothing" : trusted ? "trusted" : "not trusted"}`,
      () =>
        Effect.gen(function* () {
          yield* seed;
          const { runs, layer } = yield* world(mirror);
          yield* pull(action, sender, options).pipe(Effect.provide(layer));

          // The event stays the pull request's, so the catch-up finds the run.
          expect((yield* runs(1))[0]).toEqual({
            input: {
              project: "app",
              event: {
                _tag: "PullRequest",
                number: 7,
                base: "base" in options ? options.base : "main",
                head: "feature",
                fork: false,
              },
              sha: head,
              fork: false,
            },
          });
          expect(yield* said(head)).toBe(trusted);
        }).pipe(Effect.provide(sqlite)),
    );
  }

  it.live("but not of a pull request's head that another push moved on since", () =>
    Effect.gen(function* () {
      const { asked, layer } = yield* world();
      yield* pull("synchronized", "schnau", { after: "d".repeat(40) }).pipe(Effect.provide(layer));
      yield* Effect.sleep("50 millis");

      expect(asked).toEqual([]);
      expect(yield* said(head)).toBe(undefined);
      expect(yield* said("d".repeat(40))).toBe(undefined);
    }).pipe(Effect.provide(sqlite)),
  );
});

describe("a run's code runs like a fork's pull request", () => {
  const runs: ReadonlyArray<[string, Domain.Event, Seed, boolean]> = [
    [
      "a push of a branch nobody said who pushed",
      { _tag: "Push", branch: "feature" },
      Effect.void,
      true,
    ],
    [
      "a push of a branch renovate pushed",
      { _tag: "Push", branch: "feature" },
      pushed(head, false),
      true,
    ],
    [
      "but not one of a branch the owner pushed",
      { _tag: "Push", branch: "feature" },
      pushed(head, true),
      false,
    ],
    [
      "nor main's head nobody said who pushed, as only the trusted may",
      { _tag: "Push", branch: "main" },
      Effect.void,
      false,
    ],
    [
      "but main's head renovate pushed past its protection",
      { _tag: "Push", branch: "main" },
      pushed(head, false),
      true,
    ],
    ["and a schedule of it", { _tag: "Schedule", cron: "0 3 * * *" }, pushed(head, false), true],
    [
      "a pull request's revision nobody said who pushed",
      { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false },
      Effect.void,
      true,
    ],
    [
      "but not one the owner pushed",
      { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false },
      pushed(head, true),
      false,
    ],
    [
      "a closed pull request's of a base nobody said who pushed",
      { _tag: "PullRequestClosed", number: 7, base: "feature", head: "x" },
      Effect.void,
      true,
    ],
    [
      "but not one of a base the owner pushed",
      { _tag: "PullRequestClosed", number: 7, base: "feature", head: "x" },
      pushed(head, true),
      false,
    ],
    [
      "nor one of main",
      { _tag: "PullRequestClosed", number: 7, base: "main", head: "x" },
      Effect.void,
      false,
    ],
    // Someone who may start a manual run or a check chose to.
    [
      "but not a manual run of a branch renovate pushed",
      { _tag: "Manual", inputs: {}, branch: "feature" },
      pushed(head, false),
      false,
    ],
  ];

  for (const [what, event, seed, fork] of runs) {
    it.live(`${fork ? "is" : "isn't"}: ${what}`, () =>
      Effect.gen(function* () {
        yield* seed;

        expect(yield* untrusted({ project: "app", event, sha: head }, "main")).toBe(fork);
      }).pipe(Effect.provide(sqlite)),
    );
  }

  it.live("as does a fork's pull request, whoever pushed it", () =>
    Effect.gen(function* () {
      yield* pushed(head, true);

      const event = {
        _tag: "PullRequest",
        number: 7,
        base: "main",
        head: "f",
        fork: true,
      } as const;

      expect(yield* untrusted({ project: "app", event, sha: head, fork: true }, "main")).toBe(true);
    }).pipe(Effect.provide(sqlite)),
  );
});

describe("the catch-up", () => {
  it.live(
    "asks for the heads' runs, and looks at a head again once a webhook said who pushed it",
    () =>
      Effect.gen(function* () {
        const { runs, layer } = yield* world({ open: [1] });

        yield* Effect.gen(function* () {
          const sweep = yield* Catchup.make;
          yield* sweep;
          yield* sweep;
          yield* pushed("sha-1", true);
          yield* sweep;
        }).pipe(Effect.provide(layer));

        expect((yield* runs(3)).map((r) => [r.input.event._tag, r.input.sha])).toEqual([
          ["Push", "main-head"],
          ["PullRequest", "sha-1"],
          ["PullRequest", "sha-1"],
        ]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.live("looks at a head again whose run failed to start", () =>
    Effect.gen(function* () {
      const { runs, layer } = yield* world({ failing: 1 });

      yield* Effect.gen(function* () {
        const sweep = yield* Catchup.make;
        yield* sweep;
        yield* sweep;
      }).pipe(Effect.provide(layer));

      expect((yield* runs(2)).map((r) => [r.input.event._tag, r.input.sha])).toEqual([
        ["Push", "main-head"],
        ["Push", "main-head"],
      ]);
    }).pipe(Effect.provide(sqlite)),
  );
});

const file = (name: string, value: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "calder-secret-")), name);
  writeFileSync(path, value);

  return path;
};

const task = (name: string, secrets: ReadonlyArray<string>, lease = false): PlannedStep => ({
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
    platform: null,
    ...(lease ? { lease } : {}),
  },
});

/** Waits until the run `id` ended. */
const ended = (id: string) =>
  Rows.loadRun(id).pipe(
    Effect.repeat({
      until: (r) => r !== undefined && Domain.ended.has(r.status),
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeout("5 seconds"),
    Effect.orDie,
  );

/** Reads what the database holds once the run's steps settled. */
const reading = <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    return yield* query(yield* SqlClient.SqlClient);
  });

describe("a push to main", () => {
  const configured = {
    secrets: { cloudflare: file("cloudflare", "cloudflare-token") },
    defaultBranchSecrets: { "app-store-connect": file("app-store-connect", "store-key") },
  };

  const steps = [
    task("qa", []),
    task("deploy", ["cloudflare"], true),
    task("testflight", ["app-store-connect"]),
  ];

  /** Per job, the pool it ran in, and of a step's the run's trust it carried and the secrets it was handed. */
  const ran = (untrusted: boolean) =>
    Effect.gen(function* () {
      const handed = new Map<
        string,
        { readonly trust: Domain.Trust; readonly secrets: Readonly<Record<string, string>> }
      >();

      const run = yield* drive({
        steps,
        untrusted,
        unplanned: true,
        project: configured,
        result: (name, job) => {
          handed.set(name, { trust: job.run.trust, secrets: job.secrets });

          return undefined;
        },
      });

      return Object.fromEntries(
        [...run.pools].map(([name, pool]) => [name, { pool, ...handed.get(name) }]),
      );
    });

  it.live(
    "by renovate plans and runs in the fork pool, as a pull request's run without secrets",
    () =>
      Effect.gen(function* () {
        expect(yield* ran(true)).toEqual({
          plan: { pool: "fork" },
          qa: { pool: "fork", trust: "pr", secrets: {} },
          deploy: { pool: "fork", trust: "pr", secrets: {} },
          testflight: { pool: "fork", trust: "pr", secrets: {} },
        });
      }),
  );

  it.live("by the owner or Calder plans and runs trusted, with its secrets", () =>
    Effect.gen(function* () {
      expect(yield* ran(false)).toEqual({
        plan: { pool: "trusted" },
        qa: { pool: "trusted", trust: "trusted", secrets: {} },
        deploy: { pool: "trusted", trust: "trusted", secrets: { cloudflare: "cloudflare-token" } },
        testflight: {
          pool: "trusted",
          trust: "trusted",
          secrets: { "app-store-connect": "store-key" },
        },
      });
    }),
  );

  /** The schedules once a push to main whose plan names 03:00 ran, where 04:00 was before. */
  const schedules = (options: Partial<Drive> = {}) =>
    Effect.map(
      drive({
        steps: [task("qa", [])],
        unplanned: true,
        plan: { schedules: ["0 3 * * *"] },
        seed: reading(
          (sql) => sql`insert into schedules (project, cron) values ('app', '0 4 * * *')`,
        ),
        read: reading((sql) => sql`select cron from schedules`),
        ...options,
      }),
      (r) => r.read,
    );

  it.live("by renovate leaves the schedules as they were", () =>
    Effect.gen(function* () {
      expect(yield* schedules({ untrusted: true })).toEqual([{ cron: "0 4 * * *" }]);
      expect(yield* schedules()).toEqual([{ cron: "0 3 * * *" }]);
    }),
  );

  it.live(
    "leaves the schedules as they were once a webhook said renovate pushed it while it planned",
    () =>
      Effect.gen(function* () {
        expect(yield* schedules({ planning: Rows.pushed("app", "sha", false) })).toEqual([
          { cron: "0 4 * * *" },
        ]);
      }),
  );

  it.live("cancelled while it planned leaves the schedules as they were", () =>
    Effect.gen(function* () {
      // As `cancel` does once the plan job answered, too late to stop it.
      const cancel = reading((sql) => sql`update runs set status = 'cancelled' where id = 'app-2'`);

      expect(yield* schedules({ planning: Effect.orDie(Effect.asVoid(cancel)) })).toEqual([
        { cron: "0 4 * * *" },
      ]);
    }),
  );

  it.live("by renovate stays untrusted when someone runs it again", () =>
    Effect.gen(function* () {
      const { read } = yield* drive({
        steps: [task("qa", [])],
        untrusted: true,
        seed: Effect.andThen(
          reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
          Rows.pushed("app", "sha", false),
        ),
        meanwhile: Effect.gen(function* () {
          yield* ended("app-2");
          yield* (yield* Runs).rerun("app-2", { force: true }).pipe(Effect.orDie);
        }),
        read: reading((sql) => sql`select trust, fork from runs where id = 'app-3'`),
      });

      expect(read).toEqual([{ trust: "pr", fork: 1 }]);
    }),
  );

  it.live("isn't run again in place as trusted once a webhook said renovate pushed it", () =>
    Effect.gen(function* () {
      const { read } = yield* drive({
        steps: [task("qa", [])],
        result: () => ({ _tag: "Failed", tag: "TaskFailed", message: "", error: null, key: null }),
        seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
        meanwhile: Effect.gen(function* () {
          yield* ended("app-2");
          yield* Rows.pushed("app", "sha", false);

          // As the controller's retry of a failed deploy (Delivery.ts `converge`) would.
          expect((yield* (yield* Runs).rerun("app-2").pipe(Effect.orDie)).id).toBe("app-3");
        }),
        read: reading((sql) => sql`select id, trust, fork from runs where sha = 'sha' order by id`),
      });

      expect(read).toEqual([
        { id: "app-2", trust: "trusted", fork: 0 },
        { id: "app-3", trust: "pr", fork: 1 },
      ]);
    }),
  );

  const input = {
    project: "app",
    event: { _tag: "Push", branch: "main" },
    sha: "sha",
  } satisfies RunInput;

  const ensure = Effect.gen(function* () {
    return (yield* (yield* Runs).ensure(input).pipe(Effect.orDie)).id;
  });

  it.live("runs again when a webhook says otherwise of who pushed it", () =>
    Effect.gen(function* () {
      const { read } = yield* drive({
        steps: [task("qa", [])],
        seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
        meanwhile: Effect.gen(function* () {
          yield* Rows.pushed("app", "sha", false);
          const overruled = yield* ensure;
          const same = yield* ensure;
          yield* Rows.pushed("app", "sha", true);
          const trusted = yield* ensure;
          const again = yield* ensure;

          expect([overruled, same, trusted, again]).toEqual(["app-3", "app-3", "app-4", "app-4"]);
        }),
        read: reading((sql) => sql`select id, trust, fork from runs order by id`),
      });

      expect(read).toEqual([
        { id: "app-1", trust: "trusted", fork: 0 },
        { id: "app-2", trust: "trusted", fork: 0 },
        { id: "app-3", trust: "pr", fork: 1 },
        { id: "app-4", trust: "trusted", fork: 0 },
      ]);
    }),
  );

  it.live(
    "by renovate starts its revision's schedule run again like a fork's, which began before the webhook came",
    () =>
      Effect.gen(function* () {
        const schedule = { _tag: "Schedule", cron: "0 3 * * *" } as const;

        const { read } = yield* drive({
          steps: [task("qa", [])],
          event: schedule,
          // Still running when the webhook comes.
          work: () => Effect.sleep("300 millis"),
          seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
          meanwhile: Effect.gen(function* () {
            yield* Rows.pushed("app", "sha", false);
            yield* ensure;
          }),
          read: reading(
            (sql) => sql`select id, event, trust, fork from runs where sha = 'sha' order by id`,
          ),
        });

        expect(read).toEqual([
          { id: "app-2", event: JSON.stringify(schedule), trust: "trusted", fork: 0 },
          { id: "app-3", event: JSON.stringify(schedule), trust: "pr", fork: 1 },
          { id: "app-4", event: JSON.stringify(input.event), trust: "pr", fork: 1 },
        ]);
      }),
  );

  it.live(
    "by renovate starts a closed pull request's run of it again like a fork's, which judged it as the webhook came",
    () =>
      Effect.gen(function* () {
        const asked = Deferred.makeUnsafe<void>();
        const answer = Deferred.makeUnsafe<void>();

        const closed = {
          _tag: "PullRequestClosed",
          number: 7,
          base: "main",
          head: "feature",
        } as const;

        const { read } = yield* drive({
          steps: [task("qa", [])],
          // Still running when the webhook judges the revision.
          work: () => Effect.sleep("300 millis"),
          seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
          // Gitea answers for the title once the push's webhook judged the revision.
          pullTitle: Deferred.succeed(asked, undefined).pipe(
            Effect.andThen(Deferred.await(answer)),
            Effect.as("title"),
          ),
          meanwhile: Effect.gen(function* () {
            const runs = yield* Runs;

            const closing = yield* Effect.forkChild(
              runs.create({ project: "app", event: closed, sha: "next" }).pipe(Effect.orDie),
            );

            yield* Deferred.await(asked);
            yield* Rows.pushed("app", "next", false);

            const webhook = yield* Effect.forkChild(
              runs.ensure({ ...input, sha: "next" }).pipe(Effect.orDie),
            );

            yield* Effect.sleep("50 millis");
            yield* Deferred.succeed(answer, undefined);
            yield* Fiber.join(closing);
            yield* Fiber.join(webhook);
          }),
          read: reading(
            (sql) => sql`select id, event, trust, fork from runs where sha = 'next' order by id`,
          ),
        });

        expect(read).toEqual([
          { id: "app-3", event: JSON.stringify(closed), trust: "trusted", fork: 0 },
          { id: "app-4", event: JSON.stringify(closed), trust: "pr", fork: 1 },
          { id: "app-5", event: JSON.stringify(input.event), trust: "pr", fork: 1 },
        ]);
      }),
  );

  it.live("takes the newest of its runs, also one that started in the same millisecond", () =>
    Effect.gen(function* () {
      const { read } = yield* drive({
        steps: [task("qa", [])],
        seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 3)`),
        meanwhile: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // What replaced app-2, in its millisecond, once a webhook said renovate pushed it.
          yield* sql`insert into runs (id, project, number, event, sha, branch, commit_title, author, commit_time, trust, status,
              created_at, trace_id, span_id, fork)
            values ('app-3', 'app', 3, ${JSON.stringify(input.event)}, 'sha', 'main', 'title', 'hauke', 2, 'pr', 'passed', 2, 't', 's', 1)`.pipe(
            Effect.orDie,
          );
          yield* Rows.pushed("app", "sha", false);

          expect(yield* ensure).toBe("app-3");
        }),
        read: reading((sql) => sql`select id from runs where sha = 'sha' order by id`),
      });

      expect(read).toEqual([{ id: "app-2" }, { id: "app-3" }]);
    }),
  );

  /**
   * Gitea's signed webhook of `pusher`'s push of a revision to main, through the real `ensure` and the run it
   * starts, beside app-2, a manual run of the revision. Returns the push's runs and their jobs.
   */
  const pushedBy = (pusher: string) =>
    Effect.gen(function* () {
      const event = JSON.stringify({ _tag: "Push", branch: "main" });

      const { read, handed } = yield* drive({
        steps,
        event: { _tag: "Manual", inputs: {}, branch: "main" },
        unplanned: true,
        // Each run runs its steps, rather than take the other's results.
        plan: { reuse: "none" },
        project: configured,
        seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
        meanwhile: Effect.gen(function* () {
          yield* hook("push", {
            ref: "refs/heads/main",
            before: older,
            after: "sha",
            pusher: { login: pusher },
          }).pipe(Effect.provideService(Closes, { close: unused, catchUp: unused }));

          // The webhook starts its run in the background.
          yield* ended("app-3");
        }),
        read: reading(
          (sql) =>
            sql`select id, trust, fork, status from runs where sha = 'sha' and event = ${event} order by id`,
        ),
      });

      return {
        runs: read,
        jobs: handed
          .filter((h) => h.run === "app-3")
          .map((h) => ({
            job: h.job,
            pool: h.pool,
            ...(h.secrets === undefined ? {} : { secrets: h.secrets }),
          })),
      };
    });

  it.live("by renovate, signed by Gitea, plans and runs in the fork pool without secrets", () =>
    Effect.gen(function* () {
      expect(yield* pushedBy("renovate")).toEqual({
        runs: [{ id: "app-3", trust: "pr", fork: 1, status: "passed" }],
        jobs: [
          { job: "plan", pool: "fork" },
          { job: "qa", pool: "fork", secrets: {} },
          { job: "deploy", pool: "fork", secrets: {} },
          { job: "testflight", pool: "fork", secrets: {} },
        ],
      });
    }),
  );

  it.live("by the owner, signed by Gitea, plans and runs trusted with its secrets", () =>
    Effect.gen(function* () {
      expect(yield* pushedBy("schnau")).toEqual({
        runs: [{ id: "app-3", trust: "trusted", fork: 0, status: "passed" }],
        jobs: [
          { job: "plan", pool: "trusted" },
          { job: "qa", pool: "trusted", secrets: {} },
          { job: "deploy", pool: "trusted", secrets: { cloudflare: "cloudflare-token" } },
          { job: "testflight", pool: "trusted", secrets: { "app-store-connect": "store-key" } },
        ],
      });
    }),
  );
});

describe("the nightly audit", () => {
  /** The pools the audit of main's head planned in, and the records it noted wrong. */
  const audit = (options: Partial<Drive> = {}) =>
    Effect.map(
      drive({
        steps: [task("qa", [])],
        head: "head",
        plan: { mismatches: [{ attr: "app", recorded: null, evaluated: null, missed: [] }] },
        meanwhile: Effect.gen(function* () {
          yield* (yield* RunsCore).audit("app");
        }),
        read: reading((sql) => sql`select attr from audit_mismatches`),
        ...options,
      }),
      (r) => ({
        pools: r.handed.filter((h) => h.job === "plan").map((h) => h.pool),
        wrong: r.read,
      }),
    );

  it.live("plans main's head in the trusted pool", () =>
    Effect.gen(function* () {
      expect(yield* audit()).toEqual({ pools: ["trusted"], wrong: [{ attr: "app" }] });
    }),
  );

  it.live("but not a head renovate pushed past its protection", () =>
    Effect.gen(function* () {
      expect(yield* audit({ seed: Rows.pushed("app", "head", false) })).toEqual({
        pools: [],
        wrong: [],
      });
    }),
  );

  it.live("nor keeps what it found once a webhook said so while it planned", () =>
    Effect.gen(function* () {
      expect(yield* audit({ planning: Rows.pushed("app", "head", false) })).toEqual({
        pools: ["trusted"],
        wrong: [],
      });
    }),
  );
});
