// Every part, rail and fit on the page is cut from these dimensions (px at 1:1).
// A mating cut is always the part it receives, offset by a clearance, so every fit has the same gap.

export const DIM = {
  H: 120, // part height
  Hrows: 96, // part height when the rails are laid out in rows, on phones
  corner: 4,
  c: 2, // clearance of the value joint
  chamfer: 7, // the line a chamfered top edge leaves in elevation
  tenon: { depth: 28, root: 26, tip: 44, fillet: 2 },
  pin: { w: 6, len: 22, chamfer: 2, pitch: 12, first: 14, clear: 1 },
  bit: { w: 48, depth: 28, inset: 12 },
  // 16 below the sockets, so their numbers can be lettered in the section.
  rail: { t: 40, lipW: 8, lipH: 14, pad: 12, land: 12, socket: 24, slot: 60 },
  plate: { t: 28, overhang: 8 },
  after: { rise: 24, step: 12, entry: 10, head: 7 },
  eyelet: { r: 6, hole: 2.5 },
  item: { r: 11, inset: 9 },
  emptySeat: 56,
  minW: 160,
  maxW: 196,
}

// Pin-out: where a pin for each service sits on a part's underside, from its input edge.
export const SERVICES = ["CurrentRun", "HttpClient", "PullRequest", "Git", "Gitea", "Cache", 'Secret<"deploy-token">']
export const pinX = (service) => DIM.pin.first + DIM.pin.pitch * SERVICES.indexOf(service)

// What each rule supplies (packages/core/src/Services.ts: PrBase and Base), and its floor.
export const RULES = {
  pr: { supplies: ["CurrentRun", "PullRequest", "HttpClient"], floor: "closed", label: "On.pullRequest", line: 34 },
  push: { supplies: ["CurrentRun", "Git", "Gitea", "Cache", "HttpClient"], floor: "open", label: 'On.push("main")', line: 35 },
}

// The bit seen from the side: its end has three cuts. Every x has one depth, so it drops straight.
const BIT = [
  [0, 0], [0, 28], [10, 28], [14, 21], [19, 21], [22, 28], [27, 28], [31, 16], [36, 16], [39, 28], [48, 28], [48, 0],
]

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (a, k) => ({ x: a.x * k, y: a.y * k })
const len = (a) => Math.hypot(a.x, a.y)
const unit = (a) => scale(a, 1 / len(a))
const cross = (a, b) => a.x * b.y - a.y * b.x
const round = (n) => Math.round(n * 100) / 100

const offsetLine = (p, q, d) => {
  const n = unit({ x: -(q.y - p.y), y: q.x - p.x })
  return [add(p, scale(n, -d)), add(q, scale(n, -d))]
}
const intersect = ([p1, p2], [q1, q2]) => {
  const r = sub(p2, p1)
  const s = sub(q2, q1)
  const t = cross(sub(q1, p1), s) / cross(r, s)
  return add(p1, scale(r, t))
}

/**
 * A profile in edge coordinates (x along the edge, y out of the part), offset by `clearance`, from
 * the baseline back to the baseline. Adapted from round 5's Shapes.
 */
const offsetProfile = (points, clearance) => {
  const segs = points.slice(0, -1).map((p, i) => offsetLine(p, points[i + 1], -clearance))
  const base = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
  const out = [intersect(segs[0], base)]
  for (let i = 0; i < segs.length - 1; i++) out.push(intersect(segs[i], segs[i + 1]))
  out.push(intersect(segs[segs.length - 1], base))
  return out.map((p, i) => {
    if (i === 0 || i === out.length - 1) return { x: p.x, y: p.y, r: 0 }
    const convex = cross(sub(points[i], points[i - 1]), sub(points[i + 1], points[i])) < 0
    const r = points[i].r ?? 0
    return { x: p.x, y: p.y, r: convex ? r + clearance : Math.max(0, r - clearance) }
  })
}

const TENON = (() => {
  const { depth, root, tip, fillet } = DIM.tenon
  return [
    { x: -root / 2, y: 0, r: 0 },
    { x: -tip / 2, y: depth, r: fillet },
    { x: tip / 2, y: depth, r: fillet },
    { x: root / 2, y: 0, r: 0 },
  ]
})()
const SOCKET = offsetProfile(TENON, DIM.c)

/** Rounded polygon to an SVG path: each vertex carries its own corner radius. */
export const toPath = (vertices, closed = true) => {
  const n = vertices.length
  const parts = []
  for (let i = 0; i < n; i++) {
    const p = vertices[i]
    const r = p.r ?? 0
    const first = i === 0 ? "M" : "L"
    if (!r || (!closed && (i === 0 || i === n - 1))) {
      parts.push(`${first}${round(p.x)} ${round(p.y)}`)
      continue
    }
    const a = vertices[(i - 1 + n) % n]
    const b = vertices[(i + 1) % n]
    const u1 = unit(sub(a, p))
    const u2 = unit(sub(b, p))
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)))
    const t = Math.min(r / Math.tan(theta / 2), len(sub(a, p)) / 2, len(sub(b, p)) / 2)
    const radius = t * Math.tan(theta / 2)
    const p1 = add(p, scale(u1, t))
    const p2 = add(p, scale(u2, t))
    const sweep = cross(sub(p, a), sub(b, p)) > 0 ? 1 : 0
    parts.push(`${first}${round(p1.x)} ${round(p1.y)}`)
    parts.push(`A${round(radius)} ${round(radius)} 0 0 ${sweep} ${round(p2.x)} ${round(p2.y)}`)
  }
  return parts.join("") + (closed ? "Z" : "")
}

/** Outward offset of a clockwise outline (focus and highlight rings). */
export const offsetOutline = (vertices, d) => {
  const n = vertices.length
  return vertices.map((p, i) => {
    const a = vertices[(i - 1 + n) % n]
    const b = vertices[(i + 1) % n]
    const turn = cross(sub(p, a), sub(b, p))
    const l1 = offsetLine(a, p, d)
    const q = Math.abs(turn) < 1e-9 ? l1[1] : intersect(l1, offsetLine(p, b, d))
    const r = p.r ?? 0
    return { x: q.x, y: q.y, r: turn > 0 ? r + d : Math.max(0, r - d) }
  })
}

/**
 * A part's body, clockwise from the top-left corner, in part coordinates: x along the rail from the
 * input edge, y down from the top, the rail side at y = H. `tenon`: the value profile on the output
 * edge; `socket`: a needs socket on the input edge.
 */
export const bodyOutline = ({ W, H, tenon = false, socket = false }) => {
  const R = DIM.corner
  const cy = H / 2
  const v = [{ x: 0, y: 0, r: R }, { x: W, y: 0, r: R }]
  if (tenon) for (const p of TENON) v.push({ x: W + p.y, y: cy + p.x, r: p.r })
  v.push({ x: W, y: H, r: R }, { x: 0, y: H, r: R })
  if (socket) for (const p of SOCKET.slice().reverse()) v.push({ x: p.y, y: cy + p.x, r: p.r })
  return v
}

/** The tenon alone (the part beyond the output edge), for its wash. */
export const tenonOutline = ({ W, H }) => {
  const cy = H / 2
  return TENON.map((p) => ({ x: W + p.y, y: cy + p.x, r: p.r })).concat([])
}

/** The socket's edge as an open polyline, for drawing it in the value colour. */
export const socketEdge = ({ H }) => SOCKET.map((p) => ({ x: p.y, y: H / 2 + p.x, r: p.r }))
export const tenonEdge = ({ W, H }) => TENON.map((p) => ({ x: W + p.y, y: H / 2 + p.x, r: p.r }))

/** A service pin under the part, chamfered at its tip. */
export const pinOutline = (service, H) => {
  const { w, len: l, chamfer: k } = DIM.pin
  const x = pinX(service)
  return [
    { x, y: H - 1 }, { x: x + w, y: H - 1 }, { x: x + w, y: H + l - k }, { x: x + w - k, y: H + l },
    { x: x + k, y: H + l }, { x, y: H + l - k },
  ]
}

/** The eyelet an `after` link ends in, on the middle of the part's top edge. */
export const eyelet = (W) => ({ x: W / 2, y: 0, r: DIM.eyelet.r, hole: DIM.eyelet.hole })

/** The grant bit under the part, near its output edge. */
export const bitX = (W) => W - DIM.bit.inset - DIM.bit.w
export const bitOutline = (W, H) => {
  const x0 = bitX(W)
  return BIT.map(([x, y], i) => ({ x: x0 + x, y: H - (i === 0 || i === BIT.length - 1 ? 1 : 0) + y, r: y === DIM.bit.depth && (x === 0 || x === DIM.bit.w) ? 1 : 0 }))
}

/** The whole silhouette (body, pins, bit) for rings; pins and bit are approximated by the body. */
export const silhouette = (part, H) => bodyOutline({ W: part.W, H, tenon: part.tenon, socket: part.socket })

/**
 * Where a part comes to rest on a rail, and what touches: a pin whose service the rail doesn't
 * supply stands on the rail's top, and so does a bit on a closed floor. `rest` is how far above the
 * seat the part stops (0 when it seats).
 */
export const fit = (part, rule) => {
  const r = RULES[rule]
  const contacts = []
  for (const s of part.pins ?? []) if (!r.supplies.includes(s)) contacts.push({ kind: "pin", service: s, rest: DIM.pin.len })
  if (part.bit && r.floor === "closed") contacts.push({ kind: "bit", rest: DIM.bit.depth })
  const rest = Math.max(0, ...contacts.map((c) => c.rest))
  return { rest, contacts: contacts.filter((c) => c.rest === rest && rest > 0) }
}

/** Contact marks in part coordinates: a short line along the rail top where a feature stands on it. */
export const contactMarks = (part, H, contacts) =>
  contacts.map((c) => {
    if (c.kind === "bit") {
      const x0 = bitX(part.W)
      return { x0: x0 - 3, x1: x0 + DIM.bit.w + 3, y: H + DIM.bit.depth }
    }
    const x = pinX(c.service)
    return { x0: x - 3, x1: x + DIM.pin.w + 3, y: H + DIM.pin.len }
  })

// A break line across a rail that goes on in the next row: down its end, one zigzag.
const BREAK = [[0, 0.3], [4, 0.42], [-4, 0.58], [0, 0.7]]

/**
 * A rail in section, in rail coordinates: x along the rail, y down from its top (0) to t.
 * `seats` are the x of the parts (or empty seats) on it, each `{ x, W }`. Returns the material
 * polygons (split by open floors), the socket and slot positions.
 */
export const railSection = ({ rule, x0, x1, seats, lipStart, lipEnd, cutStart = false, cutEnd = false }) => {
  const { t, lipW, lipH, socket, slot } = DIM.rail
  const r = RULES[rule]
  const holes = []
  const slots = []
  for (const seat of seats) {
    for (const s of r.supplies) {
      const hx = seat.x + pinX(s) - DIM.pin.clear
      holes.push({ x0: hx, x1: hx + DIM.pin.w + 2 * DIM.pin.clear, service: s })
    }
    if (r.floor === "open" && seat.W >= DIM.minW) {
      const cx = seat.x + bitX(seat.W) + DIM.bit.w / 2
      slots.push({ x0: cx - slot / 2, x1: cx + slot / 2 })
    }
  }
  holes.sort((a, b) => a.x0 - b.x0)
  slots.sort((a, b) => a.x0 - b.x0)
  const spans = []
  let a = x0
  for (const s of slots) {
    spans.push([a, s.x0])
    a = s.x1
  }
  spans.push([a, x1])
  const polys = spans.map(([s0, s1]) => {
    const v = [{ x: s0, y: t }]
    if (s0 === x0 && lipStart) v.push({ x: s0, y: -lipH }, { x: s0 + lipW, y: -lipH }, { x: s0 + lipW, y: 0 })
    else if (s0 === x0 && cutStart) v.push(...BREAK.map(([dx, f]) => ({ x: s0 - dx, y: t * (1 - f) })), { x: s0, y: 0 })
    else v.push({ x: s0, y: 0 })
    for (const h of holes) {
      if (h.x0 < s0 || h.x1 > s1) continue
      v.push({ x: h.x0, y: 0 }, { x: h.x0, y: socket }, { x: h.x1, y: socket }, { x: h.x1, y: 0 })
    }
    if (s1 === x1 && lipEnd) v.push({ x: s1 - lipW, y: 0 }, { x: s1 - lipW, y: -lipH }, { x: s1, y: -lipH })
    else v.push({ x: s1, y: 0 })
    if (s1 === x1 && cutEnd) v.push(...BREAK.map(([dx, f]) => ({ x: s1 + dx, y: t * f })))
    v.push({ x: s1, y: t })
    return v
  })
  return { polys, holes, slots }
}

/** A setup plate under the parts that start from it. */
export const plateOutline = (x0, x1) => {
  const { t } = DIM.plate
  return [{ x: x0, y: -t, r: 2 }, { x: x1, y: -t, r: 2 }, { x: x1, y: 0, r: 0 }, { x: x0, y: 0, r: 0 }]
}

/** Part width for a sheet: four parts plus an empty seat must fit, on the 4 px grid. */
const FIXED = () => {
  const { lipW, pad, land } = DIM.rail
  return 2 * lipW + 4 * pad + 2 * land + DIM.emptySeat + DIM.tenon.depth + 2 * DIM.c + 2
}
export const partWidth = (available) => Math.max(DIM.minW, Math.min(DIM.maxW, Math.floor((available - FIXED()) / 4 / 4) * 4))
/** The width the widest arrangement takes at part width W; below it the drawing is scaled. */
partWidth.need = (W) => 4 * W + FIXED()
