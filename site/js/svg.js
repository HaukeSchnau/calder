const NS = "http://www.w3.org/2000/svg"

export const s = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v)
  parent?.appendChild(e)
  return e
}

export const h = (tag, attrs = {}, parent) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === "text") e.textContent = v
    else if (k === "html") e.innerHTML = v
    else e.setAttribute(k, v)
  }
  parent?.appendChild(e)
  return e
}

export const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

let uid = 0
export const nextId = (p) => `${p}-${++uid}`

/** A hatch pattern: 1 px lines at `angle`, `gap` apart, in user space. */
export const hatch = (defs, id, angle, gap, cls) => {
  const p = s("pattern", { id, patternUnits: "userSpaceOnUse", width: gap, height: gap, patternTransform: `rotate(${angle})` }, defs)
  s("line", { x1: 0, y1: 0, x2: 0, y2: gap, class: cls }, p)
  return p
}

/** A filled arrowhead with its tip at (x, y), pointing along (dx, dy). */
export const arrowHead = (parent, x, y, dx, dy, length, cls) => {
  const l = Math.hypot(dx, dy)
  const ux = dx / l
  const uy = dy / l
  const w = length * 0.42
  const bx = x - ux * length
  const by = y - uy * length
  return s("path", { d: `M${x} ${y}L${bx - uy * w} ${by + ux * w}L${bx + uy * w} ${by - ux * w}Z`, class: cls }, parent)
}

const canvas = document.createElement("canvas").getContext("2d")
/** Width of `text` in a CSS font shorthand, for laying labels out before they exist. */
export const measure = (text, font) => {
  canvas.font = font
  return canvas.measureText(text).width
}

/** Greedy wrap by measured width. */
export const wrap = (text, font, width) => {
  const words = text.split(" ")
  const lines = []
  let line = ""
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (line && measure(next, font) > width) {
      lines.push(line)
      line = w
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export const FONT = {
  label: '500 13px "Overpass", system-ui, sans-serif',
  note: '400 13px "Overpass", system-ui, sans-serif',
  mono: '600 13px "Overpass Mono", ui-monospace, monospace',
  name: '600 15px "Overpass Mono", ui-monospace, monospace',
  item: '500 12px "Overpass Mono", ui-monospace, monospace',
  callout: '600 14px "Overpass", system-ui, sans-serif',
}

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches
