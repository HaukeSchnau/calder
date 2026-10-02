import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as Leases from "../src/controller/Leases.ts"

const counter = () => {
  let n = 0
  return () => Effect.sync(() => ++n)
}

describe("Leases", () => {
  it.effect("latest wins: a waiting run gives way to a newer one, an older one never gets the lease", () =>
    Effect.gen(function*() {
      const leases = Leases.make(counter())
      const first = yield* leases.acquire("p", { job: "a", run: 10 })
      expect(first._tag).toBe("Held")

      const waiting = yield* Effect.forkChild(leases.acquire("p", { job: "b", run: 11 }))
      yield* Effect.yieldNow
      const newer = yield* Effect.forkChild(leases.acquire("p", { job: "c", run: 12 }))
      yield* Effect.yieldNow
      expect((yield* Fiber.join(waiting))._tag).toBe("Replaced")

      yield* leases.release("p", "a")
      const granted = yield* Fiber.join(newer)
      expect(granted._tag).toBe("Held")
      if (first._tag === "Held" && granted._tag === "Held") expect(granted.fence).toBeGreaterThan(first.fence)

      yield* leases.release("p", "c")
      expect((yield* leases.acquire("p", { job: "d", run: 11 }))._tag).toBe("Replaced")
    }))
})
