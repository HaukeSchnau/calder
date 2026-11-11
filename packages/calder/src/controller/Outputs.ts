import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import * as Exec from "../Exec.ts"
import { hashOf } from "./Cache.ts"
import * as Rows from "./Rows.ts"

const roots = (stateDir: string) => join(stateDir, "gcroots")

/**
 * Keeps an output from Nix's garbage collector with an indirect root: a link in Calder's state directory
 * that the daemon registers, which holds the path while the link exists. `sweep` removes it.
 */
export const root = (stateDir: string, path: string) =>
  Effect.suspend(() => {
    const link = join(roots(stateDir), basename(path))
    if (hashOf(path) === undefined || existsSync(link)) return Effect.void
    mkdirSync(roots(stateDir), { recursive: true })
    return Exec.run(["nix-store", "--add-root", link, "--realise", path]).pipe(Effect.asVoid)
  })

/** Where each run's derivations have their roots, one directory per run. */
export const derivationRoots = (stateDir: string) => join(stateDir, "derivations")

/**
 * Keeps a run's derivations from Nix's garbage collector until the run ends (`unrootDerivations`). A
 * plan's evaluation leaves them without a root once its `nix eval` exits, and a build can wait hours for a
 * slot: srv-2's nightly collection deleted infra-909's mbp derivation while it waited. `nix build
 * --out-link` of a bare `.drv` path registers an indirect root to the derivation itself without building
 * it. Derivations the run's directory already holds are left out; a batch Nix refuses, such as one with a
 * derivation that is gone already, is rooted one by one, so the rest still get theirs.
 */
export const rootDerivations = (stateDir: string, runId: string, drvs: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const dir = join(derivationRoots(stateDir), runId)
    const held = yield* Effect.try(() => {
      mkdirSync(dir, { recursive: true })
      return new Set(readdirSync(dir).map((name) => readlinkSync(join(dir, name))))
    })
    const missing = [...new Set(drvs)].filter((drv) => drv.endsWith(".drv") && hashOf(drv) !== undefined && !held.has(drv))
    if (missing.length === 0) return
    const root = (some: ReadonlyArray<string>) =>
      Exec.run(["nix", "--extra-experimental-features", "nix-command", "build", "--out-link", join(dir, randomUUID().slice(0, 8)), ...some])
    yield* root(missing).pipe(
      Effect.catch((e) => missing.length === 1 ? Effect.fail(e) : Effect.forEach(missing, (drv) => root([drv]), { discard: true })),
    )
  })

/** Drops a run's derivation roots. */
export const unrootDerivations = (stateDir: string, runId: string) =>
  Effect.try(() => rmSync(join(derivationRoots(stateDir), runId), { recursive: true, force: true }))

/** Drops the derivation roots of every run but `active`, such as runs that ended while the controller was down. */
export const sweepDerivations = (stateDir: string, active: ReadonlySet<string>) =>
  Effect.try(() => {
    const dir = derivationRoots(stateDir)
    const runs = existsSync(dir) ? readdirSync(dir) : []
    for (const run of runs) if (!active.has(run)) rmSync(join(dir, run), { recursive: true, force: true })
  })

/** The outputs that steps name, and passed results, which later runs may reuse. */
export const named = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ path: string }>`select distinct each.value as path from (
      select outputs from steps where outputs is not null
      union all select outputs from results where status = 'passed'
    ) as named, json_each(named.outputs) as each`
  return new Set(rows.map((r) => r.path))
})

/**
 * Drops the roots of outputs nothing names any more, after the retention prune, and roots the named
 * ones still in the store that have none, such as outputs from before Calder kept roots.
 */
export const sweep = (stateDir: string) =>
  Effect.gen(function*() {
    // Roots first: a step that settles in between writes its row before its root, so it is named.
    const rooted = existsSync(roots(stateDir)) ? readdirSync(roots(stateDir)) : []
    const keep = yield* named
    for (const name of rooted) if (!keep.has(`/nix/store/${name}`)) rmSync(join(roots(stateDir), name), { force: true })
    yield* Effect.forEach([...keep].filter((path) => existsSync(path)), (path) =>
      root(stateDir, path).pipe(Effect.catch((e) => Effect.logWarning(`could not keep ${path} from the garbage collector`, e))), { discard: true })
  })

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The file or directory a request names below an output, or null when there is none. Links count by
 * where they lead, which must be inside the output: a task could have written a link to the
 * controller's own files.
 */
export const below = (root: string, parts: ReadonlyArray<string>) => {
  const path = join(root, ...parts)
  if (!existsSync(path)) return null
  const real = realpathSync(path)
  return real === root || real.startsWith(`${root}/`) ? real : null
}

/** A step's output at `Domain.outputPath`: a file as it is, a directory as a list of links. */
export const serve = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const url = new URL(request.url, "http://calder")
    const [runId = "", step = "", name = "", ...rest] = url.pathname.split("/").slice(2).map(decodeURIComponent)
    const row = yield* Rows.loadStep(runId, step)
    const root = (JSON.parse(row?.outputs ?? "{}") as Record<string, string>)[name]
    if (root === undefined) return HttpServerResponse.text(`${step} of ${runId} has no output ${name}`, { status: 404 })
    const real = below(root, rest)
    if (real === null) return HttpServerResponse.text(`${join(root, ...rest)} is not in the store, or not inside the output`, { status: 404 })
    if (!statSync(real).isDirectory()) return yield* HttpServerResponse.file(real)
    // Relative, so the redirect keeps a prefix the UI is served under, such as /app.
    if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname.split("/").pop()}/`)
    const links = readdirSync(real, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .map((entry) => `<li><a href="${encodeURIComponent(entry).replace(/%2F$/, "/")}">${escape(entry)}</a></li>`)
    const title = escape([step, name, ...rest].filter((part) => part !== "").join(" / "))
    return HttpServerResponse.text(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${links.join("")}</ul>`, {
      contentType: "text/html; charset=utf-8",
    })
  }).pipe(Effect.orDie)
