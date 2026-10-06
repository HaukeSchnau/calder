import { describe, expect, it } from "@effect/vitest"
import * as Each from "../src/controller/Each.ts"

describe("Each", () => {
  it("splits files longest first onto the least loaded job", () => {
    const ms: Record<string, number> = { replay: 120_000, git: 60_000, mcp: 50_000, a: 1_000, b: 1_000 }
    const bins = Each.split(Object.keys(ms), (f) => ms[f]!, 3)
    expect(bins.map((b) => b.files)).toEqual([["replay"], ["git"], ["mcp", "a", "b"]])
    expect(Each.split(["a"], () => 1, 6)).toHaveLength(1)
  })

  it("expects unknown files to take the median of known ones", () => {
    const duration = Each.durations([
      { file: "a", durationMs: 10 },
      { file: "a", durationMs: 30 },
      { file: "b", durationMs: 100 },
      { file: "c", durationMs: 1_000 },
    ])
    expect(duration("a")).toBe(30)
    expect(duration("new")).toBe(100)
    expect(Each.durations([])("new")).toBe(5_000)
  })

  it("reads a file's outcome from its tests, or from a clean exit", () => {
    const tests: ReadonlyArray<Each.TestOutcome> = [
      { file: "ok.test.ts", status: "passed", durationMs: 5 },
      { file: "ok.test.ts", status: "skipped", durationMs: 0 },
      { file: "bad.test.ts", status: "passed", durationMs: 5 },
      { file: "bad.test.ts", status: "timeout", durationMs: 60_000 },
    ]
    const after = (clean: boolean) => Object.fromEntries([...Each.outcomes(["ok.test.ts", "bad.test.ts", "silent.test.ts"], tests, clean)].map(([f, o]) => [f, o.status]))
    expect(after(false)).toEqual({ "ok.test.ts": "passed", "bad.test.ts": "failed", "silent.test.ts": "unknown" })
    expect(after(true)["silent.test.ts"]).toBe("passed")
  })
})
