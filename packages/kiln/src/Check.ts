import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "./Exec.ts"

/** The working copy of `dir` as a commit, and where its repository lives on Gitea. */
export interface WorkingCopy {
  /** The git directory that holds the commit. */
  readonly gitDir: string
  readonly sha: string
  /** Gitea `owner/name`. */
  readonly repo: string
  readonly remote: string
}

const gitea = /git\.schnau\.dev[:/](.+?)(?:\.git)?$/

const remoteOf = (lines: string) =>
  lines.split("\n").map((l) => l.trim().split(/\s+/)[1] ?? "").find((url) => gitea.test(url))

/**
 * In a jj workspace the working-copy commit is the check (jj snapshots it first). In a git checkout,
 * tracked and untracked files go into a commit on top of HEAD through a scratch index, leaving the
 * real index and every ref alone.
 */
export const workingCopy = (dir: string) =>
  Effect.gen(function*() {
    const jj = yield* Exec.exec(["jj", "--repository", dir, "git", "root"])
    if (jj.exitCode === 0) {
      const gitDir = jj.stdout.trim()
      const sha = (yield* Exec.run(["jj", "--repository", dir, "log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim()
      const remote = remoteOf(yield* Exec.run(["jj", "--repository", dir, "git", "remote", "list"]))
      if (remote === undefined) return yield* Effect.fail(new Error("no git.schnau.dev remote"))
      return { gitDir, sha, repo: gitea.exec(remote)![1]!, remote } satisfies WorkingCopy
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
    const remote = remoteOf(yield* Exec.run(["git", "-C", top, "remote", "-v"]))
    if (remote === undefined) return yield* Effect.fail(new Error("no git.schnau.dev remote"))
    return { gitDir, sha, repo: gitea.exec(remote)![1]!, remote } satisfies WorkingCopy
  })

/** Pushes the commit as `ref` with the user's own git credentials. */
export const push = (copy: WorkingCopy, ref: string) =>
  Exec.run(["git", "--git-dir", copy.gitDir, "push", "-q", copy.remote, `${copy.sha}:refs/heads/${ref}`])

export const drop = (copy: WorkingCopy, ref: string) =>
  Exec.run(["git", "--git-dir", copy.gitDir, "push", "-q", copy.remote, "--delete", `refs/heads/${ref}`]).pipe(Effect.ignore)
