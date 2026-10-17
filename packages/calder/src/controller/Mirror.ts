import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as Exec from "../Exec.ts"
import { link } from "../Gen.ts"
import * as Pipeline from "../Pipeline.ts"
import { Config } from "./Config.ts"
import { Projects } from "./Projects.ts"

export class NoPipeline extends Schema.TaggedError<NoPipeline>("calder/NoPipeline")("NoPipeline", {
  revision: Schema.String,
}) {}

export interface CommitInfo {
  readonly sha: string
  readonly title: string
  readonly author: string
  readonly timestamp: number
  readonly changeId: string | null
}

/**
 * Bare mirrors of each project's repository, fetched with the bot's token. Workers read them (group
 * calder-workers) and never see the token.
 */
export class Mirror extends Context.Service<Mirror, {
  readonly path: (project: string) => string
  readonly fetch: (project: string) => Effect.Effect<void, Exec.ExecError>
  readonly hasPipeline: (project: string, sha: string) => Effect.Effect<boolean>
  readonly commit: (project: string, sha: string) => Effect.Effect<CommitInfo, Exec.ExecError>
  /** Extracts `.calder/` of a revision and links its `node_modules` to Calder's SDK. */
  readonly pipelineDir: (project: string, sha: string) => Effect.Effect<string, Exec.ExecError | NoPipeline>
  readonly flake: (project: string, sha: string) => string
}>()("calder/controller/Mirror") {}

const groupReadable = (dir: string) => {
  chmodSync(dir, 0o2750)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) groupReadable(path)
    else chmodSync(path, 0o640)
  }
}

const extracted = (root: string) => Pipeline.find(root) !== undefined

/**
 * Makes `root` hold a revision's `.calder/`: `fill` writes it into a scratch directory next to `root`,
 * which then takes its place in one rename, so a reader sees all of it or nothing. When two fill the
 * same root at once, the first to finish wins.
 */
export const extract = <E, R>(root: string, fill: (scratch: string) => Effect.Effect<void, E, R>) =>
  Effect.gen(function*() {
    if (extracted(root)) return
    mkdirSync(dirname(root), { recursive: true })
    const scratch = mkdtempSync(`${root}.`)
    yield* Effect.ensuring(
      Effect.gen(function*() {
        yield* fill(scratch)
        if (extracted(root)) return
        // Whatever is there without ci.ts is a leftover; rename can't replace a directory that isn't empty.
        rmSync(root, { recursive: true, force: true })
        renameSync(scratch, root)
      }),
      Effect.sync(() => rmSync(scratch, { recursive: true, force: true })),
    )
  })

export const layer = Layer.effect(Mirror)(Effect.gen(function*() {
  const config = yield* Config
  const spawner = yield* Exec.SpawnerTag
  const projects = yield* Projects
  const sql = yield* SqlClient.SqlClient
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = (project: string) => {
    let s = locks.get(project)
    if (s === undefined) {
      s = Semaphore.makeUnsafe(1)
      locks.set(project, s)
    }
    return s
  }
  const path = (project: string) => join(config.stateDir, "mirrors", `${project}.git`)
  const auth = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: token ${config.giteaToken}`,
    GIT_TERMINAL_PROMPT: "0",
  }
  const git = (project: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
    Exec.run(["git", "--git-dir", path(project), ...args], { env }).pipe(Effect.provideService(Exec.SpawnerTag, spawner))

  const has = (project: string, sha: string) => (file: string) =>
    git(project, ["cat-file", "-e", `${sha}:${file}`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

  const ensure = (project: string) =>
    Effect.gen(function*() {
      const dir = path(project)
      if (existsSync(join(dir, "HEAD"))) return
      mkdirSync(dir, { recursive: true })
      yield* git(project, ["init", "-q", "--bare"])
      const repo = projects.get(project)!.repo
      yield* git(project, ["remote", "add", "origin", `${config.gitea.url.replace(/\/$/, "")}/${repo}.git`])
      yield* git(project, ["config", "core.sharedRepository", "group"])
      yield* git(project, ["config", "uploadpack.allowAnySHA1InWant", "true"])
      yield* git(project, ["config", "gc.auto", "0"])
    })

  const fetch = (project: string) =>
    lock(project).withPermits(1)(Effect.gen(function*() {
      yield* ensure(project)
      yield* git(project, [
        "fetch",
        "-q",
        "--prune",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/heads/*",
        "+refs/pull/*/head:refs/pull/*/head",
      ], auth)
      // Nix reads the flake's HEAD even for a pinned rev, and warns when it names no branch.
      yield* git(project, ["symbolic-ref", "HEAD", `refs/heads/${projects.get(project)!.defaultBranch}`])
    })).pipe(Effect.withSpan("mirror.fetch", { attributes: { project } }))

  const commit = (project: string, sha: string) =>
    Effect.gen(function*() {
      const raw = yield* git(project, ["cat-file", "commit", sha])
      const [header, ...body] = raw.split("\n\n")
      const lines = header!.split("\n")
      const field = (name: string) => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1)
      const author = field("author") ?? ""
      const m = /^(.*?) <[^>]*> (\d+)/.exec(author)
      return {
        sha,
        title: body.join("\n\n").split("\n")[0] ?? "",
        author: m?.[1] ?? author,
        timestamp: Number(m?.[2] ?? 0) * 1000,
        changeId: field("change-id") ?? null,
      }
    })

  const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir) : [])
  const remove = (dir: string) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
  /**
   * Removes the mirror and revisions of a repository that is no longer a project, and revisions no
   * run used for a day; extracting one again is cheap.
   */
  const sweep = Effect.gen(function*() {
    const mirrors = join(config.stateDir, "mirrors")
    const revs = join(config.stateDir, "revs")
    const names = new Set([...entries(mirrors).map((entry) => entry.replace(/\.git$/, "")), ...entries(revs)])
    yield* Effect.forEach([...names].filter((name) => projects.get(name) === undefined), (name) =>
      lock(name).withPermits(1)(Effect.gen(function*() {
        yield* remove(join(mirrors, `${name}.git`))
        yield* remove(join(revs, name))
        yield* Effect.logInfo(`removed the mirror of ${name}, which is no longer a project`)
      })), { discard: true })
    const active = new Set((yield* sql<{ project: string; sha: string }>`select project, sha from runs
      where status in ('queued', 'planning', 'running')`).map((run) => `${run.project}/${run.sha}`))
    // Synchronous from here: a run that started meanwhile has touched its revision when it took it.
    const now = Date.now()
    for (const project of entries(revs)) {
      for (const entry of entries(join(revs, project))) {
        const dir = join(revs, project, entry)
        // Scratch directories start with their revision too.
        if (active.has(`${project}/${entry.split(".")[0]}`) || now - statSync(dir).mtimeMs < 86_400_000) continue
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
  const swept = sweep.pipe(Effect.catchCause((cause) => Effect.logWarning("sweeping mirrors failed", cause)))
  yield* swept
  yield* Effect.sleep("10 minutes").pipe(Effect.andThen(swept), Effect.forever, Effect.forkScoped)

  return {
    path,
    fetch,
    hasPipeline: (project, sha) => Pipeline.at(has(project, sha)).pipe(Effect.map((dir) => dir !== undefined)),
    commit,
    pipelineDir: (project, sha) =>
      Effect.gen(function*() {
        const root = join(config.stateDir, "revs", project, sha)
        if (!extracted(root)) {
          const pipeline = yield* Pipeline.at(has(project, sha))
          if (pipeline === undefined) return yield* new NoPipeline({ revision: sha })
          yield* extract(root, (scratch) =>
            Exec.run(["bash", "-c", `git --git-dir "$1" archive "$2" "$4" | tar -x -C "$3"`, "calder", path(project), sha, scratch, pipeline]).pipe(
              Effect.provideService(Exec.SpawnerTag, spawner),
              Effect.andThen(Effect.sync(() => groupReadable(scratch))),
            ))
        }
        const now = new Date()
        utimesSync(root, now, now)
        const dir = Pipeline.find(root) ?? join(root, ".calder")
        // A revision extracted before a deploy still links the SDK of the Calder that planned it then.
        link(join(dir, "node_modules"), config.sdk)
        return dir
      }),
    flake: (project, sha) => `git+file://${path(project)}?rev=${sha}`,
  }
}))
