import { BunHttpServer } from "@effect/platform-bun"
import { UiRpcs } from "@calder-ci/api"
import { Effect, Layer, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Config } from "./Config.ts"
import * as Outputs from "./Outputs.ts"
import * as Ui from "./Ui.ts"

const sessionCookie = "calder_session"
const stateCookie = "calder_sign_in"
const sessionDays = 30

/** `<payload>.<signature>`, both base64url: the payload as JSON, signed with HMAC-SHA256. */
export const sign = (key: Buffer, payload: unknown): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`
}

/** The payload of a value `sign` made with `key` whose `expires` (ms) hasn't passed, else undefined. */
export const verify = <A extends { readonly expires: number }>(key: Buffer, value: string | undefined, now: number) => {
  const [body, signature] = (value ?? "").split(".")
  if (body === undefined || signature === undefined) return undefined
  const expected = createHmac("sha256", key).update(body).digest()
  const given = Buffer.from(signature, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as A
  return payload.expires > now ? payload : undefined
}

export interface Session {
  readonly user: string
  readonly expires: number
}

interface SignIn {
  readonly state: string
  readonly next: string
  readonly expires: number
}

/**
 * What the gate does with a request under `prefix`: sign-in routes and people with a session of an
 * allowed user pass, a page someone opens without one goes to sign-in, and anything else is refused.
 */
export const admit = (options: {
  readonly prefix: string
  readonly path: string
  readonly method: string
  readonly session: Session | undefined
  readonly users: ReadonlyArray<string>
}): "pass" | "sign-in" | "refuse" => {
  if (options.path.startsWith(`${options.prefix}/auth/`)) return "pass"
  if (options.session !== undefined && options.users.includes(options.session.user)) return "pass"
  const page = options.method === "GET" && options.path !== `${options.prefix}/rpc`
  return page ? "sign-in" : "refuse"
}

const isPath = (path: string): path is `/${string}` => path.startsWith("/") && path.length > 1

/** Where sign-in returns to: a path of the UI, never another site. */
const nextOf = (prefix: string, next: string | null) =>
  next !== null && next.startsWith(`${prefix}/`) && !next.startsWith("//") ? next : `${prefix}/`

/** The key that signs sessions, made once and kept with the controller's state so restarts keep sessions. */
const sessionKey = (stateDir: string) => {
  const path = join(stateDir, "web-session.key")
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" })
  return readFileSync(path)
}

const AccessToken = Schema.Struct({ access_token: Schema.String })
const UserInfo = Schema.Struct({ preferred_username: Schema.String })

/**
 * The UI for people beyond the Tailnet, on its own listener for a proxy to expose: at the path of
 * `publicUrl` (`/app`), to the Gitea users in `web.users` once they signed in with Gitea's OAuth2.
 * The listener serves nothing else, so agents, workers, the CLI and Gitea's webhook stay on the
 * private one.
 */
export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const web = config.web
  if (web === null) return Layer.empty

  const key = sessionKey(config.stateDir)
  const clientSecret = readFileSync(web.oauth.clientSecretFile, "utf8").trim()
  const publicUrl = new URL(config.publicUrl)
  const prefix = publicUrl.pathname.replace(/\/$/, "")
  if (!isPath(prefix)) return yield* Effect.die(new Error(`publicUrl ${config.publicUrl} needs a path, such as /app, for the web UI`))
  const redirectUri = `${publicUrl.origin}${prefix}/auth/callback`
  const gitea = config.gitea.url.replace(/\/$/, "")
  const cookie = { httpOnly: true, secure: publicUrl.protocol === "https:", sameSite: "lax" as const }

  const urlOf = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, publicUrl.origin)
  const clear = (name: string, path: string) => HttpServerResponse.setCookieUnsafe(name, "", { ...cookie, path, maxAge: 0 })

  const gate = HttpRouter.middleware((app) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = urlOf(request)
      // The UI's page finds its assets and RPC next to it, so it must end in a slash.
      if (url.pathname === prefix) return HttpServerResponse.redirect(`${prefix}/${url.search}`)
      const session = verify<Session>(key, request.cookies[sessionCookie], Date.now())
      switch (admit({ prefix, path: url.pathname, method: request.method, session, users: web.users })) {
        case "pass":
          return yield* app
        case "sign-in":
          return HttpServerResponse.redirect(`${prefix}/auth/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`)
        case "refuse":
          return HttpServerResponse.text("Sign in to Calder first.", { status: 401 })
      }
    }), { global: true })

  const signIn = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const next = nextOf(prefix, urlOf(request).searchParams.get("next"))
    const state = randomBytes(16).toString("base64url")
    const authorize = new URL(`${gitea}/login/oauth/authorize`)
    authorize.search = new URLSearchParams({
      client_id: web.oauth.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile",
      state,
    }).toString()
    const saved: SignIn = { state, next, expires: Date.now() + 10 * 60_000 }
    return HttpServerResponse.redirect(authorize.toString()).pipe(
      HttpServerResponse.setCookieUnsafe(stateCookie, sign(key, saved), { ...cookie, path: `${prefix}/auth`, maxAge: "10 minutes" }),
    )
  })

  const callback = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = urlOf(request)
    const saved = verify<SignIn>(key, request.cookies[stateCookie], Date.now())
    const code = url.searchParams.get("code")
    if (saved === undefined || saved.state !== url.searchParams.get("state") || code === null) {
      return HttpServerResponse.text(`This sign-in expired or was already used. Open ${publicUrl.href} to sign in again.`, { status: 400 })
    }
    const client = yield* HttpClient.HttpClient
    const token = yield* client.execute(
      HttpClientRequest.post(`${gitea}/login/oauth/access_token`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          client_id: web.oauth.clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessToken)))
    const user = yield* client.execute(
      HttpClientRequest.get(`${gitea}/login/oauth/userinfo`).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token.access_token)),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.flatMap(HttpClientResponse.schemaBodyJson(UserInfo)))
    const login = user.preferred_username
    if (!web.users.includes(login)) {
      return HttpServerResponse.text(`Gitea signed you in as ${login}, who may not open Calder.`, { status: 403 }).pipe(
        clear(stateCookie, `${prefix}/auth`),
      )
    }
    const session: Session = { user: login, expires: Date.now() + sessionDays * 24 * 60 * 60_000 }
    return HttpServerResponse.redirect(saved.next).pipe(
      HttpServerResponse.setCookieUnsafe(sessionCookie, sign(key, session), { ...cookie, path: prefix, maxAge: `${sessionDays} days` }),
      clear(stateCookie, `${prefix}/auth`),
    )
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("sign-in with Gitea failed", error).pipe(
        Effect.as(HttpServerResponse.text("Gitea didn't complete the sign-in. Try again in a moment.", { status: 502 })),
      )
    ),
  )

  const signOut = HttpServerResponse.redirect("/").pipe(clear(sessionCookie, prefix))

  const rpc = RpcServer.layer(UiRpcs).pipe(
    Layer.provide(Ui.handlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: `${prefix}/rpc` })),
    Layer.provide(RpcSerialization.layerJson),
  )
  const routes = Layer.mergeAll(
    gate,
    HttpRouter.add("GET", `${prefix}/auth/sign-in`, signIn),
    HttpRouter.add("GET", `${prefix}/auth/callback`, callback),
    HttpRouter.add("GET", `${prefix}/auth/sign-out`, signOut),
    Layer.effectDiscard(Effect.gen(function*() {
      const router = yield* HttpRouter.HttpRouter
      yield* router.prefixed(prefix).add("GET", "/outputs/*", Outputs.serve)
    })),
    rpc,
    config.ui === null ? Layer.empty : HttpStaticServer.layer({ root: config.ui, spa: true, prefix }),
  )
  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provide(BunHttpServer.layer({ port: web.listen.port, hostname: web.listen.host, idleTimeout: 0 })),
  )
}))
