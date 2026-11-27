import { it as effect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpPlatform, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { below, serve } from "../src/controller/Outputs.ts";
import { type Project, Projects } from "../src/controller/Projects.ts";
import { insertRun, insertStep, layer as sqlite } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

describe("outputs", () => {
  it("serves what is inside an output, links included, and nothing a link or .. leads out to", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "calder-output-")));
    writeFileSync(join(parent, "secret"), "");
    const root = join(parent, "screenshots");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "a.png"), "");
    symlinkSync("home", join(root, "latest"));
    symlinkSync(join(parent, "secret"), join(root, "secret"));

    expect(below(root, [])).toBe(root);
    expect(below(root, ["latest", "a.png"])).toBe(join(root, "home", "a.png"));
    expect(below(root, ["secret"])).toBeNull();
    expect(below(root, ["..", "secret"])).toBeNull();
    expect(below(root, ["missing.png"])).toBeNull();
  });
});

/** An output directory holding `fleet.json` and `lib/views.js`, both saying `text`. */
const page = (text: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "calder-output-")));

  for (const file of ["index.html", "fleet.json", "lib/views.js"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  return root;
};

const fleet: Project = {
  name: "fleet",
  repo: "schnau/fleet",
  defaultBranch: "main",
  targets: null,
  secrets: {},
};

const services = Layer.mergeAll(
  sqlite,
  Layer.succeed(Projects)({
    get: (name) => (name === "fleet" ? fleet : undefined),
    all: () => [fleet],
    byRepo: () => Effect.undefined,
  }),
  // The controller's platform streams the file; its content is what these tests compare.
  Layer.succeed(HttpPlatform.HttpPlatform)({
    fileResponse: (path: string) =>
      Effect.succeed(HttpServerResponse.text(readFileSync(path, "utf8"))),
  } as unknown as HttpPlatform.HttpPlatform["Service"]),
);

const get = (path: string) =>
  serve(HttpServerRequest.fromWeb(new Request(`http://calder.test${path}`))).pipe(
    Effect.flatMap((response) => {
      const web = HttpServerResponse.toWeb(response);

      return Effect.promise(() => web.text()).pipe(
        Effect.map((body) => ({ status: web.status, headers: web.headers, body })),
      );
    }),
  );

const keep = (runId: string, outputs: Record<string, string>, status = "passed") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertStep(runId, "pages", { status });
    yield* sql`update steps set outputs = ${JSON.stringify(outputs)} where run_id = ${runId} and name = 'pages'`;
  });

describe("a project's latest output", () => {
  effect.live(
    "is the newest passed run of the default branch that kept it, with its relative paths, fetched afresh",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertRun("fleet-1", { at: 1, branch: "main" });
        yield* keep("fleet-1", { explorer: page("old") });
        yield* insertRun("fleet-2", { at: 2, branch: "main" });
        yield* keep("fleet-2", { explorer: page("main") }, "reused");
        yield* insertRun("fleet-3", { at: 3, branch: "main", status: "failed" });
        yield* keep("fleet-3", { explorer: page("failed") });
        // A fork's pull request from its own main.
        yield* insertRun("fleet-4", {
          at: 4,
          branch: "main",
          trust: "pr",
          event: '{"_tag":"PullRequest","number":4}',
        });
        yield* sql`update runs set pr = 4 where id = 'fleet-4'`;
        yield* keep("fleet-4", { explorer: page("pull request") });
        yield* insertRun("fleet-5", { at: 5, branch: "main" });
        yield* keep("fleet-5", {});
        yield* insertRun("fleet-6", { at: 6, branch: "release" });
        yield* keep("fleet-6", { explorer: page("another branch") });

        const index = yield* get("/outputs/fleet-latest/pages/explorer/index.html");
        expect(index.body).toBe("main");
        expect(index.headers.get("cache-control")).toBe("no-cache");
        expect((yield* get("/outputs/fleet-latest/pages/explorer/fleet.json")).body).toBe("main");
        expect((yield* get("/outputs/fleet-latest/pages/explorer/lib/views.js")).body).toBe("main");

        const bare = yield* get("/outputs/fleet-latest/pages/explorer");
        expect(bare.status).toBe(302);
        expect(bare.headers.get("location")).toBe("explorer/");

        const run = yield* get("/outputs/fleet-1/pages/explorer/fleet.json");
        expect(run.body).toBe("old");
        expect(run.headers.get("cache-control")).toBeNull();

        yield* insertRun("fleet-7", { at: 7, branch: "main" });
        yield* keep("fleet-7", { explorer: page("newer") });
        expect((yield* get("/outputs/fleet-latest/pages/explorer/fleet.json")).body).toBe("newer");
      }).pipe(Effect.provide(services)),
  );

  effect.live("is missing, and asked for again, for a project without one", () =>
    Effect.gen(function* () {
      yield* insertRun("fleet-1", { at: 1, branch: "main" });
      yield* keep("fleet-1", { explorer: page("main") });

      for (const path of [
        "/outputs/fleet-latest/pages/diagrams/",
        "/outputs/fleet-latest/lint/explorer/",
        "/outputs/other-latest/pages/explorer/",
      ]) {
        const missing = yield* get(path);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-cache");
      }
    }).pipe(Effect.provide(services)),
  );
});
