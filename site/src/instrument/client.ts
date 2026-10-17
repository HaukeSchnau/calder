import { edits, type EventName, events, type Lamp, mistake, type StepName } from "./model.ts"

const svg = "http://www.w3.org/2000/svg"

/** The wires between modules: `needs` carries a value and is a cable, the rest are thin. */
const wires: ReadonlyArray<{ readonly from: StepName; readonly to: StepName; readonly kind: "value" | "after" | "setup"; readonly tag?: string }> = [
  { from: "install", to: "typecheck", kind: "setup" },
  { from: "install", to: "test", kind: "setup" },
  { from: "typecheck", to: "deploy", kind: "after" },
  { from: "test", to: "deploy", kind: "after" },
  { from: "site", to: "deploy", kind: "value", tag: "StorePath" },
]

const isEvent = (value: string): value is EventName => value in events

function draw(rack: HTMLElement) {
  const layer = rack.querySelector<SVGSVGElement>("svg.wires")
  if (!layer) return
  const box = rack.getBoundingClientRect()
  layer.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`)
  layer.replaceChildren()
  const jack = (step: StepName, side: "in" | "out" | "value") => {
    const el = rack.querySelector<HTMLElement>(`[data-step="${step}"] .jack-${side}`)
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top }
  }
  for (const wire of wires) {
    const a = jack(wire.from, "out")
    const b = jack(wire.to, wire.kind === "value" ? "value" : "in")
    if (!a || !b) continue
    // A cable leaves its jack sideways, hangs a little, and goes up into the input below the module.
    const d = wire.kind === "value"
      ? `M ${a.x} ${a.y} C ${a.x + (b.x - a.x) * 0.7} ${a.y + 26}, ${b.x} ${b.y + 46}, ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} C ${a.x + (b.x - a.x) * 0.5} ${a.y}, ${b.x - (b.x - a.x) * 0.5} ${b.y}, ${b.x} ${b.y}`
    const path = document.createElementNS(svg, "path")
    path.setAttribute("d", d)
    path.setAttribute("class", `wire wire-${wire.kind}`)
    path.dataset["from"] = wire.from
    path.dataset["to"] = wire.to
    layer.append(path)
    if (wire.tag !== undefined) {
      const mid = path.getPointAtLength(path.getTotalLength() / 2)
      const label = document.createElementNS(svg, "text")
      label.setAttribute("x", String(mid.x + 12))
      label.setAttribute("y", String(mid.y + 20))
      label.setAttribute("class", "wire-tag")
      label.textContent = wire.tag
      layer.append(label)
    }
  }
}

const isStep = (value: string | undefined): value is StepName =>
  value === "install" || value === "typecheck" || value === "test" || value === "site" || value === "deploy"

/** Sets each module's lamp; a wire lights with the module it leads into (site.css). */
function setLamps(instrument: HTMLElement, lamps: Readonly<Record<StepName, Lamp>>) {
  for (const el of instrument.querySelectorAll<HTMLElement>(".module")) {
    const step = el.dataset["step"]
    if (isStep(step)) el.dataset["lamp"] = lamps[step]
  }
}

/** The code panel that shows the pipeline: lights the rule an event matches and the step under the pointer. */
function codePanel() {
  const panel = document.querySelector<HTMLElement>(".code-panel")
  const variants = [...(panel?.querySelectorAll<HTMLElement>(".code-variant") ?? [])]
  const light = (cls: string, from: number, to: number) => {
    for (const line of panel?.querySelectorAll<HTMLElement>("[data-line]") ?? []) {
      const n = Number(line.dataset["line"])
      line.classList.toggle(cls, n >= from && n <= to)
    }
  }
  return {
    rule: (line: number) => light("is-rule", line, line),
    step: (lines: string | undefined) => {
      const [from = 0, to = from] = (lines ?? "").split("-").map(Number)
      light("is-step", from, to)
    },
    wrong: (on: boolean) => {
      for (const v of variants) v.hidden = (v.dataset["variant"] === "wrong") !== on
    },
  }
}

function plan(instrument: HTMLElement) {
  const display = instrument.querySelector<HTMLElement>(".display code")
  const toggle = instrument.querySelector<HTMLInputElement>('input[name="mistake"]')
  const code = codePanel()
  const update = () => {
    const chosen = instrument.querySelector<HTMLInputElement>('input[name="event"]:checked')?.value ?? "pr"
    const name: EventName = isEvent(chosen) ? chosen : "pr"
    const event = events[name]
    const wrong = toggle?.checked === true
    instrument.dataset["event"] = name
    instrument.dataset["fault"] = String(wrong)
    setLamps(instrument, event.lamps)
    code.rule(event.rule)
    code.wrong(wrong)
    if (display) {
      const compiler = `$ tsc -p .calder\nci.ts:${mistake.line}:${mistake.column} error TS2322\n${mistake.reason}`
      display.textContent = !wrong ? event.plan : name === "push" ? `${compiler}\n\n${event.plan}` : `${compiler}\n\n${mistake.refusal}`
    }
  }
  instrument.addEventListener("change", update)
  for (const el of instrument.querySelectorAll<HTMLElement>(".module")) {
    el.addEventListener("pointerenter", () => code.step(el.dataset["lines"]))
    el.addEventListener("pointerleave", () => code.step(undefined))
  }
  update()
}

function editKeys(instrument: HTMLElement) {
  const keys = [...instrument.querySelectorAll<HTMLButtonElement>("[data-edit]")]
  const why = instrument.querySelector<HTMLElement>(".why")
  const tests = instrument.querySelector<HTMLElement>("[data-tests]")
  const press = (key: HTMLButtonElement, play: boolean) => {
    const edit = edits[Number(key.dataset["edit"])]
    if (!edit) return
    for (const k of keys) k.setAttribute("aria-pressed", String(k === key))
    // Restart the lamps' animation, so pressing a key again plays it again.
    instrument.dataset["played"] = "false"
    if (play) {
      void instrument.offsetWidth
      instrument.dataset["played"] = "true"
    }
    setLamps(instrument, edit.lamps)
    if (tests) tests.textContent = edit.tests
    if (why) why.textContent = edit.why
  }
  for (const key of keys) key.addEventListener("click", () => press(key, true))
  // Start on an edit that shows both kinds of lamp.
  const first = keys[1]
  if (first) press(first, false)
}

for (const instrument of document.querySelectorAll<HTMLElement>(".instrument")) {
  const rack = instrument.querySelector<HTMLElement>(".rack")
  if (rack) {
    draw(rack)
    new ResizeObserver(() => draw(rack)).observe(rack)
  }
  if (instrument.dataset["mode"] === "plan") plan(instrument)
  else editKeys(instrument)
}
