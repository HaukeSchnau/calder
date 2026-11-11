import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { sized, toBuild } from "../src/controller/Runs.ts"
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
      for (const pr of [2, 3, 4]) yield* job(`infra-pr-${pr}`, { project: "infra", expected: 0, run: pr, label: `infra-${pr}'s plan` })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-pr-2"])
      expect(slots.waitsFor({ project: "infra", expected: 0, run: 7 })).toContain("infra-2's plan")
      // The default branch's push came last, but goes before the pull requests' plans that wait.
      yield* job("infra-main", { project: "infra", expected: 0, run: 6, critical: true })
      yield* job("t3code", { project: "t3code", expected: 0, run: 6 })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-pr-2", "t3code"])
      expect(slots.waitsFor({ project: "hopwatch", expected: 0, run: 7 })).toBeNull()
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order.slice(2)).toEqual(["infra-main", "infra-pr-3", "infra-pr-4"])
    }))

  it.effect("runs a newer run's short step of a project before an older run's long one, and the older run first when they score the same", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 1, now: () => 0 })
      const { order, hold, job } = yield* harness(slots)
      yield* job("busy", { project: "infra", expected: 0, run: 0 })
      yield* Effect.yieldNow
      // A whole-fleet rebuild's m1 of an older run, and a one-file pull request's m1 of a newer one.
      yield* job("fleet-m1", { project: "infra", expected: minutes(100), run: 10 })
      yield* job("one-file-m1", { project: "infra", expected: minutes(6), run: 20 })
      yield* job("new-lint", { project: "infra", expected: minutes(1), run: 20 })
      yield* job("old-lint", { project: "infra", expected: minutes(1), run: 10 })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["busy", "old-lint", "new-lint", "one-file-m1", "fleet-m1"])
    }))

  it.effect("counts as ahead only the waiters that go first", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 1, now: () => 0 })
      const { hold, job } = yield* harness(slots)
      yield* job("busy", { project: "infra", expected: 0, run: 0, label: "infra-1 busy" })
      yield* job("fleet-m1", { project: "infra", expected: minutes(100), run: 10 })
      yield* Effect.yieldNow
      expect(slots.waitsFor({ project: "infra", expected: minutes(6), run: 20 })).toBe("1 of 1 busy: infra-1 busy")
      expect(slots.waitsFor({ project: "infra", expected: minutes(200), run: 20 })).toBe("1 of 1 busy: infra-1 busy; 1 ahead")
      yield* Deferred.succeed(hold, undefined)
    }))

  it.effect("ages a project's long step forward past a newer run's short one once it waited long enough", () =>
    Effect.gen(function*() {
      let clock = 0
      const slots = Slots.make({ capacity: 1, now: () => clock })
      const { order, hold, job } = yield* harness(slots)
      yield* job("busy", { project: "infra", expected: 0, run: 0 })
      yield* Effect.yieldNow
      yield* job("fleet-m1", { project: "infra", expected: minutes(100), run: 10 })
      yield* Effect.yieldNow
      clock = minutes(95)
      yield* job("one-file-m1", { project: "infra", expected: minutes(6), run: 20 })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order).toEqual(["busy", "fleet-m1", "one-file-m1"])
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

  it.effect("starts background work that waited only for claims withdrawn or given up", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 3, maxPerProject: 1 })
      const { order, hold, job } = yield* harness(slots)
      yield* job("infra-1 plan", { project: "infra", expected: 0, run: 1 })
      yield* Effect.yieldNow
      // infra's next plans wait for the project's one plan slot; a check waits behind them.
      yield* job("infra-2 plan", { project: "infra", expected: 0, run: 2, owner: "infra-2" })
      const given = yield* job("infra-3 plan", { project: "infra", expected: 0, run: 3 })
      yield* job("check", { project: "t3code", expected: 0, run: 4, background: true })
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-1 plan"])
      slots.withdraw("infra-2")
      yield* Fiber.interrupt(given)
      yield* Effect.yieldNow
      expect(order).toEqual(["infra-1 plan", "check"])
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
      // The deploy in the lane doesn't make the capacity look exceeded to a check.
      expect(slots.waitsFor(check)).toBe("2 of 2 busy (+1 deploy or preview): studienbuch-21 lint, studienbuch-21 preview, 1 of other projects")
      // The lane is full now, so the next critical step waits, ahead of the check.
      expect(slots.waitsFor({ ...check, critical: true })).toBe("3 of 2 (+1 for deploys) busy: studienbuch-21 lint, studienbuch-21 preview, 1 of other projects")
      yield* job("ready-pr", { project: "studienbuch", expected: minutes(1), run: 0, critical: true })
      yield* Effect.yieldNow
      yield* Deferred.succeed(hold, undefined)
      yield* Effect.yieldNow
      expect(order.slice(3)).toEqual(["ready-pr", "test-web"])
    }))

  it.effect("tells a waiting step why, again whenever the queue moves", () =>
    Effect.gen(function*() {
      const slots = Slots.make({ capacity: 1, refresh: "15 seconds" })
      const lint = yield* Deferred.make<void>()
      const rest = yield* Deferred.make<void>()
      const reasons: Array<string> = []
      const step = (label: string, until: Deferred.Deferred<void>, onWaiting?: (reason: string) => Effect.Effect<void>) =>
        Effect.forkChild(slots.with({ project: "t3code", expected: minutes(1), run: 0, label }, Deferred.await(until), onWaiting))
      yield* step("t3code-1 lint", lint)
      yield* Effect.yieldNow
      yield* step("t3code-1 test", rest)
      yield* Effect.yieldNow
      yield* step("t3code-1 build", rest, (reason) => Effect.sync(() => reasons.push(reason)))
      yield* Effect.yieldNow
      expect(reasons).toEqual(["1 of 1 busy: t3code-1 lint; 1 ahead"])
      // test takes lint's slot; build no longer counts it, nor itself, as ahead.
      yield* Deferred.succeed(lint, undefined)
      yield* TestClock.adjust("15 seconds")
      expect(reasons).toEqual(["1 of 1 busy: t3code-1 lint; 1 ahead", "1 of 1 busy: t3code-1 test"])
      yield* TestClock.adjust("15 seconds")
      expect(reasons).toHaveLength(2)
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
      expect(slots.waitsFor({ project: "t3code", expected: 0, run: 0 })).toContain("3 of 3 busy (+1 deploy or preview)")
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

describe("a build's expected time", () => {
  it("follows how many derivations it would build against how many the step usually builds, never above its usual time", () => {
    const usual = minutes(50)
    // infra's m1 for a one-file change builds 6 derivations; its last builds, after flake updates, 300.
    expect(sized(usual, 6, 300)).toBe(minutes(1))
    expect(sized(usual, 900, 300)).toBe(usual)
    expect(sized(usual, 0, 300)).toBe(0)
    expect(sized(usual, null, 300)).toBe(usual)
    expect(sized(usual, 6, undefined)).toBe(usual)
  })

  it("reads the count from nix-store's dry run", () => {
    expect(toBuild("these 12 derivations will be built:\n  /nix/store/a.drv\nthese 3 paths will be fetched (1 MiB download):\n")).toBe(12)
    expect(toBuild("this derivation will be built:\n  /nix/store/a.drv\n")).toBe(1)
    expect(toBuild("this path will be fetched (74.2 KiB download, 273.0 KiB unpacked):\n  /nix/store/b\n")).toBe(0)
    expect(toBuild("")).toBe(null)
  })
})
