// Tasks that may run on agents of another Linux system than the controller's (PlannedStep `systems`).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { vi } from "vitest"
import type { AgentUsage } from "../src/controller/Agents.ts"
import { compatibility, type PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

// The test controller is x86_64-linux.
const task = (name: string, systems?: ReadonlyArray<string>): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [],
  detail: name,
  task: {
    shell: "devShells.x86_64-linux.ci",
    keyBase: name,
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [],
    platform: null,
    offload: true,
    ...(systems === undefined ? {} : { systems }),
    preview: false,
    lease: false,
  },
})

const agent = (name: string, platform: string, slots: number, portableOnly = false): AgentUsage => ({
  name,
  platform,
  slots,
  running: 0,
  connected: true,
  build: "b",
  compatibility,
  current: true,
  evaluator: false,
  portableOnly,
  free: slots,
})

const until = (done: () => boolean) =>
  Effect.suspend(() => (done() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry(Schedule.spaced("5 millis")),
    Effect.timeout("3 seconds"),
    Effect.orDie,
  )

describe("a task that may run on another Linux system", () => {
  it.live("goes to a free agent of that system, and one that may not stays here", () =>
    Effect.gen(function*() {
      const { status, placements } = yield* drive({
        steps: [task("test", ["aarch64-linux"]), task("lint")],
        agents: () => [agent("m1-linux", "aarch64-linux", 2)],
      })
      expect(status).toBe("passed")
      expect(placements.get("test")).toEqual({ remote: true, offload: true, systems: ["aarch64-linux"] })
      expect(placements.get("lint")).toEqual({ remote: false, offload: false, systems: [] })
    }))

  it.live("that waits for this host's slot goes to an agent once one has a free slot", () =>
    Effect.gen(function*() {
      // The controller has one task slot. Whichever task takes it frees the agent once the other queued
      // for that slot, and waits for the other, which would never run if it kept waiting for the slot.
      let free = false
      const ran = new Set<string>()
      const { status, placements } = yield* drive({
        steps: [task("a", ["aarch64-linux"]), task("b", ["aarch64-linux"])],
        agents: () => (free ? [agent("tower", "aarch64-linux", 1)] : []),
        work: (name) =>
          Effect.gen(function*() {
            ran.add(name)
            if (ran.size === 1) {
              yield* Effect.sleep("200 millis")
              free = true
            }
            yield* until(() => ran.size === 2)
          }),
      })
      expect(status).toBe("passed")
      expect([...placements.values()].map((p) => p.remote).sort()).toEqual([false, true])
    }))

  it.live("goes to an agent that takes only other systems' tasks, which gets none of this system's", () =>
    Effect.gen(function*() {
      const { status, placements } = yield* drive({
        steps: [task("test", ["aarch64-linux"]), task("lint")],
        agents: () => [agent("dev-hauke-tasks", "x86_64-linux", 2, true), agent("m1-linux", "aarch64-linux", 2, true)],
      })
      expect(status).toBe("passed")
      expect(placements.get("test")).toEqual({ remote: true, offload: true, systems: ["aarch64-linux"] })
      expect(placements.get("lint")).toEqual({ remote: false, offload: false, systems: [] })
    }))

  it.live("of a pull request runs here", () =>
    Effect.gen(function*() {
      const { status, placements } = yield* drive({
        steps: [task("test", ["aarch64-linux"])],
        agents: () => [agent("m1-linux", "aarch64-linux", 2)],
        event: { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false },
      })
      expect(status).toBe("passed")
      expect(placements.get("test")).toEqual({ remote: false, offload: false, systems: [] })
    }))
})
