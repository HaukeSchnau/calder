import { Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import * as Exec from "../Exec.ts"
import { FleetBusy, FleetRejected } from "../Protocol.ts"
import { wakeEvery } from "./Agents.ts"
import { Config, type ConfigShape } from "./Config.ts"
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

export const Health = Schema.Struct({ apps: Schema.Array(Schema.String), system: Schema.optional(Schema.String) })
export type Health = typeof Health.Type

/** A promotion endpoint, and the command that wakes its host when it sleeps while idle. */
export interface Endpoint {
  readonly url: string
  readonly wake: ReadonlyArray<string> | undefined
  readonly optional: boolean
}

export const endpoint = (entry: ConfigShape["fleet"][number]): Endpoint =>
  typeof entry === "string"
    ? { url: entry, wake: undefined, optional: false }
    : { url: entry.url, wake: entry.wake, optional: entry.optional === true }

/** A host the deploy goes to, with the Nix system its release must be built for. */
export interface DeployTarget {
  readonly url: string
  readonly system: string
}

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
   * `targets` for a deploy, with the system each one's `/health` reports (the controller's when it reports
   * none or, for a project's configured targets, doesn't answer). It asks every endpoint afresh, as
   * `patiently` does. Those that don't answer are `unreachable`: they might run the app, so the deploy
   * must not go on without them. Optional ones that don't answer are left out instead.
   */
  readonly deployTargets: (project: Project, app: string) => Effect.Effect<{
    readonly targets: ReadonlyArray<DeployTarget>
    readonly unreachable: ReadonlyArray<string>
  }>
}>()("calder/controller/Fleet") {}

/**
 * Each endpoint's `/health`, kept for a minute. `cached` counts an endpoint that doesn't answer with its
 * last answer, or as unknown (null) if it never answered, and asks it again on the next lookup. `fresh`
 * always asks, and is null when the endpoint doesn't answer now.
 */
export const remembered = <E>(health: (endpoint: string) => Effect.Effect<Health, E>) => {
  const answers = new Map<string, { readonly at: number; readonly health: Health }>()
  const ask = (endpoint: string) =>
    Effect.suspend(() => health(endpoint)).pipe(Effect.tap((health) => Effect.sync(() => answers.set(endpoint, { at: Date.now(), health }))))
  return {
    cached: (endpoint: string): Effect.Effect<Health | null> =>
      Effect.suspend(() => {
        const hit = answers.get(endpoint)
        if (hit !== undefined && Date.now() - hit.at < 60_000) return Effect.succeed(hit.health)
        return ask(endpoint).pipe(Effect.orElseSucceed(() => hit?.health ?? null))
      }),
    fresh: (endpoint: string): Effect.Effect<Health | null> => ask(endpoint).pipe(Effect.orElseSucceed(() => null)),
  }
}

/**
 * Asks an endpoint every 5 seconds until it answers: for a minute, or for five when its host can be
 * woken, which `wake` then does in the background, at most once per `wakeEvery`. Null if it never answered.
 */
export const patiently = (
  lookup: (url: string) => Effect.Effect<Health | null>,
  wake: (command: ReadonlyArray<string>) => Effect.Effect<unknown, { readonly message: string }>,
) => {
  const woken = new Map<string, number>()
  const rouse = (endpoint: Endpoint, command: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const last = woken.get(endpoint.url)
      if (last !== undefined && now - last < Duration.toMillis(wakeEvery)) return
      woken.set(endpoint.url, now)
      const host = hostOf(endpoint.url)
      const failed = (why: string) => Effect.logWarning(`waking ${host} failed: ${why.split("\n")[0]}`)
      yield* Effect.logInfo(`waking ${host}`)
      yield* Effect.forkDetach(wake(command).pipe(
        Effect.timeout("5 minutes"),
        Effect.catch((error) => failed(error.message)),
        Effect.catchDefect((defect) => failed(String(defect))),
      ))
    })
  return (endpoint: Endpoint) =>
    lookup(endpoint.url).pipe(
      Effect.tap((health) => (health === null && endpoint.wake !== undefined ? rouse(endpoint, endpoint.wake) : Effect.void)),
      Effect.flatMap((health) => (health === null ? Effect.fail(endpoint.url) : Effect.succeed(health))),
      Effect.retry({
        schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: endpoint.wake === undefined ? "1 minute" : "5 minutes" })),
      }),
      Effect.orElseSucceed(() => null),
    )
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
  const spawner = yield* Exec.SpawnerTag
  const healthOf = remembered((endpoint) =>
    client.get(`${endpoint}/health`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
      Effect.timeout("5 seconds"),
    )
  )
  const asking = patiently(healthOf.fresh, (command) => Exec.run(command).pipe(Effect.provideService(Exec.SpawnerTag, spawner)))
  const endpoints = config.fleet.map(endpoint)
  const ask = (lookup: (endpoint: Endpoint) => Effect.Effect<Health | null>, among: ReadonlyArray<Endpoint>) =>
    Effect.forEach(among, (e) => Effect.map(lookup(e), (health) => ({ url: e.url, health })), { concurrency: "unbounded" })

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
      telemetry.span(trace, `deploy ${hostOf(target)}`, { "http.url": `${target}/deploy/${project}`, "calder.fence": String(release.fence) }, post(`${target}/deploy/${project}`, {
        revision: release.revision,
        storePath: release.storePath,
        source: "calder",
        fence: release.fence,
      }).pipe(
        Effect.catch((e) => Effect.succeed({ status: 0, text: String(e) })),
        Effect.flatMap((r): Effect.Effect<void, FleetBusy | FleetRejected> => {
          if (r.status === 202) return Effect.void
          if (r.status === 503) return Effect.fail(new FleetBusy({ target: hostOf(target) }))
          return Effect.fail(new FleetRejected({ target: hostOf(target), status: r.status, reason: reason(r.text) }))
        }),
      )),
    targets: (project, app) =>
      project.targets !== null
        ? Effect.succeed(project.targets)
        : Effect.map(ask((e) => healthOf.cached(e.url), endpoints), (found) => found.filter((f) => f.health?.apps.includes(app) === true).map((f) => f.url)),
    deployTargets: (project, app) =>
      Effect.gen(function*() {
        // Configured targets run the app, and one that doesn't answer fails its preflight; /health only tells the system.
        if (project.targets !== null) {
          const found = yield* ask((e) => healthOf.cached(e.url), project.targets.map((url) => ({ url, wake: undefined, optional: false })))
          return { targets: found.map((f) => ({ url: f.url, system: f.health?.system ?? config.system })), unreachable: [] }
        }
        const found = yield* ask(asking, endpoints)
        const optional = new Set(endpoints.filter((e) => e.optional).map((e) => e.url))
        const silent = found.filter((f) => f.health === null)
        for (const f of silent.filter((f) => optional.has(f.url))) {
          yield* Effect.logWarning(`${hostOf(f.url)} doesn't answer; its optional endpoint misses this release`)
        }
        return {
          targets: found.flatMap((f) => (f.health?.apps.includes(app) === true ? [{ url: f.url, system: f.health.system ?? config.system }] : [])),
          unreachable: silent.filter((f) => !optional.has(f.url)).map((f) => f.url),
        }
      }),
    status: (target, project) =>
      client.get(`${target}/status/${project}`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Status)),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      ),
  }
}))
