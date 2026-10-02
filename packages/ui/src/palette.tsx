// Cmd-K: go to a project or run, start a run of a project's default branch, and act on the run
// being looked at. Every word typed must match.

import type { Domain } from "@kiln/api"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useRunCommands } from "./commands.ts"
import { isActive, overviewAtom, runAtom } from "./data.ts"
import { refOf, titleOf } from "./format.ts"
import { go, type Route } from "./route.ts"
import { isDeployStep } from "./run.tsx"
import { Kbd } from "./ui.tsx"

interface Command {
  readonly group: string
  readonly label: string
  readonly hint: string
  readonly run: () => void
}

const noRun = Atom.make(AsyncResult.initial<Domain.RunDetail, unknown>())

export function Palette({ route, onClose }: { readonly route: Route; readonly onClose: () => void }) {
  const ov = useAtomValue(overviewAtom)
  const runId = route.page === "run" || route.page === "rollout" ? route.id : null
  const current = useAtomValue<AsyncResult.AsyncResult<Domain.RunDetail, unknown>>(runId ? runAtom(runId) : noRun)
  const { cancel, rerun, trigger } = useRunCommands()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const commands = useMemo(() => {
    const out: Array<Command> = []
    const add = (group: string, label: string, hint: string, run: () => void) => out.push({ group, label, hint, run })
    const detail = AsyncResult.isSuccess(current) ? current.value : null
    if (detail) {
      const r = detail.run
      const label = `#${r.number}`
      if (isActive(r.status)) add("This run", `Cancel ${r.project} ${label}`, r.status, () => void cancel(r))
      else add("This run", `Rerun ${r.project} ${label}`, `same revision, ${refOf(r)}`, () => void rerun(r))
      const failed = detail.steps.find((s) => s.status === "failed" || s.status === "died")
      if (failed) add("This run", `Jump to the failure in ${failed.name}`, failed.error?.tag ?? "failed", () => go({ page: "run", id: r.id, step: failed.name }))
      if (detail.steps.some(isDeployStep)) add("This run", `Open the rollout of ${label}`, "deploy", () => go({ page: "rollout", id: r.id }))
      for (const s of detail.steps) add("Steps", s.name, `${s.kind} ${s.status}`, () => go({ page: "run", id: r.id, step: s.name }))
    }
    add("Go to", "Overview", "home", () => go({ page: "overview" }))
    if (AsyncResult.isSuccess(ov)) {
      for (const p of ov.value.projects) add("Projects", p.name, p.main ? `main ${p.main.status}` : "no runs", () => go({ page: "project", name: p.name }))
      const runs = [...new Map([...ov.value.active, ...ov.value.recent].map((r) => [r.id, r])).values()]
      for (const r of runs) add("Runs", `${r.project} #${r.number} ${titleOf(r)}`, `${refOf(r)} ${r.status} ${r.commit.author}`, () => go({ page: "run", id: r.id, step: null }))
      for (const p of ov.value.projects) add("Start a run", `Run ${p.name} ${p.defaultBranch}`, "head of the default branch", () => void trigger(p.name))
    }
    return out
  }, [ov, current])

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // Matches in the label beat matches in the group or hint; groups keep their order among equals.
  const score = (c: Command) => {
    const label = c.label.toLowerCase()
    return words.length && label.startsWith(words.join(" ")) ? 3 : words.every((w) => label.includes(w)) ? 2 : 1
  }
  const matched = commands.filter((c) => words.every((w) => `${c.group} ${c.label} ${c.hint}`.toLowerCase().includes(w)))
  const best = new Map<string, number>()
  for (const c of matched) best.set(c.group, Math.max(best.get(c.group) ?? 0, score(c)))
  const groups = [...best.keys()].sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0))
  const shown = groups.flatMap((g) => matched.filter((c) => c.group === g).sort((a, b) => score(b) - score(a))).slice(0, 60)
  const at = Math.min(index, Math.max(0, shown.length - 1))

  useEffect(() => {
    list.current?.querySelector(".pi.on")?.scrollIntoView({ block: "nearest" })
  }, [at])

  const runAt = (i: number) => {
    const c = shown[i]
    onClose()
    c?.run()
  }

  let group = ""
  return (
    <div className="palette-wrap" data-modal onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          type="text"
          value={query}
          placeholder="Go to a project or run, or run a command"
          spellCheck={false}
          autoComplete="off"
          aria-controls="plist"
          onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose() }
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(at + 1, shown.length - 1)) }
            if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(at - 1, 0)) }
            if (e.key === "Enter") { e.preventDefault(); runAt(at) }
          }}
        />
        <ul id="plist" role="listbox" ref={list}>
          {shown.map((c, i) => {
            const head = c.group !== group
            group = c.group
            return (
              <Fragment key={`${c.group}:${c.label}`}>
                {head ? <li className="pg" role="presentation">{c.group}</li> : null}
                <li role="option" aria-selected={i === at} className={`pi${i === at ? " on" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => runAt(i)}>
                  <span className="pl">{c.label}</span>
                  <span className="dim">{c.hint}</span>
                </li>
              </Fragment>
            )
          })}
          {!shown.length ? <li className="pg">Nothing matches "{query}"</li> : null}
        </ul>
        <p className="pfoot"><Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd>↵</Kbd> run <Kbd>esc</Kbd> close</p>
      </div>
    </div>
  )
}
