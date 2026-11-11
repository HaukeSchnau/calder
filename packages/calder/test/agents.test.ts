import { describe, expect, it } from "@effect/vitest"
import { type Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Agents from "../src/controller/Agents.ts"
import type { AgentOrder } from "../src/Protocol.ts"

const auth = { token: "secret", name: "mac-a" }

/** Lets forked fibers and streams catch up. */
const ticks = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const connect = (
  agents: Agents.Agents["Service"],
  { running = [], compatibility = 1, name = "mac-a", slots = 1, platform = "aarch64-darwin", evaluator = false }: {
    evaluator?: boolean
    running?: ReadonlyArray<string>
    compatibility?: number
    name?: string
    slots?: number
    platform?: string
  } = {},
) =>
  Effect.gen(function*() {
    const orders: Array<AgentOrder> = []
    const fiber = yield* agents.connect({ ...auth, name }, { platform, slots, running, build: "b1", compatibility, evaluator }).pipe(
      Stream.runForEach((order) => Effect.sync(() => orders.push(order))),
      Effect.forkChild,
    )
    yield* ticks
    return { orders, fiber }
  })

/** The tower, which sleeps while idle; `wake` stands for its wake command, and counts its runs. */
const sleeping = (wake: Effect.Effect<unknown, { readonly message: string }>) => {
  const woken = { count: 0 }
  const tower = { name: "tower", platform: "x86_64-linux", wake: Effect.suspend(() => (woken.count++, wake)) }
  return { agents: Agents.make("secret", 1, [tower]), woken }
}

/** A job that waits for an x86_64-linux agent, with what it was told it waits for and its log. */
const waitFor = (agents: Agents.Agents["Service"], id: string, platform = "x86_64-linux") =>
  Effect.gen(function*() {
    const reasons: Array<string> = []
    const log: Array<string> = []
    const fiber = yield* Effect.forkChild(agents.run({ id, token: `t${id}` }, platform, {
      onWaiting: (reason) => Effect.sync(() => void reasons.push(reason)),
      onLog: (text) => Effect.sync(() => void log.push(text)),
    }))
    yield* ticks
    return { reasons, log, fiber }
  })

const waking = "an agent of x86_64-linux to take it; waking tower"

/** Moves the test clock and lets what that woke run, such as a wake's own fiber. */
const later = (duration: Duration.Input) => TestClock.adjust(duration).pipe(Effect.andThen(ticks))

describe("Agents", () => {
  it.effect("a job waits for an agent of its platform with a free slot", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const first = yield* Effect.forkChild(agents.run({ id: "a", token: "ta" }, "aarch64-darwin"))
      const second = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin"))
      yield* ticks
      const mac = yield* connect(agents)
      expect(mac.orders).toEqual([{ _tag: "Start", job: "a", token: "ta" }])

      yield* agents.exited(auth, "a", 0)
      expect(yield* Fiber.join(first)).toBe(0)
      yield* ticks
      expect(mac.orders.at(-1)).toEqual({ _tag: "Start", job: "b", token: "tb" })

      yield* agents.stop("b")
      yield* ticks
      expect(mac.orders.at(-1)).toEqual({ _tag: "Stop", job: "b" })
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
      expect(agents.usage()).toEqual([{ name: "mac-a", platform: "aarch64-darwin", slots: 1, running: 1, connected: true, build: "b1", compatibility: 1, current: true, evaluator: false }])

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
      const mac = yield* connect(agents, { running: ["old"], slots: 2 })
      expect(mac.orders).toEqual([{ _tag: "Stop", job: "old" }])
      expect(agents.usage()[0]?.running).toBe(1)

      yield* agents.exited(auth, "old", 143)
      yield* ticks
      expect(mac.orders.at(-1)).toEqual({ _tag: "Start", job: "new", token: "tn" })
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
      const mac = yield* connect(agents)
      yield* agents.offer(auth, 0)
      const offloaded = yield* agents.run({ id: "a", token: "ta" }, "aarch64-darwin", { wait: false })
      expect(offloaded).toBe(-2)

      const waiting = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin"))
      yield* ticks
      expect(mac.orders).toEqual([])
      yield* agents.offer(auth, 2)
      yield* ticks
      expect(mac.orders).toEqual([{ _tag: "Start", job: "b", token: "tb" }])
      expect(agents.usage()[0]).toMatchObject({ slots: 2, running: 1 })
      yield* agents.exited(auth, "b", 0)
      expect(yield* Fiber.join(waiting)).toBe(0)
    }))

  it.effect("a job starts once an agent takes it, and an offloaded job no agent takes never does", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      const started: Array<string> = []
      const onPlaced = (job: string) => () => Effect.sync(() => void started.push(job))
      expect(yield* agents.run({ id: "a", token: "ta" }, "aarch64-darwin", { wait: false, onPlaced: onPlaced("a") })).toBe(-2)

      const waiting = yield* Effect.forkChild(agents.run({ id: "b", token: "tb" }, "aarch64-darwin", { onPlaced: onPlaced("b") }))
      yield* ticks
      expect(started).toEqual([])
      yield* connect(agents)
      expect(started).toEqual(["b"])
      yield* agents.exited(auth, "b", 0)
      expect(yield* Fiber.join(waiting)).toBe(0)
    }))

  it.effect("waiting jobs wake a sleeping agent's host at most once per two minutes, and a failed wake keeps them waiting", () =>
    Effect.gen(function*() {
      const { agents, woken } = sleeping(Effect.fail({ message: "systemctl start calder-wake@tower.service exited with 1: Job failed.\nSee the journal." }))
      const failed = "an agent of x86_64-linux to take it; waking tower failed: systemctl start calder-wake@tower.service exited with 1: Job failed."
      const a = yield* waitFor(agents, "a")
      expect(woken.count).toBe(1)
      expect(a.log).toEqual(["waking tower", "waking tower failed: systemctl start calder-wake@tower.service exited with 1: Job failed."])
      expect(a.reasons).toEqual(["an agent of x86_64-linux to take it", waking, failed])

      const b = yield* waitFor(agents, "b")
      expect(b.reasons).toEqual([failed])
      yield* later("105 seconds")
      expect(woken.count).toBe(1)
      yield* later("15 seconds")
      expect(woken.count).toBe(2)
      expect(b.reasons.slice(-2)).toEqual([waking, failed])

      const tower = yield* connect(agents, { name: "tower", platform: "x86_64-linux", slots: 2 })
      expect(tower.orders).toEqual([{ _tag: "Start", job: "a", token: "ta" }, { _tag: "Start", job: "b", token: "tb" }])
      expect(a.log.at(-1)).toBe("tower connected after 0 s")
    }))

  it.effect("only a job that no connected agent of its platform takes wakes that platform's sleepers", () =>
    Effect.gen(function*() {
      const { agents, woken } = sleeping(Effect.void)
      expect(yield* agents.run({ id: "offloaded", token: "to" }, "x86_64-linux", { wait: false })).toBe(-2)
      yield* connect(agents, { name: "srv-x", platform: "x86_64-linux" })
      const a = yield* waitFor(agents, "a")
      expect(a.reasons).toEqual([])
      yield* waitFor(agents, "mac", "aarch64-darwin")
      yield* later("5 minutes")
      expect(woken.count).toBe(0)

      const b = yield* waitFor(agents, "b")
      expect(woken.count).toBe(1)
      expect(b.reasons.at(-1)).toBe(waking)
    }))

  it.effect("a woken agent says how long it took to connect, and takes the waiting jobs", () =>
    Effect.gen(function*() {
      const { agents, woken } = sleeping(Effect.void)
      const a = yield* waitFor(agents, "a")
      yield* later("40 seconds")
      const tower = yield* connect(agents, { name: "tower", platform: "x86_64-linux" })
      expect(a.log).toEqual(["waking tower", "tower connected after 40 s"])
      expect(tower.orders).toEqual([{ _tag: "Start", job: "a", token: "ta" }])

      yield* Fiber.interrupt(tower.fiber)
      yield* agents.exited({ ...auth, name: "tower" }, "a", 0)
      expect(yield* Fiber.join(a.fiber)).toBe(0)
      // Within two minutes of the last wake the host isn't woken again; the job checks every 15 s.
      yield* waitFor(agents, "b")
      yield* later("75 seconds")
      expect(woken.count).toBe(1)
      yield* later("15 seconds")
      expect(woken.count).toBe(2)
    }))

  it.effect("a wake whose agent doesn't connect in time keeps the job waiting and is tried again", () =>
    Effect.gen(function*() {
      const { agents, woken } = sleeping(Effect.never)
      const a = yield* waitFor(agents, "a")
      yield* later("179 seconds")
      expect(woken.count).toBe(1)
      expect(a.reasons.at(-1)).toBe(waking)
      yield* later("16 seconds")
      expect(a.log).toEqual(["waking tower", "tower didn't connect within 3 minutes of waking it", "waking tower"])
      expect(woken.count).toBe(2)
      expect(a.reasons.at(-1)).toBe(waking)
    }))

  it.effect("an evaluator agent takes evaluation jobs of any platform and no tasks, and other agents no evaluations", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      // dev-hauke's evaluator, x86_64-linux too, offers no slot yet.
      const dev = yield* connect(agents, { name: "dev-hauke", platform: "x86_64-linux", slots: 0, evaluator: true })
      const reasons: Array<string> = []
      const task = yield* Effect.forkChild(agents.run({ id: "task", token: "tt" }, "x86_64-linux"))
      const evaluation = yield* Effect.forkChild(
        agents.run({ id: "eval", token: "te" }, "aarch64-linux", { evaluation: true, onWaiting: (r) => Effect.sync(() => void reasons.push(r)) }),
      )
      yield* ticks
      expect(reasons).toEqual(["an evaluator agent to take it"])
      // An x86_64-linux agent that isn't an evaluator takes the task, never the evaluation.
      const tower = yield* connect(agents, { name: "tower", platform: "x86_64-linux", slots: 2 })
      expect(tower.orders).toEqual([{ _tag: "Start", job: "task", token: "tt" }])
      // The evaluator takes the evaluation once it has a slot, and no task.
      yield* agents.offer({ ...auth, name: "dev-hauke" }, 2)
      yield* ticks
      expect(dev.orders).toEqual([{ _tag: "Start", job: "eval", token: "te" }])
      const another = yield* Effect.forkChild(agents.run({ id: "task2", token: "t2" }, "x86_64-linux"))
      yield* ticks
      expect(dev.orders).toHaveLength(1)
      expect(tower.orders.at(-1)).toEqual({ _tag: "Start", job: "task2", token: "t2" })
      expect(agents.usage().find((a) => a.name === "dev-hauke")?.evaluator).toBe(true)

      yield* agents.exited({ ...auth, name: "dev-hauke" }, "eval", 0)
      yield* agents.exited({ ...auth, name: "tower" }, "task", 0)
      yield* agents.exited({ ...auth, name: "tower" }, "task2", 0)
      expect([yield* Fiber.join(task), yield* Fiber.join(evaluation), yield* Fiber.join(another)]).toEqual([0, 0, 0])
    }))

  it.effect("an evaluation no evaluator agent takes within its time, or once the last one left, gives up", () =>
    Effect.gen(function*() {
      const agents = Agents.make("secret", 1)
      // With no evaluator connected it doesn't wait at all.
      expect(yield* agents.run({ id: "none", token: "t" }, "aarch64-linux", { evaluation: true, within: "2 minutes" })).toBe(-2)

      // A busy evaluator: the job waits for its slot, at most two minutes.
      const dev = yield* connect(agents, { name: "dev-hauke", platform: "x86_64-linux", evaluator: true })
      const busy = yield* Effect.forkChild(agents.run({ id: "busy", token: "tb" }, "aarch64-linux", { evaluation: true }))
      yield* ticks
      const waiting = yield* Effect.forkChild(agents.run({ id: "late", token: "tl" }, "aarch64-linux", { evaluation: true, within: "2 minutes" }))
      yield* ticks
      yield* TestClock.adjust("119 seconds")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(waiting)).toBe(-2)

      // The last evaluator leaving ends the wait at once.
      const left = yield* Effect.forkChild(agents.run({ id: "left", token: "tx" }, "aarch64-linux", { evaluation: true, within: "2 minutes" }))
      yield* ticks
      yield* Fiber.interrupt(dev.fiber)
      yield* ticks
      expect(yield* Fiber.join(left)).toBe(-2)
      expect(dev.orders.map((o) => o._tag === "Start" ? o.job : o._tag)).toEqual(["busy"])
      yield* Fiber.interrupt(busy)
    }))

  it.effect("agents need the secret", () =>
    Effect.gen(function*() {
      const refused = yield* Agents.make("secret").connect({ token: "wrong", name: "mac-a" }, { platform: "aarch64-darwin", slots: 1, running: [], build: "b1", compatibility: 1 }).pipe(
        Stream.runDrain,
        Effect.flip,
      )
      expect(refused._tag).toBe("Unauthorized")
    }))
})
