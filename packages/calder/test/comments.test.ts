import { describe, expect, it } from "@effect/vitest"
import type { Domain } from "@calder-ci/api"
import { render } from "../src/controller/Comments.ts"

const at = 1_000_000
const run = {
  id: "studienbuch-21",
  number: 21,
  status: "running",
  createdAt: at,
  plannedAt: at + 3_000,
  finishedAt: null,
  commit: { sha: "abcdef1234567890" },
} as unknown as Domain.Run

const step = (name: string, fields: Partial<Domain.StepRun>): Domain.StepRun =>
  ({ name, kind: "task", status: "passed", queuedAt: null, startedAt: null, finishedAt: null, error: null, needs: [], exits: [], after: [], ...fields }) as Domain.StepRun

describe("Calder's comment on a pull request", () => {
  it("links the preview with how long after the push it was ready, next to the checks and their times", () => {
    const body = render({
      run,
      now: at + 100_000,
      link: "https://calder.example/app/#/run/studienbuch-21",
      notes: [{ step: "preview-url", run: { id: "studienbuch-21", number: 21 }, markdown: "Preview: https://pr-5.example", at: at + 91_000 }],
      steps: [
        step("bundle", { kind: "build", critical: true, queuedAt: at + 3_000, startedAt: at + 5_000, finishedAt: at + 63_000 }),
        step("preview-url", { kind: "action", critical: true, queuedAt: at + 80_000, startedAt: at + 80_000, finishedAt: at + 92_000 }),
        step("lint", { status: "running", queuedAt: at + 3_000, startedAt: at + 7_000 }),
        step("test-web", { status: "queued", queuedAt: at + 3_000, waiting: "a task slot: 3 of 3 busy: t3code-452 test-server" }),
        step("e2e-web", { status: "pending", after: ["preview-url", "lint"] }),
        step("fmt-check", { status: "reused" }),
      ],
    })
    expect(body).toBe([
      "Preview: https://pr-5.example",
      "<sub>1m 31s after the push</sub>",
      "",
      "**Run 21** running, 1m 40s so far · `abcdef123456` · planned in 3 s · [steps](https://calder.example/app/#/run/studienbuch-21)",
      "",
      "| Step | Status | Waited | Took |",
      "| --- | --- | ---: | ---: |",
      "| bundle · | passed | 2 s | 58 s |",
      "| preview-url · | passed | 0 s | 12 s |",
      "| lint | running | 4 s | 1m 33s so far |",
      "| test-web | waiting for a task slot: 3 of 3 busy: t3code-452 test-server |  |  |",
      "| e2e-web | waiting for lint to pass |  |  |",
      "",
      "Steps marked · are on the preview's or deploy's critical path; they waited 2 s for slots in all.",
      "Reused 1 identical result: fmt-check.",
    ].join("\n"))
  })

  it("keeps an earlier run's preview until the newest run says otherwise", () => {
    const body = render({ run, now: at, link: "l", notes: [{ step: "preview-url", run: { id: "studienbuch-20", number: 20 }, markdown: "Preview: u", at: 0 }], steps: [] })
    expect(body.split("\n").slice(0, 2)).toEqual(["Preview: u", "<sub>from run 20; run 21 hasn't said it yet</sub>"])
  })
})
