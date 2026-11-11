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

  it.live("is planned when they name it, or when no plan of the pipeline said", () =>
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
      expect(unknown.jobs).toEqual(["plan"])
      expect(recorded).toEqual(["release/*"])
    }))
})
