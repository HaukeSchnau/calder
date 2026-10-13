import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Telemetry from "../src/controller/Telemetry.ts"
import { config } from "./config.ts"

/** A collector that answers with `statuses` in turn, then with 200. */
const collector = (statuses: Array<number>) => {
  const answered: Array<number> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const status = statuses.shift() ?? 200
      answered.push(status)
      return HttpClientResponse.fromWeb(request, new Response(null, { status }))
    })
  )
  return { answered, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const warnings: Array<string> = []
const capture = Logger.layer([Logger.make((log) => {
  if (log.logLevel === "Warn") warnings.push(String(log.message))
})])

const record = (text: string): Telemetry.LogRecord => ({
  parent: { traceId: "t", spanId: "s" },
  timestamp: 0,
  text,
  level: "info",
  attributes: {},
})

const logTwice = (statuses: Array<number>) =>
  Effect.gen(function*() {
    warnings.length = 0
    const otlp = collector(statuses)
    yield* Effect.gen(function*() {
      const telemetry = yield* Telemetry.Telemetry
      yield* telemetry.log(record("one"))
      yield* telemetry.log(record("two"))
      yield* TestClock.adjust("15 minutes")
    }).pipe(
      Effect.provide(Telemetry.layer.pipe(
        Layer.provide([config({ telemetry: { otlp: "http://otlp.test", victoriaLogs: null, tempo: null } }), otlp.layer]),
      )),
      Effect.provide(capture),
    )
    return otlp.answered
  })

describe("Telemetry", () => {
  it.effect("retries a batch until the collector takes it", () =>
    Effect.gen(function*() {
      expect(yield* logTwice([503, 503, 503])).toEqual([503, 503, 503, 200])
      expect(warnings).toEqual([])
    }))

  it.effect("drops a batch with a warning once the collector stayed down for ten minutes", () =>
    Effect.gen(function*() {
      const answered = yield* logTwice(Array.from({ length: 100 }, () => 503))
      expect(answered.length).toBeGreaterThan(5)
      expect(answered.length).toBeLessThan(30)
      expect(warnings).toEqual([expect.stringContaining("dropped 2 log records")])
    }))

  it.effect("drops a batch the collector refused without retrying it", () =>
    Effect.gen(function*() {
      expect(yield* logTwice([400])).toEqual([400])
      expect(warnings).toEqual([expect.stringContaining("dropped 2 log records")])
    }))
})
