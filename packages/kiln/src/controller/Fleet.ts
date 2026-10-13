import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { FleetBusy, FleetRejected } from "../Protocol.ts"
import { Config } from "./Config.ts"
import type { Project } from "./Projects.ts"
import * as Telemetry from "./Telemetry.ts"

export const hostOf = (target: string) => new URL(target).hostname

export const Status = Schema.Struct({
  revision: Schema.NullOr(Schema.String),
  storePath: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.Number),
  healthy: Schema.NullOr(Schema.Boolean),
})
export type Status = typeof Status.Type

/** The hosts' promotion endpoints (`app-deployments` in nix-infra-modules). */
export class Fleet extends Context.Service<Fleet, {
  readonly preflight: (target: string, project: string, descriptor: unknown, trace: Telemetry.Parent) => Effect.Effect<void, FleetRejected>
  readonly deploy: (
    target: string,
    project: string,
    release: { readonly revision: string; readonly storePath: string; readonly fence: number },
    trace: Telemetry.Parent,
  ) => Effect.Effect<void, FleetBusy | FleetRejected>
  readonly status: (target: string, project: string) => Effect.Effect<Status | null>
  /**
   * The promotion endpoints that run `app`, in the fleet's deploy order: the project's configured targets,
   * or every endpoint whose `/health` lists the app. Endpoints that never answered are left out.
   */
  readonly targets: (project: Project, app: string) => Effect.Effect<ReadonlyArray<string>>
  /**
   * `targets` for a deploy, which asks endpoints that never answered again for a minute. Those that still
   * don't are `unreachable`: they might run the app, so the deploy must not go on without them.
   */
  readonly deployTargets: (project: Project, app: string) => Effect.Effect<{
    readonly targets: ReadonlyArray<string>
    readonly unreachable: ReadonlyArray<string>
  }>
}>()("kiln/controller/Fleet") {}

/**
 * The apps each endpoint's `/health` lists, kept for a minute. An endpoint that doesn't answer counts
 * with its last answer, or as unknown (null) if it never answered, and is asked again on the next lookup.
 */
export const remembered = <E>(health: (endpoint: string) => Effect.Effect<ReadonlyArray<string>, E>) => {
  const answers = new Map<string, { readonly at: number; readonly apps: ReadonlyArray<string> }>()
  return (endpoint: string) =>
    Effect.suspend(() => {
      const hit = answers.get(endpoint)
      if (hit !== undefined && Date.now() - hit.at < 60_000) return Effect.succeed(hit.apps)
      return health(endpoint).pipe(
        Effect.tap((apps) => Effect.sync(() => answers.set(endpoint, { at: Date.now(), apps }))),
        Effect.orElseSucceed(() => hit?.apps ?? null),
      )
    })
}

export const layer = Layer.effect(Fleet)(Effect.gen(function*() {
  const config = yield* Config
  const telemetry = yield* Telemetry.Telemetry
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("Authorization", `Bearer ${config.promotionToken}`)),
  )
  const post = (url: string, body: unknown) =>
    client.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
      Effect.flatMap((response) => response.text.pipe(Effect.map((text) => ({ status: response.status, text })))),
      Effect.timeout("2 minutes"),
    )
  const Health = Schema.Struct({ apps: Schema.Array(Schema.String) })
  const appsOf = remembered((endpoint) =>
    client.get(`${endpoint}/health`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
      Effect.timeout("5 seconds"),
      Effect.map((h) => h.apps),
    )
  )
  const patiently = (endpoint: string) =>
    appsOf(endpoint).pipe(
      Effect.flatMap((apps) => (apps === null ? Effect.fail(endpoint) : Effect.succeed(apps))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "1 minute" })) }),
      Effect.orElseSucceed(() => null),
    )
  const sort = (project: Project, app: string, lookup: (endpoint: string) => Effect.Effect<ReadonlyArray<string> | null>) =>
    Effect.gen(function*() {
      if (project.targets !== null) return { targets: project.targets, unreachable: [] }
      const found = yield* Effect.forEach(config.fleet, (endpoint) => Effect.map(lookup(endpoint), (apps) => ({ endpoint, apps })), {
        concurrency: "unbounded",
      })
      return {
        targets: found.filter((f) => f.apps?.includes(app) === true).map((f) => f.endpoint),
        unreachable: found.filter((f) => f.apps === null).map((f) => f.endpoint),
      }
    })

  const reason = (text: string) => {
    try {
      const json = JSON.parse(text) as { error?: string; compatibility?: { reasons?: ReadonlyArray<string> } }
      return json.compatibility?.reasons?.join("; ") ?? json.error ?? text
    } catch {
      return text
    }
  }

  return {
    preflight: (target, project, descriptor, trace) =>
      telemetry.span(trace, `preflight ${hostOf(target)}`, { "http.url": `${target}/preflight/${project}` }, post(`${target}/preflight/${project}`, { descriptor }).pipe(
        Effect.catch((e) => Effect.succeed({ status: 0, text: String(e) })),
        Effect.flatMap((r) =>
          r.status === 200 ? Effect.void : Effect.fail(new FleetRejected({ target: hostOf(target), status: r.status, reason: reason(r.text) }))
        ),
      )),
    deploy: (target, project, release, trace) =>
      telemetry.span(trace, `deploy ${hostOf(target)}`, { "http.url": `${target}/deploy/${project}`, "kiln.fence": String(release.fence) }, post(`${target}/deploy/${project}`, {
        revision: release.revision,
        storePath: release.storePath,
        source: "kiln",
        fence: release.fence,
      }).pipe(
        Effect.catch((e) => Effect.succeed({ status: 0, text: String(e) })),
        Effect.flatMap((r): Effect.Effect<void, FleetBusy | FleetRejected> => {
          if (r.status === 202) return Effect.void
          if (r.status === 503) return Effect.fail(new FleetBusy({ target: hostOf(target) }))
          return Effect.fail(new FleetRejected({ target: hostOf(target), status: r.status, reason: reason(r.text) }))
        }),
      )),
    targets: (project, app) => Effect.map(sort(project, app, appsOf), (found) => found.targets),
    deployTargets: (project, app) => sort(project, app, patiently),
    status: (target, project) =>
      client.get(`${target}/status/${project}`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Status)),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      ),
  }
}))
