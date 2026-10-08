import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { link } from "../Gen.ts"
import { Config } from "./Config.ts"
import { Projects } from "./Projects.ts"

export class NoPipeline extends Schema.TaggedError<NoPipeline>("kiln/NoPipeline")("NoPipeline", {
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
 * kiln-workers) and never see the token.
 */
export class Mirror extends Context.Service<Mirror, {
  readonly path: (project: string) => string
  readonly fetch: (project: string) => Effect.Effect<void, Exec.ExecError>
  readonly hasPipeline: (project: string, sha: string) => Effect.Effect<boolean>
  readonly commit: (project: string, sha: string) => Effect.Effect<CommitInfo, Exec.ExecError>
  /** Extracts `.kiln/` of a revision and links its `node_modules` to Kiln's SDK. */
  readonly kilnDir: (project: string, sha: string) => Effect.Effect<string, Exec.ExecError | NoPipeline>
  readonly flake: (project: string, sha: string) => string
}>()("kiln/controller/Mirror") {}

const groupReadable = (dir: string) => {
  chmodSync(dir, 0o2750)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) groupReadable(path)
    else chmodSync(path, 0o640)
  }
}

export const layer = Layer.effect(Mirror)(Effect.gen(function*() {
  const config = yield* Config
  const spawner = yield* Exec.SpawnerTag
  const projects = yield* Projects
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

  return {
    path,
    fetch,
    hasPipeline: (project, sha) =>
      git(project, ["cat-file", "-e", `${sha}:.kiln/ci.ts`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    commit,
    kilnDir: (project, sha) =>
      Effect.gen(function*() {
        const root = join(config.stateDir, "revs", project, sha)
        const dir = join(root, ".kiln")
        // A revision extracted before a deploy still links the SDK of the Kiln that planned it then.
        if (existsSync(join(dir, "ci.ts"))) {
          link(join(dir, "node_modules"), config.sdk)
          return dir
        }
        const has = yield* git(project, ["cat-file", "-e", `${sha}:.kiln/ci.ts`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
        if (!has) return yield* new NoPipeline({ revision: sha })
        mkdirSync(root, { recursive: true })
        yield* Exec.run(["bash", "-c", `git --git-dir "$1" archive "$2" .kiln | tar -x -C "$3"`, "kiln", path(project), sha, root]).pipe(
          Effect.provideService(Exec.SpawnerTag, spawner),
        )
        link(join(dir, "node_modules"), config.sdk)
        groupReadable(root)
        return dir
      }),
    flake: (project, sha) => `git+file://${path(project)}?rev=${sha}`,
  }
}))
