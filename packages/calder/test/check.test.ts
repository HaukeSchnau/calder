import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import { cmd, Files, Calder, On, Task } from "@calder-ci/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { checkFiles, drop, push, target, workingCopy } from "../src/Check.ts"
import * as Exec from "../src/Exec.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))

describe("calder check", () => {
  it("pushes to the remote of a repository the controller knows", () => {
    const repos = ["schnau/t3code", "schnau/calder"]
    expect(target(["git@github.com:HaukeSchnau/t3code.git", "git@git.schnau.dev:schnau/t3code.git"], repos))
      .toEqual({ remote: "git@git.schnau.dev:schnau/t3code.git", repo: "schnau/t3code" })
    expect(target(["https://git.schnau.dev/schnau/Calder/"], repos)).toEqual({ remote: "https://git.schnau.dev/schnau/Calder/", repo: "schnau/calder" })
    expect(target(["git@github.com:HaukeSchnau/t3code.git"], repos)).toBeUndefined()
  })

  it.effect("leaves a jj workspace's bookmarks and commits as it found them", () =>
    Effect.gen(function*() {
      for (const [name, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: "/dev/null", JJ_USER: "calder", JJ_EMAIL: "calder@test" })) {
        vi.stubEnv(name, value)
      }
      const dir = mkdtempSync(join(tmpdir(), "calder-check-jj-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => (vi.unstubAllEnvs(), rmSync(dir, { recursive: true, force: true }))))
      const remote = join(dir, "remote.git")
      const work = join(dir, "work")
      const jj = (...args: ReadonlyArray<string>) => Exec.run(["jj", "--repository", work, ...args])
      yield* Exec.run(["git", "init", "-q", "--bare", remote])
      yield* Exec.run(["jj", "git", "init", work])
      yield* jj("git", "remote", "add", "origin", remote)
      writeFileSync(join(work, "a"), "a")
      yield* jj("commit", "-m", "base")
      yield* jj("bookmark", "create", "main", "-r", "@-")
      yield* jj("git", "push", "--bookmark", "main")
      writeFileSync(join(work, "b"), "b")
      yield* jj("commit", "-m", "an agent's work, without a bookmark")
      const log = jj("log", "-r", "all()", "--no-graph", "-T", 'description.first_line() ++ " [" ++ bookmarks ++ "]\n"')
      const before = yield* log

      const copy = yield* workingCopy(work)
      yield* push(copy, remote, "calder/check/x")
      expect(yield* Exec.run(["git", "--git-dir", remote, "rev-parse", "refs/heads/calder/check/x"])).toContain(copy.sha)
      expect(yield* log).toBe(before)
      yield* drop(copy, remote, "calder/check/x")
      yield* jj("git", "fetch")
      expect(yield* log).toBe(before)
    }).pipe(Effect.scoped, Effect.provide(processes)))
})

describe("calder plan", () => {
  it.effect("fails on a path or pattern that matches no file of the working copy, uncommitted files included", () =>
    Effect.gen(function*() {
      // The user's git configuration, such as commit signing, stays out of it.
      for (const [name, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "calder", GIT_AUTHOR_EMAIL: "calder@test", GIT_COMMITTER_NAME: "calder", GIT_COMMITTER_EMAIL: "calder@test" })) {
        vi.stubEnv(name, value)
      }
      const dir = mkdtempSync(join(tmpdir(), "calder-plan-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => (vi.unstubAllEnvs(), rmSync(dir, { recursive: true, force: true }))))
      const git = (...args: ReadonlyArray<string>) => Exec.run(["git", "-C", dir, ...args])
      yield* git("init", "-q")
      writeFileSync(join(dir, "package.json"), "{}")
      yield* git("add", "package.json")
      yield* git("commit", "-q", "-m", "init")
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "src/a.ts"), "export const a = 1")

      const build = (inputs: Files.Files) => Calder.project({ rules: [On.push("main", [Task.make("build", { inputs, run: cmd`make` })])] })
      yield* checkFiles(dir, build(Files.glob("package.json", "src/**")))
      const error = yield* Effect.flip(checkFiles(dir, build(Files.of("package.json", "static"))))
      expect(error.message).toContain(`No file matches "static" (build's inputs).`)
    }).pipe(Effect.scoped, Effect.provide(processes)))
})
