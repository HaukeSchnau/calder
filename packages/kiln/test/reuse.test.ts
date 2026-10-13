import { describe, expect, it } from "@effect/vitest"
import * as Rows from "../src/controller/Rows.ts"

const task = (outputs: ReadonlyArray<string>, neverReuse = false) => ({ neverReuse, task: { outputs } })

describe("reuse", () => {
  it("reruns tasks without outputs on reuse \"builds\", files of tasks with each too", () => {
    expect(Rows.reusable(task([]), "builds")).toBe(false)
    expect(Rows.reusable(task(["dist"]), "builds")).toBe(true)
    expect(Rows.reusable(task([]), "all")).toBe(true)
    expect(Rows.reusable(task(["dist"]), "none")).toBe(false)
  })
})
