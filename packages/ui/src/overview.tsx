// The overview answers three questions in two seconds: what is red, what is running, what is
// deploying where. Attention rows first, then one ruled grid of projects with what each host runs,
// then the most recent runs.

import type { Domain } from "@kiln/api"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { RunSpark } from "./charts.tsx"
import { deployHistoryAtom, isActive, overviewAtom, runAtom } from "./data.ts"
import { ago, count, dur, glaze, refOf, runDuration, shortSha, stepDuration, titleOf, totalSteps, when } from "./format.ts"
import { href } from "./route.ts"
import { Fail, Loaded, Ring, RunGlyph, Swatch, hasBits, useNow } from "./ui.tsx"

export function OverviewPage() {
  const result = useAtomValue(overviewAtom)
  return (
    <main className="page overview">
      <Loaded result={result} what="the overview">{(ov) => <Overview ov={ov} />}</Loaded>
    </main>
  )
}

export const hostsOf = (projects: ReadonlyArray<Domain.Project>) => {
  const hosts = [...new Set(projects.flatMap((p) => p.deployments.map((d) => d.host)))]
  return hosts.sort((a, b) => (a === "srv-2" ? -1 : b === "srv-2" ? 1 : a.localeCompare(b)))
}

function Overview({ ov }: { readonly ov: Domain.Overview }) {
  return (
    <>
      <Attention ov={ov} />
      <Board ov={ov} />
      <Recent runs={ov.recent} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Attention                                                           */

/** Red: the newest finished run of a default branch or an open pull request failed. A fix in flight doesn't clear it. */
export function redRuns(ov: Domain.Overview): Array<Domain.Run> {
  const failed = (status: Domain.RunStatus) => status === "failed" || status === "errored"
  const mains = ov.projects.flatMap((p) => {
    const done = [...p.history].reverse().find((h) => !isActive(h.status))
    if (!done || !failed(done.status)) return []
    const run = p.main?.id === done.id ? p.main : ov.recent.find((r) => r.id === done.id)
    return run ? [run] : []
  })
  const prs = new Map<string, Domain.Run>()
  for (const r of ov.recent) {
    if (r.event._tag !== "PullRequest" || isActive(r.status)) continue
    const key = `${r.project}#${r.event.number}`
    if (!prs.has(key)) prs.set(key, r)
  }
  return [...mains, ...[...prs.values()].filter((r) => failed(r.status))].sort((a, b) => b.createdAt - a.createdAt)
}

function Attention({ ov }: { readonly ov: Domain.Overview }) {
  const red = redRuns(ov)
  const deploying = ov.projects.flatMap((p) => p.deployments.filter((d) => d.deployingRun !== null))
  const deployingRuns = new Set(deploying.map((d) => d.deployingRun))
  const running = ov.active.filter((r) => !deployingRuns.has(r.id))
  const byRun = new Map<string, Array<Domain.Deployment>>()
  for (const d of deploying) if (d.deployingRun) byRun.set(d.deployingRun, [...(byRun.get(d.deployingRun) ?? []), d])
  if (!red.length && !running.length && !deploying.length) {
    return <section className="attn" aria-label="Needs attention"><p className="at calm"><span className="at-k dim">Quiet</span><span className="at-s dim">Nothing is red, running or deploying.</span></p></section>
  }
  return (
    <section className="attn" aria-label="Needs attention">
      {red.map((r, i) => <RedRow key={r.id} run={r} first={i === 0} newer={ov.active.find((a) => a.project === r.project && a.createdAt > r.createdAt && sameRef(a, r))} />)}
      {running.map((r, i) => <RunningRow key={r.id} run={r} first={i === 0} />)}
      {[...byRun].map(([runId, deps], i) => <DeployingRow key={runId} runId={runId} deployments={deps} run={ov.active.find((r) => r.id === runId)} project={ov.projects.find((p) => p.name === deps[0]?.project)} first={i === 0} />)}
    </section>
  )
}

const sameRef = (a: Domain.Run, b: Domain.Run) => refOf(a) === refOf(b)

function RedRow({ run, first, newer }: { readonly run: Domain.Run; readonly first: boolean; readonly newer: Domain.Run | undefined }) {
  const now = useNow()
  const detail = useAtomValue(runAtom(run.id))
  const d = AsyncResult.isSuccess(detail) ? detail.value : null
  const step = d?.steps.find((s) => s.status === "failed" || s.status === "died")
  const test = d?.failingTests.find((t) => t.step === step?.name)
  return (
    <a className={`at at-red${first ? "" : " cont"}`} href={href({ page: "run", id: run.id, step: step?.name ?? null })}>
      <span className="at-k"><Fail />Red</span>
      <span className="at-s"><b>{run.project}</b> {refOf(run)} <span className="dim">#{run.number}</span></span>
      <span className="at-d">
        {run.status === "errored" ? <span className="clip">{run.error ?? "errored before its steps ran"}</span> : null}
        {step ? <span className="fact strong">{step.name}</span> : null}
        {test ? <span className="clip">{test.suite} › {test.name}</span> : step?.error ? <span className="clip">{step.error.message}</span> : null}
      </span>
      <span className="at-t">{ago(run.createdAt, now)} ago</span>
      <span className="at-a">{newer ? <span className="heat">#{newer.number} running</span> : run.commit.author}</span>
    </a>
  )
}

function RunningRow({ run, first }: { readonly run: Domain.Run; readonly first: boolean }) {
  const now = useNow()
  const detail = useAtomValue(runAtom(run.id))
  const steps = AsyncResult.isSuccess(detail) ? detail.value.steps : []
  const total = totalSteps(run.counts)
  const finished = count(run.counts, "passed", "reused", "failed", "died", "blocked", "cancelled")
  const left = (s: Domain.StepRun) => (s.expectedMs ?? 0) - (stepDuration(s, now) ?? 0)
  const longest = steps.filter((s) => s.status === "running").sort((a, b) => left(b) - left(a))[0]
  return (
    <a className={`at at-run${first ? "" : " cont"}`} href={href({ page: "run", id: run.id, step: null })}>
      <span className="at-k"><Ring p={total ? finished / total : 0} />Running</span>
      <span className="at-s"><b>{run.project}</b> {refOf(run)} <span className="dim">#{run.number} {titleOf(run)}</span></span>
      <span className="at-d">
        <StepStrip steps={steps} />
        <span className="fact">{finished} of {total} done</span>
        {longest ? <span className="fact">{longest.name} <span className="num">{dur(stepDuration(longest, now) ?? 0)}</span>{longest.expectedMs ? ` of ~${dur(longest.expectedMs)}` : ""}</span> : null}
      </span>
      <span className="at-t tnum">{dur(runDuration(run, now) ?? 0)}</span>
      <span className="at-a"><span className="bar heat"><i style={{ width: `${total ? ((finished / total) * 100).toFixed(1) : 0}%` }} /></span></span>
    </a>
  )
}

function DeployingRow({ runId, deployments, run, project, first }: {
  readonly runId: string
  readonly deployments: ReadonlyArray<Domain.Deployment>
  readonly run: Domain.Run | undefined
  readonly project: Domain.Project | undefined
  readonly first: boolean
}) {
  const now = useNow()
  const detail = useAtomValue(runAtom(runId))
  const deploy = AsyncResult.isSuccess(detail) ? detail.value.steps.find((s) => s.status === "running" && s.kind === "action") : undefined
  const hosts = deployments.map((d) => d.host)
  const waiting = project?.deployments.filter((d) => !hosts.includes(d.host) && run && d.revision !== run.commit.sha).map((d) => d.host) ?? []
  const from = deployments[0]
  return (
    <a className={`at at-run${first ? "" : " cont"}`} href={href({ page: "rollout", id: runId })}>
      <span className="at-k"><Ring p={0.5} />Deploying</span>
      <span className="at-s"><b>{from?.project}</b> {run ? shortSha(run.commit.sha) : ""} <span className="dim">to</span> {hosts.join(", ")}</span>
      <span className="at-d">
        {from?.revision ? <><Swatch k={from.storePath ?? from.revision} /><code>{shortSha(from.revision)}</code><span className="arrow">→</span></> : null}
        {run ? <code>{shortSha(run.commit.sha)}</code> : null}
        {run ? <span className="fact">#{run.number} {titleOf(run)}</span> : null}
      </span>
      <span className="at-t tnum">{deploy ? dur(stepDuration(deploy, now) ?? 0) : ""}</span>
      <span className="at-a">{waiting.length ? `then ${waiting.join(", ")}` : "last host"}</span>
    </a>
  )
}

/** One cell per step: glaze once its bits exist, heat outline while it runs, red when it failed. */
export function StepStrip({ steps }: { readonly steps: ReadonlyArray<Domain.StepRun> }) {
  return (
    <span className="cells" aria-hidden="true">
      {steps.map((s) => (
        <i
          key={s.name}
          className={`mx s-${s.status}`}
          data-key={hasBits(s.status) ? (s.key ?? undefined) : undefined}
          data-tip={`${s.name}, ${s.status}`}
          style={hasBits(s.status) && s.key ? ({ "--g": glaze(s.key) }) : undefined}
        />
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Board                                                               */

function Board({ ov }: { readonly ov: Domain.Overview }) {
  const hosts = hostsOf(ov.projects)
  const cols = `minmax(250px, 1.5fr) 128px 140px 64px 52px ${hosts.map(() => "minmax(170px, 0.8fr)").join(" ")}`
  return (
    <section className="board" aria-label="Projects" style={{ "--ocols": cols }}>
      <div className="board-bar">
        <span className="olegend">
          <span><i className="mx" style={{ "--g": "#86a8e7" }} /><i className="mx" style={{ "--g": "#8fc1a9" }} />result, by key</span>
          <span><i className="mx s-running" />running</span>
          <span><i className="mx s-failed" />failed</span>
          <span><svg width="14" height="10"><rect x="1" y="2" width="3" height="8" rx="1" className="lg-bar" /><rect x="6" y="5" width="3" height="5" rx="1" className="lg-bar" /><rect x="11" y="0" width="3" height="10" rx="1" className="lg-bar s-failed" /></svg>runs on main, height is duration</span>
        </span>
        <Slots slots={ov.slots} />
      </div>
      <div className="br br-head">
        <span className="cell">Project</span>
        <span className="cell">Main</span>
        <span className="cell">Last 20 runs</span>
        <span className="cell num">Took</span>
        <span className="cell num">Age</span>
        {hosts.map((h) => <span key={h} className="cell host">{h}</span>)}
      </div>
      {ov.projects.map((p) => <ProjectRows key={p.name} project={p} hosts={hosts} recent={ov.recent} />)}
    </section>
  )
}

function Slots({ slots }: { readonly slots: Domain.Overview["slots"] }) {
  const meter = (used: number, max: number) => (
    <span className="slots" aria-hidden="true">{Array.from({ length: max }, (_, i) => <i key={i} className={i < used ? "on" : ""} />)}</span>
  )
  return (
    <span className="oslots">
      <span>tasks {meter(slots.tasks, slots.tasksMax)}<b className="tnum">{slots.tasks}/{slots.tasksMax}</b></span>
      <span>builds {meter(slots.builds, slots.buildsMax)}<b className="tnum">{slots.builds}/{slots.buildsMax}</b></span>
    </span>
  )
}

function ProjectRows({ project, hosts, recent }: { readonly project: Domain.Project; readonly hosts: ReadonlyArray<string>; readonly recent: ReadonlyArray<Domain.Run> }) {
  const now = useNow()
  const main = project.main
  const deployingId = project.deployments.find((d) => d.deployingRun !== null)?.deployingRun
  const deploying = deployingId ? (recent.find((r) => r.id === deployingId) ?? (main?.id === deployingId ? main : undefined)) : undefined
  const prs = new Map<number, Domain.Run>()
  for (const r of recent) {
    if (r.project !== project.name || r.event._tag !== "PullRequest" || prs.has(r.event.number)) continue
    if (now - r.createdAt < 3 * 86400_000) prs.set(r.event.number, r)
  }
  return (
    <>
      <div className="br br-project">
        <span className="cell name">
          <a className="pname" href={href({ page: "project", name: project.name })}>{project.name}</a>
          {main ? <><span className="ref">{project.defaultBranch}</span><code>{shortSha(main.commit.sha)}</code><span className="ttl">{main.commit.title}</span></> : <span className="ttl">no runs yet</span>}
        </span>
        <span className="cell">{main ? <RunCell run={main} /> : null}</span>
        <span className="cell spk"><RunSpark history={project.history} /></span>
        <span className="cell num">{main ? <Took run={main} /> : null}</span>
        <span className="cell num dim">{main ? ago(main.createdAt, now) : ""}</span>
        {hosts.map((h) => <HostCell key={h} deployment={project.deployments.find((d) => d.host === h)} next={deploying} />)}
      </div>
      {[...prs.values()].slice(0, 3).map((r) => (
        <div key={r.id} className="br br-change">
          <span className="cell name">
            <span className="ref">{refOf(r)}</span>
            <span className="ttl">{titleOf(r)}</span>
            <span className="by">{r.commit.author}</span>
          </span>
          <span className="cell"><RunCell run={r} /></span>
          <span className="cell" />
          <span className="cell num"><Took run={r} /></span>
          <span className="cell num dim">{ago(r.createdAt, now)}</span>
          {hosts.map((h) => <span key={h} className="cell host" />)}
        </div>
      ))}
    </>
  )
}

function RunCell({ run }: { readonly run: Domain.Run }) {
  const word = run.status === "passed" ? null : run.status
  return (
    <a className="runcell" href={href({ page: "run", id: run.id, step: null })}>
      <RunGlyph run={run} />
      <span className="tnum">#{run.number}</span>
      {word ? <span className={statusClass(run.status)}>{word}</span> : null}
    </a>
  )
}

export const statusClass = (status: Domain.RunStatus | Domain.StepStatus) =>
  status === "failed" || status === "errored" || status === "died" ? "bad" : status === "running" || status === "planning" || status === "queued" ? "heat" : "dim"

function Took({ run }: { readonly run: Domain.Run }) {
  const now = useNow()
  const d = runDuration(run, now)
  if (d === null) return null
  return <span className={isActive(run.status) ? "heat" : ""}>{dur(d)}</span>
}

function HostCell({ deployment, next }: { readonly deployment: Domain.Deployment | undefined; readonly next: Domain.Run | undefined }) {
  return deployment ? <Host d={deployment} next={next} /> : <span className="cell host" />
}

function Host({ d, next }: { readonly d: Domain.Deployment; readonly next: Domain.Run | undefined }) {
  const now = useNow()
  const history = useAtomValue(deployHistoryAtom({ project: d.project, host: null, limit: 10 }))
  const by = AsyncResult.isSuccess(history) ? history.value.find((r) => r.host === d.host && r.revision === d.revision) : undefined
  const sha = d.revision ? (by && !d.deployingRun ? <a className="hsha" href={href({ page: "rollout", id: by.runId })} data-tip={`deployed by #${by.runNumber}`}>{shortSha(d.revision)}</a> : shortSha(d.revision)) : null
  const live = d.revision ? <><span className="hl">{d.host}</span><Swatch k={d.storePath ?? d.revision} /><code>{sha}</code></> : <><span className="hl">{d.host}</span><span className="dim">nothing live</span></>
  if (d.deployingRun) {
    return <a className="cell host" href={href({ page: "rollout", id: d.deployingRun })}>{live}<span className="arrow">→</span><span className="heat">deploying</span></a>
  }
  return (
    <span className="cell host">
      {live}
      {next && d.revision !== next.commit.sha ? <a className="hstate" href={href({ page: "rollout", id: next.id })}><span className="arrow">→</span><span className="dim">waits</span></a>
        : d.pending ? <span className="hstate" data-tip={`${shortSha(d.pending)} was asked for but isn't active`}><span className="arrow">→</span><code className="pend">{shortSha(d.pending)}</code><span>pending</span></span>
        : d.healthy === false ? <span className="bad">unhealthy</span>
        : d.since !== null ? <span className="dim">{ago(d.since, now)}</span> : null}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Recent runs                                                         */

function Recent({ runs }: { readonly runs: ReadonlyArray<Domain.Run> }) {
  const now = useNow()
  return (
    <section className="recent" aria-label="Recent runs">
      <header className="osec-h"><h2>Recent runs</h2><span className="dim">every project, newest first</span></header>
      {runs.slice(0, 14).map((r) => {
        const total = totalSteps(r.counts)
        const reused = count(r.counts, "reused")
        const failed = count(r.counts, "failed", "died")
        return (
          <a key={r.id} className="jrow" href={href({ page: "run", id: r.id, step: null })}>
            <span className="jt">{when(r.createdAt, now)}</span>
            <span className="jg"><RunGlyph run={r} /></span>
            <span className="jp">{r.project}</span>
            <span className="jn tnum">#{r.number}</span>
            <span className="jr">{refOf(r)}</span>
            <span className="jx">{titleOf(r)}</span>
            <span className="jw">{r.commit.author}</span>
            <span className="js">{r.status === "errored" ? <span className="bad">plan failed</span> : failed ? <span className="bad">{failed} failed</span> : reused ? `${reused} of ${total} reused` : total ? `${total} ran` : ""}</span>
            <span className="jd tnum"><Took run={r} /></span>
          </a>
        )
      })}
    </section>
  )
}
