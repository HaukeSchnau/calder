import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Config } from "./Config.ts"

export type StatusState = "pending" | "success" | "error" | "failure"

const Protection = Schema.Struct({
  rule_name: Schema.optional(Schema.String),
  branch_name: Schema.optional(Schema.String),
  enable_status_check: Schema.optional(Schema.Boolean),
  status_check_contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
})
const Branch = Schema.Struct({ commit: Schema.Struct({ id: Schema.String }) })
const Comment = Schema.Struct({ id: Schema.Number })
const Pull = Schema.Struct({ title: Schema.String })
const OpenPull = Schema.Struct({
  number: Schema.Number,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })) }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })) }),
})
const Repo = Schema.Struct({
  full_name: Schema.String,
  default_branch: Schema.String,
  archived: Schema.Boolean,
  empty: Schema.Boolean,
})

const matches = (pattern: string, branch: string) =>
  pattern === branch || new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(branch)

/** The parts of Gitea's API Kiln uses, as the `kiln` bot user. */
export class Gitea extends Context.Service<Gitea, {
  readonly status: (repo: string, sha: string, status: {
    readonly context: string
    readonly state: StatusState
    readonly description: string
    readonly targetUrl: string
  }) => Effect.Effect<void>
  readonly requiredChecks: (repo: string, branch: string) => Effect.Effect<ReadonlyArray<string>>
  readonly head: (repo: string, branch: string) => Effect.Effect<string>
  readonly pullTitle: (repo: string, number: number) => Effect.Effect<string | null>
  readonly comment: (repo: string, number: number, body: string, existing: number | null) => Effect.Effect<number>
  readonly dispatch: (repo: string, workflow: string, ref: string, inputs: Record<string, string>) => Effect.Effect<void>
  /** The owner's repositories the bot can see, without archived or empty ones. */
  readonly repos: (owner: string) => Effect.Effect<ReadonlyArray<{ readonly repo: string; readonly defaultBranch: string }>>
  readonly hasFile: (repo: string, ref: string, path: string) => Effect.Effect<boolean>
  readonly openPulls: (repo: string) => Effect.Effect<ReadonlyArray<{
    readonly number: number
    readonly base: string
    readonly head: string
    readonly sha: string
    /** The head lives in another repository. */
    readonly fork: boolean
  }>>
}>()("kiln/controller/Gitea") {}

export const layer = Layer.effect(Gitea)(Effect.gen(function*() {
  const config = yield* Config
  const base = `${config.gitea.url.replace(/\/$/, "")}/api/v1`
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("Authorization", `token ${config.giteaToken}`)),
    HttpClient.filterStatusOk,
  )
  const get = <A>(path: string, schema: Schema.Decoder<A>) =>
    client.get(`${base}${path}`).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
  const send = (method: "post" | "patch", path: string, body: unknown) =>
    client.execute(HttpClientRequest[method](`${base}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)))

  return {
    status: (repo, sha, s) =>
      send("post", `/repos/${repo}/statuses/${sha}`, {
        context: s.context,
        state: s.state,
        description: s.description.slice(0, 140),
        target_url: s.targetUrl,
      }).pipe(Effect.asVoid, Effect.retry({ times: 2 }), Effect.catch((e) => Effect.logWarning(`status for ${repo}@${sha} failed`, e))),
    requiredChecks: (repo, branch) =>
      get(`/repos/${repo}/branch_protections`, Schema.Array(Protection)).pipe(
        Effect.map((rules) =>
          rules
            .filter((r) => r.enable_status_check === true && matches(r.rule_name ?? r.branch_name ?? "", branch))
            .flatMap((r) => r.status_check_contexts ?? [])
        ),
        Effect.orDie,
      ),
    head: (repo, branch) =>
      get(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, Branch).pipe(Effect.map((b) => b.commit.id), Effect.orDie),
    pullTitle: (repo, number) =>
      get(`/repos/${repo}/pulls/${number}`, Pull).pipe(Effect.map((p) => p.title), Effect.orElseSucceed(() => null)),
    comment: (repo, number, body, existing) =>
      (existing === null
        ? send("post", `/repos/${repo}/issues/${number}/comments`, { body })
        : send("patch", `/repos/${repo}/issues/comments/${existing}`, { body })
      ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Comment)), Effect.map((c) => c.id), Effect.orDie),
    dispatch: (repo, workflow, ref, inputs) =>
      send("post", `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs }).pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    repos: (owner) =>
      Effect.gen(function*() {
        const found: Array<typeof Repo.Type> = []
        for (let page = 1;; page++) {
          const batch = yield* get(`/users/${owner}/repos?limit=50&page=${page}`, Schema.Array(Repo))
          found.push(...batch)
          if (batch.length < 50) break
        }
        return found.filter((r) => !r.archived && !r.empty).map((r) => ({ repo: r.full_name, defaultBranch: r.default_branch }))
      }).pipe(Effect.orDie),
    openPulls: (repo) =>
      get(`/repos/${repo}/pulls?state=open&limit=50`, Schema.Array(OpenPull)).pipe(
        Effect.map((pulls) =>
          pulls.map((p) => ({
            number: p.number,
            base: p.base.ref,
            head: p.head.ref,
            sha: p.head.sha,
            fork: p.head.repo?.full_name !== p.base.repo?.full_name,
          }))
        ),
        Effect.orDie,
      ),
    hasFile: (repo, ref, path) =>
      client.get(`${base}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  }
}))
