import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as Slots from "../src/controller/Slots.ts"

describe("Slots", () => {
  it.effect("hands a freed slot to the shortest waiting step, within the project limit", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 2, perProject: 1 })
      const order: Array<string> = []
      const hold = yield* Deferred.make<void>()
      const job = (project: string, name: string, priority: number) =>
        slots.with(project, priority, Effect.sync(() => order.push(name)).pipe(Effect.andThen(Deferred.await(hold))))

      const a = yield* Effect.forkChild(job("t3code", "shard-1", 600_000))
      const b = yield* Effect.forkChild(job("studienbuch", "qa", 60_000))
      yield* Effect.yieldNow
      const long = yield* Effect.forkChild(job("t3code", "shard-2", 600_000))
      const short = yield* Effect.forkChild(job("t3code", "smoke", 120_000))
      yield* Effect.yieldNow
      expect(order).toEqual(["shard-1", "qa"])
      expect(slots.usage()).toEqual({ running: 2, waiting: 2, capacity: 2 })

      yield* Deferred.succeed(hold, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      yield* Fiber.join(short)
      yield* Fiber.join(long)
      expect(order).toEqual(["shard-1", "qa", "smoke", "shard-2"])
    }))
})
