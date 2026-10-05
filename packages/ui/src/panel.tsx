// The docked panel under the graph. One selected step drives every tab: its log lines, its span in
// the run's trace, its metrics and history, its failing tests and its value or error.

import type { Domain } from "@kiln/api"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { BarChart, LineChart } from "./charts.tsx"
import { Kiln } from "./client.ts"
import { LOG_PAGE, earlierLogs, isActive, isTerminal, logsAtom, metricsAtom, traceAtom } from "./data.ts"
import { bytes, clockS, dur, spanDur, stepDuration } from "./format.ts"
import { Check, Fail, Kbd, Loaded, Ring, useNow } from "./ui.tsx"

export type Tab = "logs" | "trace" | "metrics" | "tests" | "value"
export const TABS: ReadonlyArray<Tab> = ["logs", "trace", "metrics", "tests", "value"]

const tabLabel = (tab: Tab, step: Domain.StepRun | null) =>
  tab === "value" ? (step?.error ? "Error" : "Value") : tab[0]?.toUpperCase() + tab.slice(1)

interface Props {
  readonly detail: Domain.RunDetail
  readonly step: Domain.StepRun | null
  readonly tab: Tab
  readonly onTab: (tab: Tab) => void
  readonly onSelect: (name: string) => void
  readonly onClose: () => void
}

export function Panel({ detail, step, tab, onTab, onSelect, onClose }: Props) {
  const failing = step ? detail.failingTests.filter((t) => t.step === step.name).length : 0
  return (
    <section className="panel" aria-label="Observability">
      <div className="phead">
        <div className="ptabs" role="tablist">
          {TABS.map((t, i) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
              {tabLabel(t, step)}
              {t === "tests" && failing ? <span className="n bad">{failing}</span> : null}
              <Kbd>{i + 1}</Kbd>
            </button>
          ))}
        </div>
        <span className="pscope">{detail.run.project} #{detail.run.number}{step ? `, ${step.name}` : ""}</span>
        <button type="button" className="pclose" onClick={onClose} title="Hide the panel"><Kbd>⌘J</Kbd></button>
      </div>
      {step === null ? <p className="empty">This run has no steps.</p> : (
        <>
          {tab === "logs" && <LogsTab key={`${detail.run.id}|${step.name}`} detail={detail} step={step} onSelect={onSelect} />}
          {tab === "trace" && <TraceTab key={detail.run.id} detail={detail} step={step} onSelect={onSelect} />}
          {tab === "metrics" && <MetricsTab key={`${detail.run.id}|${step.name}`} detail={detail} step={step} />}
          {tab === "tests" && <TestsTab detail={detail} step={step} onSelect={onSelect} />}
          {tab === "value" && <ValueTab step={step} />}
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */

type Level = Domain.LogLine["level"]
type LogStream = Domain.LogLine["stream"]

// Filters outlive a step switch, like an editor panel's.
const memory: { scope: "step" | "run"; levels: Record<Level, boolean>; streams: Record<LogStream, boolean> } = {
  scope: "step",
  levels: { error: true, warn: true, info: true, debug: false },
  streams: { stdout: true, stderr: true, kiln: true },
}

const LEVELS: ReadonlyArray<Level> = ["error", "warn", "info", "debug"]
const STREAMS: ReadonlyArray<LogStream> = ["stdout", "stderr", "kiln"]

function LogsTab({ detail, step, onSelect }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun; readonly onSelect: (name: string) => void }) {
  const [scope, setScope] = useState(memory.scope)
  const changeScope = (s: "step" | "run") => {
    memory.scope = s
    setScope(s)
  }
  // Decided once per view: a stream that follows ends by itself when the step finishes.
  const follow = scope === "step" ? !isTerminal(step.status) : isActive(detail.run.status)
  return <LogsView key={scope} detail={detail} step={step} scope={scope} follow={follow} onScope={changeScope} onSelect={onSelect} />
}

function LogsView({ detail, step, scope, follow, onScope, onSelect }: {
  readonly detail: Domain.RunDetail
  readonly step: Domain.StepRun
  readonly scope: "step" | "run"
  readonly follow: boolean
  readonly onScope: (s: "step" | "run") => void
  readonly onSelect: (name: string) => void
}) {
  const [followKey] = useState(follow)
  const result = useAtomValue(logsAtom({ runId: detail.run.id, step: scope === "step" ? step.name : null, follow: followKey }))
  const [levels, setLevels] = useState(memory.levels)
  const [streams, setStreams] = useState(memory.streams)
  const [query, setQuery] = useState("")
  const [stick, setStick] = useState(true)
  const latest = AsyncResult.isSuccess(result) ? result.value : AsyncResult.isFailure(result) && result.previousSuccess._tag === "Some" ? result.previousSuccess.value.value : []
  const [earlier, setEarlier] = useState<ReadonlyArray<Domain.LogEntry>>([])
  const [paging, setPaging] = useState(false)
  const fetchEarlier = useAtomSet(earlierLogs, { mode: "promiseExit" })
  const lines = useMemo(() => (earlier.length ? [...earlier, ...latest] : latest), [earlier, latest])
  const oldest = lines[0]
  const streaming = followKey && AsyncResult.isWaiting(result)
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => lines.filter((l) => levels[l.level] && streams[l.stream] && (!q || l.text.toLowerCase().includes(q))),
    [lines, levels, streams, q],
  )
  const origin = (scope === "step" ? step.startedAt ?? step.queuedAt : detail.run.startedAt) ?? lines[0]?.timestamp ?? 0
  const sharded = scope === "step" && step.shards !== null

  const body = useRef<HTMLDivElement>(null)
  const jumped = useRef(false)
  // The scroll height before earlier lines went in on top, so the view stays on the same line.
  const anchor = useRef<number | null>(null)
  const loadEarlier = async () => {
    if (!oldest || paging) return
    setPaging(true)
    const exit = await fetchEarlier({ runId: detail.run.id, step: scope === "step" ? step.name : null, before: oldest.index })
    setPaging(false)
    if (exit._tag !== "Success") return
    anchor.current = body.current?.scrollHeight ?? null
    setEarlier((e) => [...exit.value, ...e])
  }
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    if (anchor.current !== null) {
      el.scrollTop += el.scrollHeight - anchor.current
      anchor.current = null
    } else if (followKey && stick) {
      el.scrollTop = el.scrollHeight
    } else if (!jumped.current && lines.length) {
      jumped.current = true
      const err = el.querySelector<HTMLElement>(".ll.lv-error")
      el.scrollTop = err ? Math.max(0, err.offsetTop - 60) : followKey ? el.scrollHeight : 0
    }
  }, [shown.length, followKey, stick, lines.length])

  const toggle = <K extends string>(set: (f: (r: Record<K, boolean>) => Record<K, boolean>) => void, key: K, save: (r: Record<K, boolean>) => void) =>
    set((r) => {
      const next = { ...r, [key]: !r[key] }
      save(next)
      return next
    })
  const count = (level: Level) => lines.filter((l) => l.level === level).length

  return (
    <>
      <div className="ptool">
        <span className="seg" role="group" aria-label="Log scope">
          <button type="button" className={scope === "step" ? "on" : ""} onClick={() => onScope("step")}>{step.name}</button>
          <button type="button" className={scope === "run" ? "on" : ""} onClick={() => onScope("run")}>All steps</button>
        </span>
        <span className="lvs">
          {LEVELS.map((l) => (
            <button key={l} type="button" className={`lvtog lv-${l}${levels[l] ? " on" : ""}`} aria-pressed={levels[l]} onClick={() => toggle(setLevels, l, (r) => { memory.levels = r })}>
              {l}<span className="n">{count(l)}</span>
            </button>
          ))}
        </span>
        <span className="lvs">
          {STREAMS.map((s) => (
            <button key={s} type="button" className={`lvtog${streams[s] ? " on" : ""}`} aria-pressed={streams[s]} onClick={() => toggle(setStreams, s, (r) => { memory.streams = r })}>{s}</button>
          ))}
        </span>
        <span className="grow" />
        {followKey && (
          <button type="button" className={`tog${stick ? " on" : ""}`} aria-pressed={stick} onClick={() => setStick(!stick)}>
            {streaming ? <span className="live-dot" /> : null}Follow
          </button>
        )}
        <label className="search">
          <input id="logq" type="search" placeholder="Filter lines" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoComplete="off" />
          <Kbd>/</Kbd>
        </label>
      </div>
      <div
        className="pbody"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget
          const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
          if (followKey && atEnd !== stick) setStick(atEnd)
        }}
      >
        {AsyncResult.isFailure(result) && !lines.length ? <Loaded result={result} what="log lines">{() => null}</Loaded> : null}
        <div className={`loglist${scope === "run" ? " run" : ""}${sharded ? " sharded" : ""}`}>
          {oldest && oldest.index > 0 ? (
            <button type="button" className="ll-more" onClick={loadEarlier} disabled={paging}>
              {paging ? "Loading earlier lines" : "Load earlier lines"}<span className="dim">{oldest.index} before these, {LOG_PAGE} at a time</span>
            </button>
          ) : earlier.length ? <p className="ll-more dim">Start of the log</p> : null}
          {shown.map((l, i) => (
            <div key={i} className={`ll lv-${l.level} st-${l.stream}${scope === "run" && l.step === step.name ? " cur" : ""}`}>
              <span className="lt">{offset(l.timestamp - origin)}</span>
              {scope === "run" && <button type="button" className="ls step-link" onClick={() => onSelect(l.step)}>{l.step}</button>}
              {sharded && <span className="lsh">{l.shard === null ? "" : `s${l.shard}`}</span>}
              <span className="lv">{l.level === "error" ? "err" : l.level === "warn" ? "wrn" : l.level === "debug" ? "dbg" : "inf"}</span>
              <span className="lm">{mark(l.text, q)}</span>
            </div>
          ))}
          {streaming && stick && (
            <div className="ll caret"><span className="lt" />{scope === "run" && <span className="ls" />}{sharded && <span />}<span className="lv" /><span className="lm"><i className="cursor" /></span></div>
          )}
          {!shown.length && (AsyncResult.isSuccess(result) || AsyncResult.isInitial(result)) && (
            <p className="empty">{
              AsyncResult.isInitial(result) ? "Loading log lines"
              : lines.length ? `No lines match${q ? ` "${query.trim()}"` : " these filters"}.`
              : followKey ? (step.status === "pending" || step.status === "queued" ? `Waiting for ${step.name} to start.` : "Waiting for output.")
              : step.status === "reused" ? "Reused: nothing ran." : "No log lines."
            }</p>
          )}
        </div>
      </div>
    </>
  )
}

const offset = (ms: number) => {
  const t = Math.max(0, ms) / 1000
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`
}

function mark(text: string, q: string): ReactNode {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return text
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

/* ------------------------------------------------------------------ */
/* Trace                                                               */

function TraceTab({ detail, step, onSelect }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun; readonly onSelect: (name: string) => void }) {
  const [live] = useState(() => isActive(detail.run.status))
  const result = useAtomValue(traceAtom({ runId: detail.run.id, live }))
  if (detail.run.traceId === null && !AsyncResult.isSuccess(result)) return <p className="empty">This run has no trace.</p>
  return (
    <Loaded result={result} what="the trace">
      {(spans) => spans.length ? <Waterfall spans={spans} step={step} live={isActive(detail.run.status)} onSelect={onSelect} /> : <p className="empty">The trace has no spans yet.</p>}
    </Loaded>
  )
}

type SpanKind = "run" | "build" | "task" | "action" | "nix" | "http" | "detail"

function spanKind(s: Domain.Span): SpanKind {
  if (s.parentId === null) return "run"
  const kind = s.attributes["kiln.kind"]
  if (kind === "build" || kind === "task" || kind === "action") return kind
  if (s.attributes["http.status"] !== undefined) return "http"
  if (s.attributes["nix.activity"] !== undefined) return "nix"
  return "detail"
}

export interface Ordered {
  readonly span: Domain.Span
  readonly depth: number
}

/** Depth first, children by start time, so every span sits under its parent. */
export function orderSpans(spans: ReadonlyArray<Domain.Span>, root?: string): Array<Ordered> {
  const ids = new Set(spans.map((s) => s.spanId))
  const kids = new Map<string | null, Array<Domain.Span>>()
  for (const s of spans) {
    const parent = s.parentId !== null && ids.has(s.parentId) ? s.parentId : null
    kids.set(parent, [...(kids.get(parent) ?? []), s])
  }
  const out: Array<Ordered> = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of (kids.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      out.push({ span: s, depth })
      walk(s.spanId, depth + 1)
    }
  }
  if (root !== undefined) {
    const top = spans.find((s) => s.spanId === root)
    if (top) {
      out.push({ span: top, depth: 0 })
      walk(root, 1)
    }
    return out
  }
  walk(null, 0)
  return out
}

const stepSpanOf = (spans: ReadonlyArray<Domain.Span>, step: Domain.StepRun) =>
  spans.find((s) => s.spanId === step.spanId) ?? spans.find((s) => s.attributes["kiln.step"] === step.name)

export function Waterfall({ spans, step, live, onSelect, root, compact = false }: {
  readonly spans: ReadonlyArray<Domain.Span>
  readonly step: Domain.StepRun | null
  readonly live: boolean
  readonly onSelect?: (name: string) => void
  readonly root?: string
  readonly compact?: boolean
}) {
  const ordered = useMemo(() => orderSpans(spans, root), [spans, root])
  const own = step ? stepSpanOf(spans, step) : undefined
  const [picked, setPicked] = useState<string | null>(null)
  const selected = ordered.find((o) => o.span.spanId === picked)?.span ?? own ?? ordered[0]?.span
  const inside = useMemo(() => {
    const set = new Set<string>()
    if (!own) return set
    const parents = new Map(spans.map((s) => [s.spanId, s.parentId]))
    for (const s of spans) {
      for (let p = parents.get(s.spanId) ?? null; p !== null; p = parents.get(p) ?? null) {
        if (p === own.spanId) set.add(s.spanId)
      }
    }
    return set
  }, [spans, own])
  const t0 = Math.min(...ordered.map((o) => o.span.start))
  const t1 = Math.max(...ordered.map((o) => o.span.end), t0 + 1)
  const total = t1 - t0
  const stepOf = (s: Domain.Span): string | undefined => {
    const byId = new Map(spans.map((x) => [x.spanId, x]))
    for (let cur: Domain.Span | undefined = s; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      const name = cur.attributes["kiln.step"]
      if (name !== undefined) return name
    }
    return undefined
  }

  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = body.current?.querySelector<HTMLElement>(".tr.on")
    if (row && body.current) body.current.scrollTop = Math.max(0, row.offsetTop - 70)
  }, [own?.spanId])

  const ticks = niceTicks(total)
  const rootSpan = ordered[0]?.span
  return (
    <>
      {!compact && (
        <div className="ptool">
          <span className="ptitle">{spans.length} spans, {spanDur(total)}{live ? " so far" : ""}</span>
          <span className="grow" />
          <span className="tlegend"><i className="lg k-build" />build <i className="lg k-task" />task <i className="lg k-action" />action <i className="lg k-nix" />nix <i className="lg k-http" />http</span>
        </div>
      )}
      <div className={`pbody trace${compact ? " compact" : ""}`} ref={body}>
        <div className="twf">
          <div className="taxis">
            <span className="tn" />
            <span className="tb">{ticks.map((t) => <span key={t} className="tk" style={{ left: `${(t / total) * 100}%` }}>{axisLabel(t)}</span>)}</span>
            <span className="td" />
          </div>
          {ordered.map(({ span, depth }) => {
            const kind = spanKind(span)
            const open = live && span.status === "unset" && t1 - span.end < 1500
            const cls = [
              "tr", `k-${kind}`,
              span.status === "error" ? "failed" : "",
              open ? "open" : "",
              span.attributes["kiln.status"] === "reused" ? "reused" : "",
              own && span.spanId === own.spanId ? "on" : inside.has(span.spanId) ? "in" : "",
              selected && span.spanId === selected.spanId ? "sel" : "",
            ].join(" ")
            const tag = span.attributes["http.status"] ? `http ${span.attributes["http.status"]}` : span.attributes["nix.activity"] ?? (span.attributes["kiln.status"] === "reused" ? "reused" : "")
            return (
              <div key={span.spanId} className={cls} onClick={() => {
                setPicked(span.spanId)
                const name = stepOf(span)
                if (name && onSelect) onSelect(name)
              }}>
                <span className="tn" style={{ paddingLeft: depth * 14 + 10 }}><span className="tnm">{span.name}</span><span className="tk2">{tag}</span></span>
                <span className="tb"><i style={{ left: `${((span.start - t0) / total) * 100}%`, width: `${Math.max(0.25, ((span.end - span.start) / total) * 100)}%` }} /></span>
                <span className="td">{spanDur(span.end - span.start)}{open ? "+" : ""}</span>
              </div>
            )
          })}
        </div>
        {selected && !compact && (
          <div className="tdetail">
            <p className="tdh">{selected.name}</p>
            <dl className="kv">
              <dt>start</dt><dd>{clockS(selected.start)}, +{spanDur(selected.start - (rootSpan?.start ?? t0))}</dd>
              <dt>duration</dt><dd>{spanDur(selected.end - selected.start)}{live && selected.status === "unset" ? ", open" : ""}</dd>
              <dt>status</dt><dd className={selected.status === "error" ? "bad" : ""}>{selected.status}</dd>
              {Object.entries(selected.attributes).map(([k, v]) => <Attr key={k} k={k} v={v} />)}
            </dl>
          </div>
        )}
      </div>
    </>
  )
}

const Attr = ({ k, v }: { readonly k: string; readonly v: string }) => <><dt className="mono">{k}</dt><dd className="mono">{v}</dd></>

function niceTicks(total: number): Array<number> {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000]
  const step = steps.find((s) => total / s <= 7) ?? 7_200_000
  const out: Array<number> = []
  for (let t = 0; t <= total; t += step) out.push(t)
  return out
}

const axisLabel = (ms: number) => (ms === 0 ? "0" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${ms / 1000}s` : `${Math.floor(ms / 60_000)}m${ms % 60_000 ? `${Math.round((ms % 60_000) / 1000)}s` : ""}`)

/* ------------------------------------------------------------------ */
/* Metrics                                                             */

function MetricsTab({ detail, step }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun }) {
  const stats = useAtomValue(Kiln.query("stepStats", { project: detail.run.project, step: step.name }))
  return (
    <div className="pbody">
      <div className="metrics">
        <Loaded result={stats} what="step history">{(s) => <HistoryCards stats={s} step={step} runId={detail.run.id} />}</Loaded>
        {step.startedAt !== null ? <ResourceCards runId={detail.run.id} step={step} /> : (
          <section className="metric note">
            <p className="mh"><span>CPU and memory</span></p>
            <p className="dim">{step.status === "reused" ? "Reused: nothing ran, so there is nothing to measure." : step.status === "blocked" || step.status === "cancelled" ? "It never started." : "Samples start when a slot picks it up."}</p>
          </section>
        )}
      </div>
    </div>
  )
}

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}
const p95 = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0
}

function Metric({ title, value, sub, children }: { readonly title: string; readonly value: ReactNode; readonly sub: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="metric">
      <p className="mh"><span>{title}</span><span className="mval">{value}</span></p>
      <p className="msub">{sub}</p>
      {children}
    </section>
  )
}

function HistoryCards({ stats, step, runId }: { readonly stats: Domain.StepStats; readonly step: Domain.StepRun; readonly runId: string }) {
  const now = useNow()
  const [hover, setHover] = useState<number | null>(null)
  const [hoverQ, setHoverQ] = useState<number | null>(null)
  const samples = [...stats.samples]
  const live = step.status === "running" && !samples.some((s) => s.runId === runId)
  const durations = samples.flatMap((s) => (s.durationMs === null ? [] : [s.durationMs]))
  const reused = samples.filter((s) => s.reused).length
  const bars = samples.map((s) => ({ value: s.durationMs, cls: s.runId === runId ? `cur s-${s.status}` : s.reused ? "reused" : s.status === "failed" || s.status === "died" ? "failed" : "" }))
  if (live) bars.push({ value: stepDuration(step, now), cls: "cur s-running" })
  const queues = samples.map((s) => ({ value: s.queueMs, cls: s.runId === runId ? "cur" : "" }))
  const own = stepDuration(step, now)
  const shown = hover !== null ? bars[hover]?.value ?? null : own
  const ownQueue = step.queuedAt !== null && step.startedAt !== null ? step.startedAt - step.queuedAt : null
  const queueValues = samples.flatMap((s) => (s.queueMs === null ? [] : [s.queueMs]))
  if (!samples.length && !live) {
    return <section className="metric note"><p className="mh"><span>Duration</span></p><p className="dim">No earlier runs of {step.name} in {stats.project}.</p></section>
  }
  return (
    <>
      <Metric
        title="Duration"
        value={hover !== null ? (shown === null ? "reused" : dur(shown)) : step.status === "reused" ? "reused" : own === null ? "" : <span className={step.status === "running" ? "heat" : step.status === "failed" ? "bad" : ""}>{dur(own)}{step.status === "running" ? " so far" : ""}</span>}
        sub={`last ${samples.length} runs, p50 ${dur(median(durations))}, p95 ${dur(p95(durations))}, ${reused} reused`}
      >
        <BarChart bars={bars} baseline={median(durations)} fmt={(v) => dur(v)} xLabels={[`${samples.length} runs ago`, "this"]} onHover={setHover} />
      </Metric>
      <Metric
        title="Queue wait"
        value={hoverQ !== null ? spanDur(queues[hoverQ]?.value ?? 0) : ownQueue === null ? "" : spanDur(ownQueue)}
        sub={`waiting for a slot, p50 ${spanDur(median(queueValues))}`}
      >
        <BarChart bars={queues} fmt={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}s` : `${Math.round(v)}`)} xLabels={[`${samples.length} runs ago`, "last"]} onHover={setHoverQ} />
      </Metric>
    </>
  )
}

function ResourceCards({ runId, step }: { readonly runId: string; readonly step: Domain.StepRun }) {
  const [live] = useState(() => step.status === "running")
  const result = useAtomValue(metricsAtom({ runId, step: step.name, live }))
  const [hover, setHover] = useState<number | null>(null)
  const [hoverM, setHoverM] = useState<number | null>(null)
  return (
    <Loaded result={result} what="metrics">
      {({ samples }) => {
        if (!samples.length) {
          return <section className="metric note"><p className="mh"><span>CPU and memory</span></p><p className="dim">No samples kept for this step.{step.cpuSeconds !== null ? ` It used ${step.cpuSeconds.toFixed(1)} CPU seconds` : ""}{step.memoryPeakBytes !== null ? `, peak ${bytes(step.memoryPeakBytes)}.` : ""}</p></section>
        }
        const cpu = samples.map((s) => s.cpuPercent / 100)
        const mem = samples.map((s) => s.memoryBytes)
        const cls = step.status === "running" ? "heat" : ""
        const span = (samples.at(-1)?.timestamp ?? 0) - (samples[0]?.timestamp ?? 0)
        const at = (i: number | null) => (i === null ? "" : ` at +${dur((samples[i]?.timestamp ?? 0) - (samples[0]?.timestamp ?? 0))}`)
        return (
          <>
            <Metric title="CPU" value={`${(cpu[hover ?? cpu.length - 1] ?? 0).toFixed(1)} cores${at(hover)}`} sub={`peak ${Math.max(...cpu).toFixed(1)}${step.cpuSeconds !== null ? `, ${step.cpuSeconds.toFixed(0)} CPU seconds` : ""}, every 2 s`}>
              <LineChart values={cpu} cls={cls} fmt={(v) => v.toFixed(1)} xLabels={["0:00", dur(span)]} onHover={setHover} />
            </Metric>
            <Metric title="Memory" value={`${bytes(mem[hoverM ?? mem.length - 1] ?? 0)}${at(hoverM)}`} sub={`peak ${bytes(step.memoryPeakBytes ?? Math.max(...mem))}`}>
              <LineChart values={mem} cls={cls} fmt={(v) => (v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(1)}G` : `${Math.round(v / 2 ** 20)}M`)} xLabels={["0:00", dur(span)]} onHover={setHoverM} />
            </Metric>
          </>
        )
      }}
    </Loaded>
  )
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */

export const testOrder = (a: Domain.TestResult, b: Domain.TestResult) => Number(a.flaky) - Number(b.flaky) || Number(a.status === "timeout") - Number(b.status === "timeout")

function TestsTab({ detail, step, onSelect }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun; readonly onSelect: (name: string) => void }) {
  const failing = detail.failingTests.filter((t) => t.step === step.name).sort(testOrder)
  const elsewhere = [...new Set(detail.failingTests.filter((t) => t.step !== step.name).map((t) => t.step))]
  const [open, setOpen] = useState<string | null>(failing[0] ? `${failing[0].suite}›${failing[0].name}` : null)
  const t = step.tests
  return (
    <>
      <div className="ptool">
        <span className="ptitle">{step.name}</span>
        {t ? <span className="dim">{t.passed} passed, <span className={t.failed ? "bad" : ""}>{t.failed} failed</span>, {t.skipped} skipped</span> : <span className="dim">{step.status === "running" ? "running, results come when it finishes" : "no test report"}</span>}
        <span className="grow" />
        {elsewhere.length ? <span className="dim">failing tests in {elsewhere.map((n, i) => <span key={n}>{i ? ", " : ""}<button type="button" className="lnk" onClick={() => onSelect(n)}>{n}</button></span>)}</span> : null}
      </div>
      <div className="pbody">
        {failing.length ? (
          <div className="tests">
            <div className="thead"><span /><span>Failing test</span><span>File</span><span className="tms">Time</span><span>Last 20 runs, oldest first</span></div>
            {failing.map((test) => {
              const id = `${test.suite}›${test.name}`
              return (
                <div key={id} className={`trow failing${open === id ? " open" : ""}`} onClick={() => setOpen(open === id ? null : id)}>
                  <span className="tg">{test.status === "timeout" ? <Ring p={1} /> : <Fail />}</span>
                  <span className="tname">{test.suite} › {test.name}{test.flaky ? <span className="flaky" data-tip="Passed and failed with the same key in recent runs">flaky</span> : null}{test.status === "timeout" ? <span className="dim"> timed out</span> : null}</span>
                  <span className="tfile">{test.file ?? ""}</span>
                  <span className="tms">{spanDur(test.durationMs)}</span>
                  <TestHistory project={detail.run.project} test={test} />
                  {open === id && test.message ? <pre className="tmsg">{test.message}</pre> : null}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="empty">{t ? `No failing tests in ${step.name}.` : `${step.name} reported no tests.`}</p>
        )}
      </div>
    </>
  )
}

export function TestHistory({ project, test }: { readonly project: string; readonly test: Domain.TestResult }) {
  const result = useAtomValue(Kiln.query("testHistory", { project, suite: test.suite, name: test.name }))
  if (!AsyncResult.isSuccess(result)) return <span className="thist" />
  const runs = result.value.slice(-20)
  return (
    <span className="thist" aria-label={`last ${runs.length} runs`}>
      {runs.map((r) => <i key={r.runId} className={`h-${r.status}${r.runId === test.runId ? " this" : ""}`} data-tip={`${r.status}, ${spanDur(r.durationMs)}`} />)}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Value or error                                                      */

function ValueTab({ step }: { readonly step: Domain.StepRun }) {
  if (step.error) {
    return (
      <div className="pbody vbody">
        <p className="vhead"><Fail /><b className="bad">{step.error.tag}</b><span>{step.error.message}</span></p>
        {step.error.excerpt ? <pre className="excerpt">{step.error.excerpt}</pre> : null}
      </div>
    )
  }
  const v = step.value
  if (!v) {
    return <div className="pbody"><p className="empty">{isTerminal(step.status) ? `${step.name} produced no value.` : `No value until ${step.name} passes.`}</p></div>
  }
  return (
    <div className="pbody vbody">
      <p className="vhead"><Check /><b>{v.label ?? "value"}</b>{v.type ? <code className="dim">{v.type}</code> : null}</p>
      <p className="vtext">{v.render === "link" ? <a className="lnk" href={v.text} target="_blank" rel="noreferrer">{v.text}</a> : <code>{v.text}</code>}</p>
      {v.json !== null && v.json !== undefined ? <pre className="excerpt">{JSON.stringify(v.json, null, 2)}</pre> : null}
    </div>
  )
}
