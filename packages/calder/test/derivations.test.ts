import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { RunInfo } from "../src/Protocol.ts"
import { derivations, fromEarlier } from "../src/worker/Resolve.ts"

const run = (flake: string) => ({ flake }) as RunInfo
const drv = (name: string) => ({ drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system: "x86_64-linux" })

/**
 * Answers `nix eval` with a derivation per attribute, `nix-store --check-validity` with `valid` and
 * `nix-store --query --requisites` with `closure`.
 */
const nix = (valid: () => boolean, evaluating = Effect.void, closure: () => ReadonlyArray<string> = () => []) => {
  const calls: Array<string> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      calls.push(argv.slice(0, 2).join(" "))
      const evaluates = argv[1] === "eval"
      if (evaluates) yield* evaluating
      const stdout = evaluates ? JSON.stringify({ a0: drv("a"), a1: null }) : argv[1] === "--query" ? closure().join("\n") : ""
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(evaluates || valid() ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  )
  return { calls, spawner }
}

describe("derivations", () => {
  it.effect("evaluates a locked revision once while its derivations are in the store", () =>
    Effect.gen(function*() {
      let valid = true
      const { calls, spawner } = nix(() => valid)
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = (flake: string) => derivations(run(flake), ["a", "b"], dir).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

      const first = yield* plan("git+file:///mirror?rev=1")
      expect(yield* plan("git+file:///mirror?rev=1")).toEqual(first)
      expect(first).toEqual(new Map([["a", drv("a")], ["b", null]]))
      expect(calls).toEqual(["nix eval", "nix-store --check-validity"])

      // Another revision replaces the repository's entry; a subset of it is a hit.
      yield* plan("git+file:///mirror?rev=2")
      const subset = yield* derivations(run("git+file:///mirror?rev=2"), ["a"], dir).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      expect(subset).toEqual(new Map([["a", drv("a")]]))
      expect(yield* plan("git+file:///mirror?rev=1")).toEqual(first)
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(3)

      valid = false
      yield* plan("git+file:///mirror?rev=1")
      yield* plan("git+file:///mirror")
      yield* plan("git+file:///mirror")
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(6)
    }))

  it.live("evaluates a revision once when two plans of it start together", () =>
    Effect.gen(function*() {
      const { calls, spawner } = nix(() => true, Effect.sleep("50 millis"))
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = derivations(run("git+file:///mirror?rev=1"), ["a", "b"], dir).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const [push, schedule] = yield* Effect.all([plan, plan], { concurrency: 2 })
      expect(schedule).toEqual(push)
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(1)
    }))

  it.effect("takes over the lock of a worker that died holding it", () =>
    Effect.gen(function*() {
      const { calls, spawner } = nix(() => true)
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = derivations(run("git+file:///mirror?rev=1"), ["a"], dir).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      yield* plan
      // No process has this id: Linux caps them at 2^22.
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        writeFileSync(join(dir, `${name}.lock`), String(2 ** 23))
      }
      yield* plan
      expect(calls).toEqual(["nix eval", "nix-store --check-validity"])
    }))

  it.effect("takes an earlier plan's derivations of the same tree, unless they mention its commit", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      // The closure of the earlier derivation: one .drv file, which may mention the commit.
      const closure = join(dir, "x-bundle.drv")
      const { calls, spawner } = nix(() => true, Effect.void, () => [closure])
      const pr = "1".repeat(40)
      const committed = 1_761_609_600
      const earlier = { revision: pr, derivations: { a: drv("a"), b: null }, app: "app" }
      const take = (attrs: ReadonlyArray<string>) =>
        fromEarlier(earlier, attrs, committed).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

      writeFileSync(closure, `Derive([("out","/nix/store/x-bundle","","")],[],[],"x86_64-linux","/bin/sh",[],[("version","0.1")])`)
      expect(yield* take(["a", "b"])).toEqual(new Map([["a", drv("a")], ["b", null]]))
      // A derivation that embeds the commit, such as a version from `self.shortRev` or `self.lastModified`, doesn't carry over.
      for (const mark of [pr.slice(0, 7), String(committed), "20251028000000"]) {
        writeFileSync(closure, `Derive([("out","/nix/store/x-bundle","","")],[],[],"x86_64-linux","/bin/sh",[],[("version","0.1-${mark}")])`)
        expect(yield* take(["a", "b"])).toBeUndefined()
      }
      // Nor does a plan that didn't evaluate every attribute this one needs.
      expect(yield* take(["a", "c"])).toBeUndefined()
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(0)
    }))
})
