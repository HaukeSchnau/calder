import { describe, expect, it } from "@effect/vitest"
import * as Tests from "../src/controller/Tests.ts"

const record = (name: string, status: Tests.TestRecord["status"], file = "a.test.ts"): Tests.TestRecord => ({ suite: "", name, file, status })

describe("Tests", () => {
  it("counts a test that ran again once, with its last outcome", () => {
    const records = [
      record("passes on retry", "failed"),
      record("fails twice", "failed"),
      record("steady", "passed"),
      record("steady", "passed", "b.test.ts"),
      record("passes on retry", "passed"),
      record("fails twice", "timeout"),
    ]
    expect(Tests.count(records)).toEqual({ passed: 3, failed: 1, skipped: 0, flaky: 1 })
    expect(Tests.outcomes(records).map((t) => t.superseded)).toEqual([true, true, false, false, false, false])
  })
})
