import { Effect, Pull, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
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

/**
 * Splits a CGI program's output into its status, headers and body, reading only as far as the headers
 * end; the body streams on from `stdout` within the scope. Undefined if the output ended first.
 */
export const cgi = <E>(stdout: Stream.Stream<Uint8Array, E>) =>
  Effect.gen(function*() {
    const pull = yield* Stream.toPull(stdout)
    let head = Buffer.alloc(0)
    let split = -1
    while (split === -1) {
      head = Buffer.concat([head, ...(yield* pull)])
      split = head.indexOf("\r\n\r\n")
    }
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of head.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":")
      const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0])
      else headers[name] = value
    }
    const body = Stream.concat(Stream.succeed(head.subarray(split + 4)), Stream.fromPull(Effect.succeed(pull)))
    return { status, headers, body }
  }).pipe(Pull.catchDone(() => Effect.succeed(undefined)))

/**
 * Read-only git over HTTP for agents' workers: `git http-backend` on the job's own mirror, so they
 * check out without Gitea credentials. The pack streams through; the request's scope keeps git
 * running until the response is sent.
 */
export const git = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* worker(request)
    if (active === undefined) return unauthorized
    const url = new URL(request.url, "http://calder")
    const match = /^\/git\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname)
    // An evaluation also fetches the flake's inputs that name other projects, from their mirrors.
    const readable = (name: string) =>
      name === active.spec.run.project || Object.values(active.spec.run.mirrors).some((url) => url.endsWith(`/git/${name}.git`))
    if (match === null || !readable(match[1]!)) return HttpServerResponse.text("not found", { status: 404 })
    if (match[2] === "info/refs" && url.searchParams.get("service") !== "git-upload-pack") {
      return HttpServerResponse.text("only fetches", { status: 403 })
    }
    const mirror = (yield* Mirror).path(match[1]!)
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
    yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
    const response = yield* cgi(handle.stdout)
    if (response === undefined) return HttpServerResponse.text("git http-backend failed", { status: 500 })
    return HttpServerResponse.stream(response.body, { status: response.status, headers: response.headers })
  }).pipe(Effect.orDie)

/**
 * A task output an agent's worker produced, as a tar of one entry. Adding it here gives the same
 * content-addressed store path the worker computed, so later steps on this host can read it.
 */
export const output = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* worker(request)
    if (active === undefined) return unauthorized
    const name = new URL(request.url, "http://calder").searchParams.get("name") ?? ""
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
    const path = new URL(request.url, "http://calder").searchParams.get("path") ?? ""
    const input = Object.values(active.spec.inputs).some((o) => o._tag === "Passed" && Values.decode(o.value) === path)
    if (!input || !/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(path)) return HttpServerResponse.text("not an input of this job", { status: 403 })
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const entry = basename(path)
    const tar = yield* spawner.spawn(ChildProcess.make("tar", ["-c", "-C", "/nix/store", `--transform=s,^${entry.slice(0, 33)},,`, entry], { stdin: "ignore" }))
    return HttpServerResponse.stream(tar.stdout, { contentType: "application/x-tar" })
  }).pipe(Effect.orDie)

const storePath = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/

/** The agent's worker of a job that evaluates builds, which ships the derivations it evaluated here. */
const evaluator = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(worker(request), (active) => (active?.spec._tag === "Step" && active.spec.evaluate !== undefined ? active : undefined))

/** Which of the store paths in the body, one per line, this host's store lacks. */
export const missing = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    if ((yield* evaluator(request)) === undefined) return unauthorized
    const paths = (yield* request.text).split("\n").filter(Boolean)
    if (!paths.every((p) => storePath.test(p))) return HttpServerResponse.text("not store paths", { status: 400 })
    const invalid: Array<string> = []
    for (let i = 0; i < paths.length; i += 1000) {
      const out = yield* Exec.run(["nix-store", "--check-validity", "--print-invalid", ...paths.slice(i, i + 1000)])
      invalid.push(...out.split("\n").filter(Boolean))
    }
    return HttpServerResponse.text(invalid.join("\n"))
  }).pipe(Effect.orDie)

/**
 * The derivations an agent's worker evaluated, with the sources they read, that this host lacked: a
 * gzipped tar of a binary cache of just those paths. Each is content-addressed, so Nix takes it from
 * Calder's unprivileged user without a signature.
 */
export const derivations = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const active = yield* evaluator(request)
    if (active === undefined) return unauthorized
    const uploads = join((yield* Config).stateDir, "uploads")
    mkdirSync(uploads, { recursive: true })
    const dir = mkdtempSync(join(uploads, `${active.id}-`))
    return yield* Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const tar = yield* spawner.spawn(ChildProcess.make("tar", ["-x", "-z", "-C", dir], { stdin: Stream.orDie(request.stream) }))
      const [, stderr, code] = yield* Effect.all([
        Stream.runDrain(tar.stdout),
        Stream.mkString(Stream.decodeText(tar.stderr)),
        tar.exitCode,
      ], { concurrency: "unbounded" })
      const cache = join(dir, "cache")
      if (code !== 0 || !existsSync(cache)) return HttpServerResponse.text(`bad upload: ${stderr}`, { status: 400 })
      const paths = readdirSync(cache).filter((f) => f.endsWith(".narinfo"))
        .map((f) => /^StorePath: (\S+)$/m.exec(readFileSync(join(cache, f), "utf8"))?.[1] ?? "")
      if (!paths.every((p) => storePath.test(p))) return HttpServerResponse.text("bad upload: a narinfo without a store path", { status: 400 })
      // Nix writes the cache's realisations directory while it reads it.
      mkdirSync(join(cache, "realisations"), { recursive: true })
      yield* Exec.run(["nix", "copy", "--no-recursive", "--from", `file://${cache}`, "--stdin"], { stdin: paths.join("\n") })
      return HttpServerResponse.text(`added ${paths.length} paths`)
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  }).pipe(Effect.orDie)
