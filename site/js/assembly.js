import {
  DIM, RULES, SERVICES, bitOutline, bodyOutline, contactMarks, eyelet, fit, offsetOutline, pinOutline, pinX, plateOutline,
  railSection, socketEdge, tenonEdge, tenonOutline, toPath,
} from "./geometry.js"
import { FONT, arrowHead, hatch, measure, nextId, s, wrap } from "./svg.js"

// The steps of example/.calder/ci.ts as parts: what their types cut into them, and their lines.
export const PARTS = {
  install: { kind: "setup", line: 7 },
  typecheck: { kind: "task", line: 9, setup: "install" },
  test: { kind: "task", line: 16, setup: "install" },
  site: { kind: "build", line: 22, tenon: true },
  deploy: { kind: "action", line: 24, socket: true, needs: "site", pins: ["HttpClient"], bit: true, after: ["typecheck", "test"] },
}
const CODE_ORDER = ["typecheck", "test", "site", "deploy"]
const group = (n) => (PARTS[n].setup ? "dep" : PARTS[n].kind === "build" ? "build" : "action")
const RANK = { pr: { dep: 0, build: 1, action: 2 }, push: { build: 0, action: 1, dep: 2 } }

/** The drawing's order on a rail, which is also the order lines 34 and 35 list the steps in. */
export const order = (rule, names) =>
  names.slice().sort((a, b) => RANK[rule][group(a)] - RANK[rule][group(b)] || CODE_ORDER.indexOf(a) - CODE_ORDER.indexOf(b))

const joins = (a, b, refused) => a && b && PARTS[a].tenon && PARTS[b].needs === a && b !== refused

/**
 * Places every part from the arrangement. Pure: assembly coordinates, x along the rails, y down
 * with the rails' top at 0. `refused` is a part that stands on a rail it doesn't fit.
 */
export function layout({ arrangement, refused = null }, W, H, fill = 0) {
  const { lipW, pad, land, t } = DIM.rail
  const seq = []
  for (const rule of ["pr", "push"]) {
    const names = order(rule, arrangement[rule])
    if (!names.length) seq.push({ rule, empty: true })
    for (const name of names) seq.push({ rule, name })
  }
  const rails = { pr: { seats: [] }, push: { seats: [] } }
  rails.pr.x0 = 0
  let x = lipW + pad
  seq.forEach((it, i) => {
    const a = seq[i - 1]
    const tenonOut = (p) => (p?.name && PARTS[p.name].tenon ? DIM.tenon.depth : 0)
    if (a) {
      const joined = joins(a.name, it.name, refused)
      if (a.rule !== it.rule) {
        const bx = joined ? a.right + DIM.c / 2 : a.right + tenonOut(a) + pad
        rails[a.rule].x1 = bx
        rails[it.rule].x0 = bx
        x = joined ? a.right + DIM.c : bx + pad
      } else if (it.name === refused && a.rule === it.rule && PARTS[it.name].needs === a.name) {
        // A refused part stands clear of the tenon it couldn't come down onto.
        x = a.right + tenonOut(a) + 2 * DIM.c
      } else x = joined ? a.right + DIM.c : a.right + tenonOut(a) + land
    }
    it.x = x
    it.w = it.empty ? DIM.emptySeat : W
    it.right = x + it.w
    rails[it.rule].seats.push({ x, W: it.w, empty: !!it.empty, name: it.name })
  })
  const last = seq[seq.length - 1]
  rails[last.rule].x1 = last.right + (last.name && PARTS[last.name].tenon ? DIM.tenon.depth : 0) + pad + lipW
  // The last rail runs to the drawing's edge; free seats on it show its sockets and floor.
  if (fill > rails[last.rule].x1) {
    // A free seat is only sockets and a slot; it needs 12 px of rail after its slot.
    let fx = last.right + (last.name && PARTS[last.name].tenon ? DIM.tenon.depth : 0) + 12
    while (fx + W + 5 <= fill - lipW) {
      rails[last.rule].seats.push({ x: fx, W, free: true })
      fx += W + land
    }
    rails[last.rule].x1 = fill
  }

  // Plates: one under each run of neighbours that start from install. The first is the part, any
  // other is a phantom reference to it.
  const plates = []
  let run = null
  for (const it of seq) {
    if (it.name && PARTS[it.name].setup) {
      if (run && run.rule === it.rule) run.names.push(it.name)
      else plates.push((run = { rule: it.rule, names: [it.name] }))
    } else run = null
  }
  const pos = {}
  for (const it of seq) {
    if (!it.name) continue
    const onPlate = !!PARTS[it.name].setup
    const f = it.name === refused ? fit(PARTS[it.name], it.rule) : { rest: 0, contacts: [] }
    const yTop = -(H + (onPlate ? DIM.plate.t : 0) + f.rest)
    pos[it.name] = { name: it.name, rule: it.rule, x: it.x, yTop, W, H, rest: f.rest, contacts: f.contacts }
  }
  plates.forEach((p, i) => {
    const xs = p.names.map((n) => pos[n])
    p.x0 = Math.min(...xs.map((q) => q.x)) - DIM.plate.overhang
    p.x1 = Math.max(...xs.map((q) => q.x + W)) + DIM.plate.overhang
    p.phantom = i > 0
  })
  const joint = pos.site && pos.deploy && joins("site", "deploy", refused) && pos.deploy.x === pos.site.x + W + DIM.c
    ? { x: pos.site.x + W + DIM.c / 2, y: pos.site.yTop + H / 2, top: Math.min(pos.site.yTop, pos.deploy.yTop) }
    : null
  return { seq, pos, rails, plates, joint, W, H, refused, width: rails.push.x1 ?? rails.pr.x1, bottom: t }
}

// Where the after links run when their ends are in different rows: right of every rail.
const LANE = 20

/** Runs of the sequence that never split across rows: a plate run, and a tenon in its socket. */
function groupsOf(L) {
  const groups = []
  let g = null
  L.seq.forEach((it, i) => {
    const a = L.seq[i - 1]
    const plated = (n) => n && PARTS[n].setup
    const together = a && it.name && a.name && (joins(a.name, it.name, L.refused) || (plated(a.name) && plated(it.name) && a.rule === it.rule))
    if (together) g.items.push(it)
    else groups.push((g = { items: [it] }))
  })
  for (const gr of groups) {
    const last = gr.items[gr.items.length - 1]
    gr.left = gr.items[0].x
    gr.right = last.right + (last.name && PARTS[last.name].tenon ? DIM.tenon.depth : 0)
    gr.plateLeft = !!(gr.items[0].name && PARTS[gr.items[0].name].setup)
    gr.plateRight = !!(last.name && PARTS[last.name].setup)
  }
  return groups
}

/** The widest group any arrangement of the example makes: a row must hold it at any width. */
export const widestGroup = (() => {
  let cache = null
  return (W, H) => {
    if (cache) return cache
    let max = 0
    for (let m = 0; m < 16; m++) {
      const where = ["typecheck", "test", "site"].map((n, i) => [n, m & (1 << i) ? "push" : "pr"])
      const refused = m & 8
      const pr = where.filter(([, r]) => r === "pr").map(([n]) => n)
      const push = where.filter(([, r]) => r === "push").map(([n]) => n)
      ;(refused ? pr : push).push("deploy")
      const L = layout({ arrangement: { pr: order("pr", pr), push: order("push", push) }, refused: refused ? "deploy" : null }, W, H)
      for (const g of groupsOf(L)) max = Math.max(max, g.right - g.left)
    }
    return (cache = max + 2 * (DIM.rail.lipW + DIM.rail.pad) + LANE)
  }
})()

/**
 * Breaks the one long line of rails into rows no wider than `budget` and moves everything onto
 * them: parts, plates, the joint, rail segments, in place. One row when it all fits. A rail that
 * runs on into the next row ends in a break line and starts the next row with one.
 */
export function wrapRows(L, budget, { labelBand = 0, extra = [], after = true, rise = DIM.after.rise } = {}) {
  const { lipW, pad, t } = DIM.rail
  const rows = []
  for (const g of groupsOf(L)) {
    const row = rows[rows.length - 1]
    if (row && g.right - row.left + 2 * (lipW + pad) + LANE <= budget) {
      row.groups.push(g)
      row.right = g.right
    } else rows.push({ groups: [g], left: g.left, right: g.right })
  }
  const cuts = []
  for (let r = 0; r < rows.length - 1; r++) {
    const a = rows[r]
    const b = rows[r + 1]
    let c = (a.right + b.left) / 2
    if (a.groups[a.groups.length - 1].plateRight) c = Math.max(c, a.right + DIM.plate.overhang + 1)
    if (b.groups[0].plateLeft) c = Math.min(c, b.left - DIM.plate.overhang - 1)
    cuts.push(c)
  }
  const rowOf = (x) => {
    let r = 0
    while (r < cuts.length && x >= cuts[r]) r++
    return r
  }
  // Levels each row needs above its parts for the after links that run there.
  const levels = rows.map(() => 0)
  // The word "after" goes over the links when they stay in a row, and beside the lane when not.
  let labelled = true
  const tgt = L.pos.deploy
  if (after && tgt) {
    const tr = rowOf(tgt.x)
    let across = false
    for (const n of PARTS.deploy.after) {
      const p = L.pos[n]
      if (!p) continue
      const sr = rowOf(p.x)
      levels[sr]++
      across ||= sr !== tr
    }
    // Links from other rows share one lane and come in at one level.
    if (across) levels[tr]++
    labelled = !across
  }
  let y = 0
  rows.forEach((row, r) => {
    const names = row.groups.flatMap((g) => g.items).filter((it) => it.name).map((it) => it.name)
    // A row with only an empty seat needs no room for parts above its rail.
    const partsTop = names.length ? Math.min(-L.H, ...names.map((n) => L.pos[n].yTop)) : -DIM.rail.lipH - 8
    const band = levels[r] ? rise + DIM.after.step * (levels[r] - 1) + (labelled ? 20 : 6) : 12
    if (r > 0) y += t + labelBand + (extra[r - 1] ?? 0) + band - partsTop
    row.sx = lipW + pad - row.left
    row.y = y
    row.partsTop = y + partsTop
    row.top = row.partsTop - band
    for (const n of names) {
      const p = L.pos[n]
      p.x += row.sx
      p.yTop += y
      p.row = r
    }
  })
  for (const p of L.plates) {
    const row = rows[L.pos[p.names[0]].row]
    p.x0 += row.sx
    p.x1 += row.sx
    p.y = row.y
  }
  if (L.joint) {
    const row = rows[L.pos.site.row]
    L.joint = { x: L.joint.x + row.sx, y: L.joint.y + row.y, top: L.joint.top + row.y }
  }
  const segments = []
  for (const rule of ["pr", "push"]) {
    const rail = L.rails[rule]
    rows.forEach((row, r) => {
      const lo = r === 0 ? -Infinity : cuts[r - 1]
      const hi = r === rows.length - 1 ? Infinity : cuts[r]
      const a = Math.max(rail.x0, lo)
      const b = Math.min(rail.x1, hi)
      if (b - a < 0.5) return
      segments.push({
        rule,
        row: r,
        x0: a + row.sx,
        x1: b + row.sx,
        y: row.y,
        seats: rail.seats.filter((st) => st.x >= a && st.x < b).map((st) => ({ ...st, x: st.x + row.sx })),
        lipStart: rule === "pr" && a === rail.x0,
        lipEnd: rule === "push" && b === rail.x1,
        cutStart: a === lo && a > rail.x0,
        cutEnd: b === hi && b < rail.x1,
      })
    })
  }
  L.rows = rows
  L.segments = segments
  L.width = Math.max(...segments.map((sg) => sg.x1))
  L.bottom = rows[rows.length - 1].y + t
  L.top = rows[0].top
  return L
}

/**
 * Routes the `after` links: up from each source, across, down into the eyelet on the target's top.
 * A link between rows runs up to its row's level, right to a lane beyond the rails, and along it to
 * the target's row. Each route is a polyline.
 */
export function afterRoutes(L, rise) {
  const tgt = L.pos.deploy
  if (!tgt) return []
  const half = L.W / 2
  const cx = tgt.x + half
  const ey = tgt.yTop - DIM.eyelet.r
  const sources = PARTS.deploy.after.map((n) => L.pos[n]).filter(Boolean)
  const used = {}
  const level = (row) => {
    used[row] = (used[row] ?? -1) + 1
    return L.rows[row].partsTop - rise - DIM.after.step * used[row]
  }
  const same = sources.filter((p) => p.row === tgt.row)
  const left = same.filter((p) => p.x + half < cx).sort((a, b) => b.x - a.x)
  const right = same.filter((p) => p.x + half > cx).sort((a, b) => a.x - b.x)
  const routes = []
  for (const p of [...left, ...right]) {
    const y = level(p.row)
    routes.push({ from: p.name, pts: [[p.x + half, p.yTop], [p.x + half, y], [cx, y], [cx, ey]] })
  }
  const across = sources.filter((q) => q.row !== tgt.row)
  const yt = across.length ? level(tgt.row) : 0
  const lx = L.width + 12
  for (const p of across) {
    const ys = level(p.row)
    routes.push({ from: p.name, pts: [[p.x + half, p.yTop], [p.x + half, ys], [lx, ys], [lx, yt], [cx, yt], [cx, ey]] })
  }
  return routes
}

/** A polyline with rounded corners, on half pixels at 1:1. */
const roundPath = (pts, R) => {
  const q = pts.map(([x, y], i) => [Math.round(x) + 0.5, i === 0 || i === pts.length - 1 ? y : Math.round(y) + 0.5])
  let d = `M${q[0][0]} ${q[0][1]}`
  for (let i = 1; i < q.length - 1; i++) {
    const [ax, ay] = q[i - 1]
    const [x, y] = q[i]
    const [bx, by] = q[i + 1]
    const l1 = Math.hypot(x - ax, y - ay)
    const l2 = Math.hypot(bx - x, by - y)
    const r = Math.min(R, l1 / 2, l2 / 2)
    d += `L${x - ((x - ax) / l1) * r} ${y - ((y - ay) / l1) * r}Q${x} ${y} ${x + ((bx - x) / l2) * r} ${y + ((by - y) / l2) * r}`
  }
  const [lx, ly] = q[q.length - 1]
  return `${d}L${lx} ${ly}`
}

/** A rail section as drawn: hatched material with a thick outline. */
export function drawRail(parent, sec, fillId, cls = "rail") {
  const g = s("g", { class: cls }, parent)
  for (const p of sec.polys) s("path", { d: toPath(p), class: "rail-fill", fill: `url(#${fillId})` }, g)
  for (const p of sec.polys) s("path", { d: toPath(p), class: "rail-edge" }, g)
  return g
}

/**
 * A part's shapes in part coordinates: ring, body, value profile, pins, bit, eyelet, outline, and red
 * marks where a feature stands on a rail it doesn't fit. `spec` may override pins and bit.
 */
export function drawPartShape(g, spec, { W, H, contacts = [], owner = null }) {
  const outline = bodyOutline({ W, H, tenon: spec.tenon, socket: spec.socket })
  s("path", { d: toPath(offsetOutline(outline, 4)), class: "ring" }, g)
  s("path", { d: toPath(outline), class: "body" }, g)
  // A chamfered top edge leaves a line in elevation: the part reads as machined, not as a box.
  s("path", { d: `M${DIM.corner} ${DIM.chamfer}H${W - DIM.corner}`, class: "face" }, g)
  if (spec.tenon) s("path", { d: toPath(tenonOutline({ W, H })), class: "tenon-wash", "data-link": "f:tenon", "data-owner": owner }, g)
  for (const sv of spec.pins ?? []) s("path", { d: toPath(pinOutline(sv, H)), class: `pin${sv.startsWith("Secret") ? " is-secret" : ""}`, "data-link": "f:pin", "data-owner": owner }, g)
  if (spec.bit) s("path", { d: toPath(bitOutline(W, H)), class: "bit", "data-link": "f:bit", "data-owner": owner }, g)
  s("path", { d: toPath(outline), class: "outline" }, g)
  if (spec.after) {
    const e = eyelet(W)
    const eg = s("g", { class: "eyelet", "data-link": "f:after", "data-owner": owner }, g)
    s("circle", { cx: e.x, cy: e.y, r: e.r, class: "eyelet-body" }, eg)
    s("circle", { cx: e.x, cy: e.y, r: e.hole, class: "eyelet-hole" }, eg)
  }
  if (spec.socket) s("path", { d: toPath(socketEdge({ H }), false), class: "value-edge", "data-link": "f:socket", "data-owner": owner }, g)
  if (spec.tenon) s("path", { d: toPath(tenonEdge({ W, H }), false), class: "value-edge", "data-link": "f:tenon", "data-owner": owner }, g)
  for (const m of contactMarks({ ...spec, W }, H, contacts)) s("path", { d: `M${m.x0} ${m.y + 1}H${m.x1}`, class: "contact" }, g)
  return g
}

const KIND_CLASS = { setup: "setup", task: "task", build: "build", action: "action" }

/** "1, 2 and 3": the socket numbers a rule's rail is drilled with. */
export const socketList = (rule) => {
  const n = RULES[rule].supplies.map((sv) => SERVICES.indexOf(sv) + 1).sort((a, b) => a - b)
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`
}
const railNote = (rule) => `Sockets ${socketList(rule)}. ${RULES[rule].floor === "closed" ? "Closed floor, no grants." : "Open floor, any grant."}`

/**
 * Draws an assembly into `root` (an element the SVG fills). Wide roots get one row of rails at 1:1,
 * scaled down below the width four parts need; roots narrower than `rowsBelow` get the rails in rows.
 * `options.small` draws the compact views further down the page.
 */
export class AssemblyView {
  constructor(root, options = {}) {
    this.root = root
    this.options = options
    this.state = { arrangement: { pr: ["typecheck", "test", "site"], push: ["deploy"] }, refused: null, plan: null, marks: {} }
    this.svg = s("svg", { class: `dwg${options.small ? " is-small" : ""}`, "aria-hidden": options.interactive ? null : "true" }, root)
    this.ids = { prLive: nextId("h"), pushLive: nextId("h"), prOff: nextId("h"), pushOff: nextId("h") }
    this.lastWidth = 0
    this.ro = new ResizeObserver(() => {
      if (this.contentWidth() !== this.lastWidth) this.render()
    })
    this.ro.observe(root)
  }

  set(patch) {
    Object.assign(this.state, patch)
    this.render()
  }

  /** The root's width inside its padding: what the drawing may fill. */
  contentWidth() {
    const cs = getComputedStyle(this.root)
    return Math.floor(this.root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
  }

  /**
   * Part size and drawing scale. One row draws at 1:1 and fits the part width to the sheet; below
   * the width four parts need, the whole drawing is scaled down. In rows, the scale is the one at
   * which the widest group of any arrangement fills a row, so moving a part never rescales.
   */
  measure() {
    const width = this.contentWidth()
    const rows = width < (this.options.rowsBelow ?? 560)
    // In rows the parts are shorter: their height carries only lettering, so the rows fit a phone.
    const H = this.options.H ?? (rows ? DIM.Hrows : DIM.H)
    let W = this.options.W ?? DIM.minW
    let k = 1
    if (rows) k = Math.min(1, (width - 2) / widestGroup(W, H))
    else if (!this.options.W && this.options.partWidth) {
      W = this.options.partWidth(width)
      const need = this.options.partWidth.need?.(W) ?? 0
      if (need > width) k = Math.max(0.6, width / need)
    }
    return { width, rows, H, W, k }
  }

  /**
   * Draws, then checks that every row's captions end above the next row; where one doesn't, that
   * row's caption band grows by the difference and the drawing is drawn again.
   */
  render() {
    const extra = []
    for (let pass = 0; pass < 3; pass++) {
      const over = this.renderOnce(extra)
      if (!over?.some((d) => d > 0)) return
      over.forEach((d, r) => (extra[r] = (extra[r] ?? 0) + Math.max(0, d) / this.k))
    }
  }

  renderOnce(extra) {
    const { width, rows, H, W, k } = this.measure()
    if (!width) return null
    this.lastWidth = width
    const rise = rows ? 16 : DIM.after.rise
    const noAfter = !!this.options.noAfter
    const labels = !this.options.noRailLabels
    const L = layout(this.state, W, H, rows || this.options.noFill ? 0 : (width - 2) / k)
    wrapRows(L, rows ? (width - 2) / k : Infinity, { labelBand: labels ? 58 / k : 24 / k, extra, after: !noAfter, rise })
    this.L = L
    this.k = k
    this.rowsMode = rows
    this.inRows = L.rows.length > 1
    const svg = this.svg
    svg.replaceChildren()
    svg.classList.toggle("is-scaled", k !== 1)
    const defs = s("defs", {}, svg)
    // Hatching keeps a 5 px pitch and a 1 px line at any drawing scale.
    const hatchK = (id, angle, gap, cls) => hatch(defs, id, angle, gap / k, cls).firstChild.setAttribute("style", `stroke-width:${1 / k}px`)
    hatchK(this.ids.prLive, 45, 5, "hatch-line")
    hatchK(this.ids.pushLive, -45, 5, "hatch-line")
    hatchK(this.ids.prOff, 45, 5, "hatch-line is-off")
    hatchK(this.ids.pushOff, -45, 5, "hatch-line is-off")
    this.ids.plate ??= nextId("h")
    hatchK(this.ids.plate, 60, 6, "hatch-line is-plate")

    const routes = noAfter ? [] : afterRoutes(L, rise)
    const top = L.top
    const labelBelow = labels ? 52 : 8
    const pad = this.options.pad ?? { l: 1, t: 1 }
    const map = (x, y) => ({ X: x * k + pad.l, Y: (y - top) * k + pad.t })
    this.map = map
    const geo = s("g", { class: "geo", transform: `translate(${pad.l} ${pad.t - top * k}) scale(${k})` }, svg)
    const text = s("g", { class: "txt" }, svg)
    this.geo = geo
    this.text = text
    const live = this.state.plan?.live

    // Rails, in section, a segment per row; the sockets numbered under each seat.
    this.railEls = {}
    this.sockets = []
    const { t, socket: sd } = DIM.rail
    for (const rule of ["pr", "push"]) {
      const on = !this.state.plan || live === rule
      const fillId = on ? (rule === "pr" ? this.ids.prLive : this.ids.pushLive) : rule === "pr" ? this.ids.prOff : this.ids.pushOff
      const g = s("g", { class: `rail rail-${rule}${on ? " is-live" : " is-quiet"}`, "data-link": `rail:${rule}` }, geo)
      for (const seg of L.segments.filter((sg) => sg.rule === rule)) {
        const seats = seg.seats.filter((q) => !q.empty)
        const sec = railSection({ rule, x0: seg.x0, x1: seg.x1, seats, lipStart: seg.lipStart, lipEnd: seg.lipEnd, cutStart: seg.cutStart, cutEnd: seg.cutEnd })
        const sg = s("g", { transform: `translate(0 ${seg.y})` }, g)
        drawRail(sg, sec, fillId, "rail-seg")
        for (const seat of seats) {
          const holes = sec.holes.filter((h) => h.x0 >= seat.x && h.x1 <= seat.x + seat.W)
          if (!holes.length) continue
          s("rect", { x: holes[0].x0 - 1.5, y: sd + 1.5, width: holes[holes.length - 1].x1 - holes[0].x0 + 3, height: t - sd - 3.5, class: "sock-clear" }, sg)
          for (const h of holes) {
            const n = SERVICES.indexOf(h.service) + 1
            s("path", { d: `M${h.x0} 0V${sd}H${h.x1}V0`, class: "sock-edge", "data-link": `socket:${n}` }, sg)
            this.sockets.push({ rule, n, x: (h.x0 + h.x1) / 2, y: seg.y + sd + 1.5 + (t - sd - 3.5) / 2 })
          }
          // Where this rule supplies nothing, the rail is solid: drawn only while that socket is lit.
          for (const sv of SERVICES.slice(0, 6)) {
            if (RULES[rule].supplies.includes(sv)) continue
            const hx = seat.x + pinX(sv) - DIM.pin.clear
            s("path", { d: `M${hx} 0V${sd}H${hx + DIM.pin.w + 2 * DIM.pin.clear}V0`, class: "sock-ghost", "data-link": `socket:${SERVICES.indexOf(sv) + 1}` }, sg)
          }
          for (const h of holes) s("rect", { x: h.x0 - 2, y: -2, width: h.x1 - h.x0 + 4, height: t, class: "sock-hit", "data-link": `socket:${SERVICES.indexOf(h.service) + 1}` }, sg)
        }
      }
      this.railEls[rule] = g
    }

    // Plates, in section: the base the tasks stand on.
    for (const p of L.plates) {
      const g = s("g", { class: `plate${p.phantom ? " is-ref" : ""}`, "data-link": "f:plate", transform: `translate(0 ${p.y})` }, geo)
      s("path", { d: toPath(plateOutline(p.x0, p.x1)), class: "plate-fill", fill: `url(#${this.ids.plate})` }, g)
      s("path", { d: toPath(plateOutline(p.x0, p.x1)), class: "plate-body" }, g)
      p.el = g
    }

    // After links.
    this.afterEls = []
    for (const r of routes) {
      const g = s("g", { class: "after", "data-link": "f:after", "data-from": r.from }, geo)
      const pts = r.pts.map((p) => p.slice())
      pts[0][1] -= 1
      const end = pts[pts.length - 1]
      const tip = end[1] - 1
      end[1] = tip - DIM.after.head
      s("path", { d: roundPath(pts, 5), class: "after-line" }, g)
      s("circle", { cx: Math.round(pts[0][0]) + 0.5, cy: pts[0][1] - 0.5, r: 2.5, class: "after-dot" }, g)
      arrowHead(g, Math.round(end[0]) + 0.5, tip, 0, 1, DIM.after.head, "after-head")
      this.afterEls.push(g)
    }

    // Parts.
    this.partEls = {}
    const planned = this.state.plan?.planned
    for (const p of Object.values(L.pos)) {
      const spec = PARTS[p.name]
      const g = s("g", {
        class: `part k-${KIND_CLASS[spec.kind]}`,
        "data-link": `part:${p.name}`,
        "data-name": p.name,
      }, geo)
      // Positioned by CSS, so drags and slides can move it without losing its place.
      g.style.transform = `translate(${p.x}px, ${p.yTop}px)`
      drawPartShape(g, spec, { W, H, contacts: p.contacts, owner: `part:${p.name}` })
      if (planned) g.classList.toggle("is-off", !planned.has(p.name))
      this.partEls[p.name] = g
    }
    if (L.pos.install === undefined && planned) for (const p of L.plates) p.el.classList.toggle("is-off", !planned.has("install"))

    // Labels in screen space.
    this.textEls = {}
    for (const p of Object.values(L.pos)) this.textEls[p.name] = this.partText(p, text)
    for (const p of L.plates) this.plateText(p, text)
    if (L.joint && !this.options.small) {
      const j = map(L.joint.x, L.joint.top)
      s("text", { x: j.X, y: j.Y - 9, class: "t-joint", "text-anchor": "middle", "data-link": "f:socket" }, text).textContent = "StorePath"
    }
    const lanes = routes.filter((r) => r.pts.length > 4)
    if (!lanes.length && routes.length) {
      // On the highest run.
      const runs = routes.map((r) => [r.pts[1], r.pts[2]])
      const [a, b] = runs.reduce((p, q) => (q[0][1] < p[0][1] ? q : p))
      const m = map((a[0] + b[0]) / 2, a[1])
      s("text", { x: m.X, y: m.Y - 7, class: "t-after", "text-anchor": "middle", "data-link": "f:after" }, text).textContent = "after"
    }
    this.captionBoxes = null
    this.captionBottoms = null
    if (labels) this.railLabels(L, text)
    if (lanes.length) this.laneLabel(L, lanes[0], text)
    this.socketNumbers(text)

    // Size.
    const tb = text.getBBox()
    const lane = routes.some((r) => r.pts.length > 4) ? LANE : 0
    const w = Math.min(width, Math.ceil(Math.max((L.width + lane) * k + pad.l, tb.x + tb.width) + 2))
    const hgt = Math.ceil(Math.max((L.bottom - top) * k + pad.t + labelBelow, tb.y + tb.height + 4))
    svg.setAttribute("width", w)
    svg.setAttribute("height", hgt)
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`)
    this.size = { w, h: hgt }
    this.options.onRender?.(this)
    // How far each row's captions reach into the row below (the joint's label sits above its band).
    return L.rows.slice(0, -1).map((_, r) => {
      const next = L.rows[r + 1]
      const jointHere = L.joint && L.pos.site.row === r + 1
      return (this.captionBottoms?.[r] ?? 0) + 6 - (map(0, next.top).Y - (jointHere ? 8 : 0))
    })
  }

  faceBox(p) {
    const a = this.map(p.x, p.yTop)
    const b = this.map(p.x + p.W, p.yTop + p.H)
    return { left: a.X, right: b.X, top: a.Y, bottom: b.Y }
  }

  partText(p, parent) {
    const spec = PARTS[p.name]
    const box = this.faceBox(p)
    const socketInset = spec.socket ? (DIM.tenon.depth + DIM.c + 2) * this.k : 0
    const x = box.left + 12 + socketInset
    const y = box.top + 12
    const g = s("g", { class: "part-text", "data-name": p.name }, parent)
    const small = this.options.small
    // A face narrower than a name at full size takes the name a size down.
    const tight = box.right - x - 8 < measure(p.name, FONT.name)
    s("text", { x, y: y + (small ? 12 : 13), class: `t-name${tight ? " is-tight" : ""}` }, g).textContent = p.name
    const files = this.options.files?.(p.name)
    if (files) {
      // A task with a key per file: each file is a cartridge in it, drawn at full weight when it runs
      // and in thin lines when its result is reused. Narrow faces use the files' short names.
      const narrow = box.right - box.left < 150
      const cw = box.right - box.left - 24
      files.forEach(([file, state], i) => {
        const ty = y + 24 + i * 25
        s("rect", { x: x + 0.5, y: ty + 0.5, width: Math.round(cw), height: 20, rx: 2, class: `cart${state === "runs" ? " is-runs" : ""}` }, g)
        s("text", { x: x + 8, y: ty + 15, class: `t-file${state === "runs" ? " is-runs" : ""}` }, g).textContent = narrow ? file.replace(".test.ts", "") : file
      })
    } else {
      const kind = s("text", { x, y: y + (small ? 29 : 31), class: "t-kind" }, g)
      kind.textContent = spec.kind
      const note = this.options.note?.(p.name)
      if (note) {
        const tspan = s("tspan", { class: "t-note" }, kind)
        tspan.textContent = `, ${note}`
      }
    }
    if (!small && !files) {
      const r = DIM.item.r
      const cx = box.right - DIM.item.inset - r - 0.5
      const cy = box.bottom - DIM.item.inset - r - 0.5
      s("circle", { cx, cy, r, class: "item" }, g)
      s("text", { x: cx, y: cy + 4, class: "t-item", "text-anchor": "middle" }, g).textContent = String(spec.line)
    }
    return g
  }

  plateText(p, parent) {
    const a = this.map(p.x0, p.y - DIM.plate.t)
    const b = this.map(p.x1, p.y)
    const g = s("g", { class: `plate-text${p.phantom ? " is-ref" : ""}` }, parent)
    const note = !p.phantom ? this.options.plateNote?.() : null
    const tx = a.X + 12
    const ty = a.Y + (b.Y - a.Y) / 2 + 4.5
    // Hatching stops where the plate's name is lettered, as on a drawing.
    const w = measure("install", FONT.mono) + (note ? measure(`, ${note}`, FONT.note) : 0)
    s("rect", { x: tx - 4, y: ty - 13, width: w + 8, height: 17, class: "clear" }, g)
    const t = s("text", { x: tx, y: ty, class: "t-plate" }, g)
    t.textContent = "install"
    if (note) s("tspan", { class: "t-note" }, t).textContent = `, ${note}`
    if (!p.phantom && !this.options.small) {
      const r = 9
      const cx = b.X - 8 - r - 0.5
      const cy = ty - 4.5
      s("circle", { cx, cy, r, class: "item" }, g)
      s("text", { x: cx, y: cy + 4, class: "t-item", "text-anchor": "middle" }, g).textContent = "7"
    }
    p.textEl = g
    return g
  }

  /** Each socket's number, lettered in the rail under it, on ground cleared of hatching. */
  socketNumbers(parent) {
    // 11 px wherever the rails are one row, down to the 0.6 scale that allows; 10 px in the rows on
    // phones, which the cleared ground holds at their smallest scale.
    const size = this.rowsMode ? Math.max(10, Math.min(11, Math.round(11 * this.k))) : 11
    this.sockTextEls = { pr: s("g", { class: "socknums" }, parent), push: s("g", { class: "socknums" }, parent) }
    for (const q of this.sockets) {
      const m = this.map(q.x, q.y)
      const on = !this.state.plan || this.state.plan.live === q.rule
      s("text", { x: m.X, y: m.Y + size * 0.36, class: `t-sock${on ? "" : " is-quiet"}`, "text-anchor": "middle", style: `font-size:${size}px`, "data-link": `socket:${q.n}` }, this.sockTextEls[q.rule]).textContent = String(q.n)
    }
  }

  /**
   * Each rule's caption goes under its first segment, starting where that rail starts, and a rail
   * that goes on from the row above is named again under its continuation. Captions in a row never
   * overlap, so no caption ever sits under another rule's rail.
   */
  railLabels(L, parent) {
    const live = this.state.plan?.live
    const { lipW, t } = DIM.rail
    const limit = this.lastWidth - 4
    this.railLabelEls = {}
    for (const rule of ["pr", "push"]) {
      const on = !this.state.plan || live === rule
      this.railLabelEls[rule] = s("g", { class: `rail-label${on ? " is-live" : " is-quiet"}`, "data-link": `rail:${rule}` }, parent)
    }
    const firstOf = (rule) => L.segments.find((q) => q.rule === rule)
    this.captionBottoms = L.rows.map(() => 0)
    this.captionBoxes = L.rows.map(() => [])
    L.rows.forEach((_, r) => {
      const named = L.segments.filter((sg) => sg.row === r && (sg === firstOf(sg.rule) || sg.cutStart)).sort((p, q) => p.x0 - q.x0)
      const startX = (seg) => this.map(seg.x0 + (seg.lipStart ? lipW : 6), seg.y + t).X
      let cursor = -Infinity
      named.forEach((seg, i) => {
        const spec = RULES[seg.rule]
        const note = seg === firstOf(seg.rule) ? railNote(seg.rule) : null
        const labelW = measure(spec.label, FONT.mono)
        const x = Math.max(startX(seg), cursor)
        // A caption keeps under its own rail: up to the next caption's start, or the drawing's edge.
        const next = named[i + 1]
        const avail = (next ? startX(next) - 12 : limit) - x
        // Number and name; the name alone where both don't fit; the number alone where neither does,
        // since the rule's full caption carries the same number.
        const form = labelW + 28 <= avail ? "full" : labelW <= avail ? "name" : "number"
        const g = this.railLabelEls[seg.rule]
        const y = this.map(0, seg.y + t).Y + 22
        const box = (x0, x1, yb) => this.captionBoxes[r].push({ x0, x1, y0: yb - 12, y1: yb + 4 })
        if (form !== "name") {
          s("circle", { cx: x + 10, cy: y - 4.5, r: 10, class: "item" }, g)
          s("text", { x: x + 10, y: y - 0.5, class: "t-item", "text-anchor": "middle" }, g).textContent = String(spec.line)
        }
        const lx = form === "full" ? x + 28 : x
        if (form !== "number") s("text", { x: lx, y, class: "t-rule" }, g).textContent = spec.label
        let right = form === "number" ? x + 20 : lx + labelW
        box(x, right, y)
        let ly = y
        for (const [j, line] of (note ? wrap(note, FONT.note, Math.max(60, avail)) : []).entries()) {
          ly += j ? 17 : 20
          s("text", { x, y: ly, class: "t-railnote" }, g).textContent = line
          const lw = measure(line, FONT.note)
          right = Math.max(right, x + lw)
          box(x, x + lw, ly)
        }
        cursor = right + 16
        this.captionBottoms[r] = Math.max(this.captionBottoms[r], ly + 5)
      })
    })
  }

  /**
   * "after", beside the lane the links between rows run up: on the first caption line of the row
   * the lane passes that is free at the lane's edge.
   */
  laneLabel(L, lane, parent) {
    const r0 = Math.min(L.pos[lane.from].row, L.pos.deploy.row)
    const X = this.map(lane.pts[2][0], 0).X - 6
    const w = measure("after", FONT.label)
    let y = this.map(0, L.rows[r0].y + DIM.rail.t).Y + 22
    const boxes = this.captionBoxes?.[r0] ?? []
    while (boxes.some((b) => b.x1 > X - w - 6 && b.x0 < X && b.y1 > y - 12 && b.y0 < y + 4)) y += 17
    s("text", { x: X, y, class: "t-after", "text-anchor": "end", "data-link": "f:after" }, parent).textContent = "after"
    if (this.captionBottoms) this.captionBottoms[r0] = Math.max(this.captionBottoms[r0], y + 5)
  }
}

export const measureText = measure
