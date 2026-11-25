import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Domain } from "@calder-ci/api";
import { Event } from "@calder-ci/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import { Closes } from "../src/controller/Closes.ts";
import { Runs } from "../src/controller/Workflow.ts";
import * as Rows from "../src/controller/Rows.ts";
import * as Webhook from "../src/controller/Webhook.ts";
import type { Job, PlannedStep } from "../src/Protocol.ts";
import * as Main from "../src/worker/Main.ts";
import { drive, step, unused } from "./drive.ts";
import { insertRun, insertStep } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const secret = (name: string, value: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "calder-secret-")), name);
  writeFileSync(path, value);

  return path;
};

const task = (name: string, secrets: ReadonlyArray<string>): PlannedStep => ({
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
  },
});

/** Gitea's webhook, signed with the test config's empty secret. */
const hook = (event: "push" | "pull_request", payload: object) => {
  const body = JSON.stringify({
    repository: { full_name: "schnau/app", default_branch: "main" },
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
  ).pipe(Effect.provideService(Closes, { close: unused, catchUp: unused }));
};

/** The revision the webhooks of these tests are of. */
const head = "b".repeat(40);

/**
 * Runs what Gitea's signed `webhook` asks for through the real `ensure`, beside app-2, a planned push to main.
 * Returns the webhook's run, app-3, and the jobs the controller handed out for it.
 */
const hooked = (webhook: ReturnType<typeof hook>) =>
  Effect.gen(function* () {
    const { read, handed, planJob } = yield* drive({
      steps: [task("qa", []), task("deploy", ["cloudflare"])],
      project: { secrets: { cloudflare: secret("cloudflare", "cloudflare-token") } },
      untrustedBranches: ["renovate/**"],
      // Each run runs its steps, rather than take the other's results.
      plan: { reuse: "none" },
      // drive's runs are app-1 and app-2, so the webhook's is app-3.
      seed: Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`insert into counters (name, value) values ('run:app', 2)`,
      ),
      meanwhile: Effect.gen(function* () {
        yield* webhook;

        // The webhook starts its run in the background.
        yield* Rows.loadRun("app-3").pipe(
          Effect.repeat({
            until: (r) => r !== undefined && Domain.ended.has(r.status),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
      }).pipe(Effect.orDie),
      read: Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`select trust, fork, status from runs where id = 'app-3'`,
      ),
    });

    return {
      run: read,
      jobs: handed
        .filter((h) => h.run === "app-3")
        .map((h) => ({
          job: h.job,
          pool: h.pool,
          ...(h.secrets === undefined ? {} : { secrets: h.secrets }),
        })),
      event: planJob?.run.event,
    };
  });

const push = (branch: string) =>
  hook("push", {
    ref: `refs/heads/${branch}`,
    after: head,
    pusher: { login: "renovate" },
  });

const pull = (head_: object) =>
  hook("pull_request", {
    action: "opened",
    number: 7,
    pull_request: {
      head: { sha: head, repo: { full_name: "schnau/app" }, ...head_ },
      base: { ref: "main", repo: { full_name: "schnau/app" } },
    },
  });

describe("Gitea's webhook of a push", () => {
  it.live(
    "of a branch the controller's untrustedBranches names plans and runs in the fork pool, without secrets",
    () =>
      Effect.gen(function* () {
        expect(yield* hooked(push("renovate/toolchain"))).toMatchObject({
          run: [{ trust: "pr", fork: 1, status: "passed" }],
          jobs: [
            { job: "rules", pool: "fork" },
            { job: "plan", pool: "fork" },
            { job: "qa", pool: "fork", secrets: {} },
            { job: "deploy", pool: "fork", secrets: {} },
          ],
        });
      }),
  );

  it.live("of another branch plans and runs trusted, with its secrets", () =>
    Effect.gen(function* () {
      expect(yield* hooked(push("feature"))).toMatchObject({
        run: [{ trust: "trusted", fork: 0, status: "passed" }],
        jobs: [
          { job: "rules", pool: "trusted" },
          { job: "plan", pool: "trusted" },
          { job: "qa", pool: "trusted", secrets: {} },
          { job: "deploy", pool: "trusted", secrets: { cloudflare: "cloudflare-token" } },
        ],
      });
    }),
  );
});

describe("Gitea's webhook of a pull request", () => {
  it.live(
    "from a branch the controller's untrustedBranches names is a fork's, to its plan too, which so has no previews",
    () =>
      Effect.gen(function* () {
        expect(
          yield* hooked(pull({ ref: "renovate/toolchain", label: "renovate/toolchain" })),
        ).toMatchObject({
          run: [{ trust: "pr", fork: 1, status: "passed" }],
          jobs: [
            { job: "plan", pool: "fork" },
            { job: "qa", pool: "fork" },
            { job: "deploy", pool: "fork" },
          ],
          event: { _tag: "PullRequest", head: "renovate/toolchain", fork: true },
        });
      }),
  );

  it.live("from another branch is a same-repo pull request's", () =>
    Effect.gen(function* () {
      expect(yield* hooked(pull({ ref: "feature", label: "feature" }))).toMatchObject({
        run: [{ trust: "pr", fork: 0, status: "passed" }],
        jobs: [
          { job: "plan", pool: "pr" },
          { job: "qa", pool: "pr" },
          { job: "deploy", pool: "pr" },
        ],
        event: { _tag: "PullRequest", head: "feature", fork: false },
      });
    }),
  );

  // Anyone who may open a pull request may push one with Gitea's AGit flow, under a topic they name.
  // Gitea blanks its label, and its list of pull requests names a branch the topic shares a name with.
  it.live("whose head is no branch, as with Gitea's AGit flow, is a fork's", () =>
    Effect.gen(function* () {
      for (const ref of ["refs/pull/7/head", "feature"]) {
        expect(yield* hooked(pull({ ref, label: "" }))).toMatchObject({
          run: [{ trust: "pr", fork: 1 }],
          event: { head: "refs/pull/7/head", fork: true },
        });
      }
    }),
  );

  it.live("that doesn't name its head is a fork's", () =>
    Effect.gen(function* () {
      expect(yield* hooked(pull({}))).toMatchObject({
        run: [{ trust: "pr", fork: 1 }],
        event: { head: "refs/pull/7/head", fork: true },
      });
    }),
  );
});

describe("the worker's plan of a push the controller doesn't trust", () => {
  const processes = BunChildProcessSpawner.layer.pipe(
    Layer.provide([BunFileSystem.layer, BunPath.layer]),
  );

  /** The rules job of a push to `renovate/toolchain`, whose ci.ts runs a task with a secret on it. */
  const planned = (trust: Domain.Trust) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "calder-ci-"));
      const core = join(import.meta.dirname, "../../core/src/index.ts");

      writeFileSync(
        join(dir, "ci.ts"),
        `import { Calder, On, Secret, Task, cmd } from ${JSON.stringify(core)};\n` +
          `const token = Task.make("token", { run: cmd\`cat \${Secret.file("token")}\` });\n` +
          `export default Calder.project({ rules: [On.push("renovate/toolchain", [token])] });\n`,
      );

      const spec = {
        _tag: "Plan",
        rules: true,
        requiredChecks: [],
        run: { trust, event: Event.push("renovate/toolchain"), pipelineDir: dir },
      } as unknown as Extract<Job, { _tag: "Plan" }>;

      return yield* Main.plan(spec).pipe(Effect.provide(processes));
    });

  it.live("runs its rules like a pull request's, which refuse a task with secrets", () =>
    Effect.gen(function* () {
      expect(yield* planned("pr")).toMatchObject({
        _tag: "PlanFailed",
        message: expect.stringContaining(
          "this push to renovate/toolchain has code Calder doesn't trust",
        ),
      });
      expect(yield* planned("trusted")).toMatchObject({ _tag: "Planned" });
    }),
  );
});

describe("a run of renovate's branch that Calder trusted before untrustedBranches named it", () => {
  const renovate = { _tag: "Push", branch: "renovate/toolchain" } as const;

  it.live("is cancelled when the controller starts, rather than run on as trusted", () =>
    Effect.gen(function* () {
      const { status, handed } = yield* drive({
        steps: [task("qa", [])],
        event: renovate,
        untrustedBranches: ["renovate/**"],
      });

      expect(status).toBe("cancelled");
      expect(handed.filter((h) => h.run === "app-2")).toEqual([]);
    }),
  );

  it.live("runs again as a new run like a fork's, not in place", () =>
    Effect.gen(function* () {
      const { read, handed } = yield* drive({
        steps: [task("qa", [])],
        untrustedBranches: ["renovate/**"],
        seed: Effect.gen(function* () {
          yield* insertRun("app-9", {
            at: 3,
            event: JSON.stringify(renovate),
            branch: "renovate/toolchain",
            sha: "sha",
            status: "failed",
          });
          yield* insertStep("app-9", "qa", { status: "failed" });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`insert into counters (name, value) values ('run:app', 9)`;
        }),
        meanwhile: Effect.gen(function* () {
          yield* (yield* Runs).rerun("app-9");

          yield* Rows.loadRun("app-10").pipe(
            Effect.repeat({
              until: (r) => r !== undefined && Domain.ended.has(r.status),
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
        }).pipe(Effect.orDie),
        read: Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`select id, trust, fork, status from runs where id in ('app-9', 'app-10') order by number`,
        ),
      });

      expect(read).toEqual([
        { id: "app-9", trust: "trusted", fork: 0, status: "failed" },
        { id: "app-10", trust: "pr", fork: 1, status: "passed" },
      ]);
      expect(handed.filter((h) => h.run === "app-9")).toEqual([]);
    }),
  );
});
