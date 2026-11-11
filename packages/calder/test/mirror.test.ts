import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "../src/Exec.ts"
import * as Mirror from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import * as Repo from "../src/worker/Repo.ts"
import { config } from "./config.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const { extract } = Mirror

const revision = () => join(mkdtempSync(join(tmpdir(), "calder-revs-")), "project", "sha")

/** Writes `.calder/ci.ts` first and `.calder/flake.ts` after other fibers had a turn. */
const fill = (scratch: string) =>
  Effect.gen(function*() {
    mkdirSync(join(scratch, ".calder"))
    writeFileSync(join(scratch, ".calder", "ci.ts"), "")
    yield* Effect.yieldNow
    writeFileSync(join(scratch, ".calder", "flake.ts"), "")
  })

describe("extract", () => {
  it.effect("leaves one complete copy when two runs extract the same revision at once", () =>
    Effect.gen(function*() {
      const root = revision()
      const seen: Array<ReadonlyArray<string>> = []
      const watching = (scratch: string) =>
        Effect.andThen(fill(scratch), Effect.sync(() => seen.push(existsSync(root) ? readdirSync(join(root, ".calder")) : [])))
      yield* Effect.all([extract(root, watching), extract(root, watching)], { concurrency: 2 })
      expect(seen.every((files) => files.length === 0 || files.length === 2)).toBe(true)
      expect(readdirSync(join(root, ".calder")).sort()).toEqual(["ci.ts", "flake.ts"])
      expect(readdirSync(join(root, ".."))).toEqual(["sha"])
    }))

  it.effect("replaces a revision that was left without ci.ts", () =>
    Effect.gen(function*() {
      const root = revision()
      mkdirSync(join(root, ".calder"), { recursive: true })
      writeFileSync(join(root, ".calder", "flake.ts"), "")
      yield* extract(root, fill)
      expect(readdirSync(join(root, ".calder")).sort()).toEqual(["ci.ts", "flake.ts"])
    }))

  it.effect("leaves nothing behind when the extraction fails", () =>
    Effect.gen(function*() {
      const root = revision()
      const failed = yield* extract(root, (scratch) => Effect.andThen(fill(scratch), Effect.fail("tar failed"))).pipe(Effect.flip)
      expect(failed).toBe("tar failed")
      expect(readdirSync(join(root, ".."))).toEqual([])
    }))
})

/** Starts the mirror, which sweeps once before it is ready, with `kept` as the only project. */
const sweptOnce = (state: string) =>
  Effect.gen(function*() {
    const projects = Layer.succeed(Projects)({
      get: (name) => (name === "kept" ? { name, repo: "schnau/kept", defaultBranch: "main", targets: null, secrets: {} } : undefined),
      all: () => [],
      byRepo: () => Effect.die("unused"),
    })
    const spawner = Layer.succeed(Exec.SpawnerTag)(ChildProcessSpawner.make(() => Effect.die("unused")))
    yield* Effect.asVoid(Mirror.Mirror).pipe(
      Effect.provide(Mirror.layer.pipe(Layer.provide([config({ stateDir: state }), projects, spawner]))),
    )
  })

const directories = (state: string, dirs: ReadonlyArray<string>) => {
  for (const dir of dirs) mkdirSync(join(state, dir), { recursive: true })
}

describe("Mirror", () => {
  it.effect("removes the mirror and revisions of a repository that is no longer a project", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "calder-state-"))
      directories(state, ["mirrors/kept.git", "mirrors/gone.git", "revs/kept/sha", "revs/gone/sha"])
      yield* sweptOnce(state)
      expect(readdirSync(join(state, "mirrors"))).toEqual(["kept.git"])
      expect(readdirSync(join(state, "revs"))).toEqual(["kept"])
    }).pipe(Effect.provide(sqlite)))

  it.effect("fetches what calder check pushed outside the forge's branches", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "calder-state-"))
      const forge = mkdtempSync(join(tmpdir(), "calder-forge-"))
      const work = join(forge, "work")
      const git = (...args: ReadonlyArray<string>) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
      git("init", "-q", "--bare", join(forge, "schnau", "app.git"))
      git("init", "-q", "-b", "main", work)
      git("-C", work, "commit", "-q", "--allow-empty", "-m", "base")
      git("-C", work, "commit", "-q", "--allow-empty", "-m", "checked")
      const checked = git("-C", work, "rev-parse", "HEAD")
      git("-C", work, "push", "-q", join(forge, "schnau", "app.git"), "HEAD~1:refs/heads/main", `${checked}:refs/calder/check/x`)
      const projects = Layer.succeed(Projects)({
        get: (name) => ({ name, repo: "schnau/app", defaultBranch: "main", targets: null, secrets: {} }),
        all: () => [],
        byRepo: () => Effect.die("unused"),
      })
      const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
      yield* Effect.flatMap(Mirror.Mirror, (mirror) => mirror.fetch("app")).pipe(
        Effect.provide(Mirror.layer.pipe(Layer.provide([config({ stateDir: state, gitea: { url: `file://${forge}`, tokenFile: "", webhookSecretFile: "" } }), projects, processes]))),
      )
      expect(git("--git-dir", join(state, "mirrors", "app.git"), "rev-parse", "refs/calder/check/x")).toBe(checked)
    }).pipe(Effect.provide(sqlite)))

  it.effect("builds a merge train that leaves out a conflicting head, pushes it, and reads back what it merged", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "calder-state-"))
      const forge = mkdtempSync(join(tmpdir(), "calder-forge-"))
      const work = join(forge, "work")
      const remote = join(forge, "schnau", "app.git")
      const git = (...args: ReadonlyArray<string>) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
      git("init", "-q", "--bare", remote)
      git("init", "-q", "-b", "main", work)
      writeFileSync(join(work, "a"), "base\n")
      git("-C", work, "add", "a")
      git("-C", work, "commit", "-q", "-m", "base")
      const base = git("-C", work, "rev-parse", "HEAD")
      const branch = (name: string, file: string, content: string) => {
        git("-C", work, "checkout", "-q", "-b", name, base)
        writeFileSync(join(work, file), content)
        git("-C", work, "add", file)
        git("-C", work, "commit", "-q", "-m", name)
        return git("-C", work, "rev-parse", "HEAD")
      }
      const one = branch("one", "b", "one\n")
      const clash = branch("clash", "b", "clash\n")
      const two = branch("two", "c", "two\n")
      const three = branch("three", "d", "three\n")
      git("-C", work, "push", "-q", remote, `${base}:refs/heads/main`, "one", "clash", "two", "three")
      const projects = Layer.succeed(Projects)({
        get: (name) => ({ name, repo: "schnau/app", defaultBranch: "main", targets: null, secrets: {} }),
        all: () => [],
        byRepo: () => Effect.die("unused"),
      })
      const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
      const { built, of, next } = yield* Effect.gen(function*() {
        const mirror = yield* Mirror.Mirror
        yield* mirror.fetch("app")
        const built = yield* mirror.train("app", base, [{ pr: 1, sha: one }, { pr: 2, sha: clash }, { pr: 3, sha: two }])
        yield* mirror.push("app", built.sha!, "refs/heads/main")
        // The next train starts from the landed one, whose tip is a train's merge too.
        const second = yield* mirror.train("app", built.sha!, [{ pr: 4, sha: three }])
        return { built, of: yield* mirror.trainOf("app", built.sha!), next: yield* mirror.trainOf("app", second.sha!) }
      }).pipe(
        Effect.provide(Mirror.layer.pipe(Layer.provide([config({ stateDir: state, gitea: { url: `file://${forge}`, tokenFile: "", webhookSecretFile: "" } }), projects, processes]))),
      )
      expect(built.conflicts).toEqual([2])
      expect(of).toEqual({ base, heads: [{ pr: 1, sha: one }, { pr: 3, sha: two }] })
      expect(next).toEqual({ base: built.sha, heads: [{ pr: 4, sha: three }] })
      expect(git("--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(built.sha)
      expect(git("--git-dir", remote, "show", "main:b")).toBe("one")
      expect(git("--git-dir", remote, "show", "main:c")).toBe("two")
    }).pipe(Effect.provide(sqlite)))

  it.effect("removes revisions no run used for a day, unless a run of them is still going", () =>
    Effect.gen(function*() {
      const state = mkdtempSync(join(tmpdir(), "calder-state-"))
      const revisions = ["idle", "idle.scratch", "running", "fresh"]
      directories(state, revisions.map((sha) => `revs/kept/${sha}`))
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      for (const sha of ["idle", "idle.scratch", "running"]) utimesSync(join(state, "revs/kept", sha), twoDaysAgo, twoDaysAgo)
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("kept-1", { at: 0 })
      yield* sql`update runs set sha = 'running', status = 'running', finished_at = null where id = 'kept-1'`
      yield* sweptOnce(state)
      expect(readdirSync(join(state, "revs/kept")).sort()).toEqual(["fresh", "running"])
    }).pipe(Effect.provide(sqlite)))
})

describe("flake inputs", () => {
  it("come from the project's mirror under every URL a flake input names its repository with", () => {
    const mirror = join(mkdtempSync(join(tmpdir(), "calder-mirror-")), "studienbuch.git")
    execFileSync("git", ["init", "-q", "--bare", mirror])
    const env = {
      ...process.env,
      ...Repo.insteadOf(Object.fromEntries(Mirror.urls("https://git.example.org/", "schnau/Studienbuch").map((url) => [url, mirror]))),
      GIT_SSH_COMMAND: "false",
    }
    for (const url of ["ssh://git@git.example.org/schnau/Studienbuch.git", "https://git.example.org/schnau/Studienbuch.git"]) {
      expect(execFileSync("git", ["ls-remote", "--get-url", url], { env, encoding: "utf8" }).trim()).toBe(`file://${mirror}`)
    }
    expect(execFileSync("git", ["ls-remote", "--get-url", "ssh://git@git.example.org/schnau/Studienbuch-Legacy.git"], { env, encoding: "utf8" }).trim())
      .toBe("ssh://git@git.example.org/schnau/Studienbuch-Legacy.git")
  })
})
