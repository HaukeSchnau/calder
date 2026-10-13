import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import { cmd, Files, Kiln, On, Task } from "@kiln/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { checkFiles, target } from "../src/Check.ts"
import * as Exec from "../src/Exec.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))

describe("kiln check", () => {
  it("pushes to the remote of a repository the controller knows", () => {
    const repos = ["schnau/t3code", "schnau/kiln"]
    expect(target(["git@github.com:HaukeSchnau/t3code.git", "git@git.schnau.dev:schnau/t3code.git"], repos))
      .toEqual({ remote: "git@git.schnau.dev:schnau/t3code.git", repo: "schnau/t3code" })
    expect(target(["https://git.schnau.dev/schnau/Kiln/"], repos)).toEqual({ remote: "https://git.schnau.dev/schnau/Kiln/", repo: "schnau/kiln" })
    expect(target(["git@github.com:HaukeSchnau/t3code.git"], repos)).toBeUndefined()
  })
})

describe("kiln plan", () => {
  it.effect("fails on a path or pattern that matches no file of the working copy, uncommitted files included", () =>
    Effect.gen(function*() {
      // The user's git configuration, such as commit signing, stays out of it.
      for (const [name, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "kiln", GIT_AUTHOR_EMAIL: "kiln@test", GIT_COMMITTER_NAME: "kiln", GIT_COMMITTER_EMAIL: "kiln@test" })) {
        vi.stubEnv(name, value)
      }
      const dir = mkdtempSync(join(tmpdir(), "kiln-plan-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => (vi.unstubAllEnvs(), rmSync(dir, { recursive: true, force: true }))))
      const git = (...args: ReadonlyArray<string>) => Exec.run(["git", "-C", dir, ...args])
      yield* git("init", "-q")
      writeFileSync(join(dir, "package.json"), "{}")
      yield* git("add", "package.json")
      yield* git("commit", "-q", "-m", "init")
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "src/a.ts"), "export const a = 1")

      const build = (inputs: Files.Files) => Kiln.project({ rules: [On.push("main", [Task.make("build", { inputs, run: cmd`make` })])] })
      yield* checkFiles(dir, build(Files.glob("package.json", "src/**")))
      const error = yield* Effect.flip(checkFiles(dir, build(Files.of("package.json", "static"))))
      expect(error.message).toContain(`No file matches "static" (build's inputs).`)
    }).pipe(Effect.scoped, Effect.provide(processes)))
})
