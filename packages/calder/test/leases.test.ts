import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as Leases from "../src/controller/Leases.ts"

/** A store in memory; `saved` is what a restarted controller reads, with every holder's worker adopted. */
const memory = () => {
  let fence = 0
  const newest = new Map<string, Leases.Saved["newest"][number]>()
  const holders = new Map<string, Leases.Saved["holders"][number]>()
  const store: Leases.Store = {
    nextFence: () => Effect.sync(() => ++fence),
    held: (project, holder, f) =>
      Effect.sync(() => {
        const key = `${project}/${holder.step}`
        newest.set(key, { project, step: holder.step, run: Math.max(newest.get(key)?.run ?? 0, holder.run) })
        holders.set(project, { ...holder, project, fence: f })
      }),
    released: (project, job) => Effect.sync(() => void (holders.get(project)?.job === job && holders.delete(project))),
  }
  const saved = (): Leases.Saved => ({ newest: [...newest.values()], holders: [...holders.values()] })
  return { store, saved }
}

describe("Leases", () => {
  it.effect("latest wins per step: an older run waiting with a step gives way to the newer run that gets it", () =>
    Effect.gen(function*() {
      const leases = Leases.make(memory().store)
      const first = yield* leases.acquire("p", { job: "a", run: 10, step: "deploy" })
      expect(first._tag).toBe("Held")

      const older = yield* Effect.forkChild(leases.acquire("p", { job: "b", run: 11, step: "deploy" }))
      yield* Effect.yieldNow
      const newer = yield* Effect.forkChild(leases.acquire("p", { job: "c", run: 12, step: "deploy" }))
      yield* Effect.yieldNow

      yield* leases.release("p", "a")
      expect(yield* Fiber.join(older)).toEqual({ _tag: "Replaced", by: 12 })
      const granted = yield* Fiber.join(newer)
      expect(granted._tag).toBe("Held")
      if (first._tag === "Held" && granted._tag === "Held") expect(granted.fence).toBeGreaterThan(first.fence)

      yield* leases.release("p", "c")
      expect(yield* leases.acquire("p", { job: "d", run: 11, step: "deploy" })).toEqual({ _tag: "Replaced", by: 12 })
    }))

  it.effect("another step of a newer run doesn't replace a run's deploy", () =>
    Effect.gen(function*() {
      // Hourly runs deploy srv-1 at once while one run's m1 still builds; that m1 deploy must still happen.
      const leases = Leases.make(memory().store)
      yield* leases.acquire("p", { job: "srv-1@10", run: 10, step: "deploy-srv-1" })
      yield* leases.release("p", "srv-1@10")
      yield* leases.acquire("p", { job: "srv-1@11", run: 11, step: "deploy-srv-1" })
      yield* leases.release("p", "srv-1@11")
      expect((yield* leases.acquire("p", { job: "m1@10", run: 10, step: "deploy-m1" }))._tag).toBe("Held")
    }))

  it.effect("a newer run cancelled while it waits leaves the deploy to the older run", () =>
    Effect.gen(function*() {
      const leases = Leases.make(memory().store)
      yield* leases.acquire("p", { job: "srv-1@11", run: 11, step: "deploy-srv-1" })
      const older = yield* Effect.forkChild(leases.acquire("p", { job: "m1@10", run: 10, step: "deploy-m1" }))
      yield* Effect.yieldNow
      const newer = yield* Effect.forkChild(leases.acquire("p", { job: "m1@11", run: 11, step: "deploy-m1" }))
      yield* Effect.yieldNow

      // Run 12 supersedes run 11, or someone cancels it: its waiting deploy goes away.
      yield* Fiber.interrupt(newer)
      yield* leases.release("p", "srv-1@11")
      expect((yield* Fiber.join(older))._tag).toBe("Held")
    }))

  it.effect("deploys of one run take the lease in turn", () =>
    Effect.gen(function*() {
      const leases = Leases.make(memory().store)
      expect((yield* leases.acquire("p", { job: "a", run: 5, step: "deploy-a" }))._tag).toBe("Held")
      const b = yield* Effect.forkChild(leases.acquire("p", { job: "b", run: 5, step: "deploy-b" }))
      yield* Effect.yieldNow
      const c = yield* Effect.forkChild(leases.acquire("p", { job: "c", run: 5, step: "deploy-c" }))
      yield* Effect.yieldNow

      yield* leases.release("p", "a")
      expect((yield* Fiber.join(b))._tag).toBe("Held")
      yield* leases.release("p", "b")
      expect((yield* Fiber.join(c))._tag).toBe("Held")
    }))

  it.effect("asking again for a held lease returns the same fence", () =>
    Effect.gen(function*() {
      const leases = Leases.make(memory().store)
      const first = yield* leases.acquire("p", { job: "a", run: 1, step: "deploy" })
      expect(yield* leases.acquire("p", { job: "a", run: 1, step: "deploy" })).toEqual(first)
    }))

  it.effect("a restart keeps the holder whose worker runs on and the newest run of each step", () =>
    Effect.gen(function*() {
      const { store, saved } = memory()
      const before = Leases.make(store)
      const held = yield* before.acquire("p", { job: "m1@12", run: 12, step: "deploy-m1" })

      const after = Leases.make(store, saved())
      expect(yield* after.acquire("p", { job: "m1@12", run: 12, step: "deploy-m1" })).toEqual(held)
      expect(yield* after.acquire("p", { job: "m1@11", run: 11, step: "deploy-m1" })).toEqual({ _tag: "Replaced", by: 12 })
      const waiting = yield* Effect.forkChild(after.acquire("p", { job: "srv-1@13", run: 13, step: "deploy-srv-1" }))
      yield* Effect.yieldNow
      expect(after.holder("p")?.job).toBe("m1@12")
      yield* after.release("p", "m1@12")
      expect((yield* Fiber.join(waiting))._tag).toBe("Held")
    }))

  it.effect("a rerun of an older revision gives way when its turn comes, without keeping the head's run from deploying", () =>
    Effect.gen(function*() {
      const leases = Leases.make(memory().store)
      const stale = Effect.succeed("head-sha")
      yield* leases.acquire("p", { job: "a", run: 10, step: "deploy" })
      const head = yield* Effect.forkChild(leases.acquire("p", { job: "b", run: 11, step: "deploy" }))
      yield* Effect.yieldNow
      const rerun = yield* Effect.forkChild(leases.acquire("p", { job: "c", run: 12, step: "deploy", stale }))
      yield* Effect.yieldNow

      yield* leases.release("p", "a")
      expect(yield* Fiber.join(rerun)).toEqual({ _tag: "Stale", head: "head-sha" })
      expect((yield* Fiber.join(head))._tag).toBe("Held")
      yield* leases.release("p", "b")

      // A stale run never counts as the step's newest, so the head's next deploy still gets the lease.
      expect(yield* leases.acquire("p", { job: "d", run: 13, step: "deploy", stale })).toEqual({ _tag: "Stale", head: "head-sha" })
      expect((yield* leases.acquire("p", { job: "e", run: 12, step: "deploy" }))._tag).toBe("Held")
    }))
})
