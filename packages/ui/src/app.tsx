import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { connectionAtom } from "./client.ts"
import { overviewAtom, runAtom } from "./data.ts"
import { clockS, titleOf } from "./format.ts"
import { useKeys } from "./keys.ts"
import { OverviewPage, redRuns } from "./overview.tsx"
import { Palette } from "./palette.tsx"
import { ProjectPage } from "./project.tsx"
import { RolloutPage } from "./rollout.tsx"
import { href, go, parse, useHash, type Route } from "./route.ts"
import { RunPage } from "./run.tsx"
import { useToast } from "./toast.ts"
import { Fail, Kbd, Ring, useNow } from "./ui.tsx"

export function App() {
  const route = parse(useHash())
  const [palette, setPalette] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  useKeys((e) => {
    if (e.key === "Escape" && route.page !== "overview") go(route.page === "rollout" ? { page: "run", id: route.id, step: null } : { page: "overview" })
  })
  useEffect(() => {
    document.title = route.page === "overview" ? "Kiln" : `Kiln, ${route.page === "project" ? route.name : route.page}`
  }, [route.page])

  return (
    <div className={`app view-${route.page}`}>
      <TitleBar route={route} onPalette={() => setPalette(true)} />
      {route.page === "overview" && <OverviewPage />}
      {route.page === "run" && <RunPage id={route.id} step={route.step} />}
      {route.page === "rollout" && <RolloutPage id={route.id} />}
      {route.page === "project" && <ProjectPage name={route.name} />}
      <StatusBar />
      {palette && <Palette route={route} onClose={() => setPalette(false)} />}
      <Tip />
    </div>
  )
}

function TitleBar({ route, onPalette }: { readonly route: Route; readonly onPalette: () => void }) {
  return (
    <header className="titlebar">
      <a className="brand" href="#/">Kiln</a>
      <nav className="crumbs" aria-label="Location">
        <a className={`crumb${route.page === "overview" ? " cur" : ""}`} href="#/">Overview</a>
        {route.page === "project" && <><span className="sep">/</span><span className="crumb cur">{route.name}</span></>}
        {(route.page === "run" || route.page === "rollout") && <RunCrumbs id={route.id} rollout={route.page === "rollout"} />}
      </nav>
      <button type="button" className="omni" onClick={onPalette}>
        <span>Go to a project or run, or run a command</span>
        <Kbd>⌘K</Kbd>
      </button>
    </header>
  )
}

function RunCrumbs({ id, rollout }: { readonly id: string; readonly rollout: boolean }) {
  const result = useAtomValue(runAtom(id))
  if (!AsyncResult.isSuccess(result)) return null
  const run = result.value.run
  return (
    <>
      <span className="sep">/</span>
      <a className="crumb" href={href({ page: "project", name: run.project })}>{run.project}</a>
      <span className="sep">/</span>
      {rollout ? <a className="crumb" href={href({ page: "run", id, step: null })}>#{run.number} {titleOf(run)}</a> : <span className="crumb cur">#{run.number} {titleOf(run)}</span>}
      {rollout && <><span className="sep">/</span><span className="crumb cur">rollout</span></>}
    </>
  )
}

function StatusBar() {
  const ov = useAtomValue(overviewAtom)
  const connection = useAtomValue(connectionAtom)
  const now = useNow()
  const message = useToast()
  const data = AsyncResult.isSuccess(ov) ? ov.value : null
  const red = data ? redRuns(data) : []
  const deploying = data ? data.projects.flatMap((p) => p.deployments.filter((d) => d.deployingRun !== null)) : []
  const running = data ? data.active : []
  return (
    <footer className="statusbar">
      <span className="sbl">
        {red[0] ? <a className="sb" href={href({ page: "run", id: red[0].id, step: null })}><Fail /><b>{red.length}</b> red</a> : <span className="sb dim">nothing red</span>}
        {running[0] ? <a className="sb" href={href({ page: "run", id: running[0].id, step: null })}><Ring p={0.6} /><b>{running.length}</b> running</a> : <span className="sb dim">nothing running</span>}
        {deploying[0]?.deployingRun ? (
          <a className="sb" href={href({ page: "rollout", id: deploying[0].deployingRun })}><Ring p={0.5} /><span className="sbw">{deploying[0].project} deploying to</span> <b className="heat">{deploying.map((d) => d.host).join(", ")}</b></a>
        ) : null}
      </span>
      <span className={`toast${message?.kind === "bad" ? " bad" : ""}`} role="status" aria-live="polite">{message ? <span className="toast-t" key={message.at}>{message.text}</span> : null}</span>
      <span className="sbr">
        {data ? <span className="sb dim">tasks <b className="tnum">{data.slots.tasks}/{data.slots.tasksMax}</b> builds <b className="tnum">{data.slots.builds}/{data.slots.buildsMax}</b></span> : null}
        <span className={`sb conn-${connection}`}>{connection === "live" ? <><span className="live-dot" />live</> : connection === "offline" ? <span className="bad">reconnecting</span> : "connecting"}</span>
        <span className="sb tnum dim">{clockS(now)}</span>
      </span>
    </footer>
  )
}

/**
 * One tooltip for every `data-tip`, and the glaze trace: hovering anything with a key lights up
 * every other place with the same key.
 */
function Tip() {
  const tip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let lastKey: string | null = null
    const onOver = (e: PointerEvent) => {
      const el = tip.current
      const target = e.target instanceof Element ? e.target : null
      const host = target?.closest<HTMLElement | SVGElement>("[data-tip]")
      if (el) {
        if (host) {
          el.textContent = host.getAttribute("data-tip")
          el.hidden = false
          const r = host.getBoundingClientRect()
          const t = el.getBoundingClientRect()
          el.style.left = `${Math.min(window.innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2))}px`
          el.style.top = `${r.top - t.height - 6 < 0 ? r.bottom + 6 : r.top - t.height - 6}px`
        } else {
          el.hidden = true
        }
      }
      const key = target?.closest("[data-key]")?.getAttribute("data-key") ?? null
      if (key === lastKey) return
      lastKey = key
      document.querySelectorAll(".same").forEach((x) => x.classList.remove("same"))
      if (key) document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((x) => x.classList.add("same"))
    }
    document.addEventListener("pointerover", onOver)
    return () => document.removeEventListener("pointerover", onOver)
  }, [])
  return <div className="tip" ref={tip} role="tooltip" hidden />
}
