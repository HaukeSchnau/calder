import type { Domain } from "@kiln/api"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { dur, stepDuration } from "./format.ts"
import { GROUP, layout, shapeKey, type Box, type Layout } from "./layout.ts"
import { StepMark, Swatch, hasBits, useNow } from "./ui.tsx"

interface Props {
  readonly steps: ReadonlyArray<Domain.StepRun>
  readonly selected: string | null
  readonly onSelect: (name: string) => void
  /** "#612" for a run id the page knows about. */
  readonly runLabel: (id: string) => string | null
}

const done = (s: Domain.StepStatus | undefined) => s === "passed" || s === "reused"

function groupStatus(steps: ReadonlyArray<Domain.StepRun>): Domain.StepStatus {
  if (steps.some((s) => s.status === "failed" || s.status === "died")) return "failed"
  if (steps.some((s) => s.status === "running")) return "running"
  if (steps.every((s) => done(s.status))) return "passed"
  return "pending"
}

/** The short line under a step: how long, or why not. */
export function Meta({ step, steps, runLabel, short = false }: { readonly step: Domain.StepRun; readonly steps: ReadonlyArray<Domain.StepRun>; readonly runLabel: Props["runLabel"]; readonly short?: boolean }) {
  const now = useNow()
  const d = stepDuration(step, now)
  switch (step.status) {
    case "running":
      return <span className="heat">{short ? "" : "running "}{dur(d ?? 0)}</span>
    case "queued":
      return <span className="dim">queued{short ? "" : ` ${dur(now - (step.queuedAt ?? now))}`}</span>
    case "pending": {
      if (short) return <span className="dim">pending</span>
      const wait = [...step.needs, ...step.after, ...step.exits].find((n) => !done(steps.find((s) => s.name === n)?.status))
      return <span className="dim">{wait ? `waits for ${wait}` : "pending"}</span>
    }
    case "passed":
      return <span>{dur(d ?? 0)}</span>
    case "reused": {
      const from = step.reusedFrom ? runLabel(step.reusedFrom) : null
      return <span className="dim">{short || !from ? "reused" : `reused from ${from}`}</span>
    }
    case "failed":
      return <span className="bad">{short ? "" : "failed after "}{dur(d ?? 0)}</span>
    case "died":
      return <span className="bad">died{short ? "" : ` after ${dur(d ?? 0)}`}</span>
    case "blocked": {
      if (short) return <span className="dim">blocked</span>
      const by = [...step.needs, ...step.after].find((n) => { const s = steps.find((x) => x.name === n); return s && !done(s.status) })
      return <span className="dim">{by ? `blocked by ${by}` : "blocked"}</span>
    }
    case "cancelled":
      return <span className="dim">cancelled</span>
  }
}

export function Graph({ steps, selected, onSelect, runLabel }: Props) {
  const key = shapeKey(steps)
  // Positions depend only on the graph's shape, not on statuses.
  const shape: Layout = useMemo(() => layout(steps), [key])
  const byName = new Map(steps.map((s) => [s.name, s]))
  const members = shape.group?.members.map((m) => byName.get(m)).filter((s): s is Domain.StepRun => s !== undefined) ?? []
  const statusOf = (node: string) => (node === GROUP ? groupStatus(members) : byName.get(node)?.status)
  const selectedPort = selected && shape.group?.members.includes(selected) ? GROUP : selected

  const frame = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const observer = new ResizeObserver(() => setAvail(el.clientWidth))
    observer.observe(el)
    setAvail(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  const pad = 2
  const W = shape.width + pad * 2
  const H = shape.height + pad * 2
  const scale = avail > 0 ? Math.max(0.72, Math.min(1, avail / W)) : 1

  const now = useNow()
  const longest = Math.max(30_000, ...members.map((s) => stepDuration(s, now) ?? 0))

  return (
    <div ref={frame} className="graph-frame">
      <div className="graph" style={{ width: W, height: H, transform: scale < 1 ? `scale(${scale})` : undefined, marginBottom: scale < 1 ? -(1 - scale) * H : undefined }}>
        <svg className="edges" width={W} height={H} aria-hidden="true">
          <defs>
            <marker id="exit-end" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7">
              <circle cx="4" cy="4" r="2.6" />
            </marker>
          </defs>
          <g transform={`translate(${pad} ${pad})`}>
            {[...shape.edges].sort((a, b) => Number(a.kind === "needs" || a.kind === "exit") - Number(b.kind === "needs" || b.kind === "exit")).map((e) => {
              const from = statusOf(e.from)
              const to = statusOf(e.to)
              const state = to === "blocked" || to === "cancelled" ? "off" : to === "running" && done(from) ? "live" : !done(from) && from !== "running" ? "pending" : ""
              const hot = selectedPort !== null && (e.from === selectedPort || e.to === selectedPort)
              return <path key={`${e.from}>${e.to}:${e.kind}`} className={`${e.kind} ${state}${hot ? " hot" : ""}`} d={e.d} markerEnd={e.kind === "exit" ? "url(#exit-end)" : undefined} />
            })}
          </g>
        </svg>
        <div className="nodes" style={{ left: pad, top: pad }}>
          {shape.group && (
            <div className={`gg s-${groupStatus(members)}`} style={boxStyle(shape.group.box)}>
              <span className="gh">
                <span>Required checks</span>
                <GroupSummary steps={members} />
              </span>
              {members.map((s, i) => (
                <button key={s.name} type="button" className={`gr s-${s.status}${selected === s.name ? " sel" : ""}`} style={{ top: 30 + i * 28 }} onClick={() => onSelect(s.name)} data-step={s.name}>
                  <Swatch k={s.key} solid={hasBits(s.status)} />
                  <span className="nm">{s.name}{s.shards ? <span className="shards">×{s.shards}</span> : null}{s.attempts > 1 ? <span className="shards">retried</span> : null}</span>
                  <Track step={s} max={longest} now={now} />
                  <span className="mt"><Meta step={s} steps={steps} runLabel={runLabel} short /></span>
                  <span className="mk"><StepMark status={s.status} /></span>
                </button>
              ))}
            </div>
          )}
          {steps.filter((s) => !shape.group?.members.includes(s.name)).map((s) => {
            const box = shape.boxes.get(s.name)
            if (!box) return null
            return (
              <button key={s.name} type="button" className={`gn s-${s.status} k-${s.kind}${selected === s.name ? " sel" : ""}`} style={boxStyle(box)} onClick={() => onSelect(s.name)} data-step={s.name}>
                <span className="head">
                  <Swatch k={s.key} solid={hasBits(s.status)} />
                  <span className="nm">{s.name}{s.shards ? <span className="shards">×{s.shards}</span> : null}</span>
                  <StepMark status={s.status} />
                </span>
                <span className="sub"><Meta step={s} steps={steps} runLabel={runLabel} /></span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const boxStyle = (b: Box) => ({ left: b.x, top: b.y, width: b.w, height: b.h })

function GroupSummary({ steps }: { readonly steps: ReadonlyArray<Domain.StepRun> }) {
  const failed = steps.filter((s) => s.status === "failed" || s.status === "died").length
  if (failed) return <span className="mt bad">{failed} failed</span>
  return <span className="mt">{steps.filter((s) => done(s.status)).length} of {steps.length}</span>
}

function Track({ step, max, now }: { readonly step: Domain.StepRun; readonly max: number; readonly now: number }) {
  const d = stepDuration(step, now)
  const cls = step.status === "running" ? "run" : step.status === "failed" || step.status === "died" ? "failed" : ""
  return (
    <span className="trk" aria-hidden="true">
      {d !== null && step.status !== "reused" ? <i className={cls} style={{ width: `${Math.min(100, (d / max) * 100).toFixed(1)}%` }} /> : null}
    </span>
  )
}

/** Narrow screens: the same steps as a list in graph order, the required checks kept together. */
export function GraphList({ steps, selected, onSelect, runLabel }: Props) {
  const shape = useMemo(() => layout(steps), [shapeKey(steps)])
  const ordered = [...steps].sort((a, b) => {
    const pa = shape.group?.members.includes(a.name) ? shape.group.box : shape.boxes.get(a.name)
    const pb = shape.group?.members.includes(b.name) ? shape.group.box : shape.boxes.get(b.name)
    return (pa?.x ?? 0) - (pb?.x ?? 0) || (pa?.y ?? 0) - (pb?.y ?? 0) || (shape.boxes.get(a.name)?.y ?? 0) - (shape.boxes.get(b.name)?.y ?? 0)
  })
  const members = new Set(shape.group?.members ?? [])
  const rows: Array<React.ReactNode> = []
  let groupDone = false
  for (const s of ordered) {
    if (members.has(s.name)) {
      if (groupDone) continue
      groupDone = true
      const list = ordered.filter((x) => members.has(x.name))
      rows.push(
        <div key={GROUP} className="gl-group">
          <span className="gh"><span>Required checks</span><GroupSummary steps={list} /></span>
          {list.map((m) => <ListRow key={m.name} step={m} steps={steps} selected={selected} onSelect={onSelect} runLabel={runLabel} />)}
        </div>,
      )
      continue
    }
    rows.push(<ListRow key={s.name} step={s} steps={steps} selected={selected} onSelect={onSelect} runLabel={runLabel} />)
  }
  return <div className="graph-list">{rows}</div>
}

function ListRow({ step, steps, selected, onSelect, runLabel }: { readonly step: Domain.StepRun } & Props) {
  return (
    <button type="button" className={`gr s-${step.status}${selected === step.name ? " sel" : ""}`} onClick={() => onSelect(step.name)}>
      <Swatch k={step.key} solid={hasBits(step.status)} />
      <span className="nm">{step.name}{step.shards ? <span className="shards">×{step.shards}</span> : null}</span>
      <span className="mt"><Meta step={step} steps={steps} runLabel={runLabel} /></span>
      <span className="mk"><StepMark status={step.status} /></span>
    </button>
  )
}

export function Legend() {
  return (
    <p className="legend">
      <span><svg width="22" height="6"><path d="M0 3H22" className="lg-needs" /></svg>needs a value</span>
      <span><svg width="22" height="6"><path d="M0 3H22" className="lg-after" /></svg>runs after</span>
      <span><svg width="22" height="6"><path d="M0 3H22" className="lg-required" /></svg>required check</span>
      <span><svg width="22" height="6"><path d="M0 3H18" className="lg-exit" /><circle cx="19" cy="3" r="2.4" className="lg-exit-end" /></svg>reads the outcome</span>
      <span><i className="sw" style={{ "--g": "#8fc1a9" }} /><i className="sw" style={{ "--g": "#86a8e7" }} />glaze: same colour, same inputs</span>
    </p>
  )
}
