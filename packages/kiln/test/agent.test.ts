import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Agent from "../src/Agent.ts"

/** Starts a process in its own group, like the agent's workers, and returns its pid. */
const start = (argv: ReadonlyArray<string>) => {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore" })
  child.unref()
  return child.pid!
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("Agent", () => {
  it.live("stops the workers an earlier run left behind, but not a process that got a recorded pid", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "kiln-workers-"))
      const worker = start(["sh", "-c", "sleep 60; :", "worker", "0123456789abcdef"])
      const other = start(["sleep", "60"])
      writeFileSync(join(dir, "0123456789abcdef"), String(worker))
      writeFileSync(join(dir, "fedcba9876543210"), String(other))

      yield* Agent.stopLeftovers(dir)
      expect(alive(worker)).toBe(false)
      expect(alive(other)).toBe(true)
      expect(readdirSync(dir)).toEqual([])
      process.kill(other)
    }).pipe(Effect.provide(BunServices.layer)))
})
