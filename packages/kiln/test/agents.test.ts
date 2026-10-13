import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import * as Agents from "../src/controller/Agents.ts"
import type { AgentOrder } from "../src/Protocol.ts"

const auth = { token: "secret", name: "m1" }

/** Lets forked fibers and streams catch up. */
const ticks = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const connect = (
  agents: Agents.Agents["Service"],
  { running = [], compatibility = 1, name = "m1", slots = 1 }: { running?: ReadonlyArray<string>; compatibility?: number; name?: string; slots?: number } = {},
) =>
  Effect.gen(function*() {
    const orders: Array<AgentOrder> = []
    const fiber = yield* agents.connect({ ...auth, name }, { platform: "aarch64-darwin", slots, running, build: "b1", compatibility }).pipe(
      Stream.runForEach((order) => Effect.sync(() => orders.push(order))),
      Effect.forkChild,
    )
    yield* ticks
    return { orders, fiber }
  })

describe("Agents", () => {
  it.effect("a job waits for an agent of its platform with a free slot", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const first = yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      const second = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin"))
      yield* ticks
      const m1 = yield* connect(agents)
      expect(m1.orders).toEqual([{ _tag: "Start", job: "a", token: "ta" }])

      yield* agents.exited(auth, "a", 0)
      expect(yield* Fiber.join(first)).toBe(0)
      yield* ticks
      expect(m1.orders.at(-1)).toEqual({ _tag: "Start", job: "b", token: "tb" })

      yield* agents.stop("b")
      yield* ticks
      expect(m1.orders.at(-1)).toEqual({ _tag: "Stop", job: "b" })
      yield* agents.exited(auth, "b", 143)
      expect(yield* Fiber.join(second)).toBe(143)
    }))

  it.effect("a reconnect keeps the workers the agent still runs and loses the others", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const before = yield* connect(agents)
      const kept = yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      yield* ticks
      yield* Fiber.interrupt(before.fiber)

      yield* connect(agents, { running: ["a"] })
      expect(agents.usage()).toEqual([{ name: "m1", platform: "aarch64-darwin", slots: 1, running: 1, connected: true, build: "b1", compatibility: 1, current: true }])

      const again = yield* connect(agents)
      expect(yield* Fiber.join(kept)).toBe(-1)
      expect(agents.usage()[0]?.running).toBe(0)
      yield* Fiber.interrupt(again.fiber)
      yield* ticks
      expect(agents.usage()[0]?.connected).toBe(false)
    }))

  it.effect("only agents of the controller's compatibility version get jobs", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 2)
      const job = yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      const stale = yield* connect(agents, { compatibility: 1 })
      expect(stale.orders).toEqual([])
      expect(agents.usage()[0]).toMatchObject({ connected: true, compatibility: 1, current: false })

      const current = yield* connect(agents, { compatibility: 2, name: "m2" })
      expect(current.orders).toEqual([{ _tag: "Start", job: "a", token: "ta" }])
      yield* agents.exited({ ...auth, name: "m2" }, "a", 0)
      expect(yield* Fiber.join(job)).toBe(0)
    }))

  it.effect("an agent's workers the controller doesn't know, as after a restart, are stopped before it gets new jobs", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const job = yield* Effect.forkChild(agents.run({ id: "new", token: "tn" }, "aarch64-darwin"))
      yield* ticks
      const m1 = yield* connect(agents, { running: ["old"], slots: 2 })
      expect(m1.orders).toEqual([{ _tag: "Stop", job: "old" }])
      expect(agents.usage()[0]?.running).toBe(1)

      yield* agents.exited(auth, "old", 143)
      yield* ticks
      expect(m1.orders.at(-1)).toEqual({ _tag: "Start", job: "new", token: "tn" })
      yield* agents.exited(auth, "new", 0)
      expect(yield* Fiber.join(job)).toBe(0)
    }))

  it.effect("a stopped worker keeps new jobs off its agent until it is gone, across a reconnect", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const before = yield* connect(agents, { slots: 2 })
      yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      yield* ticks
      yield* Fiber.interrupt(before.fiber)
      yield* agents.stop("a")
      const waiting = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin"))

      const after = yield* connect(agents, { running: ["a"], slots: 2 })
      expect(after.orders).toEqual([{ _tag: "Stop", job: "a" }])
      yield* agents.exited(auth, "a", 143)
      yield* ticks
      expect(after.orders.at(-1)).toEqual({ _tag: "Start", job: "b", token: "tb" })
      yield* agents.exited(auth, "b", 0)
      expect(yield* Fiber.join(waiting)).toBe(0)
    }))

  it.effect("an agent takes jobs as it offers slots", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const m1 = yield* connect(agents)
      yield* agents.offer(auth, 0)
      const offloaded = yield* agents.run({ id: "a", token: "ta" }, "aarch64-darwin", { wait: false })
      expect(offloaded).toBe(-2)

      const waiting = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin"))
      yield* ticks
      expect(m1.orders).toEqual([])
      yield* agents.offer(auth, 2)
      yield* ticks
      expect(m1.orders).toEqual([{ _tag: "Start", job: "b", token: "tb" }])
      expect(agents.usage()[0]).toMatchObject({ slots: 2, running: 1 })
      yield* agents.exited(auth, "b", 0)
      expect(yield* Fiber.join(waiting)).toBe(0)
    }))

  it.effect("a job starts once an agent takes it, and an offloaded job no agent takes never does", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const started: Array<string> = []
      const onPlaced = (job: string) => Effect.sync(() => void started.push(job))
      expect(yield* agents.run({ id: "a", token: "ta" }, "aarch64-darwin", { wait: false, onPlaced: onPlaced("a") })).toBe(-2)

      const waiting = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin", { onPlaced: onPlaced("b") }))
      yield* ticks
      expect(started).toEqual([])
      yield* connect(agents)
      expect(started).toEqual(["b"])
      yield* agents.exited(auth, "b", 0)
      expect(yield* Fiber.join(waiting)).toBe(0)
    }))

  it.effect("agents need the secret", () =>
    Effect.gen(function*() {
      const refused = yield* Agents.make("secret").connect({ token: "wrong", name: "m1" }, { platform: "aarch64-darwin", slots: 1, running: [], build: "b1", compatibility: 1 }).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(refused._tag).toBe("Unauthorized")
    }))
})
