import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { drive } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/** Says that the push rules of `.calder/` tree `tree` name `branches`. */
const pushes = (branches: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into pipeline_pushes (project, tree, branches) values ('app', 'tree', ${JSON.stringify(branches)})`
  })

describe("a push to a branch other than the default", () => {
  it.live("isn't planned when the pipeline's push rules don't name it", () =>
    Effect.gen(function*() {
      const { status, jobs } = yield* drive({
        steps: [],
        event: { _tag: "Push", branch: "fix/lane-tab-new-window" },
        unplanned: true,
        seed: pushes(["main", "release/*"]),
      })
      expect(status).toBe("missing")
      expect(jobs).toEqual([])
    }))

  it.live("whose pipeline no plan has seen reads the rules without a plan slot, and isn't planned when they don't name it", () =>
    Effect.gen(function*() {
      // No plan slot at all: a push that waited for one would never end.
      const { status, jobs } = yield* drive({
        steps: [],
        event: { _tag: "Push", branch: "fix/lane-tab-new-window" },
        plan: { pushes: ["main", "release/*"] },
        unplanned: true,
        planSlots: 0,
      })
      expect(status).toBe("missing")
      expect(jobs).toEqual(["rules"])
    }))

  it.live("is planned when they name it, or when the rules read for an unseen pipeline do", () =>
    Effect.gen(function*() {
      const named = yield* drive({
        steps: [],
        event: { _tag: "Push", branch: "release/1" },
        unplanned: true,
        seed: pushes(["main", "release/*"]),
      })
      expect(named.jobs).toEqual(["plan"])

      let recorded: unknown = undefined
      const unknown = yield* drive({
        steps: [],
        event: { _tag: "Push", branch: "release/1" },
        plan: { pushes: ["release/*"] },
        unplanned: true,
        meanwhile: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ branches: string }>`select branches from pipeline_pushes where project = 'app' and tree = 'tree'`.pipe(
            Effect.repeat({ until: (rows) => rows.length > 0, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )
          recorded = JSON.parse(rows[0]!.branches)
        }),
      })
      expect(unknown.jobs).toEqual(["rules", "plan"])
      expect(recorded).toEqual(["release/*"])
    }))
})
