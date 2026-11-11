import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as Exec from "../Exec.ts"
import { link } from "../Gen.ts"
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
  /** The commit's root tree. */
  readonly tree: string
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
  /** The first-parent commits from `from` (excluded) to `to`, newest first, with when each was made. */
  readonly between: (project: string, from: string, to: string) => Effect.Effect<ReadonlyArray<{ readonly sha: string; readonly at: number }>, Exec.ExecError>
  /** Whether `revision` is `commit` or descends from it. False also when the mirror lacks either. */
  readonly contains: (project: string, revision: string, commit: string) => Effect.Effect<boolean>
  /** The tree id of a revision's `.calder/`, null without one. */
  readonly pipelineTree: (project: string, sha: string) => Effect.Effect<string | null>
  /** Extracts `.calder/` of a revision and links its `node_modules` to Calder's SDK. */
  readonly pipelineDir: (project: string, sha: string) => Effect.Effect<string, Exec.ExecError | NoPipeline>
  readonly flake: (project: string, sha: string) => string
  /** Every fetched project's mirror by the URLs a flake input may name its repository with. */
  readonly byUrl: () => Record<string, string>
  /**
   * A merge train: `base` with each pull request's head merged in, in order. A head that conflicts with
   * what is merged before it is left out. `sha` is null when no head merged.
   */
  readonly train: (project: string, base: string, heads: ReadonlyArray<TrainHead>) => Effect.Effect<{
    readonly sha: string | null
    readonly conflicts: ReadonlyArray<number>
  }, Exec.ExecError>
  /** The base a train (`train`) started from and the heads it merged. */
  readonly trainOf: (project: string, sha: string) => Effect.Effect<{ readonly base: string; readonly heads: ReadonlyArray<TrainHead> }, Exec.ExecError>
  /** Pushes `sha` to `ref` on the forge with the bot's token. Without `force`, a branch only moves forward. */
  readonly push: (project: string, sha: string, ref: string, options?: { readonly force?: boolean }) => Effect.Effect<void, Exec.ExecError>
}>()("calder/controller/Mirror") {}

/** A pull request's head in a merge train. */
export interface TrainHead {
  readonly pr: number
  readonly sha: string
}

const trainMerge = /^Merge #(\d+) \(([0-9a-f]{40})\) in a train on ([0-9a-f]{40})$/

/** The URLs a flake input names a repository of the forge with: `git+ssh` and `git+https`. */
export const urls = (forge: string, repo: string) => {
  const base = forge.replace(/\/$/, "")
  return [`ssh://git@${new URL(base).host}/${repo}.git`, `${base}/${repo}.git`]
}

const groupReadable = (dir: string) => {
  chmodSync(dir, 0o2750)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) groupReadable(path)
    else chmodSync(path, 0o640)
  }
}

const extracted = (root: string) => existsSync(join(root, ".calder", "ci.ts"))

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
  // A train's merges read no global or system git config, whose merge drivers or merge.renormalize
  // (which aborts merge-tree in a bare repository) would make them depend on the host.
  const identity = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Calder",
    GIT_AUTHOR_EMAIL: "calder@localhost",
    GIT_COMMITTER_NAME: "Calder",
    GIT_COMMITTER_EMAIL: "calder@localhost",
  }
  const git = (project: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
    Exec.run(["git", "--git-dir", path(project), ...args], { env }).pipe(Effect.provideService(Exec.SpawnerTag, spawner))

  const hasPipeline = (project: string, sha: string) =>
    git(project, ["cat-file", "-e", `${sha}:.calder/ci.ts`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

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
        // What `calder check` pushed (Check.ts `gitRef`).
        "+refs/calder/check/*:refs/calder/check/*",
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
        tree: field("tree") ?? "",
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
    hasPipeline,
    pipelineTree: (project, sha) =>
      git(project, ["rev-parse", "--verify", "--quiet", `${sha}:.calder`]).pipe(Effect.map((out) => out.trim()), Effect.orElseSucceed(() => null)),
    commit,
    between: (project, from, to) =>
      git(project, ["log", "--first-parent", "--format=%H %ct", `${from}..${to}`]).pipe(
        Effect.map((out) => out.split("\n").filter(Boolean).map((line) => {
          const [sha, at] = line.split(" ")
          return { sha: sha!, at: Number(at) * 1000 }
        })),
      ),
    contains: (project, revision, commit) =>
      git(project, ["merge-base", "--is-ancestor", commit, revision]).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    pipelineDir: (project, sha) =>
      Effect.gen(function*() {
        const root = join(config.stateDir, "revs", project, sha)
        if (!extracted(root)) {
          if (!(yield* hasPipeline(project, sha))) return yield* new NoPipeline({ revision: sha })
          yield* extract(root, (scratch) =>
            Exec.run(["bash", "-c", `git --git-dir "$1" archive "$2" .calder | tar -x -C "$3"`, "calder", path(project), sha, scratch]).pipe(
              Effect.provideService(Exec.SpawnerTag, spawner),
              Effect.andThen(Effect.sync(() => groupReadable(scratch))),
            ))
        }
        const now = new Date()
        utimesSync(root, now, now)
        const dir = join(root, ".calder")
        // A revision extracted before a deploy still links the SDK of the Calder that planned it then.
        link(join(dir, "node_modules"), config.sdk)
        return dir
      }),
    train: (project, base, heads) =>
      lock(project).withPermits(1)(Effect.gen(function*() {
        let tip = base
        const conflicts: Array<number> = []
        for (const head of heads) {
          const merged = yield* Exec.exec(["git", "--git-dir", path(project), "merge-tree", "--write-tree", tip, head.sha], { env: identity }).pipe(
            Effect.provideService(Exec.SpawnerTag, spawner),
          )
          // merge-tree exits 1 on a conflict; anything else is an error.
          if (merged.exitCode === 1) {
            conflicts.push(head.pr)
            continue
          }
          if (merged.exitCode !== 0) {
            return yield* new Exec.CommandFailed({ command: `git merge-tree ${tip} ${head.sha}`, exitCode: merged.exitCode, stderr: merged.stderr })
          }
          const tree = merged.stdout.split("\n")[0]!
          const subject = `Merge #${head.pr} (${head.sha}) in a train on ${base}`
          tip = (yield* git(project, ["commit-tree", tree, "-p", tip, "-p", head.sha, "-m", subject], identity)).trim()
        }
        return { sha: tip === base ? null : tip, conflicts }
      })),
    trainOf: (project, sha) =>
      Effect.gen(function*() {
        // A train's merges each name the base it started from, which may itself be a landed train's merge.
        const log = yield* git(project, ["log", "--first-parent", "--format=%H %P%x09%s", sha])
        const heads: Array<TrainHead> = []
        let base: string | null = null
        for (const line of log.split("\n")) {
          const [commits = "", subject = ""] = line.split("\t")
          const [commit = "", , second] = commits.split(" ")
          if (commit === base) break
          const m = trainMerge.exec(subject)
          if (m === null || second !== m[2] || (base !== null && m[3] !== base)) break
          base = m[3]!
          heads.push({ pr: Number(m[1]), sha: m[2]! })
        }
        return { base: base ?? sha, heads: heads.reverse() }
      }),
    push: (project, sha, ref, options) =>
      git(project, ["push", "-q", ...(options?.force === true ? ["--force"] : []), "origin", `${sha}:${ref}`], auth).pipe(Effect.asVoid),
    flake: (project, sha) => `git+file://${path(project)}?rev=${sha}`,
    byUrl: () =>
      Object.fromEntries(
        projects.all()
          .filter((project) => existsSync(join(path(project.name), "HEAD")))
          .flatMap((project) => urls(config.gitea.url, project.repo).map((url) => [url, path(project.name)])),
      ),
  }
}))
