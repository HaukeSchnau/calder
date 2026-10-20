import { AssemblyView, PARTS, drawPartShape, drawRail } from "./assembly.js"
import { DIM, RULES, SERVICES, bitOutline, bitX, bodyOutline, fit, partWidth, pinOutline, pinX, plateOutline, railSection, toPath } from "./geometry.js"
import { ARRANGEMENTS } from "./plans.js"
import { CI_TS, DEPLOY_TS, TEST_TS, TSC, esc, highlight, indentOf, keepWords, lineEl, oline, parsePlan, renderCode } from "./source.js"
import { FONT, arrowHead, h, hatch, measure, nextId, s } from "./svg.js"

const $ = (sel, root = document) => root.querySelector(sel)

/** A drawing sheet: an SVG with the two hatch patterns. */
function sheet(parent, w, hgt, label, k = 1) {
  const svg = s("svg", { class: "dwg", width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: label ? "img" : null, "aria-label": label, "aria-hidden": label ? null : "true" }, parent)
  const defs = s("defs", {}, svg)
  const ids = { pr: nextId("h"), push: nextId("h") }
  // Hatching keeps its 5 px pitch and 1 px line at any drawing scale.
  for (const [id, angle] of [[ids.pr, 45], [ids.push, -45]]) hatch(defs, id, angle, 5 / k, "hatch-line").firstChild.setAttribute("style", `stroke-width:${1 / k}px`)
  return { svg, ids }
}

/** Redraws `draw(width)` whenever the element's width changes. */
const onWidth = (el, draw) => {
  let last = -1
  new ResizeObserver(() => {
    const w = el.clientWidth
    if (w && w !== last) {
      last = w
      el.replaceChildren()
      draw(w)
    }
  }).observe(el)
}
/** A vertical break line, where a partial view stops at its side. */
const breakLineV = (parent, x, y0, y1) => {
  const m = (y0 + y1) / 2
  s("path", { d: `M${x} ${y0 - 6}V${m - 6}L${x - 6} ${m - 2}L${x + 6} ${m + 2}L${x} ${m + 6}V${y1 + 6}`, class: "leader" }, parent)
}

const text = (parent, x, y, str, cls, anchor) => {
  const t = s("text", { x, y, class: cls, "text-anchor": anchor }, parent)
  t.textContent = str
  return t
}
const balloon = (parent, x, y, label) => {
  s("circle", { cx: x, cy: y, r: 11, class: "balloon" }, parent)
  text(parent, x, y + 4.5, label, "t-balloon", "middle")
}
/**
 * A callout naming the feature that decides a fit: words starting at x on baseline y, and a short
 * leader from (lx, ly) on their edge to a dot on the feature at (fx, fy).
 */
const callout = (parent, { x, y, lx, ly, fx, fy, words, err = false }) => {
  const g = s("g", { class: `callout${err ? " is-err" : ""}` }, parent)
  text(g, x, y, words, "t-callout")
  s("path", { d: `M${lx} ${ly}L${fx} ${fy}`, class: "leader" }, g)
  s("circle", { cx: fx, cy: fy, r: 2, class: "leader-dot" }, g)
}
/**
 * Places a callout for a feature at (fx, fy) in a drawing `w` wide: beside it inside the band from
 * `band[0]` to `band[1]` when the words fit there, otherwise on the line `alt` (above or below the
 * drawing), with the leader running to it.
 */
const placeCallout = (parent, { fx, fy, w, band, alt, words, err, avoid = null, face = [4, w - 4] }) => {
  const tw = measure(words, FONT.callout)
  const y = band[1] - 14
  const tall = band[1] - band[0] >= 64
  if (tall && fx + 44 + tw <= face[1] - 12) return callout(parent, { x: fx + 44, y, lx: fx + 40, ly: y - 5, fx, fy, words, err })
  if (tall && fx - 44 - tw >= face[0] + 12) return callout(parent, { x: fx - 44 - tw, y, lx: fx - 40, ly: y - 5, fx, fy, words, err })
  const x = Math.max(4, Math.min(w - 4 - tw, fx - tw * 0.3))
  let lx = Math.max(x + 8, Math.min(x + tw - 8, fx))
  // A leader never runs through the part's name: it leaves from the far end of the words instead.
  if (avoid && lx >= avoid[0] - 6 && lx <= avoid[1] + 6) lx = x + tw - 8
  const above = alt < fy
  callout(parent, { x, y: alt, lx, ly: above ? alt + 5 : alt - 15, fx, fy, words, err })
}

/** A break line: the conventional zigzag where a partial view stops. */
const breakLine = (parent, x0, x1, y) => {
  const m = (x0 + x1) / 2
  s("path", { d: `M${x0 - 6} ${y}H${m - 6}L${m - 2} ${y - 6}L${m + 2} ${y + 6}L${m + 6} ${y}H${x1 + 6}`, class: "leader" }, parent)
}

// Steps are typed values: deploy taken apart, with its parts list and the declaration emit.

// What each feature of deploy is cut from, numbered as the balloons on the drawing.
const FEATURES = [
  { n: 1, key: "socket", feature: "Socket, cut to the dovetail", code: "needs: { site }", line: 25, type: "Takes <code>site</code>'s <code>A</code>, a <code>StorePath</code>." },
  { n: 2, key: "edge", feature: "Output edge, flat", code: 'Action.make("deploy", …)', line: 24, type: "<code>A</code> is <code>void</code>." },
  { n: 3, key: "pin", feature: "Pin at position 2", code: "Deploy.publish(site)", line: 29, type: "<code>R</code> is <code>HttpClient</code>. <code>publish</code> also reads the secret, which the grant supplies." },
  { n: 4, key: "bit", feature: "Grant bit", code: 'grants: { secrets: ["deploy-token"] }', line: 27, type: '<code>G</code> is <code>{ readonly secrets: readonly <span class="nowrap">["deploy-token"]</span> }</code>.' },
  { n: 5, key: "plate", feature: "Data plate", code: ".pipe(Step.retry({ times: 2 }))", line: 30, type: "<code>E</code> is <code>never</code> and <code>O</code> is <code>{}</code>. Neither decides a fit. The retry is a policy piped onto the step." },
  { n: 6, key: "eyelet", feature: "Eyelet for the <code>after</code> link", code: "after: [typecheck, test]", line: 26, type: "No type parameter. It orders and carries no value." },
]

// The declaration emit, deploy's type broken over lines the way a formatter prints it, each
// parameter marked with its letter and linked to the feature it cuts.
const EMIT = [
  { text: "install: Setup" },
  { text: "typecheck: Step<void, TaskFailed, never, {}, never>" },
  { text: "test: Step<void, TaskFailed, never, {}, never>" },
  { text: "site: Step<StorePath, BuildFailed, never, {}, never>", feat: "socket", val: "StorePath" },
  { text: "deploy: Step<" },
  { text: "  void,", p: "A", feat: "edge" },
  { text: "  never,", p: "E", feat: "plate" },
  { text: "  HttpClient,", p: "R", feat: "pin" },
  { text: "  {},", p: "O", feat: "plate" },
  { text: '  { readonly secrets: readonly ["deploy-token"] }', p: "G", feat: "bit" },
  { text: ">" },
]
const P_CLASS = { A: "t-val", R: "t-svc", G: "t-grant" }

/** A drawing scale as a ratio: 2:1, 1.5:1, 9:10. */
const ratio = (k) => {
  if (k >= 1) return `${k}:1`
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const n = Math.round(k * 20)
  return `${n / gcd(n, 20)}:${20 / gcd(n, 20)}`
}

/** One lit feature per section: hovering or focusing any of its views lights it in all of them. */
function litGroup(root, setLit) {
  let hover = null
  let focus = null
  const apply = () => setLit(hover ?? focus)
  const key = (e) => {
    const t = e.target.closest?.("[data-feat]")
    return t && root.contains(t) ? t.dataset.feat : null
  }
  root.addEventListener("pointerover", (e) => {
    const k = key(e)
    if (k !== hover) {
      hover = k
      apply()
    }
  })
  root.addEventListener("pointerleave", () => {
    hover = null
    apply()
  })
  root.addEventListener("focusin", (e) => {
    focus = key(e)
    apply()
  })
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) {
      focus = null
      apply()
    }
  })
}

/**
 * deploy at up to 2:1, drawn apart: site in phantom lines with its tenon pulled back along the joint's
 * axis, the pin and the bit pulled down along their centre lines, the eyelet and its after link on top,
 * the data plate on the face. Geometry is in drawing units (px at 1:1); lettering, leaders and
 * dimensions are drawn at screen size through P().
 */
function drawExploded(root, caption) {
  const H = DIM.H
  const W = DIM.minW
  const G = 36 // how far site is pulled back
  const D = 24 // how far the pin and the bit are pulled down
  const cy = H / 2
  const pin = "HttpClient"
  const px0 = pinX(pin)
  const bx0 = bitX(W)
  onWidth(root, (avail) => {
    const seen = avail < 420 ? 24 : 44
    const left = DIM.c + G + seen + 8
    // Whole quarters from 1:1 to 2:1; below 1:1 on the narrowest phones, in steps of 0.05.
    const raw = (avail - 48) / (left + W + 64)
    const k = raw >= 1 ? Math.min(2, Math.floor(raw * 4) / 4) : Math.max(0.8, Math.floor(raw * 20) / 20)
    const roomy = k >= 1.5
    const ox = Math.round(left * k) + 2
    const oy = 80
    const P = (x, y) => ({ X: ox + x * k, Y: oy + y * k })
    // Under the bit: its width, then the overall width, each with room for its figure above the line.
    const bitBottom = P(0, H + D + DIM.bit.depth).Y
    const dimB = bitBottom + 26
    const dimO = dimB + 30
    const noteBelow = !roomy
    const w = Math.min(avail, Math.ceil(P(W + 64, 0).X + 44))
    const hgt = Math.ceil(dimO + (noteBelow ? 40 : 16))
    const { svg } = sheet(root, w, hgt, "deploy taken apart from site. Its socket, output edge, pin, grant bit, data plate and eyelet are numbered 1 to 6, as in the parts list.", k)
    const defs = svg.querySelector("defs")
    const geo = s("g", { transform: `translate(${ox} ${oy}) scale(${k})` }, svg)
    const feat = (key, parent, cls = "") => s("g", { class: `feat${cls ? ` ${cls}` : ""}`, "data-feat": key }, parent)

    // site, cut off by a break line, in phantom lines; its tenon is the value the socket takes.
    const sx = -DIM.c - G - W
    const clip = nextId("c")
    s("rect", { x: sx + W - seen, y: -20, width: seen + DIM.tenon.depth + 4, height: H + 40 }, s("clipPath", { id: clip }, defs))
    const siteG = s("g", { "clip-path": `url(#${clip})` }, geo)
    const site = s("g", { class: "part is-phantom", transform: `translate(${sx} 0)` }, siteG)
    drawPartShape(site, PARTS.site, { W, H })
    const tenon = feat("socket", site)
    for (const e of site.querySelectorAll(".tenon-wash, .value-edge")) tenon.append(e)

    // deploy, whole, without the features that are pulled off it.
    const dep = s("g", { class: "part k-action" }, geo)
    drawPartShape(dep, { ...PARTS.deploy, pins: [], bit: false }, { W, H })
    dep.querySelector(".value-edge").setAttribute("data-feat", "socket")
    dep.querySelector(".eyelet").setAttribute("data-feat", "eyelet")
    s("path", { d: `M${W} ${DIM.corner + 2}V${H - DIM.corner - 2}`, class: "edge-line", "data-feat": "edge" }, dep)

    // The pin and the bit, pulled down.
    const down = s("g", { class: "part", transform: `translate(0 ${D})` }, geo)
    s("path", { d: toPath(pinOutline(pin, H)), class: "pin" }, feat("pin", down))
    s("path", { d: toPath(bitOutline(W, H)), class: "bit" }, feat("bit", down))
    for (const e of svg.querySelectorAll("path, circle")) e.setAttribute("vector-effect", "non-scaling-stroke")

    const tx = s("g", {}, svg)
    // Centre lines: the joint's axis, the pin's and the bit's.
    const cl = (x0, y0, x1, y1) => s("path", { d: `M${x0} ${y0}L${x1} ${y1}`, class: "centre" }, tx)
    const axis = Math.round(P(0, cy).Y) + 0.5
    cl(P(sx + W - seen + 6, 0).X, axis, P(DIM.tenon.depth + DIM.c + 10, 0).X, axis)
    const pc = Math.round(P(px0 + DIM.pin.w / 2, 0).X) + 0.5
    cl(pc, P(0, H - 6).Y, pc, P(0, H + D + DIM.pin.len + 8).Y)
    const bc = Math.round(P(bx0 + DIM.bit.w / 2, 0).X) + 0.5
    cl(bc, P(0, H - 6).Y, bc, P(0, H + D + DIM.bit.depth + 6).Y)
    if (seen < W) breakLineV(tx, Math.round(P(sx + W - seen, 0).X) + 0.5, P(0, 0).Y, P(0, H).Y)

    // Lettering on the faces.
    text(tx, P(sx + W - seen, 0).X + 2, P(0, 0).Y - 10, "site", "t-kind")
    const nx = P(DIM.tenon.depth + DIM.c + 8, 0).X + 4
    text(tx, nx, P(0, 0).Y + 28, "deploy", "t-name")
    text(tx, nx, P(0, 0).Y + 47, "action", "t-kind")

    // The data plate: what doesn't decide a fit.
    const lines = ["E  never", "O  {}", "retry 2"]
    const pw = roomy ? 96 : 80
    const step = roomy ? 17 : 14
    const ph = lines.length * step + (roomy ? 14 : 8)
    const pr = P(W - 12, H - 12)
    const plate = feat("plate", tx, "dplate")
    const px = Math.round(pr.X - pw) + 0.5
    // Never over the part's name and kind, which end 52 px below its top.
    const py = Math.round(Math.max(pr.Y - ph, P(0, 0).Y + 52)) + 0.5
    s("rect", { x: px, y: py, width: pw, height: ph, class: "dplate-body" }, plate)
    for (const [cx, cyy] of [[px + 5, py + 5], [px + pw - 5, py + 5], [px + 5, py + ph - 5], [px + pw - 5, py + ph - 5]]) s("circle", { cx, cy: cyy, r: 1.5, class: "rivet" }, plate)
    lines.forEach((l, i) => text(plate, px + (roomy ? 14 : 10), py + (roomy ? 21 : 16) + i * step, l, "t-plateline"))

    // The after link leaves the eyelet upwards.
    const eye = P(W / 2, -DIM.eyelet.r)
    const ay = Math.round(P(0, 0).Y - 52) + 0.5
    const ax = Math.round(P(-DIM.c - G - 8, 0).X) + 0.5
    const after = feat("eyelet", tx, "after")
    const ex = Math.round(eye.X) + 0.5
    s("path", { d: `M${ex} ${eye.Y}V${ay + 5}Q${ex} ${ay} ${ex - 5} ${ay}H${ax}`, class: "after-line" }, after)
    s("circle", { cx: ax, cy: ay, r: 2.5, class: "after-dot" }, after)
    text(after, ax, ay - 9, "after: [typecheck, test]", "t-callmono")

    // Dimensions, in px at 1:1, from the geometry module.
    const dims = s("g", {}, tx)
    const hdim = (x0, x1, y, label, from, labelAt = "above") => {
      const yy = Math.round(y) + 0.5
      const X0 = Math.round(x0) + 0.5
      const X1 = Math.round(x1) + 0.5
      s("path", { d: `M${X0} ${from[0]}V${yy + 5}M${X1} ${from[1]}V${yy + 5}M${X0 + 8} ${yy}H${X1 - 8}`, class: "leader" }, dims)
      arrowHead(dims, X0, yy, -1, 0, 8, "leader-dot")
      arrowHead(dims, X1, yy, 1, 0, 8, "leader-dot")
      if (labelAt === "above") text(dims, (X0 + X1) / 2, yy - 6, label, "t-dim", "middle")
      else text(dims, X1 + 8, yy + 4.5, label, "t-dim")
    }
    const vdim = (y0, y1, x, label, from) => {
      const xx = Math.round(x) + 0.5
      const Y0 = Math.round(y0) + 0.5
      const Y1 = Math.round(y1) + 0.5
      s("path", { d: `M${from} ${Y0}H${xx + 5}M${from} ${Y1}H${xx + 5}M${xx} ${Y0 + 8}V${Y1 - 8}`, class: "leader" }, dims)
      arrowHead(dims, xx, Y0, 0, -1, 8, "leader-dot")
      arrowHead(dims, xx, Y1, 0, 1, 8, "leader-dot")
      text(dims, xx + 7, (Y0 + Y1) / 2 + 4.5, label, "t-dim")
    }
    const sockD = DIM.tenon.depth + DIM.c
    const top = P(0, 0).Y
    hdim(P(0, 0).X, P(sockD, 0).X, top - 22, String(sockD), [top - 4, P(0, cy - DIM.tenon.tip / 2).Y - 4])
    vdim(top, P(0, H).Y, P(W + 64, 0).X, String(H), P(W, 0).X + 4)
    hdim(P(bx0, 0).X, P(bx0 + DIM.bit.w, 0).X, dimB, String(DIM.bit.w), [bitBottom + 4, bitBottom + 4])
    hdim(P(0, 0).X, P(W, 0).X, dimO, String(W), [P(0, H).Y + 4, P(0, H).Y + 4])
    if (noteBelow) text(dims, P(0, 0).X, dimO + 30, "dimensions in px at 1:1", "t-kind")
    else text(dims, P(W + 64, 0).X + 36, dimO + 4.5, "dimensions in px at 1:1", "t-kind", "end")

    // Balloons, numbered as the parts list, each with a short leader to a dot on its feature.
    const call = (key, bx, by, tx0, ty0) => {
      const f = FEATURES.find((c) => c.key === key)
      const g = feat(key, tx, "call")
      const dx = tx0 - bx
      const dy = ty0 - by
      const d = Math.hypot(dx, dy)
      s("path", { d: `M${bx + (dx / d) * 11} ${by + (dy / d) * 11}L${tx0} ${ty0}`, class: "leader" }, g)
      s("circle", { cx: tx0, cy: ty0, r: 1.75, class: "leader-dot" }, g)
      balloon(g, bx, by, String(f.n))
    }
    const sock = P(2, cy + 16)
    call("socket", P(-22, H).X, P(0, H).Y + 24, sock.X, sock.Y)
    const edge = P(W, 34)
    call("edge", P(W + 30, 0).X, edge.Y - 10, edge.X + 1.5, edge.Y)
    // Beside the pin where there is room before the bit's balloon; under it where there isn't.
    const pinR = P(px0 + DIM.pin.w, H + D + DIM.pin.len / 2)
    if (roomy) call("pin", pinR.X + 24, pinR.Y + 16, pinR.X, pinR.Y)
    else {
      const pb = P(px0 + DIM.pin.w / 2, H + D + DIM.pin.len)
      call("pin", pb.X + 14, pb.Y + 20, pb.X + 1, pb.Y + 1)
    }
    const bitL = P(bx0 + 2, H + D + 10)
    call("bit", bitL.X - 26, bitL.Y + 18, bitL.X, bitL.Y)
    call("plate", P(W + 30, 0).X, py + ph / 2 + 4, px + pw, py + ph / 2 - 6)
    call("eyelet", eye.X + 36, top - 24, eye.X + DIM.eyelet.r * k - 1, top - 2)

    caption.innerHTML = `<code>deploy</code> at ${ratio(k)}, taken apart from <code>site</code>. Its features are numbered as in the parts list.`
    root.dispatchEvent(new Event("redrawn"))
  })
}

function setupTypes() {
  const scope = $("#types")
  $("[data-emit]", scope).innerHTML = EMIT.map((l) => {
    const { n } = indentOf(l.text)
    let html = highlight(l.text.slice(n)).replace(/^(\w+)(<span class="t-pun">:<\/span>)/, '<span class="t-def">$1</span>$2')
    if (l.val) html = html.replace(l.val, `<span class="t-val">${l.val}</span>`)
    if (l.p && P_CLASS[l.p]) html = `<span class="${P_CLASS[l.p]}">${html}</span>`
    const tag = l.p ? `<span class="p-tag${P_CLASS[l.p] ? ` ${P_CLASS[l.p]}` : ""}">${l.p}</span>` : `<span class="p-tag"></span>`
    return `<div class="ln"${l.feat ? ` data-feat="${l.feat}"` : ""}><span class="src"${n ? ` style="--ind:${n}ch"` : ""}>${html}</span>${tag}</div>`
  }).join("")
  $("[data-parts] tbody", scope).innerHTML = FEATURES.map((c) => `<tr data-feat="${c.key}" tabindex="0">
      <td class="no">${c.n}</td>
      <td class="feature">${c.feature}</td>
      <td class="src"><code>${keepWords(c.code)}</code><span class="ln-ref">line ${c.line}</span></td>
      <td class="ty">${c.type}</td>
    </tr>`).join("")
  let lit = null
  const setLit = (key) => {
    lit = key
    for (const el of scope.querySelectorAll("[data-feat]")) el.classList.toggle("is-lit", el.dataset.feat === key)
  }
  const holder = $("[data-exploded]", scope)
  holder.addEventListener("redrawn", () => setLit(lit))
  drawExploded(holder, $("#exploded figcaption", scope))
  litGroup(scope, setLit)
}

// Every fit is a compiler check: five details.

const diagHTML = (lines) =>
  lines
    .map((l, i) => {
      if (i > 0) return oline(l)
      const m = l.match(/^(\.calder\/ci\.ts\(\d+,\d+\))(.*)$/)
      return `<span class="oline"><span class="loc">${esc(m[1])}</span>${keepWords(m[2])}</span>`
    })
    .join("")

/** The largest whole scale at which `units` fit `avail` px, between 2:1 and 4:1. */
const scaleFor = (avail, units) => Math.max(2, Math.min(4, Math.floor(avail / units)))

/** The needs joint, as large as the column allows, framed as a detail: the dovetail is the subject. */
function jointDetail(parent, wrong) {
  const avail = parent.clientWidth || 600
  const k = scaleFor(avail, 150)
  const H = DIM.H
  const W = 160
  const span = Math.floor((avail - 2) / k)
  const jx0 = W + DIM.c / 2
  const x0 = Math.round(jx0 - span / 2)
  const y0 = H / 2 - 46
  const vh = 92
  const top = 30
  const w = span * k + 2
  const X = (x) => 1 + (x - x0) * k
  const Y = (y) => top + (y - y0) * k
  // deploy's name, and the callout under it when its face is wide enough; else under the frame.
  const dx = X(W + DIM.c) + (DIM.tenon.depth + DIM.c) * k + 16
  const words = wrong ? "nothing in the socket" : "StorePath, in deploy's socket"
  const inFace = dx + measure(words, FONT.callout) <= span * k - 8
  const hgt = vh * k + top + (inFace ? 4 : 40)
  const { svg } = sheet(parent, w, hgt, wrong ? "typecheck's flat end against deploy's socket, which it can't fill" : "site's StorePath profile seated in deploy's socket", k)
  const clip = nextId("c")
  s("rect", { x: x0, y: y0, width: span, height: vh }, s("clipPath", { id: clip }, svg.querySelector("defs")))
  const g = s("g", { transform: `translate(${1 - x0 * k} ${top - y0 * k}) scale(${k})` }, svg)
  const c = s("g", { "clip-path": `url(#${clip})` }, g)
  drawPartShape(s("g", { class: "part" }, c), wrong ? PARTS.typecheck : PARTS.site, { W, H })
  const dep = s("g", { class: "part k-action", transform: `translate(${W + DIM.c} 0)` }, c)
  drawPartShape(dep, { ...PARTS.deploy, pins: [], bit: false }, { W: 184, H })
  if (wrong) dep.querySelector(".value-edge").classList.add("is-empty")
  for (const p of svg.querySelectorAll("path")) p.setAttribute("vector-effect", "non-scaling-stroke")
  // The detail's frame: the parts go on beyond it.
  s("rect", { x: 1.5, y: top + 0.5, width: w - 3, height: vh * k - 1, class: "detail-frame" }, svg)
  text(svg, X(W) - 16, Y(y0) + 26, wrong ? "typecheck" : "site", "t-name", "end")
  text(svg, X(W) - 16, Y(y0) + 44, wrong ? "task" : "build", "t-kind", "end")
  text(svg, dx, Y(y0) + 26, "deploy", "t-name")
  text(svg, dx, Y(y0) + 44, "action", "t-kind")
  const jx = X(jx0)
  if (wrong) {
    text(svg, jx - 8, top - 10, "void", "t-err", "end")
    text(svg, jx + 8, top - 10, "StorePath", "t-joint")
  } else text(svg, jx, top - 10, "StorePath", "t-joint", "middle")
  // In deploy's face, under its name, or under the frame: what decides this fit.
  const f = wrong ? { X: X(W + DIM.c + 14), Y: Y(H / 2 + 6) } : { X: X(W + 12), Y: Y(H / 2 + 15) }
  if (inFace) callout(svg, { x: dx, y: Y(H / 2 + 33), lx: dx - 5, ly: Y(H / 2 + 33) - 5, fx: f.X, fy: f.Y, words, err: wrong })
  else placeCallout(svg, { fx: f.X, fy: f.Y, w, band: [0, 0], alt: top + vh * k + 26, words, err: wrong })
  return k
}

/**
 * A part's underside over a rail, as large as the column allows: where a pin or bit fit is decided.
 * Sockets are numbered and named under the rail.
 */
function railDetail(parent, { part, rule, label, name }) {
  const avail = parent.clientWidth || 600
  const W = DIM.minW
  const k = scaleFor(avail, W + 16)
  const span = Math.floor((avail - 4) / k)
  const showH = 26
  const f = fit(part, rule)
  const top = 24
  const railTop = showH + DIM.bit.depth + 6
  const names = k >= 3 ? 3 * 18 + 8 : 4 * 16 + 8
  const hgt = (railTop + DIM.rail.t) * k + top + 24 + names + 26
  const w = span * k + 4
  const { svg, ids } = sheet(parent, w, hgt, label, k)
  const g = s("g", { transform: `translate(2 ${top}) scale(${k})` }, svg)
  const seatX = Math.round((span - W) / 2)
  const sec = railSection({ rule, x0: 0, x1: span, seats: [{ x: seatX, W }], lipStart: true, lipEnd: true })
  drawRail(s("g", { transform: `translate(0 ${railTop})` }, g), sec, rule === "pr" ? ids.pr : ids.push, "rail is-live")
  const H = DIM.H
  const py = railTop - H - f.rest
  const pg = s("g", { class: `part${part.bit ? " k-action" : ""}`, transform: `translate(${seatX} ${py})` }, g)
  const clip = nextId("c")
  s("rect", { x: -20, y: H - showH, width: W + 40, height: showH + 60 }, s("clipPath", { id: clip }, svg.querySelector("defs")))
  pg.setAttribute("clip-path", `url(#${clip})`)
  drawPartShape(pg, part, { W, H, contacts: f.contacts })
  for (const p of svg.querySelectorAll("path")) p.setAttribute("vector-effect", "non-scaling-stroke")
  const by = top + (py + H - showH) * k
  breakLine(svg, 2 + seatX * k, 2 + (seatX + W) * k, by + 0.5)
  text(svg, 2 + (seatX + 12) * k, by + 28, name, "t-name")
  // Socket numbers, and the service each position stands for: staggered under their sockets where
  // the pitch leaves room, else listed in two columns under the numbers.
  const ny = top + (railTop + DIM.rail.t) * k + 20
  const staggered = k >= 3
  SERVICES.forEach((sv, i) => {
    const has = RULES[rule].supplies.includes(sv)
    const cls = has ? "" : " is-none"
    const x = 2 + (seatX + pinX(sv) + DIM.pin.w / 2) * k
    text(svg, x, ny, String(i + 1), "t-pinno" + cls, "middle")
    if (staggered) {
      const ly = ny + 20 + (i % 3) * 18
      s("path", { d: `M${Math.round(x) + 0.5} ${ny + 5}V${ly - 12}`, class: "leader" }, svg)
      const last = i === SERVICES.length - 1
      text(svg, last ? x - 6 : x, ly, sv, "t-svcname" + cls, last ? "start" : "middle")
    } else {
      const col2 = Math.min(Math.round(w / 2), Math.floor(w - 4 - 18 - measure('Secret<"deploy-token">', '400 12px "Overpass Mono", monospace')))
      const lx = 2 + (i < 4 ? 0 : col2)
      const ly = ny + 20 + (i % 4) * 16
      text(svg, lx, ly, String(i + 1), "t-pinno" + cls)
      text(svg, lx + 18, ly, sv, "t-svcname" + cls)
    }
  })
  text(svg, 2, ny + 20 + (staggered ? 3 * 18 + 6 : 4 * 16 + 6), RULES[rule].label, "t-rule")
  const P = (x, y) => ({ X: 2 + x * k, Y: top + y * k })
  // In the part's face, low, beside the feature, or above the drawing: what decides this fit.
  const at = (fx, fy, words, err) => {
    const f = P(fx, fy)
    const nx = 2 + (seatX + 12) * k
    placeCallout(svg, { fx: f.X, fy: f.Y, w, band: [by + 40, P(0, py + H).Y], alt: top - 8, words, err, avoid: [nx, nx + measure(name, FONT.name)], face: [P(seatX, 0).X, P(seatX + W, 0).X] })
  }
  return { k, at, seatX, py, H, W }
}

/** Folds lines out of an excerpt behind one row that says so. */
function skip(code, nos) {
  const rows = nos.map((n) => code.querySelector(`.ln[data-line="${n}"]`)).filter(Boolean)
  if (!rows.length) return
  const row = lineEl("", `<span class="t-com">… ${rows.length} lines</span>`, { cls: "is-skip" })
  rows[0].before(row)
  for (const r of rows) r.classList.add("is-gap")
}

/** Redraws a fit when its figure's width changes, so the detail always fills its column. */
const redrawOnWidth = (el, draw) => {
  let last = el.clientWidth
  new ResizeObserver(() => {
    if (el.clientWidth && el.clientWidth !== last) {
      last = el.clientWidth
      draw()
    }
  }).observe(el)
}

function fitItem(root, { letter, title, note, how, toggle }) {
  const art = h("article", { class: "fit-item", id: `fit-${letter.toLowerCase()}` }, root)
  const left = h("div", { class: "fit-text" }, art)
  h("h3", { html: `<span class="letter" aria-hidden="true">${letter}</span><span>${title}</span>` }, left)
  h("p", { class: "fit-note", html: note }, left)
  // The edit, as a switch; the word in the code it changes is a button too, and both stay in step.
  const sw = h("button", { type: "button", class: "switch", role: "switch", "aria-checked": "false", html: `<span class="sw-track" aria-hidden="true"><span class="sw-knob"></span></span><span class="sw-label">${how}</span>` }, left)
  sw.addEventListener("click", toggle)
  const pane = h("div", { class: "pane" }, left)
  const head = h("div", { class: "pane-head" }, pane)
  h("span", { class: "pane-title", text: ".calder/ci.ts" }, head)
  const status = h("span", { class: "pane-note", text: "no errors" }, head)
  const code = h("div", {}, pane)
  const right = h("div", { class: "fit-fig" }, art)
  const fig = h("figure", { class: "fig" }, right)
  const dwg = h("div", { class: "fig-dwg" }, fig)
  const cap = h("figcaption", { class: "view-title" }, fig)
  const extra = h("div", { class: "fit-extra" }, right)
  return { art, code, status, dwg, cap, extra, sw }
}

/** Puts the switch and the edit in the code in the same state, and wires the edit. */
const syncEdit = (it, on, toggle) => {
  it.sw.setAttribute("aria-checked", String(on))
  const b = it.code.querySelector("[data-edit]")
  b.setAttribute("aria-pressed", String(on))
  b.addEventListener("click", () => {
    toggle()
    it.code.querySelector("[data-edit]").focus()
  })
}

const editButton = (label, html, aria) => `<button type="button" class="edit" aria-pressed="false" aria-label="${esc(aria)}" data-edit>${html}</button>`

function setStatus(status, loc) {
  status.textContent = loc ? `${loc[3]} at ${loc[1]},${loc[2]}` : "no errors"
  status.classList.toggle("is-error", !!loc)
}
const locOf = (lines) => lines?.[0]?.match(/\((\d+),(\d+)\): error (TS\d+)/)

function fitValue(root) {
  const it = fitItem(root, {
    letter: "A",
    title: "The value into <code>needs</code>",
    note: "<code>needs: { site }</code> hands deploy's body the <code>StorePath</code> that <code>Deploy.publish</code> expects. A step with another value has no profile to fill the socket.",
    how: "Connect <code>typecheck</code> instead of <code>site</code>",
    toggle: () => {
      wrong = !wrong
      draw()
    },
  })
  let wrong = false
  const draw = () => {
    const lines = CI_TS.slice()
    const custom = {}
    const after = {}
    const btn = wrong
      ? editButton("", `site: <span class="t-def">typecheck</span>`, "Change site: typecheck back to site")
      : editButton("", `<span class="t-val">site</span>`, "Change needs: { site } to needs: { site: typecheck }")
    custom[25] = `${highlight("  needs: { ")}${btn}${highlight(" },")}`
    if (wrong) {
      custom[29] = `${highlight("  yield* Deploy.publish(")}<span class="squiggle">site</span>${highlight(")")}`
      const d = h("div", { class: "diag", html: diagHTML(TSC.needsTypecheck) })
      after[29] = d
    }
    renderCode(it.code, lines, { from: 24, to: 30, defs: { 24: "deploy" }, custom, after, marks: { 28: { site: "t-val" }, 29: { site: "t-val" } }, cls: { 27: "is-grant", ...(wrong ? { 29: "is-error" } : {}) } })
    syncEdit(it, wrong, () => {
      wrong = !wrong
      draw()
    })
    setStatus(it.status, wrong ? locOf(TSC.needsTypecheck) : null)
    it.dwg.replaceChildren()
    const k = jointDetail(it.dwg, wrong)
    it.cap.innerHTML = wrong ? `Detail A, ${k}:1. <code>typecheck</code> returns <code>void</code>: a flat end, nothing to seat in the socket.` : `Detail A, ${k}:1. <code>site</code>'s <code>StorePath</code> profile seated in <code>deploy</code>'s socket.`
  }
  draw()
  redrawOnWidth(it.dwg, draw)
}

function fitServices(root, pinout) {
  const it = fitItem(root, {
    letter: "B",
    title: "The services a rule supplies",
    note: "A step that comments on the pull request needs <code>PullRequest</code>, which only pull-request rules supply, so only that rail has its socket. For this fit the example gets a <code>comment</code> step before <code>export default</code>.",
    how: "Move <code>comment</code> to the push rule",
    toggle: () => {
      rule = rule === "pr" ? "push" : "pr"
      draw()
    },
  })
  let rule = "pr"
  const VAR = [
    ...CI_TS.slice(0, 31),
    'const comment = Action.make("comment", { after: [test] }, function*() {',
    '  yield* PullRequest.comment("The tests passed.")',
    "})",
    "",
    ...CI_TS.slice(31),
  ]
  VAR[0] = 'import { Action, Calder, Files, Nix, On, PullRequest, Step, Task, cmd } from "@calder-ci/core"'
  const draw = () => {
    const custom = {}
    const after = {}
    const btn = (aria) => editButton("", `<span class="t-def">comment</span>`, aria)
    if (rule === "pr") {
      custom[38] = `${highlight("    On.pullRequest([typecheck, test, site, ")}${btn("Move comment to the push rule")}${highlight("]),")}`
      custom[39] = highlight('    On.push("main", [deploy]),')
    } else {
      custom[38] = highlight("    On.pullRequest([typecheck, test, site]),")
      custom[39] = `<span class="squiggle">${highlight("On")}</span>`.replace(/^/, "    ") + `${highlight('.push("main", [deploy, ')}${btn("Move comment back to the pull-request rule")}${highlight("]),")}`
      after[39] = h("div", { class: "diag", html: diagHTML(TSC.commentInPush) + '<span class="oline diag-cut">tsc goes on to compare PullRequest with Gitea; cut here.</span>' })
    }
    renderCode(it.code, VAR, { from: 32, to: 41, defs: { 32: "comment" }, marks: { 33: { PullRequest: "t-svc" } }, custom, after, cls: rule === "push" ? { 39: "is-error" } : {} })
    syncEdit(it, rule === "push", () => {
      rule = rule === "pr" ? "push" : "pr"
      draw()
    })
    setStatus(it.status, rule === "push" ? locOf(TSC.commentInPush) : null)
    it.dwg.replaceChildren()
    const part = { pins: ["PullRequest"], bit: false }
    const d = railDetail(it.dwg, { part, rule, name: "comment", label: rule === "pr" ? "comment's PullRequest pin in its socket on the pull-request rail" : "comment's PullRequest pin standing on the push rail, which has no socket for it" })
    const k = d.k
    const pc = d.seatX + pinX("PullRequest") + DIM.pin.w / 2
    if (rule === "pr") d.at(pc + DIM.pin.w / 2, d.py + d.H + DIM.pin.len - 6, "pin 3 in socket 3, PullRequest")
    else d.at(pc, d.py + d.H + DIM.pin.len, "no socket 3 on the push rail", true)
    it.cap.innerHTML = rule === "pr"
      ? `Detail B, ${k}:1. The <code>PullRequest</code> pin (3) drops into its socket.`
      : `Detail B, ${k}:1. The push rail has no socket 3: the pin stands on the rail.`
    it.extra.innerHTML = rule === "pr"
      ? `<pre class="out">${[["calder plan --event pr:7", "cmd"], ["pull request #7: pr, reuse all", "head"], ["  setup  install (pulled in)"], ["  task   typecheck  ← needs install"], ["  task   test  ← needs install"], ["  build  site"], ["  action comment  ← after test", "hit"]].map(([l, cls]) => oline(l, { cls })).join("")}</pre>`
      : ""
  }
  draw()
  redrawOnWidth(it.dwg, draw)
  void pinout
}

function fitGrants(root) {
  const it = fitItem(root, {
    letter: "C",
    title: "Grants",
    note: "<code>deploy</code> declares a grant, and a pull-request rule takes only steps without grants. Its rail has a closed floor; the push rail's floor is open and takes any bit.",
    how: "Move <code>deploy</code> to the pull-request rule",
    toggle: () => {
      inPr = !inPr
      draw()
    },
  })
  let inPr = false
  const e = ARRANGEMENTS["pr,pr,pr"]
  const draw = () => {
    const entry = inPr ? e.refused : e.ok
    const custom = {}
    const after = {}
    const btn = (aria) => editButton("", `<span class="t-def">deploy</span>`, aria)
    if (inPr) {
      custom[34] = `${highlight("    On.pullRequest([typecheck, test, site, ")}<span class="squiggle">${btn("Move deploy back to the push rule")}</span>${highlight("]),")}`
      custom[35] = highlight(entry.line35)
      after[34] = h("div", { class: "diag", html: diagHTML(entry.tsc.out.split("\n")) })
    } else {
      custom[34] = highlight(entry.line34)
      custom[35] = `${highlight('    On.push("main", [')}${btn("Put deploy in the pull-request rule")}${highlight("]),")}`
    }
    renderCode(it.code, CI_TS, { from: 32, to: 37, custom, after, cls: inPr ? { 34: "is-error" } : {} })
    syncEdit(it, inPr, () => {
      inPr = !inPr
      draw()
    })
    setStatus(it.status, inPr ? locOf(entry.tsc.out.split("\n")) : null)
    it.dwg.replaceChildren()
    const d = railDetail(it.dwg, { part: { pins: ["HttpClient"], bit: true }, rule: inPr ? "pr" : "push", name: "deploy", label: inPr ? "deploy's grant bit standing on the closed floor of the pull-request rail" : "deploy seated on the push rail, its bit through the open floor" })
    const k = d.k
    const bx = d.seatX + bitX(d.W)
    if (inPr) d.at(bx + 4, d.py + d.H + DIM.bit.depth - 6, "the bit, on the closed floor", true)
    else d.at(bx + 4, d.py + d.H + DIM.bit.depth - 6, "the bit, through the open floor")
    it.cap.innerHTML = inPr
      ? `Detail C, ${k}:1. The bit stands on the closed floor, so <code>deploy</code> never seats; its pin hangs above socket 2.`
      : `Detail C, ${k}:1. The bit drops through the open floor and the <code>HttpClient</code> pin into socket 2.`
    it.extra.innerHTML = `<p class="fit-small">The planner refuses the same thing at run time, for pipelines nothing type-checked. It also keeps tasks that read secrets out of pull-request runs; those have no grants for the compiler to see.</p><pre class="out">${oline("calder plan --event pr:7", { cls: "cmd" })}${oline(e.refused.plans.pr.out, { cls: "err" })}</pre>`
  }
  draw()
  redrawOnWidth(it.dwg, draw)
}

function fitSecret(root) {
  const it = fitItem(root, {
    letter: "D",
    title: "A secret without its grant",
    note: "The grant hands deploy's body the secret it reads in <code>deploy.ts</code>. Delete the grant, and reading the secret becomes a service <code>deploy</code> needs, <code>Secret&lt;\"deploy-token\"&gt;</code>, which no rule supplies.",
    how: "Delete the grant, line 27",
    toggle: () => {
      deleted = !deleted
      draw()
    },
  })
  let deleted = false
  const draw = () => {
    const lines = deleted ? [...CI_TS.slice(0, 26), ...CI_TS.slice(27)] : CI_TS.slice()
    const custom = {}
    const after = {}
    const marks = {}
    const cls = {}
    if (deleted) {
      // Line 27 is gone; what was line 35 is line 34.
      custom[34] = `    <span class="squiggle">${highlight("On")}</span>${highlight('.push("main", [deploy]),')}`
      after[34] = h("div", { class: "diag", html: diagHTML(TSC.noGrant) })
      cls[34] = "is-error"
      custom[27] = `  ${editButton("", `<span class="ghost-line">${highlight('grants: { secrets: ["deploy-token"] },')}</span>`, "Put back grants: { secrets: [\"deploy-token\"] }, line 27")}`
    } else {
      custom[27] = `  ${editButton("", `<span class="t-grant">${highlight('grants: { secrets: ["deploy-token"] },')}</span>`, "Delete grants: { secrets: [\"deploy-token\"] }, line 27")}`
      cls[27] = "is-grant"
    }
    if (deleted) {
      // Show the deleted line struck through, unnumbered, where it was.
      const rows = []
      for (let n = 24; n <= 34; n++) rows.push(n)
      renderCode(it.code, lines, { from: 24, to: 34, custom: { ...custom, 27: highlight(lines[26], { marks: { site: "t-val" } }) }, after, cls, marks: { 25: { site: "t-val" }, 28: { site: "t-val" } } })
      const struck = lineEl("", custom[27], { cls: "is-removed" })
      it.code.querySelector('.ln[data-line="27"]').before(struck)
      struck.querySelector(".no").textContent = ""
      // Lines 31 and 32 of the renumbered file are the project; keep the excerpt short.
      skip(it.code, [30, 31, 32])
    } else {
      renderCode(it.code, lines, { from: 24, to: 35, custom, after, cls, marks: { 25: { site: "t-val" }, 28: { site: "t-val" }, 29: { site: "t-val" } } })
      skip(it.code, [31, 32, 33])
    }
    syncEdit(it, deleted, () => {
      deleted = !deleted
      draw()
    })
    setStatus(it.status, deleted ? locOf(TSC.noGrant) : null)
    it.dwg.replaceChildren()
    const d = railDetail(it.dwg, {
      name: "deploy",
      part: deleted ? { pins: ["HttpClient", 'Secret<"deploy-token">'], bit: false } : { pins: ["HttpClient"], bit: true },
      rule: "push",
      label: deleted ? "deploy without its bit: a Secret pin stands on the push rail, which has no socket for it" : "deploy seated on the push rail, its bit carrying the secret",
    })
    const k = d.k
    if (deleted) d.at(d.seatX + pinX('Secret<"deploy-token">') + DIM.pin.w / 2, d.py + d.H + DIM.pin.len, 'pin 7, Secret<"deploy-token">, has no socket', true)
    else d.at(d.seatX + bitX(d.W) + 4, d.py + d.H + DIM.bit.depth - 6, "the grant bit, in place of a Secret pin")
    it.cap.innerHTML = deleted
      ? `Detail D, ${k}:1. No bit, and a <code>Secret</code> pin (7) that no rail has a socket for.`
      : `Detail D, ${k}:1. The bit carries the secret: with it, reading the secret needs no socket.`
  }
  draw()
  redrawOnWidth(it.dwg, draw)
}

function fitMissing(root) {
  const it = fitItem(root, {
    letter: "E",
    title: "A part that doesn't exist",
    note: "<code>calder gen</code> writes <code>.calder/flake.ts</code> from the flake's outputs, so they are typed names. A build of an output the flake doesn't have is an empty outline.",
    how: "Misspell <code>site</code> as <code>sit</code>",
    toggle: () => {
      typo = !typo
      draw()
    },
  })
  let typo = false
  const draw = () => {
    const custom = {}
    const after = {}
    const word = typo ? "sit" : "site"
    const btn = editButton("", typo ? `<span class="squiggle">sit</span>` : "site", typo ? "Change sit back to site" : "Misspell site as sit")
    custom[22] = `${highlight("const site = Nix.build(flake.packages.", { def: "site" })}${btn}${highlight(")")}`
    if (typo) after[22] = h("div", { class: "diag", html: diagHTML(TSC.typo) })
    renderCode(it.code, CI_TS, { from: 22, to: 22, custom, after, cls: typo ? { 22: "is-error" } : {} })
    syncEdit(it, typo, () => {
      typo = !typo
      draw()
    })
    setStatus(it.status, typo ? locOf(TSC.typo) : null)
    it.dwg.replaceChildren()
    const H = DIM.H
    const W = 120
    const dw = W + 28
    const avail = it.dwg.clientWidth || 600
    // On a phone the gap narrows and the build's label goes a line up, so both labels fit.
    const narrow = avail < 420
    const gap = narrow ? 36 : 56
    const unitsW = dw + gap + W + DIM.tenon.depth + 8
    const k = Math.max(1, Math.min(2, Math.floor((avail - 8) / unitsW)))
    const px = dw + gap
    const oy = narrow ? 52 : 34
    const P = (x, y) => ({ X: 4 + x * k, Y: oy + y * k })
    const { svg } = sheet(it.dwg, Math.ceil(P(unitsW, 0).X), Math.ceil(P(0, H + 32).Y + 40), typo ? "flake.packages.sit: an empty outline; the flake's only package is site" : "flake.packages.site, built as the part site", k)
    const g = s("g", { transform: `translate(4 ${oy}) scale(${k})` }, svg)
    // The flake's packages, as calder gen typed them: a drawer with one part in it.
    s("rect", { x: 0, y: 0, width: dw, height: H + 32, class: "drawer" }, g)
    drawPartShape(s("g", { class: "part k-build", transform: "translate(12 16)" }, g), PARTS.site, { W: W - 28, H })
    const part = s("g", { class: `part k-build${typo ? " is-missing" : ""}`, transform: `translate(${px} 16)` }, g)
    drawPartShape(part, PARTS.site, { W, H })
    s("path", { d: `M${12 + W - 28 + DIM.tenon.depth + 6} ${16 + H / 2}H${px - 6}`, class: "centre" }, g)
    for (const e of svg.querySelectorAll("path, rect")) e.setAttribute("vector-effect", "non-scaling-stroke")
    const tx = s("g", {}, svg)
    const pa = P(12, 16)
    text(tx, P(0, 0).X, P(0, 0).Y - 12, "flake.packages", "t-callmono")
    text(tx, pa.X + 14, pa.Y + 28, "site", "t-name")
    text(tx, pa.X + 14, pa.Y + 47, "package", "t-kind")
    const pb = P(px, 16)
    const call = typo ? "Nix.build(flake.packages.sit)" : "Nix.build(flake.packages.site)"
    if (narrow) text(tx, P(unitsW, 0).X - 2, P(0, 0).Y - 30, call, "t-callmono", "end")
    else text(tx, pb.X, P(0, 0).Y - 12, call, "t-callmono")
    text(tx, pb.X + 14, pb.Y + 28, word, typo ? "t-name is-err" : "t-name")
    text(tx, pb.X + 14, pb.Y + 47, typo ? "no such output" : "build", typo ? "t-kind is-err" : "t-kind")
    // Under the row: what decides this fit.
    const cy = P(0, H + 32).Y + 26
    if (typo) callout(tx, { x: pb.X, y: cy, lx: pb.X + 40, ly: cy - 15, fx: pb.X + 52, fy: P(0, 16 + H).Y + 2, words: "no package called sit", err: true })
    else callout(tx, { x: P(0, 0).X, y: cy, lx: P(0, 0).X + 40, ly: cy - 15, fx: pa.X + 52, fy: P(0, 16 + H).Y + 2, words: "site, a package of the flake" })
    it.cap.innerHTML = typo
      ? "Detail E. <code>flake.packages.sit</code> names nothing, so there is no part to draw."
      : "Detail E. <code>Nix.build(flake.packages.site)</code> makes the part <code>site</code> from the flake's package."
  }
  draw()
  redrawOnWidth(it.dwg, draw)
}

function setupFits() {
  const root = $("[data-fits]")
  fitValue(root)
  fitServices(root)
  fitGrants(root)
  fitSecret(root)
  fitMissing(root)
}

// A plan is a function: one drawing, tabulated by event.

function silhouette(name, state) {
  // The real parts at 0.36, cropped to their features.
  const k = 0.36
  const W = 150
  const H = DIM.H
  const vw = Math.ceil((W + DIM.tenon.depth) * k) + 4
  const vh = Math.ceil((H + DIM.bit.depth) * k) + 6
  const svg = s("svg", { class: "dwg sil is-scaled", width: vw, height: vh, viewBox: `-2 -4 ${vw} ${vh}`, "aria-hidden": "true" })
  if (name === "install") {
    const pl = s("g", { class: `plate${state === "off" ? " is-off" : ""}`, transform: `scale(${k})` }, svg)
    s("path", { d: toPath(plateOutline(0, W).map((p) => ({ ...p, y: p.y + H }))), class: "plate-body" }, pl)
  } else {
    const g = s("g", { class: `part k-${PARTS[name].kind}${state === "off" ? " is-off" : ""}`, transform: `scale(${k})` }, svg)
    drawPartShape(g, PARTS[name], { W, H })
  }
  for (const p of svg.querySelectorAll("path")) p.setAttribute("vector-effect", "non-scaling-stroke")
  return svg
}

function setupPlans() {
  renderCode($("[data-test]"), TEST_TS, { marks: { 9: {} } })
  const root = $("[data-views]")
  const e = ARRANGEMENTS["pr,pr,pr"].ok
  const rows = [
    { ev: "pr", label: "Pull request #7", rail: "On.pullRequest", why: "The pull-request rule runs, and <code>typecheck</code> and <code>test</code> pull in <code>install</code>.", steps: '["install", "typecheck", "test", "site"]' },
    { ev: "push", label: "Push to main", rail: 'On.push("main")', why: "<code>deploy</code> pulls in the four steps before it.", steps: '["site", "install", "typecheck", "test", <span class="hit">"deploy"</span>]' },
    { ev: "check", label: "Before pushing", rail: "On.pullRequest", why: "A check runs like a pull request.", steps: null },
  ]
  const names = ["install", "typecheck", "test", "site", "deploy"]
  const t = h("table", { class: "tab" }, root)
  t.innerHTML = `<caption>One drawing, tabulated. What <code>Calder.plan</code> returns for each event, from the real plans of the example</caption><thead><tr><th scope="col">event</th><th scope="col">live rail</th>${names.map((n) => `<th scope="col"><code>${n}</code></th>`).join("")}</tr></thead>`
  const body = h("tbody", {}, t)
  for (const r of rows) {
    const p = parsePlan(e.plans[r.ev].out)
    const tr = h("tr", {}, body)
    h("th", { scope: "row", text: r.label }, tr)
    h("td", { html: `<code>${esc(r.rail)}</code>` }, tr)
    for (const n of names) {
      const td = h("td", { class: "sil-cell" }, tr)
      const on = p.planned.has(n)
      td.append(silhouette(n, on ? "on" : "off"))
      h("span", { class: `sil-note${on ? "" : " is-off"}`, text: on ? (p.pulled.has(n) ? "pulled in" : "runs") : "not planned" }, td)
    }
    const steps = h("tr", { class: "tab-steps" }, body)
    h("td", { colspan: 7, html: `<span class="tab-why">${r.why}</span>` + (r.steps ? `<code>plan.steps.map((step) =&gt; step.name)</code> is <code class="arr">${r.steps}</code>${r.ev === "pr" ? ". No <code>\"deploy\"</code>, so the test passes." : ""}` : `Before pushing, <code>calder plan --event check</code> plans the working copy under the pull-request rule and prints the same steps: <code>${esc(e.plans.check.out.split("\n")[0])}</code>`) }, steps)
  }
}

// Calder keeps every result by what it read.

const EDITS = {
  readme: {
    file: "README.md",
    cells: { install: "not needed", typecheck: "reused", test: "reused, 0 of 2 run", site: "reused" },
    states: { install: "none", typecheck: "reused", test: "reused", site: "reused" },
    files: { "price.test.ts": "reused", "health.test.ts": "reused" },
    why: {
      install: "Every task that starts from it reused its result, so it never had to run.",
      typecheck: "It reads apps and tsconfig.json; README.md is neither.",
      test: "Neither test file imports README.md.",
      site: "The flake builds the site from apps/web, so its derivation didn't change.",
    },
  },
  price: {
    file: "apps/web/src/price.ts",
    cells: { install: "reused", typecheck: "runs", test: "runs price.test.ts", site: "rebuilt" },
    states: { install: "reused", typecheck: "runs", test: "runs", site: "runs" },
    files: { "price.test.ts": "runs", "health.test.ts": "reused" },
    why: {
      install: "An earlier run prepared its key, so it settles at once.",
      typecheck: "It reads apps, and a file in apps changed.",
      test: "price.test.ts imports price.ts. health.test.ts keeps its result.",
      site: "apps/web changed, so the derivation did.",
    },
  },
  health: {
    file: "apps/api/src/health.ts",
    cells: { install: "reused", typecheck: "runs", test: "runs health.test.ts", site: "reused" },
    states: { install: "reused", typecheck: "runs", test: "runs", site: "reused" },
    files: { "price.test.ts": "reused", "health.test.ts": "runs" },
    why: {
      install: "An earlier run prepared its key, so it settles at once.",
      typecheck: "It reads apps, and a file in apps changed.",
      test: "health.test.ts imports health.ts. price.test.ts keeps its result.",
      site: "Nothing in apps/web changed.",
    },
  },
  lock: {
    file: "pnpm-lock.yaml",
    cells: { install: "runs", typecheck: "runs", test: "runs both", site: "reused" },
    states: { install: "runs", typecheck: "runs", test: "runs", site: "reused" },
    files: { "price.test.ts": "runs", "health.test.ts": "runs" },
    why: {
      install: "The lockfile is part of its key.",
      typecheck: "It starts from install, and install's key changed.",
      test: "Each file's key includes the root manifests and the lockfile.",
      site: "The flake builds the site from apps/web, which doesn't hold the lockfile.",
    },
  },
}

function setupReuse() {
  const scope = $("#reuse")
  const body = scope.querySelector("[data-edits] tbody")
  let pick = "price"
  for (const [key, e] of Object.entries(EDITS)) {
    const tr = h("tr", { "data-edit": key }, body)
    const td = h("td", { class: "file" }, tr)
    td.innerHTML = `<label><input type="radio" name="edit" value="${key}"${key === pick ? " checked" : ""}>${esc(e.file)}</label>`
    for (const n of ["install", "typecheck", "test", "site"]) h("td", { class: `st${e.states[n] === "runs" ? " runs" : ""}`, text: e.cells[n] }, tr)
    tr.addEventListener("click", (ev) => {
      const input = tr.querySelector("input")
      if (ev.target === input) return
      input.checked = true
      input.focus({ preventScroll: true })
      update(key)
    })
    tr.querySelector("input").addEventListener("change", () => update(key))
  }
  const view = new AssemblyView(scope.querySelector("[data-reuse]"), {
    partWidth,
    rowsBelow: 560,
    noFill: false,
    note: (name) => (name === "deploy" ? null : EDITS[pick].cells[name] ?? null),
    plateNote: () => EDITS[pick].cells.install,
    files: (name) => (name === "test" ? Object.entries(EDITS[pick].files) : null),
    onRender: (v) => {
      const e = EDITS[pick]
      for (const [n, g] of Object.entries(v.partEls)) {
        const st = n === "deploy" ? "none" : e.states[n]
        g.classList.toggle("is-reused", st === "reused")
        g.classList.toggle("is-off", st === "none")
        v.textEls[n].classList.toggle("is-off", st === "none")
      }
      for (const p of v.L.plates) {
        p.el.classList.toggle("is-off", e.states.install === "none")
        p.el.classList.toggle("is-reused", e.states.install === "reused")
      }
      for (const a of v.afterEls) a.classList.add("is-off")
    },
  })
  const why = scope.querySelector("[data-why]")
  const caption = scope.querySelector("[data-reuse-caption]")
  const update = (key) => {
    pick = key
    const e = EDITS[key]
    for (const tr of body.querySelectorAll("tr")) tr.classList.toggle("is-picked", tr.dataset.edit === key)
    view.set({ plan: { live: "pr", planned: new Set(["install", "typecheck", "test", "site"]), pulled: new Set() } })
    why.innerHTML = ["install", "typecheck", "test", "site"]
      .map((n) => {
        const state = e.cells[n]
        const quiet = state.startsWith("reused") || state === "not needed"
        return `<li><span class="who">${n}</span><span class="what${quiet ? " quiet" : ""}">${esc(state)}</span><span class="because">${esc(e.why[n])}</span></li>`
      })
      .join("")
    caption.innerHTML = `Pull request #7 after an edit to <code>${esc(e.file)}</code>. Full weight runs, thin lines are reused, phantom lines are not needed or not in this plan. Each test file is a cartridge in <code>test</code> with a key of its own.`
  }
  update(pick)
}

// It runs before you push.

function setupCheck() {
  const e = ARRANGEMENTS["pr,pr,pr"].ok
  $("[data-check-out]").innerHTML = oline("calder plan --event check", { cls: "cmd" }) + e.plans.check.out.split("\n").map((l, i) => oline(l, { cls: i === 0 ? "head" : "" })).join("")
  const root = $("[data-handoff]")
  const stops = [
    ["calder check", "your working copy", "runs"],
    ["pull request #7", "after you push", "reused"],
    ["push to main", "after the merge", "reused"],
  ]
  onWidth(root, (avail) => {
    const W = 136
    const H = 64
    const gap = 80
    const narrow = avail < 3 * W + 2 * gap + 8
    const w = narrow ? Math.min(avail, 340) : 3 * W + 2 * gap + 8
    const rowH = H + 40
    const hgt = narrow ? 3 * rowH + 2 * 24 : H + 64
    const { svg } = sheet(root, w, hgt, "One typecheck result: run by the check, reused by the pull request and by main")
    stops.forEach(([head, sub, state], i) => {
      const x = narrow ? 4 : 4 + i * (W + gap)
      const y = narrow ? i * (rowH + 24) : 0
      text(svg, x, y + 14, head, "t-callmono")
      text(svg, x, y + 32, sub, "t-kind")
      const g = s("g", { class: `part${state === "reused" ? " is-reused" : ""}`, transform: `translate(${x} ${y + 44})` }, svg)
      drawPartShape(g, PARTS.typecheck, { W, H })
      text(svg, x + 12, y + 44 + 25, "typecheck", "t-name")
      text(svg, x + 12, y + 44 + 43, state, state === "runs" ? "t-kind is-strong" : "t-kind")
      if (!i) return
      const a = s("g", {}, svg)
      if (narrow) {
        const ax = x + W + 32.5
        s("path", { d: `M${ax} ${y - rowH - 24 + 44 + H / 2}V${y + 44 + H / 2 - 6}`, class: "leader" }, a)
        arrowHead(a, ax, y + 44 + H / 2, 0, 1, 6, "leader-dot")
        text(svg, ax + 8, y + 44 - 24 + 4, "same key", "t-kind")
      } else {
        const ay = 44 + H / 2 + 0.5
        s("path", { d: `M${x - gap + 8} ${ay}H${x - 9}`, class: "leader" }, a)
        arrowHead(a, x - 4, ay, 1, 0, 6, "leader-dot")
        text(svg, x - gap / 2, ay - 8, "same key", "t-kind", "middle")
      }
    })
  })
}

// Libraries are functions: a catalogue.

function catDrawing(parent, kind) {
  const H = DIM.H
  if (kind === "setup") {
    // A setup is the plate tasks start from: shown with two tasks standing on it, in phantom.
    const W = 96
    const { svg } = sheet(parent, 2 * W + 48, H + DIM.plate.t + 8)
    const g = s("g", { transform: `translate(2 ${H + 2})` }, svg)
    for (const x of [12, W + 28]) {
      const pg = s("g", { class: "part is-off", transform: `translate(${x} ${-H})` }, g)
      s("path", { d: toPath(bodyOutline({ W, H: H - 8 }).map((p) => ({ ...p, y: p.y + 8 }))), class: "outline" }, pg)
    }
    s("path", { d: toPath(plateOutline(0, 2 * W + 40).map((p) => ({ ...p, y: p.y + DIM.plate.t }))), class: "plate-body" }, s("g", { class: "plate" }, g))
    text(svg, 14, H + 2 + 17, "install", "t-plate")
    text(svg, 26, 40, "a task", "t-kind")
    text(svg, W + 42, 40, "a task", "t-kind")
    return svg
  }
  if (kind === "task") {
    const W = 196
    const { svg } = sheet(parent, W + 8, H + 6)
    const g = s("g", { class: "part", transform: "translate(2 2)" }, svg)
    drawPartShape(g, PARTS.test, { W, H })
    text(svg, 14, 27, "test", "t-name")
    // Each test file is a cartridge in the task, with a key of its own.
    ;["price.test.ts", "health.test.ts"].forEach((file, i) => {
      const y = 38 + i * 25
      s("rect", { x: 14.5, y: y + 0.5, width: W - 28, height: 20, rx: 2, class: "cart" }, svg)
      text(svg, 22, y + 15, file, "t-file")
      text(svg, W - 22, y + 15, "a key", "t-filestate", "end")
    })
    return svg
  }
  if (kind === "project") {
    const W = 56
    const PH = 36
    const { svg, ids } = sheet(parent, 300, PH + 54)
    const g = s("g", { transform: "translate(2 4)" }, svg)
    for (const [rule, x0, x1, n] of [["pr", 0, 150, 2], ["push", 150, 296, 1]]) {
      const seats = Array.from({ length: n }, (_, i) => ({ x: x0 + 16 + i * (W + 12), W }))
      const sec = railSection({ rule, x0, x1, seats: [], lipStart: rule === "pr", lipEnd: rule === "push" })
      drawRail(s("g", { transform: `translate(0 ${PH})` }, g), { ...sec, polys: sec.polys.map((p) => p.map((q) => ({ ...q, y: Math.min(q.y, 12) }))) }, rule === "pr" ? ids.pr : ids.push, "rail is-live")
      for (const st of seats) {
        const pg = s("g", { class: "part is-generic", transform: `translate(${st.x} 0)` }, g)
        s("path", { d: toPath(bodyOutline({ W, H: PH })), class: "body" }, pg)
        s("path", { d: toPath(bodyOutline({ W, H: PH })), class: "outline" }, pg)
      }
      text(svg, x0 + (rule === "pr" ? 8 : 18), PH + 4 + 12 + 20, RULES[rule].label.replace('("main")', ""), "t-rule")
    }
    return svg
  }
  if (kind === "policy") {
    // A policy is no part of its own: it goes on the step's data plate, as on deploy's.
    const W = 176
    const { svg } = sheet(parent, W + 8, H + 6)
    const g = s("g", { class: "part is-phantom", transform: "translate(2 2)" }, svg)
    drawPartShape(g, { kind: "action" }, { W, H })
    text(svg, 14, 27, "a step", "t-kind")
    const pw = 84
    const ph = 34
    const px = Math.round(2 + W - 12 - pw) + 0.5
    const py = Math.round(2 + H - 12 - ph) + 0.5
    s("rect", { x: px, y: py, width: pw, height: ph, class: "dplate-body" }, svg)
    for (const [cx, cy] of [[px + 5, py + 5], [px + pw - 5, py + 5], [px + 5, py + ph - 5], [px + pw - 5, py + ph - 5]]) s("circle", { cx, cy, r: 1.5, class: "rivet" }, svg)
    text(svg, px + 14, py + 22, "retry 2", "t-plateline")
    return svg
  }
  if (kind === "effect") {
    // An Effect, not a step: it takes the StorePath and needs two services, and has no grant.
    const W = 176
    const ny = H + DIM.pin.len + 18
    const { svg } = sheet(parent, W + 8, ny + 6)
    const g = s("g", { class: "part", transform: "translate(2 2)" }, svg)
    drawPartShape(g, { socket: true, pins: ["HttpClient", 'Secret<"deploy-token">'] }, { W, H })
    for (const p of svg.querySelectorAll("path")) p.setAttribute("vector-effect", "non-scaling-stroke")
    const x0 = 2 + DIM.tenon.depth + DIM.c + 12
    text(svg, x0, 27, "publish", "t-name")
    text(svg, x0, 45, "an Effect", "t-kind")
    for (const sv of ["HttpClient", 'Secret<"deploy-token">']) text(svg, 2 + pinX(sv) + DIM.pin.w / 2, ny, String(SERVICES.indexOf(sv) + 1), "t-pinno", "middle")
    return svg
  }
}

/** Where a part comes from, lettered under its drawing. */
function fromLabel(svg, pkg) {
  const hgt = Number(svg.getAttribute("height")) + 26
  const w = Number(svg.getAttribute("width"))
  svg.setAttribute("height", hgt)
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`)
  const t = text(svg, 2, hgt - 6, "from ", "t-kind")
  s("tspan", { class: "t-from" }, t).textContent = pkg
}

function setupCatalogue() {
  const root = $("[data-catalogue]")
  const std = "@calder-ci/std"
  const items = [
    { sig: "<b>Pnpm.install</b>({ shell })", ret: "returns a <code>Setup</code>, the plate tasks start from", draw: "setup", from: std },
    { sig: "<b>Bun.install</b>({ shell })", ret: "returns a <code>Setup</code>, for bun's lockfile", draw: "setup", from: std },
    { sig: "<b>Vitest.files</b>({ shell, setup, tests })", ret: "returns a task, <code>Step&lt;void, TaskFailed, never, {}, never&gt;</code>, with a key per test file", draw: "task", from: std },
    { sig: "<b>Project.standard</b>({ flake })", ret: "returns a <code>Calder.Project</code>, its rules and the steps on them", draw: "project", from: std },
    { sig: ".pipe(<b>Step.retry</b>({ times: 2 }))", ret: "returns the same step, of the same type, retried. <code>Step.timeout</code> adds <code>TimedOut</code> to its failure <code>E</code>.", draw: "policy", from: "@calder-ci/core" },
    { sig: "<b>Deploy.publish</b>(site)", ret: 'returns <code>Effect&lt;void, HttpClientError, HttpClient | Secret&lt;"deploy-token"&gt;&gt;</code>. In <code>deploy</code>\'s body the grant supplies the <code>Secret</code>, so <code>deploy</code> needs only <code>HttpClient</code>.', draw: "effect", from: "./deploy.ts", code: true },
  ]
  for (const it of items) {
    const c = h("div", { class: "cat" }, root)
    h("div", { class: "sig", html: it.sig }, c)
    h("div", { class: "ret", html: it.ret }, c)
    const svg = catDrawing(h("div", { class: "cat-dwg" }, c), it.draw)
    fromLabel(svg, it.from)
    if (it.code) {
      const pane = h("div", { class: "pane cat-pane" }, c)
      renderCode(h("div", {}, pane), DEPLOY_TS, { from: 6, to: 9, defs: { 6: "publish" }, marks: { 6: { site: "t-val", StorePath: "t-val" }, 8: { Secret: "t-grant" }, 9: { HttpClient: "t-svc" } } })
    }
  }
}

export function setupSections() {
  setupTypes()
  setupFits()
  setupPlans()
  setupReuse()
  setupCheck()
  setupCatalogue()
}
