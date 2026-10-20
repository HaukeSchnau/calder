import { ARRANGEMENTS } from "./plans.js"
import { AssemblyView, PARTS, order } from "./assembly.js"
import { DIM, RULES, SERVICES, partWidth } from "./geometry.js"
import { CHILDREN, CI_BLOCKS, CI_DEFS, CI_LINKS, CI_MARKS, CI_TS, TYPES, esc, highlight, keepWords, oline, parsePlan, renderCode } from "./source.js"
import { socketList } from "./assembly.js"
import { reduced, s } from "./svg.js"

const MOVABLE = ["typecheck", "test", "site", "deploy"]
const EVENT_CMD = { pr: "calder plan --event pr:7", push: "calder plan --event push:main", check: "calder plan --event check" }

/** The arrangement on the plate: where typecheck, test and site sit, and whether deploy was put in the pull-request rule. */
export const initial = () => ({ where: { typecheck: "pr", test: "pr", site: "pr" }, refused: false, event: "pr" })
const keyOf = (w) => `${w.typecheck},${w.test},${w.site}`
export const entryOf = (st) => ARRANGEMENTS[keyOf(st.where)][st.refused ? "refused" : "ok"]
export const arrangementOf = (st) => {
  const pr = ["typecheck", "test", "site"].filter((n) => st.where[n] === "pr")
  const push = ["typecheck", "test", "site"].filter((n) => st.where[n] === "push")
  ;(st.refused ? pr : push).push("deploy")
  return { pr: order("pr", pr), push: order("push", push) }
}
const tscLocation = (out) => out.match(/\((\d+),(\d+)\): error (TS\d+)/)

/**
 * Hover and focus link code to drawing: a line lights what it declares, a part lights its block of
 * code and its features. Adapted from round 5's Compiled.
 */
export function linkScope(root, onChange) {
  let hover = null
  let focus = null
  let tapped = null
  const keys = (e, attr) => (e?.dataset?.[attr] ?? "").split(" ").filter(Boolean)
  const apply = () => {
    const src = hover ?? tapped ?? focus
    const own = new Set(keys(src, "link"))
    const owner = keys(src, "owner")
    const precise = owner.length > 0
    const K = new Set(own)
    if (precise) for (const k of owner) K.add(k)
    else for (const k of own) for (const c of CHILDREN[k] ?? []) K.add(c)
    for (const e of root.querySelectorAll("[data-link], [data-owner]")) {
      let lit = false
      if (src && !e.classList.contains("blk")) {
        if (e.classList.contains("ln")) {
          lit = precise
            ? e === src || keys(e, "link").some((k) => own.has(k))
            : keys(e, "link").some((k) => K.has(k)) || keys(e, "owner").some((k) => K.has(k))
        } else if (e.matches(".part, .part-text, .rail, .rail-label, .plate, .plate-text, .oline")) {
          // Whole parts light only when they are the source's own subject.
          lit = keys(e, "link").some((k) => (precise ? owner.includes(k) || own.has(k) : K.has(k)))
        } else lit = keys(e, "link").some((k) => K.has(k))
      }
      e.classList.toggle("is-lit", lit)
    }
    onChange?.(K, src)
  }
  const target = (e) => {
    const t = e.target.closest?.("[data-link], [data-owner]")
    return t && root.contains(t) && !t.classList.contains("blk") ? t : null
  }
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return
    const t = target(e)
    if (t !== hover) {
      hover = t
      apply()
    }
  })
  root.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return
    hover = null
    apply()
  })
  root.addEventListener("focusin", (e) => {
    const t = e.target.closest?.("[data-link]")
    focus = t && root.contains(t) && (t.tabIndex >= 0 || t.getAttribute("tabindex") === "0") ? t : null
    apply()
  })
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) {
      focus = null
      apply()
    }
  })
  return { refresh: apply, tap: (t) => { tapped = t; apply() } }
}

// The readout: what the pointer or focus is on, as tsc infers it, and one sentence about its shape.
const typeLine = (name) => {
  const text = name === "install" ? "install: Setup" : `${name}: Step<${TYPES[name].join(", ")}>`
  return highlight(text, { def: name, marks: { StorePath: "t-val", HttpClient: "t-svc" } }).replace(/(<span class="t-pun">\{<\/span> readonly.*<span class="t-pun">\}<\/span>)/, '<span class="t-grant">$1</span>')
}
const SAY = {
  install: "A setup is the plate its tasks stand on. <code>typecheck</code> and <code>test</code> start from it, so a plan with either pulls it in.",
  typecheck: "<code>A</code> is <code>void</code>, so its output edge is flat. With no pins and no bit it seats on either rail.",
  test: "<code>Vitest.files</code> made it, with a key per test file. Its edge is flat, with no pins and no bit, so it seats on either rail.",
  site: "<code>A</code> is <code>StorePath</code>, the dovetail on its output edge that <code>deploy</code>'s socket takes. No pins, no bit.",
  deploy: "Its socket takes a <code>StorePath</code>. <code>R</code> is <code>HttpClient</code>, one pin, in socket 2. <code>G</code> is a grant, the brass bit, which only an open floor takes.",
}
const BASE = { pr: "PrBase", push: "Base" }
function readoutFor(src, refusedAt) {
  const keys = (attr) => (src?.dataset?.[attr] ?? "").split(" ").filter(Boolean)
  const own = keys("link")
  const owner = keys("owner")
  const sock = own.find((k) => k.startsWith("socket:"))
  if (sock) {
    const n = Number(sock.slice(7))
    const sv = SERVICES[n - 1]
    const by = ["pr", "push"].filter((r) => RULES[r].supplies.includes(sv))
    const say = by.length === 2
      ? "Both rules supply it, so both rails are drilled there."
      : by[0] === "pr"
        ? "Only the pull-request rule supplies it, so the push rail is solid there."
        : "Only the push rule supplies it, so the pull-request rail is solid there."
    return { type: `<span class="ro-k">Socket ${n}</span> <span class="t-svc">${esc(sv)}</span>`, say }
  }
  const rail = own.find((k) => k.startsWith("rail:"))
  if (rail) {
    const rule = rail.slice(5)
    const r = RULES[rule]
    return {
      type: `${BASE[rule]} <span class="t-pun">=</span> ${r.supplies.map((sv) => `<span class="t-svc">${sv}</span>`).join(' <span class="t-pun">|</span> ')}`,
      say: rule === "pr"
        ? `The pull-request rule supplies these, as sockets ${socketList(rule)}. Its closed floor takes no grants.`
        : `The push rule supplies these, as sockets ${socketList(rule)}. Its open floor takes any grant.`,
    }
  }
  if (own.includes("f:after")) return { type: highlight("after: [typecheck, test]"), say: "<code>deploy</code> runs after <code>typecheck</code> and <code>test</code>. The link carries no value, so no type parameter cuts it." }
  if (own.includes("f:plate") || own.includes("part:install")) return { type: typeLine("install"), say: SAY.install }
  const part = [...own, ...owner].find((k) => k.startsWith("part:"))?.slice(5)
  if (!part || !SAY[part]) return null
  if (part === "deploy" && refusedAt) return { type: typeLine(part), say: `Its grant bit stands on the pull-request rail's closed floor, so it doesn't seat. tsc reports ${refusedAt}.` }
  return { type: typeLine(part), say: SAY[part] }
}

/** Folds lines 1 to 5 behind one row, so the steps fit beside the drawing. */
function foldImports(code) {
  const lines = [1, 2, 3, 4, 5].map((n) => code.querySelector(`.ln[data-line="${n}"]`))
  const body = document.createElement("div")
  body.className = "fold-body"
  body.id = "imports"
  body.hidden = true
  lines[0].before(body)
  body.append(...lines)
  const row = document.createElement("div")
  row.className = "ln fold-row"
  row.innerHTML = `<span class="no">1</span><span class="src"><button type="button" class="fold" aria-expanded="false" aria-controls="imports"><span>${highlight('import { … } from "@calder-ci/core"')}</span><span class="fold-pill">4 more</span></button></span>`
  body.before(row)
  const close = document.createElement("button")
  close.type = "button"
  close.className = "fold fold-close"
  close.setAttribute("aria-expanded", "true")
  close.setAttribute("aria-controls", "imports")
  close.innerHTML = `<span class="fold-pill">Fold the imports</span>`
  lines[4].querySelector(".src").replaceChildren(close)
  const open = row.querySelector("button")
  const set = (expanded) => {
    body.hidden = !expanded
    row.hidden = expanded
    ;(expanded ? close : open).focus({ preventScroll: true })
  }
  open.addEventListener("click", () => set(true))
  close.addEventListener("click", () => set(false))
}

export function setupHero() {
  const scope = document.querySelector("#hero")
  const code = scope.querySelector("#hero-code")
  const out = scope.querySelector("#hero-out")
  const checked = scope.querySelector("[data-checked]")
  const tscText = scope.querySelector("[data-tsc]")
  const status = scope.querySelector("[data-code-status]")
  const radios = [...scope.querySelectorAll("[data-events] [role=radio]")]
  const live = scope.querySelector("[data-live]")
  const reset = scope.querySelector("[data-reset]")
  const dwgRoot = scope.querySelector("#hero-dwg")
  const hint = scope.querySelector("[data-hint]")
  const hintBack = scope.querySelector("[data-hint-back]")
  const head = scope.querySelector(".sheet-head")
  const roType = scope.querySelector("[data-ro-type]")
  const roSay = scope.querySelector("[data-ro-say]")
  const why = scope.querySelector("[data-why]")
  let pointed = null
  let st = initial()
  let carry = null // { name, target }
  let drag = null
  let links = null

  const say = (t) => {
    live.textContent = ""
    requestAnimationFrame(() => (live.textContent = t))
  }

  const view = new AssemblyView(dwgRoot, {
    interactive: true,
    partWidth,
    rowsBelow: 560,
    note: (name) => (planNow().pulled.has(name) ? "pulled in" : null),
    onRender: (v) => decorate(v),
  })
  view.svg.classList.add("is-interactive")

  const planNow = () => {
    const e = entryOf(st)
    const p = e.plans[st.event]
    return p.exit === 0 ? parsePlan(p.out) : { planned: new Set(), pulled: new Set() }
  }

  // Parts become controls after every render; their state is painted separately.
  function decorate(v) {
    for (const [name, g] of Object.entries(v.partEls)) {
      if (!MOVABLE.includes(name)) continue
      g.setAttribute("tabindex", "0")
      g.setAttribute("role", "button")
      g.setAttribute("aria-describedby", "dwg-help")
      g.addEventListener("pointerdown", (e) => onDown(e, name))
      g.addEventListener("keydown", (e) => onKey(e, name))
    }
    const planned = planNow().planned
    for (const [name, t] of Object.entries(v.textEls)) {
      t.classList.toggle("is-off", !planned.has(name))
      t.dataset.link = `part:${name}`
    }
    for (const p of v.L.plates) {
      p.el.classList.toggle("is-off", !planned.has("install"))
      p.textEl.dataset.link = "f:plate"
    }
    for (const g of v.afterEls) g.classList.toggle("is-off", !planned.has("deploy"))
    paint(v)
    links?.refresh()
  }
  function showReadout() {
    const loc = st.refused ? tscLocation(entryOf(st).tsc.out) : null
    const subject = pointed ?? (carry ? view.partEls[carry.name] : null)
    const r = subject ? readoutFor(subject, loc ? `${loc[3]} at ${loc[1]},${loc[2]}` : null) : null
    head.classList.toggle("is-reading", !!r)
    if (r) {
      roType.innerHTML = r.type
      roSay.innerHTML = r.say
    }
  }
  function paint(v = view) {
    for (const [name, g] of Object.entries(v.partEls)) {
      if (!MOVABLE.includes(name)) continue
      const rule = v.L.pos[name].rule
      const refusedHere = st.refused && name === "deploy"
      g.setAttribute("aria-label", `${name}, ${PARTS[name].kind}, line ${PARTS[name].line}, on the ${rule === "pr" ? "pull-request" : "push"} rail${refusedHere ? ", not seated: its grant bit stands on the closed floor" : ""}.`)
      g.setAttribute("aria-pressed", String(carry?.name === name))
      g.classList.toggle("is-carried", carry?.name === name)
    }
    for (const rule of ["pr", "push"]) v.railEls[rule].classList.toggle("is-target", !!carry && carry.target === rule)
    for (const rule of ["pr", "push"]) v.railLabelEls?.[rule]?.classList.toggle("is-target", !!carry && carry.target === rule)
    showReadout()
  }

  // Code pane.
  const diag = document.createElement("div")
  diag.className = "diag"
  const renderSource = (changed = []) => {
    const e = entryOf(st)
    const custom = {}
    const loc = e.tsc.exit ? tscLocation(e.tsc.out) : null
    for (const [no, text] of [[34, e.line34], [35, e.line35]]) {
      let html = highlight(text)
      if (loc && Number(loc[1]) === no) {
        const col = Number(loc[2]) - 1
        const word = text.slice(col).match(/^[A-Za-z_$][\w$]*/)?.[0] ?? ""
        html = `${highlight(text.slice(0, col))}<span class="squiggle">${esc(word)}</span>${highlight(text.slice(col + word.length))}`
      }
      custom[no] = html
    }
    const after = {}
    if (loc) {
      diag.innerHTML = e.tsc.out.split("\n").map((l, i) => {
        if (i > 0) return oline(l)
        const m = l.match(/^(\.calder\/ci\.ts\(\d+,\d+\))(.*)$/)
        return `<span class="oline"><span class="loc">${esc(m[1])}</span>${keepWords(m[2])}</span>`
      }).join("")
      after[Number(loc[1])] = diag
    }
    const folded = code.querySelector(".fold-body")?.hidden ?? true
    renderCode(code, CI_TS, { links: CI_LINKS, defs: CI_DEFS, blocks: CI_BLOCKS, marks: { ...CI_MARKS }, custom, after, cls: { 27: "is-grant", ...(loc ? { [Number(loc[1])]: "is-error" } : {}) } })
    foldImports(code)
    if (!folded) {
      code.querySelector(".fold-body").hidden = false
      code.querySelector(".fold-row").hidden = true
    }
    for (const n of changed) code.querySelector(`.ln[data-line="${n}"]`)?.classList.add("is-changed")
    status.textContent = loc ? "1 error" : "37 lines"
    status.classList.toggle("is-error", !!loc)
    checked.classList.toggle("is-error", !!loc)
    tscText.textContent = loc ? `${loc[3]} at ${loc[1]},${loc[2]}` : "no errors"
    // The innermost line of the error is the reason; the grant's type is elided to keep it to a line.
    why.hidden = !loc
    if (loc) why.textContent = e.tsc.out.split("\n").pop().trim().replace(/'\{ readonly secrets: [^']*\}'/, "'{ readonly secrets: … }'")
    hint.hidden = !!st.refused
    hintBack.hidden = !st.refused
    reset.hidden = keyOf(st.where) === "pr,pr,pr" && !st.refused
  }

  const renderOut = () => {
    const p = entryOf(st).plans[st.event]
    let html = oline(EVENT_CMD[st.event], { cls: "cmd" })
    p.out.split("\n").forEach((l, i) => {
      if (p.exit !== 0) html += oline(l, { cls: "err" })
      else {
        const m = l.match(/^\s+(?:setup|task|build|action)\s+(\S+)/)
        html += oline(l, { cls: i === 0 ? "head" : "", attrs: m ? ` data-link="part:${m[1]}"` : "" })
      }
    })
    out.innerHTML = html
  }

  const renderAll = (opts = {}) => {
    const before = snapshot()
    const plan = planNow()
    view.set({ arrangement: arrangementOf(st), refused: st.refused ? "deploy" : null, plan: { live: st.event === "push" ? "push" : "pr", planned: plan.planned, pulled: plan.pulled } })
    if (opts.flip !== false) flip(before, opts.from)
    renderOut()
    for (const r of radios) {
      const on = r.dataset.event === st.event
      r.setAttribute("aria-checked", String(on))
      r.tabIndex = on ? 0 : -1
    }
    if (opts.focus) view.partEls[opts.focus]?.focus({ preventScroll: true })
  }

  // Parts slide from where they were to where the new layout puts them.
  const snapshot = () => {
    const m = {}
    if (!view.L) return m
    for (const [name, p] of Object.entries(view.L.pos)) m[name] = { x: p.x, y: p.yTop, s: view.map(p.x, p.yTop) }
    return m
  }
  const flip = (before, from) => {
    if (reduced()) return
    for (const [name, p] of Object.entries(view.L.pos)) {
      const b = from?.name === name ? from : before[name]
      if (!b) continue
      const dx = b.x - p.x
      const dy = b.y - p.yTop
      if (!dx && !dy) continue
      const s1 = view.map(p.x, p.yTop)
      const sdx = b.s.X - s1.X
      const sdy = b.s.Y - s1.Y
      const opts = { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" }
      view.partEls[name].animate([{ transform: `translate(${b.x}px, ${b.y}px)` }, { transform: `translate(${p.x}px, ${p.yTop}px)` }], opts)
      view.textEls[name].animate([{ transform: `translate(${sdx}px, ${sdy}px)` }, { transform: "translate(0, 0)" }], opts)
    }
    for (const c of view.svg.querySelectorAll(".contact")) {
      c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 460 })
    }
  }

  // Moving a part: the code follows.
  const move = (name, rule, from) => {
    const was = { ...st, where: { ...st.where } }
    if (name === "deploy") st.refused = rule === "pr"
    else st.where[name] = rule
    const e = entryOf(st)
    const prev = entryOf(was)
    const changed = [34, 35].filter((n) => (n === 34 ? e.line34 !== prev.line34 : e.line35 !== prev.line35))
    renderSource(changed)
    renderAll({ from, focus: name })
    if (e.tsc.exit) {
      const loc = tscLocation(e.tsc.out)
      say(`${name} doesn't seat on the pull-request rail. Its grant bit stands on the closed floor. tsc reports ${loc[3]} at line ${loc[1]}, column ${loc[2]}.`)
    } else if (changed.length) say(`${name} is on the ${rule === "pr" ? "pull-request" : "push"} rail. ${changed.map((n) => `Line ${n} changed.`).join(" ")} No errors.`)
  }

  // Pointer: a drag moves the part; a press without movement picks it up like Space.
  const toAssembly = (dx, dy) => ({ x: dx / view.k, y: dy / view.k })
  // The rail whose row band is nearest the pointer.
  const ruleAt = (clientX, clientY) => {
    const r = view.svg.getBoundingClientRect()
    const X = clientX - r.left
    const Y = clientY - r.top
    let best = null
    let bestD = Infinity
    for (const seg of view.L.segments) {
      const a = view.map(seg.x0, view.L.rows[seg.row].top)
      const b = view.map(seg.x1, seg.y + DIM.rail.t)
      const d = Math.hypot(Math.max(a.X - X, 0, X - b.X), Math.max(a.Y - Y, 0, Y - b.Y))
      if (d < bestD) {
        bestD = d
        best = seg.rule
      }
    }
    return best
  }
  function onDown(e, name) {
    if (e.button !== 0) return
    drag = { name, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
    const g = e.currentTarget
    const moveH = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return
      const dx = ev.clientX - drag.sx
      const dy = ev.clientY - drag.sy
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      const p = view.L.pos[name]
      if (!drag.moved) {
        drag.moved = true
        carry = null
        g.classList.add("is-carried")
        g.closest("svg").classList.add("is-dragging")
        // The place it came from stays drawn in phantom lines, as an alternate position.
        const ghost = g.cloneNode(true)
        ghost.classList.add("is-ghost")
        ghost.removeAttribute("tabindex")
        ghost.removeAttribute("data-link")
        for (const e of ghost.querySelectorAll("[data-link]")) e.removeAttribute("data-link")
        g.before(ghost)
        drag.ghost = ghost
        // Above every other part and label while it moves.
        const layer = s("g", { transform: view.geo.getAttribute("transform"), class: "drag-layer" }, view.svg)
        layer.append(g)
        view.svg.append(view.textEls[name])
        g.focus({ preventScroll: true })
      }
      const a = toAssembly(dx, dy)
      g.style.transform = `translate(${p.x + a.x}px, ${p.yTop + a.y}px)`
      view.textEls[name].style.transform = `translate(${dx}px, ${dy}px)`
      const target = ruleAt(ev.clientX, ev.clientY)
      for (const rule of ["pr", "push"]) view.railEls[rule].classList.toggle("is-target", rule === target)
      drag.target = target
      drag.a = a
    }
    const up = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return
      g.removeEventListener("pointermove", moveH)
      g.removeEventListener("pointerup", up)
      g.removeEventListener("pointercancel", up)
      const d = drag
      drag = null
      if (!d.moved) {
        if (carry?.name === name) return cancelCarry()
        return startCarry(name)
      }
      const p = view.L.pos[name]
      const from = { name, x: p.x + d.a.x, y: p.yTop + d.a.y, s: { X: view.map(p.x, p.yTop).X + (ev.clientX - d.sx), Y: view.map(p.x, p.yTop).Y + (ev.clientY - d.sy) } }
      drag?.ghost?.remove()
      d.ghost?.remove()
      view.textEls[name].style.transform = ""
      view.svg.classList.remove("is-dragging")
      const rule = ev.type === "pointercancel" ? p.rule : d.target
      if (rule === p.rule) renderAll({ from })
      else move(name, rule, from)
    }
    g.addEventListener("pointermove", moveH)
    g.addEventListener("pointerup", up)
    g.addEventListener("pointercancel", up)
  }

  // Keyboard and tap: pick up, choose a rail, put down.
  const ruleName = (r) => (r === "pr" ? "pull-request" : "push")
  function startCarry(name) {
    const rule = view.L.pos[name].rule
    carry = { name, target: rule === "pr" ? "push" : "pr" }
    paint()
    say(`Picked up ${name}. The arrow keys choose a rail; the ${ruleName(carry.target)} rail is chosen. Space puts it down, Escape cancels.`)
  }
  function cancelCarry() {
    carry = null
    paint()
    say("Put back.")
  }
  function onKey(e, name) {
    const k = e.key
    if (k === " " || k === "Enter") {
      e.preventDefault()
      if (!carry) return startCarry(name)
      if (carry.name === name) {
        const target = carry.target
        carry = null
        if (target === view.L.pos[name].rule) return renderAll({ focus: name })
        return move(name, target)
      }
    }
    if (!carry || carry.name !== name) return
    const dirs = { ArrowLeft: "pr", ArrowUp: "pr", ArrowRight: "push", ArrowDown: "push" }
    if (dirs[k]) {
      e.preventDefault()
      carry.target = dirs[k]
      paint()
      say(`The ${ruleName(carry.target)} rail.`)
    } else if (k === "Escape") {
      e.preventDefault()
      cancelCarry()
    }
  }
  // A tap on a rail while carrying puts the part there.
  dwgRoot.addEventListener("pointerup", (e) => {
    if (!carry || drag || e.target.closest(".part")) return
    const target = ruleAt(e.clientX, e.clientY)
    const name = carry.name
    carry = null
    if (target === view.L.pos[name].rule) return renderAll({ focus: name })
    move(name, target)
  })

  for (const r of radios) {
    r.addEventListener("click", () => {
      st.event = r.dataset.event
      renderAll()
    })
    r.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
      if (!d) return
      e.preventDefault()
      const next = radios[(radios.indexOf(r) + d + radios.length) % radios.length]
      st.event = next.dataset.event
      renderAll()
      next.focus()
    })
  }
  reset.addEventListener("click", () => {
    const event = st.event
    st = initial()
    st.event = event
    renderSource([34, 35])
    renderAll()
    view.partEls.deploy?.focus({ preventScroll: true })
    say("Back to the example's ci.ts.")
  })

  renderSource()
  // In two columns both end on the same pixel at rest: each is at least as tall as the other's
  // content. A diagnostic only lengthens the code.
  const pane = scope.querySelector(".hero-code .pane")
  const main = scope.querySelector(".hero-main")
  let fitting = false
  const fit = () => {
    if (fitting || st.refused) return
    fitting = true
    scope.style.removeProperty("--row-h")
    const h = Math.max(pane.offsetHeight, main.offsetHeight)
    scope.style.setProperty("--row-h", `${h}px`)
    requestAnimationFrame(() => (fitting = false))
  }
  new ResizeObserver(fit).observe(scope)
  links = linkScope(scope, (K, src) => {
    pointed = src
    showReadout()
  })
  renderAll({ flip: false })
  /**
   * The derivation on load: a scan reads ci.ts; each part is drawn as the line that declares it is
   * read, rails are hatched at lines 34 and 35 and their parts settle onto them, then the plan for
   * pull request #7 is applied. About two seconds. Off under reduced motion; any input ends it.
   */
  function derive() {
    const box = dwgRoot.getBoundingClientRect()
    if (reduced() || box.bottom < 0 || box.top > innerHeight) return
    const beside = matchMedia("(min-width: 1400px)").matches
    const STEP = 26
    const FIRST = 6
    const LAST = 37
    const time = (n) => (n - FIRST) * STEP
    const ease = "cubic-bezier(0.2, 0, 0, 1)"
    const anims = []
    const timers = []
    const at = (ms, fn) => timers.push(setTimeout(fn, ms))
    const svg = view.svg
    const L = view.L
    svg.classList.add("is-deriving")
    const all = [...svg.querySelectorAll(".part, .part-text, .plate, .plate-text, .rail, .rail-label, .socknums, .after, .t-joint, .t-after")]
    for (const e of all) e.style.opacity = "0"
    const lines = [...out.querySelectorAll(".oline")]
    for (const l of lines) l.style.opacity = "0"
    const lift = 10
    for (const p of Object.values(L.pos)) view.partEls[p.name].style.transform = `translate(${p.x}px, ${p.yTop - lift}px)`
    const draw = (g, dur = 440) => {
      if (!g) return
      g.style.opacity = ""
      for (const p of g.querySelectorAll(".outline, .rail-edge, .plate-body, .value-edge, .bit, .after-line")) {
        p.setAttribute("pathLength", "1")
        const a = p.animate([{ strokeDasharray: "1 1", strokeDashoffset: 1 }, { strokeDasharray: "1 1", strokeDashoffset: 0 }], { duration: dur, easing: ease })
        a.finished.then(() => p.removeAttribute("pathLength"), () => p.removeAttribute("pathLength"))
        anims.push(a)
      }
      for (const f of g.querySelectorAll(".body, .rail-fill, .tenon-wash, .pin, .after-head, .after-dot")) {
        anims.push(f.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: dur + 120, easing: ease }))
      }
    }
    const fade = (e, dur = 260) => {
      if (!e) return
      e.style.opacity = ""
      anims.push(e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: ease }))
    }
    const settle = (name) => {
      const p = L.pos[name]
      const g = view.partEls[name]
      g.style.transform = `translate(${p.x}px, ${p.yTop}px)`
      anims.push(g.animate([{ transform: `translate(${p.x}px, ${p.yTop - lift}px)` }, { transform: `translate(${p.x}px, ${p.yTop}px)` }], { duration: 300, easing: "cubic-bezier(0.3, 0, 0, 1)" }))
      anims.push(view.textEls[name].animate([{ transform: `translate(0, ${-lift * view.k}px)` }, { transform: "translate(0, 0)" }], { duration: 300, easing: "cubic-bezier(0.3, 0, 0, 1)" }))
    }
    let scanned = null
    const scan = (n) => {
      scanned?.classList.remove("is-scan")
      scanned = n ? code.querySelector(`.ln[data-line="${n}"]`) : null
      scanned?.classList.add("is-scan")
    }
    const PARTS_AT = { 9: "typecheck", 16: "test", 22: "site", 24: "deploy" }
    for (let n = FIRST; n <= LAST; n++) if (beside) at(time(n), () => scan(n))
    at(time(7), () => {
      for (const p of L.plates) {
        draw(p.el)
        fade(p.textEl)
      }
    })
    for (const [n, name] of Object.entries(PARTS_AT)) {
      at(time(Number(n)), () => {
        draw(view.partEls[name])
        at(260, () => fade(view.textEls[name]))
      })
    }
    at(time(25) + 200, () => svg.querySelectorAll(".t-joint").forEach((e) => fade(e)))
    at(time(26) + 200, () => {
      for (const g of view.afterEls) draw(g, 520)
      svg.querySelectorAll(".t-after").forEach((e) => fade(e))
    })
    for (const [n, rule] of [[34, "pr"], [35, "push"]]) {
      at(time(n), () => {
        draw(view.railEls[rule], 520)
        fade(view.railLabelEls?.[rule])
        fade(view.sockTextEls?.[rule])
        at(320, () => {
          for (const p of Object.values(L.pos)) if (p.rule === rule) settle(p.name)
        })
      })
    }
    const planAt = time(LAST) + 520
    at(time(LAST) + STEP, () => scan(null))
    at(planAt, () => {
      svg.classList.remove("is-deriving")
      lines.forEach((l, i) => {
        l.style.opacity = ""
        anims.push(l.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: i * 50, fill: "backwards" }))
      })
    })
    const finish = () => {
      for (const id of timers) clearTimeout(id)
      timers.length = 0
      for (const a of anims) a.finish?.()
      scan(null)
      for (const e of all) e.style.opacity = ""
      for (const l of lines) l.style.opacity = ""
      for (const p of Object.values(L.pos)) view.partEls[p.name].style.transform = `translate(${p.x}px, ${p.yTop}px)`
      for (const p of svg.querySelectorAll("[pathLength]")) p.removeAttribute("pathLength")
      svg.classList.remove("is-deriving")
      scope.removeEventListener("pointerdown", finish, true)
      scope.removeEventListener("keydown", finish, true)
      removeEventListener("resize", finish)
    }
    scope.addEventListener("pointerdown", finish, true)
    scope.addEventListener("keydown", finish, true)
    addEventListener("resize", finish)
    at(planAt + lines.length * 50 + 240, finish)
  }

  return { view, scope, code, out, derive, get state() { return st } }
}
