import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Event } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Job as JobSpec, JobResult } from "../src/Protocol.ts"
import * as Remote from "../src/controller/Remote.ts"
import * as Client from "../src/worker/Client.ts"
import { Job } from "../src/worker/Client.ts"
import * as Main from "../src/worker/Main.ts"
import * as Steps from "../src/worker/Steps.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
const logged: Array<string> = []
const self = (remote: Job["Service"]["remote"]) =>
  ({ id: "job", token: "token", remote, emit: () => Effect.void, log: (_: string, text: string) => Effect.sync(() => void logged.push(text)), redact: (t: string) => t }) as unknown as Job["Service"]

/** A repository with `commits` commits whose ci.ts throws as soon as anything loads it. */
const repository = (commits: number) => {
  const dir = mkdtempSync(join(tmpdir(), "calder-evaluator-repo-"))
  const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  mkdirSync(join(dir, ".calder"))
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, ".calder", "ci.ts"), `throw new Error("ci.ts ran ${i}")\n`)
    git("add", "-A")
    git("commit", "-q", "-m", `commit ${i}`)
  }
  return { dir, sha: git("rev-parse", "HEAD") }
}

const evaluation = (dir: string, sha: string, flake: string): Extract<JobSpec, { _tag: "Step" }> =>
  ({
    _tag: "Step",
    run: { id: "app-1", project: "app", number: 1, revision: sha, branch: "feature", trust: "pr", event: Event.push("main"), flake, mirror: dir, mirrors: {}, pipelineDir: join(dir, ".calder"), system: "aarch64-linux" },
    step: "srv-1",
    evaluate: { builds: [], planned: [] },
  }) as unknown as Extract<JobSpec, { _tag: "Step" }>

/** Puts a `nix` first on PATH that appends its arguments to `calls` and exits with `code`. */
const fakeNix = (code: number) => {
  const bin = mkdtempSync(join(tmpdir(), "calder-evaluator-nix-"))
  writeFileSync(join(bin, "nix"), `#!/usr/bin/env bash\necho "$*" >> ${bin}/calls\necho "error: cannot connect to the store" >&2\nexit ${code}\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  return { calls: () => readFileSync(join(bin, "calls"), "utf8"), restore: Effect.sync(() => void (process.env.PATH = path)) }
}

describe("an evaluation job", () => {
  it.live("evaluates without loading the pipeline, so no ci.ts runs in its worker", () =>
    Effect.gen(function*() {
      const { dir, sha } = repository(1)
      const result: JobResult = yield* Main.step(evaluation(dir, sha, `git+file://${dir}`)).pipe(Effect.provideService(Job, self(null)), Effect.provide(processes))
      expect(result._tag).toBe("Evaluated")
    }))

  it.live("on an evaluator agent evaluates a full mirror of the project, fetched from the controller", () =>
    Effect.gen(function*() {
      const { dir, sha } = repository(3)
      const workspaces = mkdtempSync(join(tmpdir(), "calder-evaluator-ws-"))
      const remote = { url: "http://controller", workspaces, store: "ssh-ng://controller" }
      const run = yield* Main.evaluatedRun(evaluation(dir, sha, "")).pipe(Effect.provideService(Job, self(remote)), Effect.provide(processes))
      const mirror = join(workspaces, ".mirrors", "app.git")
      expect(run.mirror).toBe(mirror)
      expect(run.flake).toBe(`git+file://${mirror}?rev=${sha}`)
      // The whole history, so Nix's revCount is the controller mirror's.
      expect(execFileSync("git", ["--git-dir", mirror, "rev-list", "--count", sha], { encoding: "utf8" }).trim()).toBe("3")
      // One ref, at the last revision fetched, not one per revision evaluated.
      expect(execFileSync("git", ["--git-dir", mirror, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" }).trim()).toBe(
        `refs/calder/last ${sha}`,
      )
    }))
})

describe("an evaluator agent's evaluation", () => {
  const evaluated: Extract<JobResult, { _tag: "Evaluated" }> = {
    _tag: "Evaluated",
    derivations: { "srv-1": { drv: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-srv-1.drv", out: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-srv-1", system: "aarch64-linux" }, broken: null },
    tooLarge: {},
    uses: {},
    errors: {},
  }
  const remote = { url: "http://controller", workspaces: "/tmp", store: "ssh-ng://nix-ssh@controller" }

  it.live("pushes the derivations it got to the controller's store", () =>
    Effect.gen(function*() {
      const nix = fakeNix(0)
      const result = yield* Steps.pushed(evaluated).pipe(Effect.provideService(Job, self(remote)), Effect.provide(processes), Effect.ensuring(nix.restore))
      expect(result).toEqual(evaluated)
      expect(nix.calls()).toBe("--extra-experimental-features nix-command copy --derivation --to ssh-ng://nix-ssh@controller -- /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-srv-1.drv\n")
    }))

  it.live("dies when the push fails, so the controller evaluates the builds itself", () =>
    Effect.gen(function*() {
      const nix = fakeNix(1)
      const result = yield* Steps.pushed(evaluated).pipe(Effect.provideService(Job, self(remote)), Effect.provide(processes), Effect.ensuring(nix.restore))
      expect(result).toEqual({ _tag: "Died", message: "pushing the derivations to the controller's store failed: error: cannot connect to the store" })
    }))

  it.live("of a local worker pushes nothing", () =>
    Effect.gen(function*() {
      const nix = fakeNix(1)
      const result = yield* Steps.pushed(evaluated).pipe(Effect.provideService(Job, self(null)), Effect.provide(processes), Effect.ensuring(nix.restore))
      expect(result).toEqual(evaluated)
    }))
})

describe("an evaluation's cache", () => {
  it("is per trust on an agent, so a trusted run never takes what a pull request's evaluation cached", () => {
    const remote = { workspaces: "/var/lib/calder-agent" }
    expect(Steps.evaluationCache(remote, "pr")).toBe("/var/lib/calder-agent/.cache/pr")
    expect(Steps.evaluationCache(remote, "trusted")).toBe("/var/lib/calder-agent/.cache/trusted")
    // A local trusted worker's pool user has a home, and so a cache, of its own. A pull request's pool is
    // shared with every same-repo pull request's ci.ts, which could forge an entry, so it caches nothing.
    expect(Steps.evaluationCache(null, "trusted")).toMatch(/\.cache\/calder$/)
    expect(Steps.evaluationCache(null, "pr")).toBeNull()
  })
})

describe("an evaluator agent's log", () => {
  const nix = { nix: "nix (Nix) 2.34.9", ifd: "true", config: "e3b0c44298fc" }
  it("says which Nix it evaluates with", () => {
    expect(Steps.contextNote(nix, nix)).toBe("this agent evaluates with nix (Nix) 2.34.9, allow-import-from-derivation true, NIX_CONFIG e3b0c44298fc")
  })
  it("warns when the controller's Nix differs, since its runs then can't take the records", () => {
    expect(Steps.contextNote(nix, { ...nix, nix: "nix (Nix) 2.35.0" })).toContain(
      "warning: the controller has nix (Nix) 2.35.0, allow-import-from-derivation true",
    )
    expect(Steps.contextNote(nix, { ...nix, ifd: "false" })).toContain("warning:")
    expect(Steps.contextNote(nix, { ...nix, config: "0123456789ab" })).toContain("warning: the controller has nix (Nix) 2.34.9, allow-import-from-derivation true, NIX_CONFIG 0123456789ab")
  })
})

describe("an evaluation on an agent", () => {
  const env = Client.evaluationEnv({ "ssh://git@git.example/schnau/lib.git": "https://ci.example/git/lib.git" }, { id: "job", token: "secret" })
  const git = (...args: Array<string>) =>
    spawnSync("git", args, { env: { ...process.env, ...env, HOME: mkdtempSync(join(tmpdir(), "calder-home-")) }, encoding: "utf8" }).stdout.trim()

  it("fetches the flake's forge inputs from the controller's mirrors", () => {
    expect(git("ls-remote", "--get-url", "ssh://git@git.example/schnau/lib.git")).toBe("https://ci.example/git/lib.git")
    expect(git("ls-remote", "--get-url", "https://github.com/NixOS/nixpkgs.git")).toBe("https://github.com/NixOS/nixpkgs.git")
  })

  it("sends the job's token to the controller alone", () => {
    expect(git("config", "--get-urlmatch", "http.extraHeader", "https://ci.example/git/lib.git")).toBe("Authorization: Bearer job:secret")
    expect(git("config", "--get-urlmatch", "http.extraHeader", "https://github.com/NixOS/nixpkgs.git")).toBe("")
    // The origin the mirrors are at, not wherever else the agent reaches the controller.
    expect(git("config", "--get-urlmatch", "http.extraHeader", "https://ci.example/other")).toBe("")
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })

  it.live("gives the job's token to the Nix commands that fetch, never to the worker's environment", () =>
    Effect.gen(function*() {
      const { dir, sha } = repository(1)
      const workspaces = mkdtempSync(join(tmpdir(), "calder-evaluator-ws-"))
      const drv = "/nix/store/00000000000000000000000000000000-srv-1.drv"
      const calls: Array<{ readonly argv: ReadonlyArray<string>; readonly header: string | undefined }> = []
      const real = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.provide(processes))
      const line = (text: string) => new TextEncoder().encode(`${text}\n`)
      const answer = (stdout: Array<string>, stderr: Array<string> = [], code = 0) =>
        Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromIterable(stdout.map(line)),
          stderr: Stream.fromIterable(stderr.map(line)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }))
      // Nix answers the evaluator's expression with one derivation; git runs for real.
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command) || (command.command !== "nix" && command.command !== "strace")) return real.spawn(command)
        const argv = [command.command, ...command.args]
        calls.push({ argv, header: Object.values(command.options.env ?? {}).find((v) => v?.startsWith("Authorization:")) })
        if (command.command === "strace") return answer([], [], 1)
        if (argv[1] === "--version") return answer(["nix (Nix) 2.34.9"])
        if (argv[1] === "eval") {
          const tag = /calder-flake-([0-9a-f]+)/.exec(argv.join(" "))?.[1] ?? ""
          const report = JSON.stringify([0, { drv, out: "/nix/store/00000000000000000000000000000000-srv-1", system: "aarch64-linux" }])
          return answer(["null"], [`trace: calder-flake-${tag}`, `trace: calder-derivation-${tag} ${report}`])
        }
        return answer([])
      })
      const spec = {
        ...evaluation(dir, sha, ""),
        evaluate: { builds: [{ name: "srv-1", attr: "checks.aarch64-linux.srv-1" }], planned: [] },
        run: { ...evaluation(dir, sha, "").run, mirrors: { "ssh://git@git.example/schnau/lib.git": "https://ci.example/git/lib.git" } },
      } as unknown as Extract<JobSpec, { _tag: "Step" }>
      const remote = { url: "https://ci.example", workspaces, store: "ssh-ng://controller" }
      const result = yield* Main.step(spec).pipe(
        Effect.provideService(Job, self(remote)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      expect(result._tag).toBe("Evaluated")
      expect(calls.find((c) => c.argv[1] === "eval")?.header).toBe("Authorization: Bearer job:token")
      // nix copy pushes to the controller's store over SSH, which needs no token.
      expect(calls.find((c) => c.argv.includes("copy"))?.header).toBeUndefined()
      expect(Object.values(process.env).some((v) => v?.includes("Bearer job:token") === true)).toBe(false)
    }))
})

describe("the controller's git endpoint", () => {
  const known = new Set(["app", "lib"])
  const job = (evaluate: boolean) =>
    ({ _tag: "Step", run: { project: "app" }, ...(evaluate ? { evaluate: { builds: [], planned: [] } } : {}) }) as unknown as JobSpec
  it("serves an evaluation any mirrored project, and other jobs only their own", () => {
    expect(Remote.readable(job(true), "lib", known)).toBe(true)
    expect(Remote.readable(job(true), "secret-project", known)).toBe(false)
    expect(Remote.readable(job(false), "lib", known)).toBe(false)
    expect(Remote.readable(job(false), "app", known)).toBe(true)
  })
})

