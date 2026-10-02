import type { Domain } from "@kiln/api"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { href } from "./route.ts"
import { dur } from "./format.ts"

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

const PAD = { l: 40, r: 8, t: 8, b: 18 }

export interface Bar {
  readonly value: number | null
  readonly cls?: string
}

interface ChartProps {
  readonly height?: number
  readonly fmt: (v: number) => string
  readonly xLabels?: readonly [string, string]
  readonly onHover?: (i: number | null) => void
}

function Frame({ width, height, max, fmt, xLabels, children, n, bars, onHover }: ChartProps & {
  readonly width: number
  readonly height: number
  readonly max: number
  readonly n: number
  readonly bars: boolean
  readonly children: ReactNode
}) {
  const [hover, setHover] = useState<number | null>(null)
  const iw = width - PAD.l - PAD.r
  const ih = height - PAD.t - PAD.b
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const xAt = (i: number) => PAD.l + (bars ? (i + 0.5) * (iw / n) : n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const pick = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - PAD.l
    return Math.max(0, Math.min(n - 1, bars ? Math.floor(px / (iw / n)) : Math.round((px / iw) * (n - 1))))
  }
  return (
    <svg
      width={width}
      height={height}
      onPointerMove={(e) => { const i = pick(e.clientX, e.currentTarget.getBoundingClientRect()); setHover(i); onHover?.(i) }}
      onPointerLeave={() => { setHover(null); onHover?.(null) }}
    >
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={y(max * f)} y2={y(max * f)} />
          <text className="tick" x={PAD.l - 6} y={y(max * f) + 3.5} textAnchor="end">{fmt(max * f)}</text>
        </g>
      ))}
      {xLabels && (
        <>
          <text className="tick" x={PAD.l} y={height - 4}>{xLabels[0]}</text>
          <text className="tick" x={width - PAD.r} y={height - 4} textAnchor="end">{xLabels[1]}</text>
        </>
      )}
      {children}
      {hover !== null && n > 0 && <line className="cross" x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t} y2={PAD.t + ih} />}
    </svg>
  )
}

export function BarChart({ bars, height = 84, baseline, ...props }: ChartProps & { readonly bars: ReadonlyArray<Bar>; readonly baseline?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const values = bars.map((b) => b.value ?? 0)
  const max = niceMax(Math.max(...values, baseline ?? 0, 1) * 1.08)
  const n = bars.length
  const iw = width - PAD.l - PAD.r
  const ih = height - PAD.t - PAD.b
  const bw = Math.max(2, Math.min(10, iw / Math.max(1, n) - 3))
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {width > 0 && (
        <Frame width={width} height={height} max={max} n={n} bars {...props}>
          {baseline !== undefined && <line className="baseline" x1={PAD.l} x2={width - PAD.r} y1={PAD.t + ih - (baseline / max) * ih} y2={PAD.t + ih - (baseline / max) * ih} />}
          {bars.map((b, i) => {
            const cx = PAD.l + (i + 0.5) * (iw / n)
            if (b.value === null) return <rect key={i} className={`cbar empty ${b.cls ?? ""}`} x={cx - bw / 2} y={PAD.t + ih - 3} width={bw} height={3} rx={1} />
            const h = Math.max(1.5, (b.value / max) * ih)
            return <rect key={i} className={`cbar ${b.cls ?? ""}`} x={cx - bw / 2} y={PAD.t + ih - h} width={bw} height={h} rx={1} />
          })}
        </Frame>
      )}
    </div>
  )
}

export function LineChart({ values, height = 84, cls = "", ...props }: ChartProps & { readonly values: ReadonlyArray<number>; readonly cls?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const max = niceMax(Math.max(...values, 1) * 1.08)
  const n = values.length
  const iw = width - PAD.l - PAD.r
  const ih = height - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const last = values.at(-1)
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {width > 0 && n > 0 && (
        <Frame width={width} height={height} max={max} n={n} bars={false} {...props}>
          <polyline className={`line ${cls}`} points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />
          {last !== undefined && <circle className={`end ${cls}`} cx={x(n - 1)} cy={y(last)} r={3} />}
        </Frame>
      )}
    </div>
  )
}

/** Recent runs of a branch as bars: height is duration, colour is status. Each bar opens its run. */
export function RunSpark({ history, width = 132, height = 18 }: { readonly history: Domain.Project["history"]; readonly width?: number; readonly height?: number }) {
  const n = 20
  const slot = width / n
  const known = history.map((h) => h.durationMs).filter((d): d is number => d !== null)
  const max = Math.max(1, ...known)
  const offset = n - history.length
  return (
    <svg className="rspark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Recent runs">
      {history.map((h, i) => {
        const v = h.durationMs ?? max * 0.6
        const bh = Math.max(3, (v / max) * (height - 2))
        return (
          <a key={h.id} href={href({ page: "run", id: h.id, step: null })} data-tip={`${h.status}${h.durationMs !== null ? `, ${dur(h.durationMs)}` : ""}`}>
            <rect className={`s-${h.status}`} x={(offset + i) * slot + 0.5} y={height - bh} width={Math.max(2, slot - 2)} height={bh} rx={1} />
          </a>
        )
      })}
    </svg>
  )
}
