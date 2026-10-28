import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import { Comments, layer as comments } from "../src/controller/Comments.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Projects } from "../src/controller/Projects.ts"
import { config } from "./config.ts"
import { unused } from "./drive.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/** Comments with a Gitea that records each comment it gets, and two runs of pull request 5. */
const setup = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  for (const [id, at] of [["app-1", 1], ["app-2", 2]] as const) {
    yield* sql`insert into runs (id, project, number, event, sha, branch, pr, commit_title, author, commit_time, trust, status, created_at,
        trace_id, span_id) values (${id}, 'app', ${at}, '{"_tag":"PullRequest","number":5}', ${`sha-${at}`}, 'feature', 5, 't', 'h', 0, 'pr',
        'running', ${at}, 't', 's')`
  }
  const spec = { name: "lint", kind: "task", needs: [], exits: [], after: [], required: [], target: true, neverReuse: false, detail: "lint",
    build: null, setup: null, task: null, action: null, output: null }
  yield* sql`insert into steps (run_id, name, kind, status, spec, position, span_id, started_at)
    values ('app-2', 'lint', 'task', 'running', ${JSON.stringify(spec)}, 0, 's', 3)`
  const posted: Array<string> = []
  const project = { name: "app", repo: "o/app", defaultBranch: "main", targets: null, secrets: {} }
  const service = yield* Effect.provide(Effect.gen(function*() { return yield* Comments }), comments.pipe(Layer.provide(Layer.mergeAll(
    config(),
    Layer.succeed(SqlClient.SqlClient)(sql),
    Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: unused }),
    Layer.succeed(Gitea)({
      comment: (_repo, _pr, body) => Effect.sync(() => (posted.push(body), posted.length)),
      status: unused, requiredChecks: unused, head: unused, pullTitle: unused, dispatch: unused, repos: unused, hasFile: unused, pull: unused,
      updatePull: unused, mergePull: unused, openPulls: unused,
    }),
  ))))
  return { sql, service, posted }
})

/** Past the comment's wait for more changes. */
const later = Effect.sleep("3500 millis")

describe("Calder's comment on a pull request", () => {
  it.live("takes notes only from the pull request's newest run, a few seconds later, and edits only when its state changed", () =>
    Effect.gen(function*() {
      const { sql, service, posted } = yield* setup
      yield* service.note("app-1", "preview-url", "Preview: https://old.example")
      yield* later
      expect(posted).toEqual([])

      yield* service.note("app-2", "preview-url", "Preview: https://pr-5.example")
      expect(posted).toEqual([])
      yield* later
      expect(posted).toHaveLength(1)
      expect(posted[0]).toContain("Preview: https://pr-5.example")

      yield* service.touch("app-2")
      yield* later
      expect(posted).toHaveLength(1)

      yield* sql`update steps set status = 'passed', finished_at = 9 where run_id = 'app-2' and name = 'lint'`
      yield* service.touch("app-2")
      yield* later
      expect(posted).toHaveLength(2)
      expect(posted[1]).toContain("| lint | passed |")
    }).pipe(Effect.provide(sqlite)), { timeout: 30_000 })
})
