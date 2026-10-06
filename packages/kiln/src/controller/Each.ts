/** How a task with `each` splits its files into jobs and reads what happened to each file. */

export interface TestOutcome {
  readonly file: string | null
  readonly status: "passed" | "failed" | "skipped" | "timeout"
  readonly durationMs: number
}

export type FileStatus = "passed" | "failed" | "unknown"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** A file's expected duration from its recent ones; files never seen get the median of the others. */
export const durations = (history: ReadonlyArray<{ readonly file: string; readonly durationMs: number }>) => {
  const byFile = new Map<string, Array<number>>()
  for (const h of history) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.durationMs])
  const medians = new Map([...byFile].map(([file, ms]) => [file, median(ms)]))
  const fallback = medians.size > 0 ? median([...medians.values()]) : 5_000
  return (file: string) => medians.get(file) ?? fallback
}

/** Longest first onto the least loaded job, at most `count` jobs and never an empty one. */
export const split = (files: ReadonlyArray<string>, duration: (file: string) => number, count: number) => {
  const bins = Array.from({ length: Math.max(1, Math.min(count, files.length)) }, () => ({ files: [] as Array<string>, ms: 0 }))
  for (const file of [...files].sort((a, b) => duration(b) - duration(a) || a.localeCompare(b))) {
    const bin = bins.reduce((least, b) => (b.ms < least.ms ? b : least))
    bin.files.push(file)
    bin.ms += duration(file)
  }
  return bins
}

/**
 * What a job's report says about each of its files: a failed test fails the file; any result, or a
 * job that exited cleanly, passes it; a file the report doesn't mention after a failed job is unknown.
 */
export const outcomes = (files: ReadonlyArray<string>, tests: ReadonlyArray<TestOutcome>, exitedCleanly: boolean) =>
  new Map(files.map((file) => {
    const mine = tests.filter((t) => t.file === file)
    const status: FileStatus = mine.some((t) => t.status === "failed" || t.status === "timeout") ? "failed"
      : mine.length > 0 || exitedCleanly ? "passed"
      : "unknown"
    return [file, { status, ms: mine.reduce((sum, t) => sum + t.durationMs, 0) }] as const
  }))
