import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { FleetBusy, FleetRejected } from "../Protocol.ts"
import { Config } from "./Config.ts"
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
}>()("kiln/controller/Fleet") {}

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
    status: (target, project) =>
      client.get(`${target}/status/${project}`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Status)),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      ),
  }
}))
