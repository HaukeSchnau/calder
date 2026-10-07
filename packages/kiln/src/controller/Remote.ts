import { Effect, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as Exec from "../Exec.ts"
import { AgentRpcs } from "../Protocol.ts"
import * as Values from "../Values.ts"
import { Agents } from "./Agents.ts"
import { Config } from "./Config.ts"
import { Jobs } from "./Jobs.ts"
import { Mirror } from "./Mirror.ts"

export const agentHandlers = AgentRpcs.toLayer(Effect.gen(function*() {
  const agents = yield* Agents
  return {
    work: ({ token, name, ...agent }) => agents.connect({ token, name }, agent),
    exited: ({ token, name, job, code }) => agents.exited({ token, name }, job, code),
    offer: ({ token, name, slots }) => agents.offer({ token, name }, slots),
  }
}))

const unauthorized = HttpServerResponse.text("unauthorized", { status: 401 })

/** The agent's worker whose job and token the request carries as `Authorization: Bearer <job>:<token>`. */
const worker = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const jobs = yield* Jobs
    const match = /^Bearer ([0-9a-f]+):([0-9a-f]+)$/.exec(request.headers["authorization"] ?? "")
    if (match === null) return undefined
    const active = yield* jobs.authorize(match[1]!, match[2]!).pipe(Effect.option)
    return active._tag === "Some" && active.value.remote ? active.value : undefined
  })

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * Read-only git over HTTP for agents' workers: `git http-backend` on the job's own mirror, so they
 * check out without Gitea credentials.
 */
export const git = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* worker(request)
    if (active === undefined) return unauthorized
    const url = new URL(request.url, "http://kiln")
    const match = /^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname)
    const project = active.spec.run.project
    if (match === null || match[1] !== project) return HttpServerResponse.text("not found", { status: 404 })
    if (match[2] === "info/refs" && url.searchParams.get("service") !== "git-upload-pack") {
      return HttpServerResponse.text("only fetches", { status: 403 })
    }
    const mirror = (yield* Mirror).path(project)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["http-backend"], {
      env: {
        GIT_PROJECT_ROOT: dirname(mirror),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${basename(mirror)}/${match[2]}`,
        REQUEST_METHOD: request.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant",
        GIT_CONFIG_VALUE_0: "true",
      },
      extendEnv: true,
      stdin: request.method === "POST" ? Stream.orDie(request.stream) : "ignore",
    }))
    const [chunks] = yield* Effect.all([Stream.runCollect(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode], { concurrency: "unbounded" })
    const output = concat(chunks)
    const split = Buffer.from(output).indexOf("\r\n\r\n")
    if (split === -1) return HttpServerResponse.text("git http-backend failed", { status: 500 })
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of new TextDecoder().decode(output.subarray(0, split)).split("\r\n")) {
      const colon = line.indexOf(":")
      const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0])
      else headers[name] = value
    }
    return HttpServerResponse.uint8Array(output.subarray(split + 4), { status, headers })
  }).pipe(Effect.scoped, Effect.orDie)

/**
 * A task output an agent's worker produced, as a tar of one entry. Adding it here gives the same
 * content-addressed store path the worker computed, so later steps on this host can read it.
 */
export const output = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* worker(request)
    if (active === undefined) return unauthorized
    const name = new URL(request.url, "http://kiln").searchParams.get("name") ?? ""
    if (!/^[A-Za-z0-9+._?=-]+$/.test(name)) return HttpServerResponse.text("bad name", { status: 400 })
    const uploads = join((yield* Config).stateDir, "uploads")
    mkdirSync(uploads, { recursive: true })
    const dir = mkdtempSync(join(uploads, `${active.id}-`))
    return yield* Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const tar = yield* spawner.spawn(ChildProcess.make("tar", ["-x", "-C", dir], { stdin: Stream.orDie(request.stream) }))
      const [, stderr, code] = yield* Effect.all([
        Stream.runDrain(tar.stdout),
        Stream.mkString(Stream.decodeText(tar.stderr)),
        tar.exitCode,
      ], { concurrency: "unbounded" })
      const entries = readdirSync(dir)
      if (code !== 0 || entries.length !== 1) return HttpServerResponse.text(`bad upload: ${stderr}`, { status: 400 })
      const path = yield* Exec.run(["nix", "store", "add", "--name", name, join(dir, entries[0]!)])
      return HttpServerResponse.text(path.trim())
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  }).pipe(Effect.orDie)

/**
 * A store path among the job's inputs, as a tar of one entry named like the path without its hash,
 * for an agent's worker that can't substitute it: outputs of tasks that ran here.
 */
export const store = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* worker(request)
    if (active === undefined || active.spec._tag !== "Step") return unauthorized
    const path = new URL(request.url, "http://kiln").searchParams.get("path") ?? ""
    const input = Object.values(active.spec.inputs).some((o) => o._tag === "Passed" && Values.decode(o.value) === path)
    if (!input || !/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(path)) return HttpServerResponse.text("not an input of this job", { status: 403 })
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const entry = basename(path)
    const tar = yield* spawner.spawn(ChildProcess.make("tar", ["-c", "-C", "/nix/store", `--transform=s,^${entry.slice(0, 33)},,`, entry], { stdin: "ignore" }))
    return HttpServerResponse.stream(tar.stdout, { contentType: "application/x-tar" })
  }).pipe(Effect.orDie)
