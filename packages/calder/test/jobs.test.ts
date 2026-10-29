import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { startUnit } from "../src/controller/Jobs.ts"

const timedOut = {
  exitCode: 1,
  stderr: "Job for calder-job-pr@0a1b.service failed because a timeout was exceeded.\nSee \"systemctl status calder-job-pr@0a1b.service\" for details.\n",
}
const failed = { exitCode: 1, stderr: "Job for calder-job-pr@0a1b.service failed because the control process exited with error code.\n" }
const started = { exitCode: 0, stderr: "" }

interface Answer {
  readonly answer: { readonly exitCode: number; readonly stderr: string }
  /** The unit's `Result` after this start. */
  readonly unit: string
  /** How long this `systemctl start` takes. */
  readonly takes?: `${number} seconds`
}

/** `systemctl start` answering with `answers` in turn, and what the job's log said meanwhile. */
const starting = (answers: Array<Answer>) => {
  const logs: Array<string> = []
  let starts = 0
  let result = ""
  const start = Effect.gen(function*() {
    starts += 1
    const { answer, unit, takes } = answers.shift()!
    if (takes !== undefined) yield* Effect.sleep(takes)
    result = unit
    return answer
  })
  return { logs, starts: () => starts, run: startUnit(start, Effect.sync(() => result), (text) => Effect.sync(() => void logs.push(text))) }
}

const timeout = { answer: timedOut, unit: "timeout" } satisfies Answer
const reason = "a timeout was exceeded (result timeout, calder-job-pr@0a1b.service)"

describe("starting a worker's unit", () => {
  it.effect("starts it again after 15 s and 30 s when its start timed out, saying so", () =>
    Effect.gen(function*() {
      const { logs, starts, run } = starting([timeout, timeout, { answer: started, unit: "success" }])
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("14 seconds")
      expect(starts()).toBe(1)
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(fiber)).toBeUndefined()
      expect(starts()).toBe(3)
      expect(logs).toEqual([
        `the worker didn't start: ${reason}; starting it again in 15 s`,
        `the worker didn't start: ${reason}; starting it again in 30 s`,
      ])
    }))

  it.effect("gives up after four timeouts, the cause first", () =>
    Effect.gen(function*() {
      const { starts, run } = starting([timeout, timeout, timeout, timeout])
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust("2 minutes")
      expect(yield* Fiber.join(fiber)).toBe("a timeout was exceeded, tried 4 times (result timeout, calder-job-pr@0a1b.service)")
      expect(starts()).toBe(4)
    }))

  it.effect("doesn't start a unit again that failed otherwise, since it may have run", () =>
    Effect.gen(function*() {
      const { starts, run } = starting([{ answer: failed, unit: "exit-code" }, { answer: started, unit: "success" }])
      expect(yield* run).toBe("the control process exited with error code (result exit-code, calder-job-pr@0a1b.service)")
      expect(starts()).toBe(1)
    }))

  it.effect("stops waiting when the job is cancelled, also where the job itself may not be interrupted", () =>
    Effect.gen(function*() {
      const { starts, run } = starting([timeout, { answer: started, unit: "success" }])
      const fiber = yield* Effect.forkChild(Effect.uninterruptible(run))
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 minute")
      expect(starts()).toBe(1)
    }))

  it.effect("stops after a retry's start when the job was cancelled while the unit started", () =>
    Effect.gen(function*() {
      let ran = false
      const { starts, run } = starting([timeout, { answer: started, unit: "success", takes: "5 seconds" }])
      const fiber = yield* Effect.forkChild(Effect.uninterruptible(run.pipe(Effect.andThen(Effect.sync(() => void (ran = true))))))
      yield* TestClock.adjust("16 seconds")
      expect(starts()).toBe(2)
      const cancel = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(cancel)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(ran).toBe(false)
    }))
})
