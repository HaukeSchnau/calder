/**
 * A step's test records in the order they ran: a test runs more than once when `Step.retry` repeats
 * the task or a task with `each` runs its failed files again. Each test counts once, with its last outcome.
 */

export interface TestRecord {
  readonly suite: string
  readonly name: string
  readonly file: string | null
  readonly status: "passed" | "failed" | "skipped" | "timeout"
}

const id = (t: TestRecord) => JSON.stringify([t.file, t.suite, t.name])

export const failing = (t: Pick<TestRecord, "status">) => t.status === "failed" || t.status === "timeout"

/** Marks the records a later record of the same test superseded, and the last ones of tests that failed before they passed. */
export const outcomes = <T extends TestRecord>(records: ReadonlyArray<T>) => {
  const last = new Map(records.map((t, i) => [id(t), i]))
  const failedOnce = new Set(records.filter(failing).map(id))
  return records.map((t, i) => {
    const superseded = last.get(id(t)) !== i
    return { ...t, superseded, flaky: !superseded && t.status === "passed" && failedOnce.has(id(t)) }
  })
}

export const count = (records: ReadonlyArray<TestRecord>) => {
  const latest = outcomes(records).filter((t) => !t.superseded)
  return {
    passed: latest.filter((t) => t.status === "passed").length,
    failed: latest.filter(failing).length,
    skipped: latest.filter((t) => t.status === "skipped").length,
    flaky: latest.filter((t) => t.flaky).length,
  }
}
