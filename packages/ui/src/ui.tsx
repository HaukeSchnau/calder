import type { Domain } from "@kiln/api"
import { AsyncResult } from "effect/reactivity"
import { Cause } from "effect"
import { type ReactNode, useSyncExternalStore } from "react"
import { glaze } from "./format.ts"

/* ------------------------------------------------------------------ */
/* Time                                                                */

let now = Date.now()
const tickers = new Set<() => void>()
setInterval(() => {
  now = Date.now()
  for (const f of tickers) f()
}, 1000)

const subscribeTick = (f: () => void) => {
  tickers.add(f)
  return () => tickers.delete(f)
}

/** The current time, re-rendering once a second only the components that show it. */
export const useNow = () => useSyncExternalStore(subscribeTick, () => now)

/* ------------------------------------------------------------------ */
/* Glyphs: status as small shapes, identity as glaze                   */

export function Ring({ p = 0.3 }: { readonly p?: number }) {
  const r = 3.8
  const c = 2 * Math.PI * r
  return (
    <svg className="g g-run" viewBox="0 0 10 10" aria-label="running">
      <circle className="trk" cx="5" cy="5" r={r} />
      <circle className="arc" cx="5" cy="5" r={r} strokeDasharray={`${(Math.max(0.08, Math.min(1, p)) * c).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 5 5)" />
    </svg>
  )
}

export const Fail = () => (
  <svg className="g g-fail" viewBox="0 0 10 10" aria-label="failed">
    <path d="M2 2l6 6M8 2l-6 6" />
  </svg>
)

export const Check = () => (
  <svg className="g g-pass" viewBox="0 0 10 10" aria-label="passed">
    <path d="M2 5.2 4.2 7.4 8 2.8" />
  </svg>
)

export const Waiting = () => (
  <svg className="g g-queued" viewBox="0 0 10 10" aria-label="waiting">
    <circle cx="5" cy="5" r="3.6" />
  </svg>
)

export const Dash = ({ label }: { readonly label: string }) => (
  <svg className="g g-none" viewBox="0 0 10 10" aria-label={label}>
    <path d="M2.5 5h5" />
  </svg>
)

export const Stopped = () => (
  <svg className="g g-stop" viewBox="0 0 10 10" aria-label="cancelled">
    <circle cx="5" cy="5" r="3.6" />
    <path d="M2.6 7.4 7.4 2.6" />
  </svg>
)

/** One glyph for a run: its verdict, with progress while it runs. */
export function RunGlyph({ run }: { readonly run: Domain.Run }) {
  switch (run.status) {
    case "passed":
      return <Check />
    case "failed":
    case "errored":
      return <Fail />
    case "cancelled":
      return <Stopped />
    case "queued":
      return <Waiting />
    case "planning":
    case "running": {
      const total = Object.values(run.counts).reduce((a, b) => a + b, 0)
      const done = (run.counts["passed"] ?? 0) + (run.counts["reused"] ?? 0)
      return <Ring p={total ? done / total : 0.1} />
    }
  }
}

/** The status mark of a step; passed and reused steps carry their glaze instead. */
export function StepMark({ status }: { readonly status: Domain.StepStatus }) {
  switch (status) {
    case "failed":
    case "died":
      return <Fail />
    case "running":
      return <Ring />
    case "queued":
    case "pending":
      return <Waiting />
    case "blocked":
      return <Dash label="blocked" />
    case "cancelled":
      return <Stopped />
    case "passed":
    case "reused":
      return null
  }
}

/** A step's identity: solid once its bits exist, an outline while only its inputs are known. */
export function Swatch({ k, solid = true }: { readonly k: string | null; readonly solid?: boolean }) {
  if (k === null) return <i className="sw none" aria-hidden="true" />
  return <i className={solid ? "sw" : "sw hollow"} data-key={k} style={{ "--g": glaze(k) } as React.CSSProperties} aria-hidden="true" />
}

export const hasBits = (status: Domain.StepStatus) => status === "passed" || status === "reused"

export const Kbd = ({ children }: { readonly children: ReactNode }) => <kbd>{children}</kbd>

/* ------------------------------------------------------------------ */
/* Loading and failure                                                 */

/** Renders a result's value, keeping the previous value on screen while a refresh is in flight. */
export function Loaded<A, E>({ result, children, what }: {
  readonly result: AsyncResult.AsyncResult<A, E>
  readonly children: (value: A) => ReactNode
  readonly what: string
}) {
  if (AsyncResult.isSuccess(result)) return children(result.value)
  if (AsyncResult.isFailure(result)) {
    const previous = result.previousSuccess
    if (previous._tag === "Some") return children(previous.value.value)
    return <p className="empty">{failureText(result.cause, what)}</p>
  }
  return <p className="empty">Loading {what}</p>
}

function failureText<E>(cause: Cause.Cause<E>, what: string): string {
  const error: unknown = Cause.squash(cause)
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "NotFound") return `No ${what} here. It may have been removed.`
    if (error._tag === "Refused" && "reason" in error) return String(error.reason)
  }
  return `Couldn't load ${what}.`
}

export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "Refused" && "reason" in error) return String(error.reason)
    if (error._tag === "NotFound" && "what" in error) return `${String(error.what)} not found`
    if (error._tag === "RpcClientError") return "The controller is unreachable"
  }
  return error instanceof Error ? error.message : "Something went wrong"
}
