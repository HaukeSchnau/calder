import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { basename, join } from "node:path";
import * as Exec from "../Exec.ts";
import { only } from "../StorePaths.ts";
import { hashOf } from "./Cache.ts";
import * as Rows from "./Rows.ts";

const roots = (stateDir: string) => join(stateDir, "gcroots");

/**
 * Keeps an output from Nix's garbage collector with an indirect root: a link in Calder's state directory
 * that the daemon registers, which holds the path while the link exists. `sweep` removes it.
 */
export const root = (stateDir: string, path: string) =>
  Effect.suspend(() => {
    const link = join(roots(stateDir), basename(path));

    if (hashOf(path) === undefined || existsSync(link)) return Effect.void;
    mkdirSync(roots(stateDir), { recursive: true });

    return Exec.run(["nix-store", "--add-root", link, "--realise", ...only([path])]).pipe(
      Effect.asVoid,
    );
  });

/** Where each run's derivations have their roots, one directory per run. */
export const derivationRoots = (stateDir: string) => join(stateDir, "derivations");

/**
 * Keeps a run's derivations from Nix's garbage collector until the run ends (`unrootDerivations`). A
 * plan's evaluation leaves them without a root once its `nix eval` exits, and a build can wait hours for a
 * slot: srv-2's nightly collection deleted infra-909's mbp derivation while it waited. `nix build
 * --out-link` of a bare `.drv` path registers an indirect root to the derivation itself without building
 * it. Derivations the run's directory already holds are left out; a batch Nix refuses, such as one with a
 * derivation that is gone already, is rooted one by one, so the rest still get theirs.
 */
export const rootDerivations = (stateDir: string, runId: string, drvs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = join(derivationRoots(stateDir), runId);

    const held = yield* Effect.try(() => {
      mkdirSync(dir, { recursive: true });

      return new Set(readdirSync(dir).map((name) => readlinkSync(join(dir, name))));
    });

    const missing = [...new Set(drvs)].filter(
      (drv) => drv.endsWith(".drv") && hashOf(drv) !== undefined && !held.has(drv),
    );

    if (missing.length === 0) return;

    const root = (some: ReadonlyArray<string>) =>
      Exec.run([
        "nix",
        "--extra-experimental-features",
        "nix-command",
        "build",
        "--out-link",
        join(dir, randomUUID().slice(0, 8)),
        "--",
        ...only(some),
      ]);

    yield* root(missing).pipe(
      Effect.catch((e) =>
        missing.length === 1
          ? Effect.fail(e)
          : Effect.forEach(missing, (drv) => root([drv]), { discard: true }),
      ),
    );
  });

/**
 * Keeps a build's output in the store until the run ends, beside its derivation roots. Nothing else roots it,
 * and a release that waits for its promotion would otherwise be collected: srv-2's nightly collection deleted
 * t3code-801's release between its build and its promotion. Only a path this store holds is rooted; one only
 * in the binary cache stays there rather than being downloaded, also when the path left between the check and
 * the root, since a rerun roots under a lock that Delivery's round waits for. Returns whether the path is
 * rooted for the run, which it isn't when this store no longer holds it.
 */
export const rootBuilt = (stateDir: string, runId: string, path: string) =>
  Effect.suspend(() => {
    const link = join(derivationRoots(stateDir), runId, basename(path));

    if (hashOf(path) === undefined || !existsSync(path)) return Effect.succeed(false);

    if (existsSync(link)) return Effect.succeed(true);

    return addRoot(stateDir, runId, path, ["--option", "substitute", "false"]).pipe(
      Effect.as(true),
    );
  });

/**
 * Makes a build's output valid in this store, substituting it from the binary cache if this store lost it,
 * and roots it like `rootBuilt`. Fails when the cache can't be asked or has it no more, and then only building
 * it again may bring it back.
 */
export const realiseBuilt = (stateDir: string, runId: string, path: string) =>
  addRoot(stateDir, runId, path, []);

const addRoot = (stateDir: string, runId: string, path: string, options: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    mkdirSync(join(derivationRoots(stateDir), runId), { recursive: true });

    return Exec.run([
      "nix-store",
      ...options,
      "--add-root",
      join(derivationRoots(stateDir), runId, basename(path)),
      "--realise",
      ...only([path]),
    ]);
  }).pipe(Effect.asVoid);

/** Drops a run's derivation roots. */
export const unrootDerivations = (stateDir: string, runId: string) =>
  Effect.try(() =>
    rmSync(join(derivationRoots(stateDir), runId), { recursive: true, force: true }),
  );

/** Drops the derivation roots of every run but `active`, such as runs that ended while the controller was down. */
export const sweepDerivations = (stateDir: string, active: ReadonlySet<string>) =>
  Effect.try(() => {
    const dir = derivationRoots(stateDir);
    const runs = existsSync(dir) ? readdirSync(dir) : [];

    for (const run of runs)
      if (!active.has(run)) rmSync(join(dir, run), { recursive: true, force: true });
  });

/** Where deploys keep the builds they read for a later run (`holdDeploy`): a directory per project and step, in it one per run. */
export const deployRoots = (stateDir: string) => join(stateDir, "deploys");

const deploySlot = (stateDir: string, project: string, step: string) =>
  join(deployRoots(stateDir), encodeURIComponent(project), encodeURIComponent(step));

/** The runs, by number, whose builds a step keeps. */
const holding = (dir: string) =>
  (existsSync(dir) ? readdirSync(dir) : []).map(Number).filter(Number.isInteger);

/**
 * Keeps the builds a deploy read in the store after its run ends, until the same step of this run or a newer one
 * deploys (`releaseDeploy`). A run's own roots go when it ends, but what it built may deploy in a later run: infra's
 * hourly run deploys a host that was asleep, and a promotion that failed runs again hours later. Without a root,
 * srv-2's nightly collection deletes it in between, and the later run fetches it from the binary cache, if that still
 * has it, or builds it again. A step keeps one run's builds, the newest's, since no later run deploys an older one's.
 * Paths this store doesn't hold are left out.
 */
export const holdDeploy = (
  stateDir: string,
  project: string,
  step: string,
  run: number,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const dir = deploySlot(stateDir, project, step);
    const held = yield* Effect.try(() => holding(dir));

    if (held.some((r) => r > run)) return;
    const mine = join(dir, String(run));
    yield* Effect.try(() => mkdirSync(mine, { recursive: true }));

    for (const path of paths) {
      const link = join(mine, basename(path));

      if (hashOf(path) === undefined || !existsSync(path) || existsSync(link)) continue;
      yield* Exec.run([
        "nix-store",
        "--option",
        "substitute",
        "false",
        "--add-root",
        link,
        "--realise",
        ...only([path]),
      ]);
    }

    // The new roots hold before the older run's go. Touched, so `sweepDeploys` tells a step that still deploys.
    yield* Effect.try(() => {
      const now = new Date();
      utimesSync(mine, now, now);

      for (const r of held)
        if (r < run) rmSync(join(dir, String(r)), { recursive: true, force: true });
    });
  });

/** Drops what a step kept for a later run (`holdDeploy`) once the step of this run or a newer one deployed. */
export const releaseDeploy = (stateDir: string, project: string, step: string, run: number) =>
  Effect.try(() => {
    const dir = deploySlot(stateDir, project, step);

    for (const r of holding(dir))
      if (r <= run) rmSync(join(dir, String(r)), { recursive: true, force: true });
  });

/**
 * Drops what steps kept (`holdDeploy`) that no run reached for `days`, such as the deploy of a host that left the
 * fleet. A step that still deploys keeps its builds afresh in every run that reaches it, such as infra's hourly one.
 */
export const sweepDeploys = (stateDir: string, days: number) =>
  Effect.try(() => {
    const cutoff = Date.now() - days * 86_400_000;

    const below = (dir: string) =>
      existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];

    for (const project of below(deployRoots(stateDir))) {
      for (const step of below(project)) {
        for (const run of below(step))
          if (statSync(run).mtimeMs < cutoff) rmSync(run, { recursive: true, force: true });
      }
    }
  });

/** The outputs that steps name, and passed results, which later runs may reuse. */
export const named = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ path: string }>`select distinct each.value as path from (
      select outputs from steps where outputs is not null
      union all select outputs from results where status = 'passed'
    ) as named, json_each(named.outputs) as each`;

  return new Set(rows.map((r) => r.path));
});

/**
 * Drops the roots of outputs nothing names any more, after the retention prune, and roots the named
 * ones still in the store that have none, such as outputs from before Calder kept roots.
 */
export const sweep = (stateDir: string) =>
  Effect.gen(function* () {
    // Roots first: a step that settles in between writes its row before its root, so it is named.
    const rooted = existsSync(roots(stateDir)) ? readdirSync(roots(stateDir)) : [];
    const keep = yield* named;

    for (const name of rooted)
      if (!keep.has(`/nix/store/${name}`)) rmSync(join(roots(stateDir), name), { force: true });
    yield* Effect.forEach(
      [...keep].filter((path) => existsSync(path)),
      (path) =>
        root(stateDir, path).pipe(
          Effect.catch((e) =>
            Effect.logWarning(`could not keep ${path} from the garbage collector`, e),
          ),
        ),
      { discard: true },
    );
  });

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The file or directory a request names below an output, or null when there is none. Links count by
 * where they lead, which must be inside the output: a task could have written a link to the
 * controller's own files.
 */
export const below = (root: string, parts: ReadonlyArray<string>) => {
  const path = join(root, ...parts);

  if (!existsSync(path)) return null;
  const real = realpathSync(path);

  return real === root || real.startsWith(`${root}/`) ? real : null;
};

/** A step's output at `Domain.outputPath`: a file as it is, a directory as a list of links. */
export const serve = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://calder");

    const [runId = "", step = "", name = "", ...rest] = url.pathname
      .split("/")
      .slice(2)
      .map(decodeURIComponent);

    const row = yield* Rows.loadStep(runId, step);
    const root = (JSON.parse(row?.outputs ?? "{}") as Record<string, string>)[name];

    if (root === undefined)
      return HttpServerResponse.text(`${step} of ${runId} has no output ${name}`, { status: 404 });
    const real = below(root, rest);

    if (real === null)
      return HttpServerResponse.text(
        `${join(root, ...rest)} is not in the store, or not inside the output`,
        { status: 404 },
      );

    if (!statSync(real).isDirectory()) return yield* HttpServerResponse.file(real);

    // Relative, so the redirect keeps a prefix the UI is served under, such as /app.
    if (!url.pathname.endsWith("/"))
      return HttpServerResponse.redirect(`${url.pathname.split("/").pop()}/`);

    const links = readdirSync(real, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .map(
        (entry) =>
          `<li><a href="${encodeURIComponent(entry).replace(/%2F$/, "/")}">${escape(entry)}</a></li>`,
      );

    const title = escape([step, name, ...rest].filter((part) => part !== "").join(" / "));

    return HttpServerResponse.text(
      `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${links.join("")}</ul>`,
      {
        contentType: "text/html; charset=utf-8",
      },
    );
  }).pipe(Effect.orDie);
