import type { Domain } from "@kiln/api"

// Twelve glazes, muted like ceramic glazes. No reds or oranges: those mean failure and work in progress.
const GLAZES = ["#8fc1a9", "#86a8e7", "#5b7fe0", "#e7c9a0", "#4fb3a9", "#a592e0", "#7fa65e", "#a7aea4", "#ddd3bf", "#d4b04a", "#3f9b98", "#c7a0d9"] as const

const fnv = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Same key, same colour, wherever it appears. */
export const glaze = (key: string): string => GLAZES[fnv(key) % GLAZES.length] ?? GLAZES[0]

/** The part of a key or store path a person compares: the hash, seven characters of it. */
export const shortKey = (key: string): string => {
  const store = /^\/nix\/store\/([0-9a-z]{32})-/.exec(key)
  return (store?.[1] ?? key).slice(0, 7)
}

export const shortSha = (sha: string) => sha.slice(0, 7)

export const storeName = (path: string) => path.replace(/^\/nix\/store\/[0-9a-z]{32}-/, "")

/** Terse age: 40s, 6m, 2h, 4d. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400 * 2) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const pad = (n: number) => String(n).padStart(2, "0")

export const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const clockS = (ms: number) => `${clock(ms)}:${pad(new Date(ms).getSeconds())}`

/** When: today as a clock, earlier as a date. */
export function when(ms: number, now: number): string {
  const d = new Date(ms)
  if (d.toDateString() === new Date(now).toDateString()) return clock(ms)
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`
}

/** Durations as m:ss, or h:mm:ss past an hour. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** Span durations: 4 ms, 0.8 s, 12 s, 3:02. */
export function spanDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return dur(ms)
}

export function bytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(2)} GiB`
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MiB`
  return `${Math.round(n / 1024)} KiB`
}

/** Where a run came from, as short as it can be: main, PR #418, cron, manual. */
export function refOf(run: Domain.Run): string {
  switch (run.event._tag) {
    case "PullRequest":
      return `PR #${run.event.number}`
    case "Push":
      return run.event.branch
    case "Schedule":
      return "cron"
    case "Manual":
      return "manual"
  }
}

export function eventLine(event: Domain.Event): string {
  switch (event._tag) {
    case "PullRequest":
      return `pull request, ${event.head} into ${event.base}`
    case "Push":
      return `push to ${event.branch}`
    case "Schedule":
      return `schedule ${event.cron}`
    case "Manual":
      return Object.keys(event.inputs).length ? `manual, ${Object.entries(event.inputs).map(([k, v]) => `${k} ${String(v)}`).join(", ")}` : "manual"
  }
}

export const titleOf = (run: Domain.Run) => run.title ?? run.commit.title

export function runDuration(run: Domain.Run, now: number): number | null {
  if (run.startedAt === null) return null
  return (run.finishedAt ?? now) - run.startedAt
}

export function stepDuration(step: Domain.StepRun, now: number): number | null {
  if (step.startedAt === null) return null
  return (step.finishedAt ?? now) - step.startedAt
}

export const count = (counts: Domain.Run["counts"], ...statuses: ReadonlyArray<Domain.StepStatus>) =>
  statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0)

export const totalSteps = (counts: Domain.Run["counts"]) => Object.values(counts).reduce((a, b) => a + b, 0)

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
