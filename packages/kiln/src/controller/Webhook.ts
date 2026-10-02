import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Config } from "./Config.ts"
import { Mirror } from "./Mirror.ts"
import { Runs } from "./Workflow.ts"
import { SqlClient } from "effect/sql"

interface Payload {
  readonly ref?: string
  readonly after?: string
  readonly action?: string
  readonly number?: number
  readonly repository?: { readonly full_name?: string }
  readonly pull_request?: {
    readonly head?: { readonly ref?: string; readonly sha?: string }
    readonly base?: { readonly ref?: string }
  }
}

const zero = /^0+$/

const verified = (secret: string, body: string, signature: string | undefined) => {
  if (signature === undefined) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  const given = Buffer.from(signature, "hex")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Gitea's system webhook: pushes and pull requests of every repository. Repositories that aren't
 * enrolled, and revisions without `.kiln/ci.ts`, are ignored, so a repository switches by committing it.
 */
export const handle = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const config = yield* Config
    const mirror = yield* Mirror
    const runs = yield* Runs
    const sql = yield* SqlClient.SqlClient
    const body = yield* request.text
    if (!verified(config.webhookSecret, body, request.headers["x-gitea-signature"])) {
      return HttpServerResponse.text("bad signature", { status: 401 })
    }
    const event = request.headers["x-gitea-event"]
    const payload = JSON.parse(body) as Payload
    const enrolled = config.projectByRepo(payload.repository?.full_name ?? "")
    if (enrolled === undefined) return HttpServerResponse.text("not enrolled")
    const [project] = enrolled

    const start = (sha: string, run: Effect.Effect<unknown, unknown>) =>
      Effect.gen(function*() {
        yield* mirror.fetch(project)
        if (!(yield* mirror.hasPipeline(project, sha))) return
        yield* run
      }).pipe(
        Effect.catchCause((cause) => Effect.logError(`webhook for ${project}@${sha} failed`, cause)),
        Effect.forkDetach,
      )

    if (event === "push") {
      const sha = payload.after
      if (payload.ref?.startsWith("refs/heads/") !== true || sha === undefined || zero.test(sha)) return HttpServerResponse.text("ignored")
      const branch = payload.ref.slice("refs/heads/".length)
      yield* start(sha, runs.create({ project, event: { _tag: "Push", branch }, sha }))
      return HttpServerResponse.text("accepted", { status: 202 })
    }

    if (event === "pull_request") {
      const pr = payload.pull_request
      const number = payload.number
      if (pr === undefined || number === undefined) return HttpServerResponse.text("ignored")
      if (payload.action === "closed") {
        const active = yield* sql<{ id: string }>`select id from runs where project = ${project} and pr = ${number}
          and status in ('queued', 'planning', 'running')`.pipe(Effect.orDie)
        yield* Effect.forEach(active, (r) => runs.cancel(r.id, "pull request closed"), { discard: true })
        return HttpServerResponse.text("cancelled")
      }
      if (!["opened", "reopened", "synchronized"].includes(payload.action ?? "")) return HttpServerResponse.text("ignored")
      const sha = pr.head?.sha
      if (sha === undefined) return HttpServerResponse.text("ignored")
      yield* start(sha, runs.create({
        project,
        event: { _tag: "PullRequest", number, base: pr.base?.ref ?? "main", head: pr.head?.ref ?? `pr-${number}` },
        sha,
      }))
      return HttpServerResponse.text("accepted", { status: 202 })
    }

    return HttpServerResponse.text("ignored")
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("bad request", { status: 400 }))))
