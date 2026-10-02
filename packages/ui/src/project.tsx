// One project: its runs with filters for ref and status, and how long each step takes over time.

import type { Domain } from "@kiln/api"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { Kiln } from "./client.ts"
import { useRunCommands } from "./commands.ts"
import { isActive, overviewAtom, projectRunsAtom, runAtom } from "./data.ts"
import { ago, count, dur, refOf, runDuration, shortSha, titleOf, totalSteps, when } from "./format.ts"
import { hostsOf } from "./overview.tsx"
import { href } from "./route.ts"
import { graphOrder } from "./run.tsx"
import { Loaded, RunGlyph, Swatch, useNow } from "./ui.tsx"

type StatusFilter = "all" | "failed" | "running" | "passed"
const STATUS_FILTERS: ReadonlyArray<StatusFilter> = ["all", "failed", "running", "passed"]

const matchesStatus = (run: Domain.Run, f: StatusFilter) =>
  f === "all" || (f === "failed" ? run.status === "failed" || run.status === "errored" : f === "running" ? isActive(run.status) : run.status === f)

export function ProjectPage({ name }: { readonly name: string }) {
  const ov = useAtomValue(overviewAtom)
  const project = AsyncResult.isSuccess(ov) ? ov.value.projects.find((p) => p.name === name) : undefined
  const { trigger } = useRunCommands()
  return (
    <main className="page project">
      <header className="doc-h">
        <h1>{name}</h1>
        {project ? <span className="dim">{project.repo}, default branch {project.defaultBranch}</span> : null}
        <span className="grow" />
        {project ? <Deployments project={project} /> : null}
        <button type="button" className="btn" onClick={() => trigger(name)}>Run {project?.defaultBranch ?? "main"}</button>
      </header>
      <div className="proj-body">
        <Runs project={name} />
        <aside className="proj-steps">
          <header className="osec-h"><h2>Step duration</h2><span className="dim">last 30 runs of each step</span></header>
          {project?.main ? <StepHistory project={name} mainId={project.main.id} /> : <p className="empty">No run on the default branch yet.</p>}
        </aside>
      </div>
    </main>
  )
}

function Deployments({ project }: { readonly project: Domain.Project }) {
  const now = useNow()
  return (
    <span className="pdeps">
      {hostsOf([project]).map((h) => {
        const d = project.deployments.find((x) => x.host === h)
        if (!d) return null
        return (
          <span key={h} className="pdep">
            <span className="dim">{h}</span>
            {d.revision ? <><Swatch k={d.storePath ?? d.revision} /><code>{shortSha(d.revision)}</code></> : <span className="dim">nothing live</span>}
            {d.deployingRun ? <a className="heat" href={href({ page: "rollout", id: d.deployingRun })}>deploying</a> : d.healthy === false ? <span className="bad">unhealthy</span> : d.since !== null ? <span className="dim">{ago(d.since, now)}</span> : null}
          </span>
        )
      })}
    </span>
  )
}

function Runs({ project }: { readonly project: string }) {
  const [ref, setRef] = useState<string>("all")
  const [status, setStatus] = useState<StatusFilter>("all")
  const pullRequest = ref.startsWith("PR #") ? Number(ref.slice(4)) : null
  const all = useAtomValue(projectRunsAtom({ project, pullRequest: null }))
  const result = useAtomValue(projectRunsAtom({ project, pullRequest }))
  const [older, setOlder] = useState<{ readonly key: string; readonly runs: ReadonlyArray<Domain.Run>; readonly done: boolean }>({ key: "", runs: [], done: false })
  const fetchRuns = useAtomSet(Kiln.mutation("runs"), { mode: "promiseExit" })
  const key = `${project}|${pullRequest ?? ""}`
  const extra = older.key === key ? older.runs : []
  const refs = AsyncResult.isSuccess(all) ? [...new Set(all.value.map(refOf))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : b.localeCompare(a, "en", { numeric: true }))) : []

  return (
    <section className="proj-runs" aria-label="Runs">
      <div className="ptool flat">
        <span className="seg" role="group" aria-label="Ref">
          {["all", ...refs.slice(0, 7)].map((r) => <button key={r} type="button" className={ref === r ? "on" : ""} onClick={() => setRef(r)}>{r === "all" ? "All refs" : r}</button>)}
        </span>
        <span className="seg" role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => <button key={f} type="button" className={status === f ? "on" : ""} onClick={() => setStatus(f)}>{f === "all" ? "Any status" : f}</button>)}
        </span>
      </div>
      <Loaded result={result} what="runs">
        {(loaded) => {
          const runs = [...loaded, ...extra.filter((r) => !loaded.some((x) => x.id === r.id))]
            .filter((r) => (ref === "all" || refOf(r) === ref) && matchesStatus(r, status))
          const oldest = [...loaded, ...extra].at(-1)
          const more = async () => {
            if (!oldest) return
            const exit = await fetchRuns({ payload: pullRequest === null ? { project, before: oldest.createdAt, limit: 60 } : { project, pullRequest, before: oldest.createdAt, limit: 60 } })
            if (exit._tag === "Success") setOlder({ key, runs: [...extra, ...exit.value], done: exit.value.length === 0 })
          }
          return (
            <>
              <div className="rtable">
                <div className="rt-head"><span /><span className="tnum">Run</span><span>Ref</span><span>Title</span><span>By</span><span>Commit</span><span>Steps</span><span className="num">Took</span><span className="num">When</span></div>
                {runs.map((r) => <RunRow key={r.id} run={r} />)}
                {!runs.length ? <p className="empty">No runs match.</p> : null}
              </div>
              {!(older.key === key && older.done) && oldest ? <p className="more"><button type="button" className="btn" onClick={more}>Older runs</button></p> : null}
            </>
          )
        }}
      </Loaded>
    </section>
  )
}

function RunRow({ run }: { readonly run: Domain.Run }) {
  const now = useNow()
  const total = totalSteps(run.counts)
  const reused = count(run.counts, "reused")
  const failed = count(run.counts, "failed", "died")
  const d = runDuration(run, now)
  return (
    <a className="rt-row" href={href({ page: "run", id: run.id, step: null })}>
      <span><RunGlyph run={run} /></span>
      <span className="tnum">#{run.number}</span>
      <span className="ref">{refOf(run)}</span>
      <span className="ttl">{titleOf(run)}</span>
      <span className="dim">{run.commit.author}</span>
      <span className="mono dim">{shortSha(run.commit.sha)}</span>
      <span>{run.status === "errored" ? <span className="bad">plan failed</span> : failed ? <span className="bad">{failed} failed</span> : isActive(run.status) ? <span className="heat">{run.status}</span> : reused ? <span className="dim">{reused} of {total} reused</span> : <span className="dim">{total} ran</span>}</span>
      <span className={`num${isActive(run.status) ? " heat" : ""}`}>{d !== null ? dur(d) : ""}</span>
      <span className="num dim">{when(run.createdAt, now)}</span>
    </a>
  )
}

function StepHistory({ project, mainId }: { readonly project: string; readonly mainId: string }) {
  const result = useAtomValue(runAtom(mainId))
  return (
    <Loaded result={result} what="the steps">
      {(detail) => (
        <div className="shist">
          {graphOrder(detail.steps).map((s) => <StepRow key={s.name} project={project} step={s.name} />)}
          <p className="dim skeys">One bar per run, height is time, reused runs are flat. Click a bar to open its run.</p>
        </div>
      )}
    </Loaded>
  )
}

function StepRow({ project, step }: { readonly project: string; readonly step: string }) {
  const result = useAtomValue(Kiln.query("stepStats", { project, step }))
  const samples = AsyncResult.isSuccess(result) ? result.value.samples : []
  const durations = samples.flatMap((s) => (s.durationMs === null ? [] : [s.durationMs]))
  const sorted = [...durations].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length / 2)]
  const last = samples.at(-1)
  const max = Math.max(1, ...durations)
  const w = 150
  const slot = w / 30
  return (
    <div className="srow2">
      <span className="sname">{step}</span>
      <svg className="rspark" width={w} height={20} viewBox={`0 0 ${w} 20`} aria-hidden="true">
        {samples.map((s, i) => {
          const h = s.durationMs === null ? 2 : Math.max(2, (s.durationMs / max) * 18)
          return (
            <a key={`${s.runId}-${i}`} href={href({ page: "run", id: s.runId, step })} data-tip={`${s.reused ? "reused" : s.status}${s.durationMs !== null ? `, ${dur(s.durationMs)}` : ""}${s.queueMs !== null ? `, waited ${(s.queueMs / 1000).toFixed(1)} s` : ""}`}>
              <rect className={s.reused ? "s-reused" : `s-${s.status}`} x={(30 - samples.length + i) * slot + 0.5} y={20 - h} width={Math.max(2, slot - 2)} height={h} rx={1} />
            </a>
          )
        })}
      </svg>
      <span className="num">{p50 !== undefined ? dur(p50) : ""}</span>
      <span className="num dim">{last ? (last.reused ? "reused" : last.durationMs !== null ? dur(last.durationMs) : "") : ""}</span>
    </div>
  )
}
