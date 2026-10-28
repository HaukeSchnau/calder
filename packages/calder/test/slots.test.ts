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

  it.effect("keeps one project's stuck plans from holding every slot, even while nobody else waits", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 4, maxPerProject: 1 })
      const { order, hold, job } = yield* harness(slots)
      for (const pr of [2, 3, 4]) yield* job(`infra-pr-${pr}`, { project: "infra", expected: 0, run: pr })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-pr-2"])
      yield* job("t3code", { project: "t3code", expected: 0, run: 5 })
      yield* job("studienbuch", { project: "studienbuch", expected: 0, run: 6 })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-pr-2", "t3code", "studienbuch"])
      expect(slots.waitsFor({ project: "infra", expected: 0, run: 7 })).not.toBeNull()
      expect(slots.waitsFor({ project: "hopwatch", expected: 0, run: 7 })).toBeNull()
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order.slice(3)).toEqual(["infra-pr-3", "infra-pr-4"])
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
      yield* job("busy", { project: "calder", expected: 0, run: 0 })
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
      yield* job("new", { project: "calder", expected: 0, run: 0 })
      yield* Effect.yieldNow
      expect(order).toEqual([])
      yield* giveBack[0]!
      yield* giveBack[1]!
      yield* Effect.yieldNow
      expect(order).toEqual(["new"])
      yield* Deferred.succeed(hold, undefined)
    }))

  it.effect("gives background work only slots nothing else wants, keeping one free", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 3 })
      const { order, hold, job } = yield* harness(slots)
      for (const n of [1, 2, 3]) yield* job(`check-${n}`, { project: "t3code", expected: 0, run: 0, background: true })
      yield* Effect.yieldNow
      // The third would take the last free slot.
      expect(order).toEqual(["check-1", "check-2"])
      yield* job("push", { project: "hopwatch", expected: minutes(1), run: 1 })
      yield* Effect.yieldNow
      expect(order).toEqual(["check-1", "check-2", "push"])
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["check-1", "check-2", "push", "check-3"])
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

  it.effect("starts a deploy's critical step in the lane while long checks hold every slot, and says why others wait", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 2, perProject: 1, lane: 1 })
      const { order, hold, job } = yield* harness(slots)
      yield* job("test-server", { project: "t3code", expected: minutes(20), run: 0, label: "t3code-452 test-server" })
      yield* job("lint", { project: "studienbuch", expected: minutes(1), run: 0, label: "studienbuch-21 lint" })
      yield* Effect.yieldNow
      const check = { project: "studienbuch", expected: minutes(1), run: 0 }
      // Reasons reach pull requests' comments, so another project's steps go unnamed.
      expect(slots.waitsFor(check)).toBe("2 of 2 busy: studienbuch-21 lint, 1 of other projects")
      yield* job("test-web", check)
      yield* job("deploy-pr", { project: "studienbuch", expected: minutes(1), run: 0, critical: true, label: "studienbuch-21 preview" })
      yield* Effect.yieldNow
      expect(order).toEqual(["test-server", "lint", "deploy-pr"])
      // The lane is full now, so the next critical step waits, ahead of the check.
      expect(slots.waitsFor({ ...check, critical: true })).toBe("3 of 2 (+1 for deploys) busy: studienbuch-21 lint, studienbuch-21 preview, 1 of other projects")
      yield* job("ready-pr", { project: "studienbuch", expected: minutes(1), run: 0, critical: true })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order.slice(3)).toEqual(["ready-pr", "test-web"])
    }))

  it.effect("keeps a project at its share while another project's step fits, critical or not", () =>
    Effect.gen(function*() {
      // Production sizes: three task slots, two per project, one more for deploys.
      const slots = Slots.make({ capacity: 3, perProject: 2, lane: 1 })
      const { order, hold, job } = yield* harness(slots)
      const deploy = (host: string) => ({ project: "infra", expected: minutes(1), run: 0, critical: true, label: `infra deploy-${host}` })
      yield* job("infra-1", deploy("srv-1"))
      yield* job("infra-2", deploy("srv-2"))
      yield* job("t3code-1", { project: "t3code", expected: minutes(20), run: 0 })
      yield* Effect.yieldNow
      yield* job("infra-3", deploy("tower"))
      yield* job("t3code-2", { project: "t3code", expected: minutes(5), run: 0 })
      yield* Effect.yieldNow
      // The lane takes infra's third deploy only because t3code's next step doesn't fit the capacity, which the lane is beyond.
      expect(order).toEqual(["infra-1", "infra-2", "t3code-1", "infra-3"])
      expect(slots.waitsFor({ project: "t3code", expected: 0, run: 0 })).toContain("4 of 3 busy")
      yield* Deferred.succeed(hold, undefined)
    }))

  it.effect("gives a freed slot to another project's step before a deploy of a project at its share", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 3, perProject: 2, lane: 1 })
      const order: Array<string> = []
      const holds = new Map<string, Deferred.Deferred<void>>()
      const job = (name: string, claim: Slots.Claim) =>
        Effect.gen(function*() {
          const hold = yield* Deferred.make<void>()
          holds.set(name, hold)
          return yield* Effect.forkChild(slots.with(claim, Effect.sync(() => order.push(name)).pipe(Effect.andThen(Deferred.await(hold)))))
        })
      const deploy = (host: string) => ({ project: "infra", expected: minutes(1), run: 0, critical: true })
      yield* job("infra-1", deploy("srv-1"))
      yield* job("infra-2", deploy("srv-2"))
      yield* job("t3code-1", { project: "t3code", expected: minutes(20), run: 0 })
      yield* job("infra-lane", deploy("m1"))
      yield* Effect.yieldNow
      yield* job("infra-3", deploy("tower"))
      yield* job("t3code-2", { project: "t3code", expected: minutes(5), run: 0 })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-1", "infra-2", "t3code-1", "infra-lane"])
      yield* Deferred.succeed(holds.get("infra-1")!, undefined)
      yield* Effect.yieldNow
      expect(order.slice(4)).toEqual(["t3code-2"])
      for (const hold of holds.values()) yield* Deferred.succeed(hold, undefined)
    }))
})
