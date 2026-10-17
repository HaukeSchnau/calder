import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
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
    if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname}/`)
    const links = readdirSync(real, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .map((entry) => `<li><a href="${encodeURIComponent(entry).replace(/%2F$/, "/")}">${escape(entry)}</a></li>`)
    const title = escape([step, name, ...rest].filter((part) => part !== "").join(" / "))
    return HttpServerResponse.text(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${links.join("")}</ul>`, {
      contentType: "text/html; charset=utf-8",
    })
  }).pipe(Effect.orDie)
