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

const agent = (name: string, platform: string, slots: number, portableOnly = false, pools: AgentUsage["pools"] = ["trusted"]): AgentUsage => ({
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
  pools,
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

  it.live("of a pull request runs here, unless an agent runs pull requests' jobs in its host's sandbox", () =>
    Effect.gen(function*() {
      const plain = yield* drive({
        steps: [task("test", ["aarch64-linux"])],
        agents: () => [agent("m1-linux", "aarch64-linux", 2)],
        event: pullRequest,
      })
      expect(plain.status).toBe("passed")
      expect(plain.placements.get("test")).toEqual({ remote: false, offload: false, systems: [] })

      const sandboxing = yield* drive({
        steps: [task("test", ["aarch64-linux"])],
        agents: () => [agent("m1-linux", "aarch64-linux", 2), agent("tower", "aarch64-linux", 2, false, units)],
        event: pullRequest,
      })
      expect(sandboxing.status).toBe("passed")
      expect(sandboxing.placements.get("test")).toEqual({ remote: true, offload: true, systems: ["aarch64-linux"] })
      expect(sandboxing.pools.get("test")).toBe("pr")
    }))
})

const pullRequest = { _tag: "PullRequest", number: 7, base: "main", head: "feature", fork: false } as const
/** The pools of an agent that starts each job in its host's unit of the job's pool (`calder agent --units`). */
const units: AgentUsage["pools"] = ["pr", "fork", "trusted"]

describe("a pull request's task", () => {
  it.live("that waits for this host's slot goes to a sandboxing agent once it has a free slot, and wakes its host meanwhile", () =>
    Effect.gen(function*() {
      let free = false
      const ran = new Set<string>()
      const { status, placements, roused } = yield* drive({
        steps: [task("a", ["aarch64-linux"]), task("b", ["aarch64-linux"])],
        agents: () => (free ? [agent("tower", "aarch64-linux", 1, false, units)] : []),
        event: pullRequest,
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
      // Before the agent came, the waiting task asked for a host of either system it may run on.
      expect(new Set(roused)).toEqual(new Set(["x86_64-linux", "aarch64-linux"]))
    }))

  it.live("doesn't wake an agent's host right after the controller started", () =>
    Effect.gen(function*() {
      const ran = new Set<string>()
      const { status, roused } = yield* drive({
        steps: [task("a", ["aarch64-linux"]), task("b", ["aarch64-linux"])],
        rouseAfterStart: "1 minute",
        event: pullRequest,
        work: (name) =>
          Effect.gen(function*() {
            ran.add(name)
            if (ran.size === 1) yield* Effect.sleep("100 millis")
          }),
      })
      expect(status).toBe("passed")
      expect(roused).toEqual([])
    }))

  it.live("doesn't wake an agent's host that said it runs no pull requests' jobs", () =>
    Effect.gen(function*() {
      const ran = new Set<string>()
      const { status, roused } = yield* drive({
        steps: [task("a", ["aarch64-linux"]), task("b", ["aarch64-linux"])],
        // Away, as a sleeping host's agent is: it has no free slot, but the controller saw what it runs.
        agents: () => [{ ...agent("m1-linux", "aarch64-linux", 1), connected: false, free: 0 }],
        event: pullRequest,
        work: (name) =>
          Effect.gen(function*() {
            ran.add(name)
            if (ran.size === 1) yield* Effect.sleep("100 millis")
          }),
      })
      expect(status).toBe("passed")
      expect(roused).not.toContain("aarch64-linux")
    }))

  it.live("that gets its preview's secrets stays here", () =>
    Effect.gen(function*() {
      const preview = task("preview", ["aarch64-linux"])
      const { status, placements, pools } = yield* drive({
        steps: [{ ...preview, task: { ...preview.task!, preview: true } }],
        agents: () => [agent("tower", "aarch64-linux", 2, false, units), agent("tower-x86", "x86_64-linux", 2, false, units)],
        event: pullRequest,
      })
      expect(status).toBe("passed")
      expect(placements.get("preview")).toEqual({ remote: false, offload: false, systems: [] })
      expect(pools.get("preview")).toBe("trusted")
    }))

  it.live("of another platform is refused when the only agent of it that sandboxes pull requests is of another version", () =>
    Effect.gen(function*() {
      const pinned = task("android")
      const { steps } = yield* drive({
        steps: [{ ...pinned, task: { ...pinned.task!, platform: "aarch64-linux" } }],
        agents: () => [{ ...agent("tower", "aarch64-linux", 2, false, units), current: false, free: 0 }],
        event: pullRequest,
      })
      expect(steps.get("android")).toMatchObject({ status: "died" })
    }))

  it.live("of another platform is refused when only a portable-only agent of it sandboxes pull requests", () =>
    Effect.gen(function*() {
      const pinned = task("android")
      const { steps } = yield* drive({
        steps: [{ ...pinned, task: { ...pinned.task!, platform: "aarch64-linux" } }],
        agents: () => [agent("dev-hauke-tasks", "aarch64-linux", 2, true, units)],
        event: pullRequest,
      })
      expect(steps.get("android")).toMatchObject({
        status: "died",
        error: { message: "aarch64-linux steps of pull requests need an agent that sandboxes them, and none of aarch64-linux does" },
      })
    }))

  it.live("that gets its preview's secrets and needs another platform is refused, though an agent sandboxes pull requests there", () =>
    Effect.gen(function*() {
      const preview = task("preview")
      const { steps } = yield* drive({
        steps: [{ ...preview, task: { ...preview.task!, preview: true, platform: "aarch64-linux" } }],
        agents: () => [agent("tower", "aarch64-linux", 2, false, units)],
        event: pullRequest,
      })
      expect(steps.get("preview")).toMatchObject({
        status: "died",
        error: { message: "a preview task gets secrets, which stay on x86_64-linux, so it can't run on aarch64-linux" },
      })
    }))
})
