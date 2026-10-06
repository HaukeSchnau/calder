import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as Slots from "../src/controller/Slots.ts"

const minutes = (n: number) => n * 60_000

/** Jobs that record when they start and run until `hold` completes. */
const harness = (slots: Slots.Slots) =>
  Effect.gen(function*() {
    const order: Array<string> = []
    const hold = yield* Deferred.make<void>()
    const job = (name: string, claim: Slots.Claim) =>
      Effect.forkChild(slots.with(claim, Effect.sync(() => order.push(name)).pipe(Effect.andThen(Deferred.await(hold)))))
    return { order, hold, job }
  })

describe("Slots", () => {
  it.effect("hands a freed slot to the shortest waiting step, within the project limit", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 2, perProject: 1 })
      const { order, hold, job } = yield* harness(slots)
      const a = yield* job("shard-1", { project: "t3code", expected: minutes(10), run: 0 })
      const b = yield* job("qa", { project: "studienbuch", expected: minutes(1), run: 0 })
      yield* Effect.yieldNow
      const long = yield* job("shard-2", { project: "t3code", expected: minutes(10), run: 0 })
      const short = yield* job("smoke", { project: "t3code", expected: minutes(2), run: 0 })
      yield* Effect.yieldNow
      expect(order).toEqual(["shard-1", "qa"])
      expect(slots.usage()).toEqual({ running: 2, waiting: 2, capacity: 2 })

      yield* Deferred.succeed(hold, undefined)
      yield* Effect.forEach([a, b, short, long], Fiber.join)
      expect(order).toEqual(["shard-1", "qa", "smoke", "shard-2"])
    }))

  it.effect("lets a project use slots nobody else waits for", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 3, perProject: 2 })
      const { order, hold, job } = yield* harness(slots)
      for (const i of [1, 2, 3]) yield* job(`t3code-${i}`, { project: "t3code", expected: minutes(10), run: 0 })
      yield* job("t3code-4", { project: "t3code", expected: minutes(1), run: 0 })
      yield* Effect.yieldNow
      expect(order).toEqual(["t3code-1", "t3code-2", "t3code-3"])
      yield* job("hopwatch", { project: "hopwatch", expected: minutes(5), run: 0 })
      yield* Effect.yieldNow
      expect(slots.usage()).toEqual({ running: 3, waiting: 2, capacity: 3 })
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      // A freed slot goes to the project under its share, although t3code's step is shorter.
      expect(order.slice(3)).toEqual(["hopwatch", "t3code-4"])
    }))

  it.effect("runs a project's older runs first, shortest first within a run", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 1 })
      const { order, hold, job } = yield* harness(slots)
      yield* job("busy", { project: "t3code", expected: 0, run: 0 })
      yield* Effect.yieldNow
      yield* job("new-static", { project: "t3code", expected: minutes(1), run: 20 })
      yield* job("old-shard", { project: "t3code", expected: minutes(10), run: 10 })
      yield* job("old-smoke", { project: "t3code", expected: minutes(2), run: 10 })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["busy", "old-smoke", "old-shard", "new-static"])
    }))

  it.effect("ages waiting steps, so a long one waiting long enough beats a fresh short one", () =>
    Effect.gen(function*() {
      let clock = 0
      const slots = Slots.make({ capacity: 1, now: () => clock })
      const { order, hold, job } = yield* harness(slots)
      yield* job("busy", { project: "kiln", expected: 0, run: 0 })
      yield* Effect.yieldNow
      yield* job("typecheck", { project: "t3code", expected: minutes(10), run: 0 })
      yield* Effect.yieldNow
      clock = minutes(12)
      yield* job("hopwatch", { project: "hopwatch", expected: minutes(1), run: clock })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["busy", "typecheck", "hopwatch"])
    }))

  it.effect("counts reserved jobs at once, even past capacity, until they are given back", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 2, perProject: 1 })
      const { order, hold, job } = yield* harness(slots)
      const giveBack = [slots.reserve("t3code"), slots.reserve("t3code"), slots.reserve("t3code")]
      expect(slots.usage()).toEqual({ running: 3, waiting: 0, capacity: 2 })
      yield* job("new", { project: "kiln", expected: 0, run: 0 })
      yield* Effect.yieldNow
      expect(order).toEqual([])
      yield* giveBack[0]!
      yield* giveBack[1]!
      yield* Effect.yieldNow
      expect(order).toEqual(["new"])
      yield* Deferred.succeed(hold, undefined)
    }))

  it.effect("gives up the place in the queue when interrupted while waiting", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 1 })
      const { order, hold, job } = yield* harness(slots)
      yield* job("busy", { project: "a", expected: 0, run: 0 })
      yield* Effect.yieldNow
      const waiting = yield* job("cancelled", { project: "a", expected: 0, run: 0 })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      expect(slots.usage()).toEqual({ running: 1, waiting: 0, capacity: 1 })
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["busy"])
      expect(slots.usage().running).toBe(0)
    }))
})
