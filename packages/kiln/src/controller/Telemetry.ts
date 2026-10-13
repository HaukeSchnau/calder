import type { Domain } from "@kiln/api"
import { Cause, Context, Effect, Exit, Layer, Schedule } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { randomBytes } from "node:crypto"
import { Config } from "./Config.ts"

export interface Parent {
  readonly traceId: string
  readonly spanId: string
}

export interface SpanData {
  readonly traceId: string
  readonly spanId: string
  readonly parentId: string | null
  readonly name: string
  readonly start: number
  readonly end: number
  readonly error: boolean
  readonly attributes: Record<string, string>
}

export interface LogRecord {
  readonly parent: Parent
  readonly timestamp: number
  readonly text: string
  readonly level: Domain.LogLine["level"]
  readonly attributes: Record<string, string>
}

export const traceId = () => randomBytes(16).toString("hex")
export const spanId = () => randomBytes(8).toString("hex")

/**
 * Kiln's runs, steps, Nix builds and deploy calls as OTLP spans, and step output as OTLP logs, sent to
 * the host's collector. History is read back from Tempo and VictoriaLogs, which keep the only copy.
 */
export class Telemetry extends Context.Service<Telemetry, {
  readonly exportSpan: (span: SpanData) => Effect.Effect<void>
  readonly log: (record: LogRecord) => Effect.Effect<void>
  /** Runs an effect as a child span of `parent`. */
  readonly span: <A, E, R>(parent: Parent, name: string, attributes: Record<string, string>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly logs: (query: { readonly run: string; readonly step?: string }) => Effect.Effect<ReadonlyArray<Domain.LogLine>>
  readonly trace: (traceId: string) => Effect.Effect<ReadonlyArray<Domain.Span>>
}>()("kiln/controller/Telemetry") {}

const attrs = (record: Record<string, string>) => Object.entries(record).map(([key, value]) => ({ key, value: { stringValue: value } }))
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`
const severity = { debug: 5, info: 9, warn: 13, error: 17 } as const

/**
 * Retries an export for up to ten minutes, so a collector restart loses nothing; the UI holds a step's
 * output for fifteen minutes before it reads it back from VictoriaLogs.
 */
const retrying = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(Schedule.upTo({ duration: "10 minutes" }))

/** The collector answered that it won't take the batch, which no retry changes. */
const refused = (e: HttpClientError.HttpClientError | Cause.TimeoutError) => {
  if (e._tag !== "HttpClientError" || e.reason._tag !== "StatusCodeError") return false
  const { status } = e.reason.response
  return status >= 400 && status < 500 && status !== 429
}

export const layer = Layer.effect(Telemetry)(Effect.gen(function*() {
  const config = yield* Config
  const client = yield* HttpClient.HttpClient
  const resource = { attributes: attrs({ "service.name": "kiln", "service.namespace": "ci", "host.name": process.env.HOSTNAME ?? "srv-2" }) }
  let spans: Array<SpanData> = []
  let logs: Array<LogRecord> = []

  const collector = client.pipe(HttpClient.filterStatusOk)
  /** Sends a batch, retrying on `schedule` unless the collector refused it, and says what it drops. */
  const post = (path: string, body: unknown, what: string, schedule: Schedule.Schedule<unknown, unknown>) =>
    config.telemetry.otlp === null
      ? Effect.void
      : collector.execute(HttpClientRequest.post(`${config.telemetry.otlp}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
        Effect.timeout("10 seconds"),
        Effect.retry({ schedule, while: (e) => !refused(e) }),
        Effect.asVoid,
        Effect.catch((e) => Effect.logWarning(`dropped ${what}: the OTLP export failed`, e)),
      )

  const flush = (schedule: Schedule.Schedule<unknown, unknown>) => Effect.suspend(() => {
    const s = spans
    const l = logs
    spans = []
    logs = []
    return Effect.all([
      s.length === 0 ? Effect.void : post("/v1/traces", {
        resourceSpans: [{
          resource,
          scopeSpans: [{
            scope: { name: "kiln" },
            spans: s.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentId === null ? {} : { parentSpanId: span.parentId }),
              name: span.name,
              kind: 1,
              startTimeUnixNano: nanos(span.start),
              endTimeUnixNano: nanos(span.end),
              attributes: attrs(span.attributes),
              status: { code: span.error ? 2 : 1 },
            })),
          }],
        }],
      }, `${s.length} spans`, schedule),
      l.length === 0 ? Effect.void : post("/v1/logs", {
        resourceLogs: [{
          resource,
          scopeLogs: [{
            scope: { name: "kiln" },
            logRecords: l.map((r) => ({
              timeUnixNano: nanos(r.timestamp),
              severityNumber: severity[r.level],
              severityText: r.level.toUpperCase(),
              body: { stringValue: r.text },
              attributes: attrs(r.attributes),
              traceId: r.parent.traceId,
              spanId: r.parent.spanId,
            })),
          }],
        }],
      }, `${l.length} log records`, schedule),
    ], { concurrency: 2, discard: true })
  })
  // Batches wait while one is retried, so they arrive in order.
  yield* flush(retrying).pipe(Effect.delay("2 seconds"), Effect.forever, Effect.forkScoped)
  yield* Effect.addFinalizer(() => flush(Schedule.recurs(0)))

  const exportSpan = (span: SpanData) => Effect.sync(() => void spans.push(span))

  const logs_: Telemetry["Service"]["logs"] = (query) =>
    config.telemetry.victoriaLogs === null ? Effect.succeed([]) : Effect.gen(function*() {
      const filter = [`"kiln.run":=${JSON.stringify(query.run)}`, ...(query.step === undefined ? [] : [`"kiln.step":=${JSON.stringify(query.step)}`])]
      const response = yield* client.execute(
        HttpClientRequest.post(`${config.telemetry.victoriaLogs}/select/logsql/query`).pipe(
          HttpClientRequest.bodyUrlParams({ query: `${filter.join(" ")} | sort by (_time)`, limit: "50000" }),
        ),
      )
      const text = yield* response.text
      return text.split("\n").filter(Boolean).map((line): Domain.LogLine => {
        const row = JSON.parse(line) as Record<string, string>
        const shard = row["kiln.shard"]
        return {
          step: row["kiln.step"] ?? "",
          shard: shard === undefined || shard === "" ? null : Number(shard),
          stream: (row["kiln.stream"] as Domain.LogLine["stream"] | undefined) ?? "stdout",
          level: ((row.severity ?? row.level ?? "info").toLowerCase() as Domain.LogLine["level"]),
          timestamp: Date.parse(row._time ?? "") || 0,
          text: row._msg ?? "",
        }
      })
    }).pipe(Effect.timeout("15 seconds"), Effect.orElseSucceed(() => []))

  const trace: Telemetry["Service"]["trace"] = (id) =>
    config.telemetry.tempo === null ? Effect.succeed([]) : Effect.gen(function*() {
      const response = yield* client.get(`${config.telemetry.tempo}/api/traces/${id}`, { headers: { Accept: "application/json" } })
      if (response.status !== 200) return []
      const json = (yield* response.json) as {
        batches?: ReadonlyArray<OtlpResourceSpans>
        trace?: { resourceSpans?: ReadonlyArray<OtlpResourceSpans> }
        resourceSpans?: ReadonlyArray<OtlpResourceSpans>
      }
      const batches = json.batches ?? json.trace?.resourceSpans ?? json.resourceSpans ?? []
      return batches.flatMap((b) =>
        (b.scopeSpans ?? b.instrumentationLibrarySpans ?? []).flatMap((s) =>
          (s.spans ?? []).map((span): Domain.Span => ({
            spanId: hex(span.spanId),
            parentId: span.parentSpanId ? hex(span.parentSpanId) : null,
            name: span.name ?? "",
            start: Number(BigInt(span.startTimeUnixNano ?? "0") / 1_000_000n),
            end: Number(BigInt(span.endTimeUnixNano ?? "0") / 1_000_000n),
            status: span.status?.code === 2 || span.status?.code === "STATUS_CODE_ERROR" ? "error" : span.status?.code ? "ok" : "unset",
            attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, String(Object.values(a.value ?? {})[0] ?? "")])),
          }))
        )
      ).sort((a, b) => a.start - b.start)
    }).pipe(Effect.timeout("15 seconds"), Effect.orElseSucceed(() => []))

  return {
    exportSpan,
    log: (record) => Effect.sync(() => void logs.push(record)),
    span: (parent, name, attributes, effect) =>
      Effect.gen(function*() {
        const start = Date.now()
        const exit = yield* Effect.exit(effect)
        yield* exportSpan({
          traceId: parent.traceId,
          spanId: spanId(),
          parentId: parent.spanId,
          name,
          start,
          end: Date.now(),
          error: Exit.isFailure(exit),
          attributes,
        })
        return yield* exit
      }),
    logs: logs_,
    trace,
  }
}))

interface OtlpResourceSpans {
  readonly scopeSpans?: ReadonlyArray<OtlpScopeSpans>
  readonly instrumentationLibrarySpans?: ReadonlyArray<OtlpScopeSpans>
}
interface OtlpScopeSpans {
  readonly spans?: ReadonlyArray<{
    readonly spanId: string
    readonly parentSpanId?: string
    readonly name?: string
    readonly startTimeUnixNano?: string
    readonly endTimeUnixNano?: string
    readonly status?: { readonly code?: number | string }
    readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value?: Record<string, unknown> }>
  }>
}

/** Tempo returns ids as base64 in some versions and hex in others. */
const hex = (id: string) => (/^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : Buffer.from(id, "base64").toString("hex"))
