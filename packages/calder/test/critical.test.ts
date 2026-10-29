import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { criticalPath } from "../src/controller/Rows.ts"
import type { PlannedStep } from "../src/Protocol.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const p = (name: string, fields: Partial<PlannedStep>): PlannedStep => ({
  name, kind: "task", needs: [], exits: [], after: [], required: [], target: true, neverReuse: false, detail: name,
  build: null, setup: null, task: null, action: null, output: null, ...fields,
})
const task = (lease: boolean, preview: boolean) => ({
  shell: null, keyBase: "", inputs: [], interpolates: [], shards: null, each: null, deps: "", outputs: [], secrets: [], platform: null, lease, preview,
})

describe("the critical path", () => {
  const steps = [
    p("deps", { kind: "build" }),
    p("bundle", { kind: "build", needs: ["deps"] }),
    p("lint", {}),
    p("node", { kind: "build" }),
    p("smoke", { kind: "build", needs: ["bundle", "node"] }),
    p("deploy-beta", { needs: ["bundle"], after: ["lint"], task: task(true, false) }),
    p("preview", { needs: ["bundle"], after: ["smoke", "lint"], gates: ["smoke"], task: task(false, true) }),
    p("preview-url", { kind: "action", needs: ["preview"], action: { deploy: false, secrets: [], preview: true } }),
    p("e2e-web", { after: ["preview-url"] }),
    // A plan's own word doesn't count.
    p("bulk", { critical: true }),
  ]
  it("is every step whose value a deploy reads or that gates it, not the checks a deploy merely waits for", () => {
    expect(criticalPath(steps, false).filter((s) => s.critical).map((s) => s.name)).toEqual([
      "deps",
      "bundle",
      "node",
      "smoke",
      "deploy-beta",
      "preview",
      "preview-url",
    ])
  })
  it("is empty for a fork's run", () => {
    expect(criticalPath(steps, true).filter((s) => s.critical)).toEqual([])
  })
})
