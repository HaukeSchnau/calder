import { DIM, bitOutline, bitX, bodyOutline, pinOutline, pinX, socketEdge, tenonEdge, tenonOutline, toPath } from "./geometry.js"
import { arrowHead, h, s } from "./svg.js"
import { setupHero } from "./hero.js"

// The mark: site's tenon seated in deploy's socket. Real profiles at 1:2, on two short bodies.
function drawMark() {
  const svg = document.querySelector("[data-mark]")
  const W = 30
  const H = 60
  const k = 0.36
  const w = (2 * W + DIM.c) * k + 2
  const hgt = H * k + 2
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`)
  svg.setAttribute("width", w)
  svg.setAttribute("height", hgt)
  const g = s("g", { transform: `translate(1 1) scale(${k})` }, svg)
  const ns = { "vector-effect": "non-scaling-stroke" }
  s("path", { d: toPath(bodyOutline({ W, H, tenon: true })), class: "m-body", ...ns }, g)
  s("path", { d: toPath(tenonOutline({ W, H })), class: "m-tenon" }, g)
  const r = s("g", { transform: `translate(${W + DIM.c} 0)` }, g)
  s("path", { d: toPath(bodyOutline({ W, H, socket: true })), class: "m-body", ...ns }, r)
  s("path", { d: toPath(socketEdge({ H }), false), class: "m-edge", ...ns }, r)
  s("path", { d: toPath(tenonEdge({ W, H }), false), class: "m-edge", ...ns }, g)
}

// The key to the drawing: crops of real parts at 1:1, so it can't drift from what it explains.
function drawLegend() {
  const ul = document.querySelector("[data-legend]")
  const H = DIM.H
  const W = 160
  const k = 0.6
  // Glyphs are crops of real parts at 0.6, so the key can't drift from what it explains. Phones
  // show the short label, so the key fits in one wrapping row above the code.
  const item = (label, draw, [x, y, w, hgt], short) => {
    const li = h("li", {}, ul)
    const svg = s("svg", { class: "dwg glyph is-scaled", width: Math.round(w * k), height: Math.round(hgt * k), viewBox: `${x} ${y} ${w} ${hgt}`, "aria-hidden": "true" }, li)
    const g = s("g", { class: "geo" }, svg)
    draw(s("g", { class: "part" }, g))
    h("span", { class: "lg-long", html: label }, li)
    h("span", { class: "lg-short", "aria-hidden": "true", html: short }, li)
  }
  item("a value, here <code>StorePath</code> (A)", (g) => {
    s("path", { d: toPath(bodyOutline({ W, H, tenon: true })), class: "body" }, g)
    s("path", { d: toPath(tenonOutline({ W, H })), class: "tenon-wash" }, g)
    s("path", { d: toPath(bodyOutline({ W, H, tenon: true })), class: "outline" }, g)
    s("path", { d: toPath(tenonEdge({ W, H }), false), class: "value-edge" }, g)
  }, [W - 12, H / 2 - 26, DIM.tenon.depth + 16, 52], "value (A)")
  item("a service it needs (R)", (g) => {
    s("path", { d: toPath(pinOutline("HttpClient", H)), class: "pin" }, g)
    s("path", { d: `M${pinX("HttpClient") - 14} ${H}H${pinX("HttpClient") + 20}`, class: "outline" }, g)
  }, [pinX("HttpClient") - 14, H - 6, 34, DIM.pin.len + 10], "service (R)")
  item("a grant it declares (G)", (g) => {
    s("path", { d: toPath(bitOutline(W, H)), class: "bit" }, g)
    s("path", { d: `M${bitX(W) - 6} ${H}H${bitX(W) + DIM.bit.w + 6}`, class: "outline" }, g)
  }, [bitX(W) - 6, H - 6, DIM.bit.w + 12, DIM.bit.depth + 10], "grant (G)")
  item("<code>after</code>: orders only", (g) => {
    const a = s("g", { class: "after" }, g)
    s("path", { d: "M0.5 10.5H38", class: "after-line" }, a)
    arrowHead(a, 48, 10.5, 1, 0, 9, "after-head")
  }, [0, 0, 50, 21], "<code>after</code>")
  item("not in this plan", (g) => {
    g.classList.add("is-off")
    s("path", { d: toPath([{ x: 1, y: 1, r: 4 }, { x: 70, y: 1, r: 0 }, { x: 70, y: 40, r: 0 }, { x: 1, y: 40, r: 4 }]), class: "outline" }, g)
  }, [0, 0, 50, 26], "not in this plan")
}

async function main() {
  drawMark()
  await document.fonts.ready
  drawLegend()
  const hero = setupHero()
  window.__hero = hero
  hero.derive()
  const { setupSections } = await import("./sections.js")
  setupSections()
}

main()
