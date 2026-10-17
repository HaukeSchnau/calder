import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as InFlight from "../src/controller/InFlight.ts"

describe("InFlight", () => {
  it.effect("lets a run wait for keys another run's job is computing", () =>
    Effect.gen(function*() {
      const flights = InFlight.make()
      const done = yield* Deferred.make<void>()
      const job = yield* Effect.forkChild(flights.flying(["a", "b"], Deferred.await(done)))
      yield* Effect.yieldNow
      expect(flights.has("a")).toBe(true)
      const waiter = yield* Effect.forkChild(flights.landing(["b", "c"]))
      yield* Effect.yieldNow
      expect(waiter.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(done, undefined)
      yield* Fiber.join(job)
      yield* Fiber.join(waiter)
      expect(flights.has("a")).toBe(false)
      // Nothing in flight: no wait.
      yield* flights.landing(["a"])
    }))

  it.effect("releases its keys when the job fails or is interrupted", () =>
    Effect.gen(function*() {
      const flights = InFlight.make()
      const job = yield* Effect.forkChild(flights.flying(["k"], Effect.never))
      yield* Effect.yieldNow
      expect(flights.has("k")).toBe(true)
      yield* Fiber.interrupt(job)
      expect(flights.has("k")).toBe(false)
      yield* flights.flying(["k"], Effect.fail("boom")).pipe(Effect.ignore)
      expect(flights.has("k")).toBe(false)
    }))
})
