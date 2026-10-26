import { mkdtempSync } from "node:fs"
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
const nix = (valid: () => boolean) => {
  const calls: Array<string> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      calls.push(argv.slice(0, 2).join(" "))
      const evaluating = argv[1] === "eval"
      const stdout = evaluating ? JSON.stringify({ a0: drv("a"), a1: null }) : ""
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(evaluating || valid() ? 0 : 1)),
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

      yield* plan("git+file:///mirror?rev=2")
      valid = false
      yield* plan("git+file:///mirror?rev=2")
      yield* plan("git+file:///mirror")
      yield* plan("git+file:///mirror")
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(5)
    }))
})
