import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "./Exec.ts"
import type * as Remote from "./Remote.ts"

export type Client = Effect.Success<typeof Remote.client>

/** The working copy of `dir` as a commit, and the URLs of its git remotes. */
export interface WorkingCopy {
  /** The git directory that holds the commit. */
  readonly gitDir: string
  readonly sha: string
  readonly remotes: ReadonlyArray<string>
}

const urls = (lines: string) => [...new Set(lines.split("\n").map((l) => l.trim().split(/\s+/)[1] ?? "").filter(Boolean))]

/** The remote whose URL ends in one of the controller's repositories (`owner/name`), and that repository. */
export const target = (remotes: ReadonlyArray<string>, repos: ReadonlyArray<string>) => {
  for (const remote of remotes) {
    const path = remote.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase()
    const repo = repos.find((r) => path.endsWith(`/${r.toLowerCase()}`) || path.endsWith(`:${r.toLowerCase()}`))
    if (repo !== undefined) return { remote, repo }
  }
  return undefined
}

/**
 * In a jj workspace the working-copy commit is the check: jj snapshots it first, or with
 * `snapshot: false` the last snapshot is used, so a watcher doesn't race the workspace's owner. In a
 * git checkout, tracked and untracked files go into a commit on top of HEAD through a scratch index,
 * leaving the real index and every ref alone.
 */
export const workingCopy = (dir: string, options: { readonly snapshot?: boolean } = {}) =>
  Effect.gen(function*() {
    const flags = options.snapshot === false ? ["--ignore-working-copy"] : []
    const jj = yield* Exec.exec(["jj", ...flags, "--repository", dir, "git", "root"])
    if (jj.exitCode === 0) {
      const gitDir = jj.stdout.trim()
      const sha = (yield* Exec.run(["jj", ...flags, "--repository", dir, "log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim()
      const remotes = urls(yield* Exec.run(["jj", ...flags, "--repository", dir, "git", "remote", "list"]))
      return { gitDir, sha, remotes } satisfies WorkingCopy
    }
    const top = (yield* Exec.run(["git", "-C", dir, "rev-parse", "--show-toplevel"])).trim()
    const gitDir = (yield* Exec.run(["git", "-C", top, "rev-parse", "--absolute-git-dir"])).trim()
    const scratch = mkdtempSync(join(tmpdir(), "kiln-check-"))
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") }
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "-C", top, ...args], { env })
    const sha = yield* Effect.gen(function*() {
      yield* git(["read-tree", "HEAD"])
      yield* git(["add", "-A"])
      const tree = (yield* git(["write-tree"])).trim()
      return (yield* git(["commit-tree", tree, "-p", "HEAD", "-m", "kiln check"])).trim()
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true, force: true }))))
    const remotes = urls(yield* Exec.run(["git", "-C", top, "remote", "-v"]))
    return { gitDir, sha, remotes } satisfies WorkingCopy
  })

/** Pushes the commit as `ref` with the user's own git credentials, replacing what the ref held. */
export const push = (copy: WorkingCopy, remote: string, ref: string) =>
  Exec.run(["git", "--git-dir", copy.gitDir, "push", "-q", remote, `+${copy.sha}:refs/heads/${ref}`])

export const drop = (copy: WorkingCopy, remote: string, ref: string) =>
  Exec.run(["git", "--git-dir", copy.gitDir, "push", "-q", remote, "--delete", `refs/heads/${ref}`]).pipe(Effect.ignore)

/**
 * Pushes `dir`'s working copy and starts its check run. `key` names the ref (`kiln/check/<key>`), so a
 * newer check under the same key replaces an older one; without it the commit names it.
 */
export const submit = (
  client: Client,
  dir: string,
  options: { readonly key?: string; readonly background?: boolean; readonly snapshot?: boolean } = {},
) =>
  Effect.gen(function*() {
    const copy = yield* workingCopy(dir, { snapshot: options.snapshot ?? true })
    const projects = (yield* client.overview()).projects
    const found = target(copy.remotes, projects.map((p) => p.repo))
    if (found === undefined) return yield* Effect.fail(new Error("no git remote points at a repository the controller knows"))
    const ref = `kiln/check/${options.key ?? copy.sha.slice(0, 12)}`
    yield* push(copy, found.remote, ref)
    const run = yield* client.check({ repo: found.repo, ref, sha: copy.sha, ...(options.background === true ? { background: true } : {}) })
    return { run, copy, remote: found.remote, ref }
  })
