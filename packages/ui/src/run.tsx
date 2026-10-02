// The run page: the Workbench. Navigator on the left, the run and its step graph in the middle with
// the observability panel docked under it, the selected step's inspector on the right. Failure
// comes first: a failed step is selected, and its error and failing tests show without a click.

import type { Domain } from "@kiln/api"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { isActive, isSibling, overviewAtom, runAtom } from "./data.ts"
import { useRunCommands } from "./commands.ts"
import { ago, bytes, clockS, count, dur, eventLine, refOf, runDuration, shortKey, shortSha, spanDur, stepDuration, titleOf, totalSteps } from "./format.ts"
import { Graph, GraphList, Legend, Meta } from "./graph.tsx"
import { layout, shapeKey } from "./layout.ts"
import { statusClass } from "./overview.tsx"
import { Panel, TABS, TestHistory, testOrder, type Tab } from "./panel.tsx"
import { go, href } from "./route.ts"
import { useKeys, usePhone } from "./keys.ts"
import { Fail, Kbd, Loaded, RunGlyph, StepMark, Swatch, hasBits, useNow } from "./ui.tsx"

const failedStatus = (s: Domain.StepStatus) => s === "failed" || s === "died"

/** Graph order: left to right, top to bottom, the order a person reads the canvas in. */
export function graphOrder(steps: ReadonlyArray<Domain.StepRun>): Array<Domain.StepRun> {
  const shape = layout(steps)
  const pos = (s: Domain.StepRun) => (shape.group?.members.includes(s.name) ? shape.group.box : shape.boxes.get(s.name))
  return [...steps].sort((a, b) => (pos(a)?.x ?? 0) - (pos(b)?.x ?? 0) || (shape.boxes.get(a.name)?.y ?? 0) - (shape.boxes.get(b.name)?.y ?? 0))
}

/** Failure first, then work in progress, then the deploy, then the first step. */
export function defaultStep(steps: ReadonlyArray<Domain.StepRun>): Domain.StepRun | undefined {
  const ordered = graphOrder(steps)
  return ordered.find((s) => failedStatus(s.status))
    ?? ordered.find((s) => s.status === "running")
    ?? ordered.find((s) => isDeployStep(s))
    ?? ordered.find((s) => s.target)
    ?? ordered[0]
}

/** The API has no deploy marker yet, so this reads the action's result type and name. */
export const isDeployStep = (s: Domain.StepRun) =>
  s.kind === "action" && ((s.value?.type ?? "").startsWith("@kiln/std/Release/") || /Release\.promote/.test(s.detail))

// The panel's tab and visibility outlive the run being looked at.
const prefs = { tab: "logs" as Tab, open: true, height: 270 }

export function RunPage({ id, step }: { readonly id: string; readonly step: string | null }) {
  const result = useAtomValue(runAtom(id))
  return (
    <>
      <Navigator current={id} />
      <Loaded result={result} what="this run">{(detail) => <RunView detail={detail} requested={step} />}</Loaded>
    </>
  )
}

function RunView({ detail, requested }: { readonly detail: Domain.RunDetail; readonly requested: string | null }) {
  const phone = usePhone()
  const steps = detail.steps
  const fallback = useMemo(() => defaultStep(steps), [shapeKey(steps), detail.run.id, steps.some((s) => failedStatus(s.status))])
  const selected = steps.find((s) => s.name === requested) ?? fallback ?? null
  const [tab, setTabState] = useState<Tab>(prefs.tab)
  const [open, setOpenState] = useState(prefs.open)
  const [height, setHeight] = useState(prefs.height)
  const setTab = (t: Tab) => {
    prefs.tab = t
    setTabState(t)
    setOpen(true)
  }
  const setOpen = (o: boolean) => {
    prefs.open = o
    setOpenState(o)
  }
  const select = (name: string) => go({ page: "run", id: detail.run.id, step: name }, { replace: true })
  const runLabel = useRunLabels(detail)
  const ordered = graphOrder(steps)

  useKeys((e) => {
    const k = e.key
    if (k >= "1" && k <= "5") return setTab(TABS[Number(k) - 1] ?? "logs")
    if ((k === "]" || k === "[") && selected) {
      const i = ordered.findIndex((s) => s.name === selected.name)
      const next = ordered[(i + (k === "]" ? 1 : -1) + ordered.length) % ordered.length]
      if (next) select(next.name)
      return
    }
    if (k === "x") {
      const failed = ordered.find((s) => failedStatus(s.status))
      if (failed) select(failed.name)
      return
    }
    if (k === "/") {
      e.preventDefault()
      setTab("logs")
      requestAnimationFrame(() => document.getElementById("logq")?.focus())
      return
    }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "j") {
      e.preventDefault()
      setOpen(!prefs.open)
    }
  }, { withModifiers: true })

  return (
    <>
      <main className="editor" style={{ "--panel-h": `${height}px` } as React.CSSProperties} data-panel={open ? "open" : "closed"}>
        <div className="doc">
          <div className="chg">
            <RunHeader detail={detail} />
            <FailureBlock detail={detail} step={selected} onSelect={select} onTab={setTab} runLabel={runLabel} />
            <section className="canvas" aria-label="Step graph">
              {steps.length === 0 ? <p className="empty">{detail.run.status === "planning" ? "Planning: the steps appear once the plan is known." : "No steps."}</p>
                : phone ? <GraphList steps={steps} selected={selected?.name ?? null} onSelect={select} runLabel={runLabel} />
                : <Graph steps={steps} selected={selected?.name ?? null} onSelect={select} runLabel={runLabel} />}
              {steps.length > 0 && !phone ? <Legend /> : null}
            </section>
          </div>
        </div>
        {open ? (
          <>
            <Resizer onResize={(h) => { prefs.height = h; setHeight(h) }} />
            <Panel detail={detail} step={selected} tab={tab} onTab={setTab} onSelect={select} onClose={() => setOpen(false)} />
          </>
        ) : (
          <button type="button" className="panel-off" onClick={() => setOpen(true)}>Show logs, trace, metrics and tests <Kbd>⌘J</Kbd></button>
        )}
      </main>
      <aside className="inspector" aria-label="Inspector">
        {selected ? <Inspector detail={detail} step={selected} onSelect={select} onTab={setTab} runLabel={runLabel} /> : null}
      </aside>
    </>
  )
}

function Resizer({ onResize }: { readonly onResize: (height: number) => void }) {
  return (
    <div
      className="presize"
      aria-hidden="true"
      onPointerDown={(e) => {
        const handle = e.currentTarget
        handle.setPointerCapture(e.pointerId)
        const editor = handle.closest(".editor")
        if (!editor) return
        const move = (ev: PointerEvent) => {
          const rect = editor.getBoundingClientRect()
          onResize(Math.round(Math.max(150, Math.min(rect.height - 160, rect.bottom - ev.clientY))))
        }
        const up = () => {
          handle.removeEventListener("pointermove", move)
          handle.removeEventListener("pointerup", up)
        }
        handle.addEventListener("pointermove", move)
        handle.addEventListener("pointerup", up)
      }}
    />
  )
}

/** "#612" for every run the page has heard of: siblings, and the overview's recent runs. */
function useRunLabels(detail: Domain.RunDetail) {
  const ov = useAtomValue(overviewAtom)
  const known = new Map<string, Domain.Run>()
  if (AsyncResult.isSuccess(ov)) for (const r of [...ov.value.recent, ...ov.value.active]) known.set(r.id, r)
  for (const r of detail.siblings) known.set(r.id, r)
  known.set(detail.run.id, detail.run)
  return (id: string) => {
    const r = known.get(id)
    return r ? (r.project === detail.run.project ? `#${r.number}` : `${r.project} #${r.number}`) : null
  }
}

/* ------------------------------------------------------------------ */
/* Header                                                              */

function RunHeader({ detail }: { readonly detail: Domain.RunDetail }) {
  const now = useNow()
  const { run } = detail
  const d = runDuration(run, now)
  const total = totalSteps(run.counts)
  const finished = count(run.counts, "passed", "reused", "failed", "died", "blocked", "cancelled")
  const deploys = detail.steps.some(isDeployStep)
  const statusWord = run.status === "passed" ? `passed in ${dur(d ?? 0)}`
    : run.status === "failed" ? `failed after ${dur(d ?? 0)}`
    : run.status === "running" ? `running ${dur(d ?? 0)}`
    : run.status === "cancelled" ? `cancelled after ${dur(d ?? 0)}`
    : run.status === "errored" ? "errored before its steps ran"
    : run.status
  const versions = [detail.run, ...detail.siblings].sort((a, b) => b.number - a.number)
  return (
    <header className="chg-h">
      <div className="chg-t">
        <p className="kicker">
          <a href={href({ page: "project", name: run.project })}>{run.project}</a>
          <span>{refOf(run)}</span>
          {run.commit.changeId ? <span className="mono" data-tip={`jj change ${run.commit.changeId}`}>{run.commit.changeId.slice(0, 8)}</span> : null}
          <span className="mono">{shortSha(run.commit.sha)}</span>
        </p>
        <h1>{titleOf(run)}</h1>
        <p className="who">{run.commit.author}{run.title && run.title !== run.commit.title ? <>, commit <b>{run.commit.title}</b></> : null}, {eventLine(run.event)}{run.trust === "pr" ? ", untrusted" : ""}</p>
        <p className="runline">
          <span className="rstat"><RunGlyph run={run} /><b>#{run.number}</b> <span className={statusClass(run.status)}>{statusWord}</span></span>
          {total ? <span><b>{finished}</b> of {total} steps done{count(run.counts, "reused") ? `, ${count(run.counts, "reused")} reused` : ""}{count(run.counts, "running") ? <>, <span className="heat">{count(run.counts, "running")} running</span></> : null}</span> : null}
          <span>created {ago(run.createdAt, now)} ago</span>
        </p>
      </div>
      <div className="chg-r">
        <p className="chg-acts">
          {deploys ? <a className="btn" href={href({ page: "rollout", id: run.id })}>Rollout</a> : null}
          <RunActions run={run} />
        </p>
        {versions.length > 1 ? <Siblings runs={versions} current={run.id} /> : null}
      </div>
    </header>
  )
}

function RunActions({ run }: { readonly run: Domain.Run }) {
  const { cancel, rerun } = useRunCommands()
  return isActive(run.status)
    ? <button type="button" className="btn" onClick={() => cancel(run)}>Cancel</button>
    : <button type="button" className="btn" onClick={() => rerun(run)}>Rerun</button>
}

function Siblings({ runs, current }: { readonly runs: ReadonlyArray<Domain.Run>; readonly current: string }) {
  const now = useNow()
  return (
    <nav className="matrix" aria-label="Other runs of this change">
      {runs.slice(0, 7).map((r) => (
        <a key={r.id} className={`mrow${r.id === current ? " on" : ""}`} href={href({ page: "run", id: r.id, step: null })}>
          <RunGlyph run={r} />
          <span className="rn tnum">#{r.number}</span>
          <span className="mono">{shortSha(r.commit.sha)}</span>
          <span className={`mv ${statusClass(r.status)}`}>{r.status}</span>
          <span className="mw tnum">{runDuration(r, now) === null ? "" : dur(runDuration(r, now) ?? 0)}</span>
          <span className="na">{ago(r.createdAt, now)}</span>
        </a>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/* Failure                                                             */

function FailureBlock({ detail, step, onSelect, onTab, runLabel }: {
  readonly detail: Domain.RunDetail
  readonly step: Domain.StepRun | null
  readonly onSelect: (name: string) => void
  readonly onTab: (tab: Tab) => void
  readonly runLabel: (id: string) => string | null
}) {
  const { run } = detail
  if (run.status === "errored") {
    return (
      <section className="failure" aria-label="Failure">
        <p className="fl-head"><Fail /><b>Plan failed</b><span className="dim">no step ran</span></p>
        <pre className="excerpt">{run.error ?? "The run errored before its steps could run."}</pre>
      </section>
    )
  }
  const failed = graphOrder(detail.steps).filter((s) => failedStatus(s.status))
  const shown = step && failedStatus(step.status) ? step : failed[0]
  if (!shown || !shown.error) return null
  const tests = detail.failingTests.filter((t) => t.step === shown.name).sort(testOrder)
  const newer = detail.siblings.find((r) => r.number > run.number)
  const others = failed.filter((s) => s.name !== shown.name)
  return (
    <section className="failure" aria-label="Failure">
      <p className="fl-head">
        <Fail />
        <button type="button" className="lnk strong" onClick={() => onSelect(shown.name)}>{shown.name}</button>
        <span className="bad">{shown.error.tag}</span>
        <span className="fl-msg">{shown.error.message}</span>
        <span className="grow" />
        {others.length ? <span className="dim">also {others.map((s, i) => <span key={s.name}>{i ? ", " : ""}<button type="button" className="lnk" onClick={() => onSelect(s.name)}>{s.name}</button></span>)}</span> : null}
        <button type="button" className="btn" onClick={() => { onSelect(shown.name); onTab("logs") }}>Log lines <Kbd>1</Kbd></button>
        {tests.length ? <button type="button" className="btn" onClick={() => { onSelect(shown.name); onTab("tests") }}>Tests <Kbd>4</Kbd></button> : null}
        {newer ? <a className="lnk" href={href({ page: "run", id: newer.id, step: null })}>#{newer.number} {newer.status}</a> : null}
      </p>
      {tests.length ? (
        <div className="fl-tests">
          {tests.slice(0, 4).map((t) => (
            <div key={`${t.suite}›${t.name}`} className="fl-test">
              <span className="tg">{t.status === "timeout" ? <span className="heat">timeout</span> : <Fail />}</span>
              <span className="tname"><b>{t.suite} › {t.name}</b>{t.flaky ? <span className="flaky">flaky</span> : null}</span>
              <span className="tmsg1">{t.message?.split("\n")[0] ?? ""}</span>
              <TestHistory project={run.project} test={t} />
            </div>
          ))}
          {tests.length > 4 ? <p className="dim">{tests.length - 4} more in the tests tab</p> : null}
        </div>
      ) : null}
      {shown.error.excerpt ? <pre className="excerpt">{shown.error.excerpt}</pre> : null}
      {shown.attempts > 1 || shown.reusedFrom ? (
        <p className="fl-act dim">
          {shown.attempts > 1 ? <span>{shown.attempts} attempts</span> : null}
          {shown.reusedFrom ? <span>failed in {runLabel(shown.reusedFrom) ?? "an earlier run"}</span> : null}
        </p>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Inspector                                                           */

function Kv({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode] | null | false> }) {
  return (
    <dl className="kv">
      {rows.filter((r): r is readonly [string, ReactNode] => Boolean(r)).map(([k, v]) => <Row key={k} k={k} v={v} />)}
    </dl>
  )
}

const Row = ({ k, v }: { readonly k: string; readonly v: ReactNode }) => <><dt>{k}</dt><dd>{v}</dd></>

function Inspector({ detail, step, onSelect, onTab, runLabel }: {
  readonly detail: Domain.RunDetail
  readonly step: Domain.StepRun
  readonly onSelect: (name: string) => void
  readonly onTab: (tab: Tab) => void
  readonly runLabel: (id: string) => string | null
}) {
  const now = useNow()
  const byName = new Map(detail.steps.map((s) => [s.name, s]))
  const link = (name: string, extra?: ReactNode) => {
    const s = byName.get(name)
    return (
      <span key={name} className="inp">
        {s ? <Swatch k={s.key} solid={hasBits(s.status)} /> : null}
        <button type="button" className="lnk" onClick={() => onSelect(name)}>{name}</button>
        {s && !hasBits(s.status) ? <StepMark status={s.status} /> : null}
        {extra}
      </span>
    )
  }
  const neededBy = detail.steps.filter((s) => s.needs.includes(step.name) || s.after.includes(step.name) || s.exits.includes(step.name)).map((s) => s.name)
  const queue = step.queuedAt !== null && step.startedAt !== null ? step.startedAt - step.queuedAt : step.status === "queued" && step.queuedAt !== null ? now - step.queuedAt : null
  const d = stepDuration(step, now)
  return (
    <>
      <header className="ih">
        {hasBits(step.status) ? <Swatch k={step.key} /> : <StepMark status={step.status} />}
        <h2>{step.name}</h2>
        <span className="dim">{step.kind}{step.target ? ", target" : ""}</span>
      </header>
      <p className="icmd"><code>{step.detail}</code></p>
      <section className="isec">
        <h3>Result</h3>
        <Kv rows={[
          ["status", <Meta step={step} steps={detail.steps} runLabel={runLabel} />],
          ["key", step.key ? <><Swatch k={step.key} solid={hasBits(step.status)} /><code data-tip={step.key} data-key={step.key}>{shortKey(step.key)}</code></> : <span className="dim">not known yet</span>],
          step.reusedFrom !== null && ["from", <a className="lnk" href={href({ page: "run", id: step.reusedFrom, step: step.name })}>{runLabel(step.reusedFrom) ?? "the earlier run"}</a>],
          step.startedAt !== null && ["started", <span className="tnum">{clockS(step.startedAt)}</span>],
          d !== null && step.status !== "running" && ["took", <span className="tnum">{dur(d)}</span>],
          queue !== null && ["queue", <span className="tnum">{spanDur(queue)}</span>],
          step.attempts > 1 && ["attempts", <span className="heat">{step.attempts}</span>],
          step.shards !== null && ["shards", String(step.shards)],
          step.value !== null && [step.value.label ?? "value", step.value.render === "link" ? <a className="lnk" href={step.value.text} target="_blank" rel="noreferrer">{step.value.text}</a> : <code className="wrap">{step.value.text}</code>],
          step.error !== null && ["error", <span className="bad">{step.error.tag}</span>],
        ]} />
      </section>
      <section className="isec">
        <h3>Inputs</h3>
        {step.needs.length + step.after.length + step.exits.length === 0 ? <p className="dim">Only the source at {shortSha(detail.run.commit.sha)}.</p> : (
          <Kv rows={[
            step.needs.length > 0 && ["needs", <span className="inps">{step.needs.map((n) => link(n))}</span>],
            step.exits.length > 0 && ["reads", <span className="inps">{step.exits.map((n) => link(n))}</span>],
            step.after.length > 0 && ["after", <span className="inps">{step.after.map((n) => link(n, step.required.includes(n) ? <span className="req">required</span> : null))}</span>],
          ]} />
        )}
        {neededBy.length ? <Kv rows={[["used by", <span className="inps">{neededBy.map((n) => link(n))}</span>]]} /> : null}
      </section>
      <section className="isec">
        <h3>Resources</h3>
        {step.cpuSeconds !== null || step.memoryPeakBytes !== null ? (
          <Kv rows={[
            step.cpuSeconds !== null && ["cpu", <span className="tnum">{step.cpuSeconds.toFixed(1)} s</span>],
            step.memoryPeakBytes !== null && ["memory", <span className="tnum">{bytes(step.memoryPeakBytes)} peak</span>],
            step.tests !== null && ["tests", <span>{step.tests.passed} passed{step.tests.failed ? <>, <span className="bad">{step.tests.failed} failed</span></> : null}{step.tests.skipped ? `, ${step.tests.skipped} skipped` : ""}</span>],
          ]} />
        ) : <p className="dim">{step.status === "running" ? "Live in the metrics tab." : step.status === "reused" ? "Nothing ran." : "No process yet."}</p>}
      </section>
      <p className="iacts">
        <button type="button" className="btn" onClick={() => onTab("logs")}>Logs <Kbd>1</Kbd></button>
        <button type="button" className="btn" onClick={() => onTab("trace")}>Span <Kbd>2</Kbd></button>
        <button type="button" className="btn" onClick={() => onTab("metrics")}>Metrics <Kbd>3</Kbd></button>
      </p>
      <p className="ikeys dim"><Kbd>[</Kbd><Kbd>]</Kbd> previous, next step <Kbd>x</Kbd> failure</p>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Navigator                                                           */

/** Runs grouped by what they ran for: a branch, a pull request, a schedule. The group of the run on screen opens to its runs. */
function Navigator({ current }: { readonly current: string }) {
  const ov = useAtomValue(overviewAtom)
  const here = useAtomValue(runAtom(current))
  const now = useNow()
  const [filter, setFilter] = useState("")
  const list = useRef<HTMLDivElement>(null)
  const detail = AsyncResult.isSuccess(here) ? here.value : null
  const runs = [
    ...(AsyncResult.isSuccess(ov) ? [...ov.value.active, ...ov.value.recent] : []),
    ...(detail ? [detail.run, ...detail.siblings] : []),
  ]
  const unique = [...new Map(runs.map((r) => [r.id, r])).values()].sort((a, b) => b.createdAt - a.createdAt)
  const f = filter.trim().toLowerCase()
  const match = (r: Domain.Run) => !f || `${r.project} ${titleOf(r)} ${refOf(r)} #${r.number} ${r.commit.author}`.toLowerCase().includes(f)
  const projects = AsyncResult.isSuccess(ov) ? ov.value.projects.map((p) => p.name) : []
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".nr.cur")?.scrollIntoView({ block: "nearest" })
  }, [current])
  return (
    <nav className="navigator" aria-label="Navigator">
      <div className="navtabs"><span className="on">Runs</span></div>
      <div className="navbody" ref={list}>
        <a className="nr home" href="#/"><span className="ng" /><span className="nt">Overview</span><span className="na"><Kbd>Esc</Kbd></span></a>
        {projects.map((p) => {
          const groups = new Map<string, Array<Domain.Run>>()
          for (const r of unique) if (r.project === p && match(r)) groups.set(refOf(r), [...(groups.get(refOf(r)) ?? []), r])
          const shown = [...groups.values()].slice(0, f ? 12 : 4)
          if (!shown.length) return null
          return (
            <div key={p}>
              <a className="nh" href={href({ page: "project", name: p })}>{p}</a>
              {shown.map((group) => {
                const [head] = group
                if (!head) return null
                const open = group.some((r) => r.id === current)
                return (
                  <div key={refOf(head)}>
                    <a className={`nr${open && group.length === 1 ? " cur" : ""}`} href={href({ page: "run", id: head.id, step: null })}>
                      <span className="ng"><RunGlyph run={head} /></span>
                      <span className="nt">{titleOf(head)}</span>
                      <span className="nref">{refOf(head).replace("PR ", "")}</span>
                      <span className="na">{ago(head.createdAt, now)}</span>
                    </a>
                    {open && group.length > 1 ? group.slice(0, 6).map((r) => (
                      <a key={r.id} className={`nr rev${r.id === current ? " cur" : ""}`} href={href({ page: "run", id: r.id, step: null })}>
                        <span className="ng"><RunGlyph run={r} /></span>
                        <span className="nt"><span className="rn">#{r.number}</span><span className="mono dim">{shortSha(r.commit.sha)}</span></span>
                        <span className="na">{ago(r.createdAt, now)}</span>
                      </a>
                    )) : null}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <label className="navfilter"><input type="search" placeholder="Filter runs" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoComplete="off" /></label>
    </nav>
  )
}
