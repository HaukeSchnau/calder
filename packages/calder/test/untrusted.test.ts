import type { Domain } from "@calder-ci/api";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import * as Catchup from "../src/controller/Catchup.ts";
import { layer as closes } from "../src/controller/Closes.ts";
import { Gitea } from "../src/controller/Gitea.ts";
import { Mirror } from "../src/controller/Mirror.ts";
import { type Project, Projects } from "../src/controller/Projects.ts";
import * as Rows from "../src/controller/Rows.ts";
import * as Webhook from "../src/controller/Webhook.ts";
import { type RunInput, Runs, untrusted } from "../src/controller/Workflow.ts";
import type { PlannedStep } from "../src/Protocol.ts";
import { config } from "./config.ts";
import { drive, step, unused } from "./drive.ts";
import { layer as sqlite } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const project: Project = {
  name: "app",
  repo: "schnau/app",
  defaultBranch: "main",
  targets: null,
  secrets: {},
};

/** A run the webhook, the catch-up or a closing asked for, with how far it may overrule one there is. */
interface Asked {
  readonly input: RunInput;
  readonly overrule?: "any" | "upward" | undefined;
}

/**
 * The webhook, the catch-up and the closings in front of a Gitea whose open pull requests are `open`, with
 * the controller's `trustedPushers`. Returns the runs they asked for.
 */
const world = (
  options: {
    readonly open?: ReadonlyArray<number>;
    readonly trustedPushers?: ReadonlyArray<string>;
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
        contains: unused,
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
        ensure: (input, o) =>
          Effect.sync(() => void asked.push({ input, overrule: o?.overrule })).pipe(
            Effect.as({} as never),
          ),
        cancel: () => Effect.void,
        rerun: unused,
        audit: unused,
      }),
      Layer.succeed(Gitea)({
        self: Effect.succeed("calder"),
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

const push = (branch: string, pusher: string | null) =>
  hook("push", {
    ref: `refs/heads/${branch}`,
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
      ? { before: options.before ?? "c".repeat(40), after: options.after ?? head }
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
          {
            input: { project: "app", event: { _tag: "Push", branch }, sha: head },
            overrule: "any",
          },
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

  it.live("and once someone trusted pushed it, it stays trusted", () =>
    Effect.gen(function* () {
      yield* pushed(head, true);
      yield* pushed(head, false);

      expect(yield* said(head)).toBe(true);
    }).pipe(Effect.provide(sqlite)),
  );

  const pulls: ReadonlyArray<[string, Seed, string, string, object, boolean | undefined]> = [
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
      pushed("c".repeat(40), true),
      "synchronized",
      "calder",
      {},
      true,
    ],
    [
      "Calder merged main into one renovate pushed",
      pushed("c".repeat(40), false),
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
      pushed("c".repeat(40), true),
      "synchronized",
      "calder",
      { base: "feature-base" },
      false,
    ],
  ];

  for (const [what, seed, action, sender, options, trusted] of pulls) {
    it.live(
      `when ${what}: ${trusted === undefined ? "nothing" : trusted ? "trusted" : "not trusted"}`,
      () =>
        Effect.gen(function* () {
          yield* seed;
          const { runs, layer } = yield* world();
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
            overrule: "any",
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
    "only moves runs toward trusted, and looks at a head again once a webhook said who pushed it",
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

        expect((yield* runs(3)).map((r) => [r.input.event._tag, r.input.sha, r.overrule])).toEqual([
          ["Push", "main-head", "upward"],
          ["PullRequest", "sha-1", "upward"],
          ["PullRequest", "sha-1", "upward"],
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

  it.live("by renovate leaves the schedules, which run main's head as trusted, alone", () =>
    Effect.gen(function* () {
      const schedules = (untrusted: boolean) =>
        Effect.map(
          drive({
            steps: [task("qa", [])],
            untrusted,
            unplanned: true,
            plan: { schedules: ["0 3 * * *"] },
            read: reading((sql) => sql`select cron from schedules`),
          }),
          (r) => r.read,
        );

      expect(yield* schedules(true)).toEqual([]);
      expect(yield* schedules(false)).toEqual([{ cron: "0 3 * * *" }]);
    }),
  );

  it.live("by renovate stays untrusted when someone runs it again", () =>
    Effect.gen(function* () {
      const { read } = yield* drive({
        steps: [task("qa", [])],
        untrusted: true,
        seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
        meanwhile: Effect.gen(function* () {
          yield* Rows.loadRun("app-2").pipe(
            Effect.repeat({
              until: (r) => r?.status === "passed",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.orDie,
          );
          yield* (yield* Runs).rerun("app-2", { force: true }).pipe(Effect.orDie);
        }),
        read: reading((sql) => sql`select trust, fork from runs where id = 'app-3'`),
      });

      expect(read).toEqual([{ trust: "pr", fork: 1 }]);
    }),
  );

  it.live(
    "runs again when a webhook says otherwise of who pushed it, but only toward trusted on the catch-up's word",
    () =>
      Effect.gen(function* () {
        const input = {
          project: "app",
          event: { _tag: "Push", branch: "main" },
          sha: "sha",
        } satisfies RunInput;

        const { read } = yield* drive({
          steps: [task("qa", [])],
          seed: reading((sql) => sql`insert into counters (name, value) values ('run:app', 2)`),
          meanwhile: Effect.gen(function* () {
            const runs = yield* Runs;

            const ensure = (overrule: "any" | "upward") =>
              Effect.map(runs.ensure(input, { overrule }).pipe(Effect.orDie), (r) => r.id);

            yield* Rows.pushed("app", "sha", false);
            const caughtUp = yield* ensure("upward");
            const overruled = yield* ensure("any");
            yield* Rows.pushed("app", "sha", true);
            const trusted = yield* ensure("upward");
            const again = yield* ensure("any");

            expect([caughtUp, overruled, trusted, again]).toEqual([
              "app-2",
              "app-3",
              "app-4",
              "app-4",
            ]);
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
});

describe("a pull request that runs like a fork's", () => {
  it.live("is a fork's to its plan, which so leaves out the previews", () =>
    Effect.gen(function* () {
      const { planJob } = yield* drive({
        steps: [task("qa", [])],
        event: { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false },
        untrusted: true,
        unplanned: true,
      });

      expect(planJob?.run.event).toEqual({
        _tag: "PullRequest",
        number: 7,
        base: "main",
        head: "feature",
        fork: true,
      });
    }),
  );
});
