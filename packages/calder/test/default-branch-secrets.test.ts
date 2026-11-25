import type { Domain } from "@calder-ci/api";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { vi } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfig } from "../src/controller/Config.ts";
import type { PlannedStep } from "../src/Protocol.ts";
import { drive, step } from "./drive.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const file = (name: string, value: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "calder-secret-")), name);
  writeFileSync(path, value);

  return path;
};

/** hopwatch's and Studienbuch's store keys are default-branch secrets; their Cloudflare token isn't. */
const project = {
  secrets: { cloudflare: file("cloudflare", "cloudflare-token") },
  defaultBranchSecrets: { "app-store-connect": file("app-store-connect", "store-key") },
};

const task = (name: string, secrets: ReadonlyArray<string>, preview = false): PlannedStep => ({
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
    ...(preview ? { preview } : {}),
  },
});

/**
 * Runs `steps` for `event` and returns, per step that got a job, the secrets it was handed. `passed` steps
 * have a result with their key from an earlier run.
 */
const granted = (
  event: Domain.Event,
  steps: ReadonlyArray<PlannedStep>,
  passed: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const handed = new Map<string, Record<string, string>>();

    const ran = yield* drive({
      steps,
      event,
      project,
      passed,
      result: (name, job) => {
        handed.set(name, job.secrets);

        return undefined;
      },
    });

    return { ...ran, handed };
  });

describe("a default-branch secret", () => {
  it.live("goes to a push to the default branch", () =>
    Effect.gen(function* () {
      const { status, handed } = yield* granted({ _tag: "Push", branch: "main" }, [
        task("testflight", ["app-store-connect"]),
      ]);

      expect(status).toBe("passed");
      expect(handed.get("testflight")).toEqual({ "app-store-connect": "store-key" });
    }),
  );

  it.live("goes to a manual run of the default branch, such as a release", () =>
    Effect.gen(function* () {
      const { handed } = yield* granted(
        { _tag: "Manual", inputs: { release: "native" }, branch: "main" },
        [task("testflight", ["app-store-connect"])],
      );

      expect(handed.get("testflight")).toEqual({ "app-store-connect": "store-key" });
    }),
  );

  it.live(
    "is refused to a push to another branch, also where a result could be reused, and its other secrets aren't",
    () =>
      Effect.gen(function* () {
        const { status, handed, steps } = yield* granted(
          { _tag: "Push", branch: "feature" },
          [task("testflight", ["app-store-connect"]), task("deploy", ["cloudflare"])],
          ["testflight"],
        );

        expect(status).toBe("failed");
        expect(handed.has("testflight")).toBe(false);
        expect(steps.get("testflight")).toMatchObject({
          status: "died",
          error: {
            message: `testflight needs the secret "app-store-connect", which only runs of main get (its pushes, schedules and manual runs), not this push to feature`,
          },
        });
        expect(handed.get("deploy")).toEqual({ cloudflare: "cloudflare-token" });
      }),
  );

  const manual: ReadonlyArray<[string, Domain.Event]> = [
    ["another branch", { _tag: "Manual", inputs: {}, branch: "feature" }],
    // From before manual runs named their branch, when one of another branch looked the same; a rerun keeps it.
    ["no branch", { _tag: "Manual", inputs: {} }],
  ];

  for (const [what, event] of manual) {
    it.live(`is refused to a manual run of ${what}`, () =>
      Effect.gen(function* () {
        const { handed, steps } = yield* granted(event, [
          task("testflight", ["app-store-connect"]),
        ]);

        expect(handed.has("testflight")).toBe(false);
        expect(steps.get("testflight")?.status).toBe("died");
      }),
    );
  }

  it.live(
    "is refused to a same-repo pull request's preview, which gets the project's other secrets",
    () =>
      Effect.gen(function* () {
        const { handed, steps } = yield* granted(
          { _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: false },
          [
            task("preview-store", ["app-store-connect"], true),
            task("preview", ["cloudflare"], true),
          ],
        );

        expect(handed.has("preview-store")).toBe(false);
        expect(steps.get("preview-store")).toMatchObject({
          status: "died",
          error: { message: expect.stringContaining("not this pull request #5") },
        });
        expect(handed.get("preview")).toEqual({ cloudflare: "cloudflare-token" });
      }),
  );

  it("needs the project's default branch configured, which Calder would otherwise guess until Gitea answers", () => {
    const decode = Schema.decodeUnknownExit(ProjectConfig);
    const secrets = { defaultBranchSecrets: { "app-store-connect": "/run/key" } };
    expect(decode({ repo: "schnau/app", ...secrets })._tag).toBe("Failure");
    expect(decode({ repo: "schnau/app", defaultBranch: "main", ...secrets })._tag).toBe("Success");
    expect(decode({ repo: "schnau/app", secrets: { cloudflare: "/run/env" } })._tag).toBe(
      "Success",
    );
  });
});
