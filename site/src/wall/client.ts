import { runRow } from "./markup.ts"
import { changes, duration, Simulation, tally, type Run } from "./model.ts"

/** Real milliseconds per simulated second. */
const pace = 45
const maxRows = 7

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function mount(wall: HTMLElement) {
  const list = wall.querySelector<HTMLOListElement>(".runs")
  const tip = wall.querySelector<HTMLElement>(".tip")
  const status = wall.querySelector<HTMLElement>("[role=status]")
  const buttons = [...wall.querySelectorAll<HTMLButtonElement>("button[data-change]")]
  if (!list || !tip || !status) return

  // The page shows the seeded runs already; replaying them brings the simulation to the same state.
  const simulation = new Simulation()
  simulation.seed()

  const fire = async (run: Run) => {
    list.insertAdjacentHTML("beforeend", runRow(run, true))
    while (list.children.length > maxRows) list.firstElementChild?.remove()
    const row = list.lastElementChild
    const time = row?.querySelector<HTMLElement>(".run-time")
    const tiles = [...(row?.querySelectorAll<HTMLElement>(".tile") ?? [])]
    const began = performance.now()
    let ticking = true
    const tick = () => {
      if (!ticking || !time) return
      time.textContent = duration(Math.min(run.seconds, Math.round((performance.now() - began) / pace)))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    await Promise.all(
      run.tiles.map(async (t, i) => {
        const tile = tiles[i]
        if (!t.ran || !tile) return
        await wait(t.start * pace)
        tile.style.setProperty("--fire", `${t.step.seconds * pace}ms`)
        tile.dataset["state"] = "running"
        await wait(t.step.seconds * pace)
        tile.dataset["state"] = "ran"
      }),
    )
    ticking = false
    if (time) time.textContent = duration(run.seconds)
    status.textContent = `Run ${run.id}, ${run.event} ${run.change}: ${tally(run)} in ${duration(run.seconds)}.`
  }

  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const change = changes.find((c) => c.file === button.dataset["change"])
      if (!change || wall.dataset["busy"]) return
      wall.dataset["busy"] = "true"
      for (const b of buttons) b.setAttribute("aria-disabled", "true")
      const [pullRequest, merge] = simulation.pullRequest(change.file)
      await fire(pullRequest)
      await wait(700)
      await fire(merge)
      delete wall.dataset["busy"]
      for (const b of buttons) b.removeAttribute("aria-disabled")
    })
  }

  const trace = (key: string | undefined) => {
    for (const tile of list.querySelectorAll<HTMLElement>(".tile")) {
      tile.classList.toggle("same", key !== undefined && tile.dataset["key"] === key)
    }
  }

  list.addEventListener("pointerover", (event) => {
    const tile = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".tile") : null
    if (!tile) return
    const { key, step, from, state } = tile.dataset
    const what = state === "reused"
      ? `reused from #${from}`
      : state === "ran"
      ? `ran in #${from}`
      : state === "running"
      ? "running"
      : "waits for install"
    tip.innerHTML = `<b>${step}</b> <span>${what}</span> <code>key ${key}</code>`
    const box = tile.getBoundingClientRect()
    const frame = wall.getBoundingClientRect()
    tip.style.left = `${box.left + box.width / 2 - frame.left}px`
    tip.style.top = `${box.top - frame.top}px`
    tip.hidden = false
    trace(key)
  })
  list.addEventListener("pointerleave", () => {
    tip.hidden = true
    trace(undefined)
  })
}
