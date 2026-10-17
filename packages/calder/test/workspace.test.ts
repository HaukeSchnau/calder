import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Workspace from "../src/worker/Workspace.ts"

// A plain directory as the slot and no snapshots: nothing here runs btrfs.
const noProcesses = ChildProcessSpawner.make(() => Effect.die(new Error("no processes in this test")))
const open = (root: string, deps: string) => Workspace.open(root, deps).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses))

describe("Workspace", () => {
  it.effect("takes the key off a slot that is set up for another, so a setup that stops halfway leaves it unused", () =>
    Effect.gen(function*() {
      const root = join(mkdtempSync(join(tmpdir(), "calder-slot-")), "slot-0")
      mkdirSync(root)
      writeFileSync(join(root, "deps"), "a\n")
      expect((yield* open(root, "a")).fresh).toBe(false)

      expect((yield* open(root, "b")).fresh).toBe(true)
      expect(existsSync(join(root, "deps"))).toBe(false)
      expect((yield* open(root, "a")).fresh).toBe(true)
    }))
})
