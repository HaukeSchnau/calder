import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import * as Agents from "../src/controller/Agents.ts"
import type { AgentOrder } from "../src/Protocol.ts"

const auth = { token: "secret", name: "m1" }

/** Lets forked fibers and streams catch up. */
const ticks = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const connect = (agents: Agents.Agents["Service"], running: ReadonlyArray<string> = []) =>
  Effect.gen(function*() {
    const orders: Array<AgentOrder> = []
    const fiber = yield* agents.connect(auth, { platform: "aarch64-darwin", slots: 1, running }).pipe(
      Stream.runForEach((order) => Effect.sync(() => orders.push(order))),
      Effect.forkChild,
    )
    yield* ticks
    return { orders, fiber }
  })

describe("Agents", () => {
  it.effect("a job waits for an agent of its platform with a free slot", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret")
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
      const agents = Agents.make("secret")
      const before = yield* connect(agents)
      const kept = yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      yield* ticks
      yield* Fiber.interrupt(before.fiber)

      yield* connect(agents, ["a"])
      expect(agents.usage()).toEqual([{ name: "m1", platform: "aarch64-darwin", slots: 1, running: 1, connected: true }])

      const again = yield* connect(agents, [])
      expect(yield* Fiber.join(kept)).toBe(-1)
      expect(agents.usage()[0]?.running).toBe(0)
      yield* Fiber.interrupt(again.fiber)
      yield* ticks
      expect(agents.usage()[0]?.connected).toBe(false)
    }))

  it.effect("agents need the secret", () =>
    Effect.gen(function*() {
      const refused = yield* Agents.make("secret").connect({ token: "wrong", name: "m1" }, { platform: "aarch64-darwin", slots: 1, running: [] }).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(refused._tag).toBe("Unauthorized")
    }))
})
