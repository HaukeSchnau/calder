// The page behind every rollout: per host what ran before, what this run deploys and what is live
// now, then the deploy step's own trace and log. Only what deployments and the step report; no
// invented bake metrics.

import type { Domain } from "@kiln/api"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useLayoutEffect, useRef, useState } from "react"
import { isActive, isTerminal, logsAtom, overviewAtom, runAtom, traceAtom } from "./data.ts"
import { ago, clock, clockS, dur, eventLine, shortSha, stepDuration, titleOf } from "./format.ts"
import { statusClass } from "./overview.tsx"
import { Waterfall } from "./panel.tsx"
import { href } from "./route.ts"
import { Check, Fail, Loaded, Ring, Stopped, Swatch, Waiting, useNow } from "./ui.tsx"

export function RolloutPage({ id }: { readonly id: string }) {
  const result = useAtomValue(runAtom(id))
  const ov = useAtomValue(overviewAtom)
  return (
    <main className="page rollout">
      <Loaded result={result} what="this rollout">
        {(detail) => {
          const project = AsyncResult.isSuccess(ov) ? ov.value.projects.find((p) => p.name === detail.run.project) : undefined
          const step = detail.steps.find((s) => s.deploys)
          if (!step) return <p className="empty">#{detail.run.number} has no deploy step. <a className="lnk" href={href({ page: "run", id, step: null })}>Back to the run</a></p>
          return <Rollout detail={detail} step={step} deployments={project?.deployments ?? []} />
        }}
      </Loaded>
    </main>
  )
}

type HostState = "deploying" | "live" | "waiting" | "failed" | "replaced" | "not deployed"

function hostState(d: Domain.Deployment, run: Domain.Run, step: Domain.StepRun): HostState {
  if (d.deployingRun === run.id) return "deploying"
  if (d.revision === run.commit.sha) return "live"
  if (step.status === "running" || step.status === "pending" || step.status === "queued") return "waiting"
  if (step.status === "failed" || step.status === "died") return "failed"
  if (step.status === "passed") return "replaced"
  return "not deployed"
}

function StateGlyph({ state }: { readonly state: HostState }) {
  switch (state) {
    case "deploying":
      return <Ring p={0.5} />
    case "live":
      return <Check />
    case "waiting":
      return <Waiting />
    case "failed":
      return <Fail />
    case "replaced":
    case "not deployed":
      return <Stopped />
  }
}

function Rollout({ detail, step, deployments }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun; readonly deployments: ReadonlyArray<Domain.Deployment> }) {
  const now = useNow()
  const { run } = detail
  const sha = run.commit.sha
  const hosts = [...deployments].sort((a, b) => order(a, run, step) - order(b, run, step))
  const elapsed = stepDuration(step, now)
  const waitsFor = [...step.needs, ...step.after].filter((n) => {
    const s = detail.steps.find((x) => x.name === n)
    return s && s.status !== "passed" && s.status !== "reused"
  })
  const big = step.status === "running" ? <span className="big heat">{dur(elapsed ?? 0)}</span>
    : step.status === "passed" ? <span className="big">live</span>
    : step.status === "failed" || step.status === "died" ? <span className="big bad">failed</span>
    : <span className="big dim">{step.status}</span>
  const under = step.status === "running" ? `deploying since ${clockS(step.startedAt ?? now)}`
    : step.status === "passed" ? `took ${dur(elapsed ?? 0)}, done at ${clock(step.finishedAt ?? now)}`
    : step.status === "failed" || step.status === "died" ? (step.error?.message ?? "")
    : waitsFor.length ? `waits for ${waitsFor.join(", ")}` : ""
  return (
    <>
      <header className="ro-head">
        <div className="ro-title">
          <h1><span className="h-ref">{run.project} rollout</span>{shortSha(sha)} to {hosts.map((d) => d.host).join(", then ") || "no hosts"}</h1>
          <p className="cx-meta">
            <span>{titleOf(run)}</span>
            <span>{run.commit.author}, {eventLine(run.event)}</span>
            <a className="lnk" href={href({ page: "run", id: run.id, step: step.name })}>#{run.number}, {step.name}</a>
            <code className="dim">{step.detail}</code>
          </p>
          <ol className="stages">
            {hosts.map((d, i) => {
              const state = hostState(d, run, step)
              return (
                <li key={d.host} className={state === "deploying" ? "cur" : ""}>
                  {i > 0 ? <span className="line" aria-hidden="true" /> : null}
                  <StateGlyph state={state} />
                  <b>{d.host}</b>
                  <span className={state === "deploying" ? "heat" : state === "failed" ? "bad" : state === "live" ? "" : "dim"}>{state}</span>
                  {state === "live" && d.since !== null ? <span className="dim">since {clock(d.since)}</span> : null}
                </li>
              )
            })}
          </ol>
        </div>
        <div className="ro-count">{big}<span className="dim">{under}</span></div>
      </header>
      <div className="ro-body">
        <section className="ro-main">
          <header className="sub-h"><h3>Hosts</h3><span className="dim">what ran before, what this run brings, what is live now</span></header>
          <table className="gtt hosts-t">
            <thead><tr><th>Host</th><th>Before</th><th>This run</th><th>Live now</th><th>Since</th><th>Health</th><th>URL</th></tr></thead>
            <tbody>
              {hosts.map((d) => {
                const state = hostState(d, run, step)
                const before = d.revision === sha ? d.previous : d.revision
                return (
                  <tr key={d.host}>
                    <td><b>{d.host}</b></td>
                    <td>{before ? <code>{shortSha(before)}</code> : <span className="dim">nothing</span>}</td>
                    <td><span className="hs"><StateGlyph state={state} /><code>{shortSha(sha)}</code><span className={statusClass(state === "deploying" ? "running" : state === "failed" ? "failed" : "passed")}>{state}</span></span></td>
                    <td>
                      <span className="hs">
                        {d.revision ? <><Swatch k={d.storePath ?? d.revision} /><code>{shortSha(d.revision)}</code></> : <span className="dim">nothing live</span>}
                        {d.pending ? <span data-tip="asked for but not active"><span className="arrow">→</span><code>{shortSha(d.pending)}</code> pending</span> : null}
                      </span>
                    </td>
                    <td className="tnum">{d.since !== null ? <>{clock(d.since)} <span className="dim">{ago(d.since, now)}</span></> : ""}</td>
                    <td>{d.healthy === true ? <span className="dim">healthy</span> : d.healthy === false ? <span className="bad">unhealthy</span> : <span className="dim">no check</span>}</td>
                    <td>{d.url ? <a className="lnk" href={d.url} target="_blank" rel="noreferrer">{d.url.replace(/^https?:\/\//, "")}</a> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <header className="sub-h"><h3>Deploy trace</h3><span className="dim">spans of {step.name}</span></header>
          <DeployTrace detail={detail} step={step} />
          <DeployLog runId={run.id} step={step} />
        </section>
      </div>
    </>
  )
}

/** Hosts in deploy order: done first, then the one deploying, then those waiting. */
const order = (d: Domain.Deployment, run: Domain.Run, step: Domain.StepRun) =>
  ["live", "replaced", "deploying", "failed", "waiting", "not deployed"].indexOf(hostState(d, run, step))

function DeployTrace({ detail, step }: { readonly detail: Domain.RunDetail; readonly step: Domain.StepRun }) {
  const [live] = useState(() => isActive(detail.run.status))
  const result = useAtomValue(traceAtom({ runId: detail.run.id, live }))
  const root = step.spanId
  if (root === null) return <p className="empty">No spans until {step.name} starts.</p>
  return (
    <Loaded result={result} what="the deploy trace">
      {(spans) => spans.some((s) => s.spanId === root) ? <Waterfall spans={spans} step={step} root={root} live={step.status === "running"} compact /> : <p className="empty">The trace has no span for {step.name} yet.</p>}
    </Loaded>
  )
}

const since = (ms: number) => (ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)} s` : dur(ms))

function DeployLog({ runId, step }: { readonly runId: string; readonly step: Domain.StepRun }) {
  const [follow] = useState(() => !isTerminal(step.status))
  const [debug, setDebug] = useState(false)
  const result = useAtomValue(logsAtom({ runId, step: step.name, follow }))
  const box = useRef<HTMLDivElement>(null)
  const all = AsyncResult.isSuccess(result) ? result.value : []
  const hidden = all.filter((l) => l.level === "debug").length
  const lines = debug ? all : all.filter((l) => l.level !== "debug")
  useLayoutEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [lines.length, follow])
  const origin = step.startedAt ?? lines[0]?.timestamp ?? 0
  const head = (
    <header className="sub-h">
      <h3>Deploy log</h3>
      <span className="dim">{step.name}, {isTerminal(step.status) ? step.status : "live"}</span>
      <span className="grow" />
      {hidden ? <button type="button" className={`lvtog${debug ? " on" : ""}`} aria-pressed={debug} onClick={() => setDebug(!debug)}>debug<span className="n">{hidden}</span></button> : null}
    </header>
  )
  if (!lines.length) return <>{head}<p className="empty">{AsyncResult.isInitial(result) ? "Loading the deploy log" : follow ? `Waiting for ${step.name} to start.` : "No log lines."}</p></>
  return (
    <>
    {head}
    <div className="dlog" ref={box}>
      {lines.map((l, i) => (
        <div key={i} className={`dl lv-${l.level}`}>
          <span className="dl-t">+{since(l.timestamp - origin)}</span>
          <span className="dl-m">{l.text}</span>
        </div>
      ))}
    </div>
    </>
  )
}
