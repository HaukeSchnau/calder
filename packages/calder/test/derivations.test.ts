import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { RunInfo } from "../src/Protocol.ts"
import { derivations } from "../src/worker/Resolve.ts"

const run = (flake: string) => ({ flake }) as RunInfo
const drv = (name: string) => ({ drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}` })

/** Answers `nix eval` with a derivation per attribute and `nix-store --check-validity` with `valid`. */
const nix = (valid: () => boolean, evaluating = Effect.void) => {
  const calls: Array<string> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      calls.push(argv.slice(0, 2).join(" "))
      const evaluates = argv[1] === "eval"
      if (evaluates) yield* evaluating
      const stdout = evaluates ? JSON.stringify({ a0: drv("a"), a1: null }) : ""
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
})
