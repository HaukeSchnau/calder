// Layered layout for a run's step graph. Columns come from the longest path over needs, after and
// exits; a graph without edges wraps into a grid instead. Steps that some step requires through branch protection collapse into one "Required
// checks" group, as in the prototype, so their gate edges merge into one. Within a column, nodes
// follow the average height of what feeds them, so a chain of values runs on one straight row.

import type { Domain } from "@kiln/api"

export type EdgeKind = "needs" | "after" | "required" | "exit"

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Edge {
  /** Graph nodes, where the group stands for its members. */
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  readonly d: string
}

export interface Layout {
  readonly width: number
  readonly height: number
  readonly boxes: ReadonlyMap<string, Box>
  readonly group: { readonly box: Box; readonly members: ReadonlyArray<string> } | null
  readonly edges: ReadonlyArray<Edge>
}

export const GROUP = "@required"
export const NODE_H = 44
export const ROW_H = 28
export const HEAD_H = 30
const GAP_X = 44
const GAP_Y = 14
const R = 6

/** A string that only changes when the graph's shape does, so positions survive status updates. */
export const shapeKey = (steps: ReadonlyArray<Domain.StepRun>) =>
  steps.map((s) => `${s.name}|${s.needs.join(",")}|${s.after.join(",")}|${s.exits.join(",")}|${s.required.join(",")}|${s.shards ?? ""}`).join("\n")

const textWidth = (s: string) => s.length * 7 + 70

export function layout(steps: ReadonlyArray<Domain.StepRun>): Layout {
  const names = new Set(steps.map((s) => s.name))
  const required = [...new Set(steps.flatMap((s) => s.required))].filter((n) => names.has(n))
  const members = required.length >= 2 ? steps.map((s) => s.name).filter((n) => required.includes(n)) : []
  const port = (name: string) => (members.includes(name) ? GROUP : name)

  const nodes: Array<string> = []
  for (const s of steps) if (!nodes.includes(port(s.name))) nodes.push(port(s.name))

  const links: Array<{ from: string; to: string; kind: EdgeKind }> = []
  const seen = new Set<string>()
  for (const s of steps) {
    const groups: ReadonlyArray<readonly [EdgeKind, ReadonlyArray<string>]> = [["needs", s.needs], ["exit", s.exits], ["after", s.after]]
    for (const [kind, deps] of groups) {
      for (const dep of deps) {
        if (!names.has(dep)) continue
        const from = port(dep)
        const to = port(s.name)
        const k: EdgeKind = kind === "after" && s.required.includes(dep) ? "required" : kind
        const id = `${from}>${to}:${k}`
        if (from === to || seen.has(id)) continue
        seen.add(id)
        links.push({ from, to, kind: k })
      }
    }
  }

  const preds = new Map<string, Array<string>>(nodes.map((n) => [n, []]))
  for (const l of links) preds.get(l.to)?.push(l.from)

  const column = new Map<string, number>()
  const columnOf = (n: string, trail: ReadonlySet<string> = new Set()): number => {
    const known = column.get(n)
    if (known !== undefined) return known
    const ps = (preds.get(n) ?? []).filter((p) => !trail.has(p))
    const c = ps.length ? 1 + Math.max(...ps.map((p) => columnOf(p, new Set([...trail, n])))) : 0
    column.set(n, c)
    return c
  }
  const columns: Array<Array<string>> = []
  if (links.length === 0 && nodes.length > 3) {
    // Nothing depends on anything (a pull request's checks): one column would be a long list, so the
    // steps wrap into a grid, in plan order down each column.
    const rows = Math.ceil(nodes.length / Math.ceil(Math.sqrt(nodes.length / 2)))
    for (let i = 0; i < nodes.length; i += rows) columns.push(nodes.slice(i, i + rows))
  } else {
    for (const n of nodes) (columns[columnOf(n)] ??= []).push(n)
  }

  // A few barycenter sweeps against the previous columns reduce crossings.
  const index = new Map<string, number>()
  const reindex = () => columns.forEach((col) => col.forEach((n, i) => index.set(n, i)))
  reindex()
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const col of columns.slice(1)) {
      const weight = new Map(col.map((n) => {
        const ps = preds.get(n) ?? []
        return [n, ps.length ? ps.reduce((a, p) => a + (index.get(p) ?? 0), 0) / ps.length : (index.get(n) ?? 0)] as const
      }))
      col.sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0))
      reindex()
    }
  }

  const label = (n: string) => steps.find((s) => s.name === n)
  const widthOf = (n: string) => {
    if (n === GROUP) return Math.max(256, ...members.map((m) => textWidth(m) + 96))
    const s = label(n)
    return Math.min(240, Math.max(140, textWidth(n) + (s?.shards ? 24 : 0)))
  }
  const heightOf = (n: string) => (n === GROUP ? HEAD_H + members.length * ROW_H + 6 : NODE_H)

  const boxes = new Map<string, Box>()
  let x = 0
  for (const col of columns) {
    const w = Math.max(...col.map(widthOf))
    let bottom = -Infinity
    let stack = 0
    const placed: Array<{ n: string; y: number; desired: number | null }> = []
    for (const n of col) {
      const h = heightOf(n)
      const ps = (preds.get(n) ?? []).map((p) => boxes.get(p)).filter((b): b is Box => b !== undefined)
      const desired = ps.length ? ps.reduce((a, b) => a + b.y + b.h / 2, 0) / ps.length - h / 2 : null
      const y = Math.max(desired ?? stack, bottom + GAP_Y)
      placed.push({ n, y, desired })
      bottom = y + h
      stack = bottom + GAP_Y
    }
    for (const p of placed) boxes.set(p.n, { x, y: p.y, w, h: heightOf(p.n) })
    x += w + GAP_X
  }

  const top = Math.min(0, ...[...boxes.values()].map((b) => b.y))
  for (const [n, b] of boxes) boxes.set(n, { ...b, y: b.y - top })

  const groupBox = boxes.get(GROUP)
  if (groupBox) {
    members.forEach((m, i) => boxes.set(m, { x: groupBox.x, y: groupBox.y + HEAD_H + i * ROW_H, w: groupBox.w, h: ROW_H }))
  }

  const solid = [...nodes.map((n) => boxes.get(n))].filter((b): b is Box => b !== undefined)
  // Each source in a column gets its own vertical lane, so trunks of different sources never merge.
  const lanes = new Map<string, number>()
  for (const col of columns) col.filter((n) => links.some((l) => l.from === n)).forEach((n, i) => lanes.set(n, i))
  const edges = links.map((l) => {
    const a = boxes.get(l.from)
    const b = boxes.get(l.to)
    return a && b ? { ...l, d: route(a, b, solid, lanes.get(l.from) ?? 0) } : null
  }).filter((e): e is Edge => e !== null)

  const all = [...boxes.values()]
  return {
    width: Math.max(0, ...all.map((b) => b.x + b.w)),
    height: Math.max(0, ...all.map((b) => b.y + b.h)),
    boxes,
    group: groupBox ? { box: groupBox, members } : null,
    edges,
  }
}

/** Right side of the source to left side of the target with one vertical, placed where it doesn't cut through a node. */
function route(a: Box, b: Box, obstacles: ReadonlyArray<Box>, lane: number): string {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  if (Math.abs(y1 - y2) < 1) return `M${x1} ${y1}H${x2}`
  const between = obstacles.filter((o) => o !== a && o !== b && o.x > x1 && o.x + o.w < x2)
  const blocked = (y: number, from: number, to: number) => between.some((o) => o.x < to && o.x + o.w > from && y > o.y - 4 && y < o.y + o.h + 4)
  const lead = 12 + (lane % 4) * 8
  const nearSource = x1 + lead
  const nearTarget = x2 - lead
  const xm = !blocked(y2, nearSource, x2) ? nearSource : nearTarget
  const dy = y2 > y1 ? 1 : -1
  const r = Math.min(R, Math.abs(y2 - y1) / 2)
  return `M${x1} ${y1}H${xm - r}Q${xm} ${y1} ${xm} ${y1 + dy * r}V${y2 - dy * r}Q${xm} ${y2} ${xm + r} ${y2}H${x2}`
}
