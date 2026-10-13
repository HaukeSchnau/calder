import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import * as Rows from "./Rows.ts"

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
    const url = new URL(request.url, "http://kiln")
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
