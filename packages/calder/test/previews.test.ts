import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const action = (name: string, preview: boolean): PlannedStep => ({
  ...step,
  name,
  kind: "action",
  needs: [],
  detail: name,
  action: { deploy: false, secrets: [], preview },
})

describe("a pull request's preview", () => {
  it.live("runs its actions as trusted jobs, for the network, and the pull request's other actions sandboxed", () =>
    Effect.gen(function*() {
      const { status, pools } = yield* drive({
        steps: [action("preview-url", true), action("summary", false)],
        event: { _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: false },
      })
      expect(status).toBe("passed")
      expect(pools.get("preview-url")).toBe("trusted")
      expect(pools.get("summary")).toBe("pr")
    }))

  it.live("from a fork runs every action sandboxed, in the forks' own pool", () =>
    Effect.gen(function*() {
      const { pools } = yield* drive({
        steps: [action("preview-url", true), action("summary", false)],
        event: { _tag: "PullRequest", number: 5, base: "main", head: "feature", fork: true },
      })
      // A same-repo pull request's jobs never read what a fork's job wrote, so the default branch may take their plans.
      expect(pools.get("preview-url")).toBe("fork")
      expect(pools.get("summary")).toBe("fork")
    }))
})
