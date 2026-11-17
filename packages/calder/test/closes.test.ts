import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import { vi } from "vitest"
import * as Catchup from "../src/controller/Catchup.ts"
import { Closes, layer as closes } from "../src/controller/Closes.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { type Project, Projects } from "../src/controller/Projects.ts"
import * as Webhook from "../src/controller/Webhook.ts"
import { type RunInput, Runs } from "../src/controller/Workflow.ts"
import { config } from "./config.ts"
import { unused } from "./drive.ts"
import { insertRun, layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const project: Project = { name: "app", repo: "o/app", defaultBranch: "main", targets: null, secrets: {} }

/** A pull request as Gitea has it: open, or closed at `closedAt`. */
interface Pull {
  readonly number: number
  readonly head: string
  closedAt: number | null
}

/** A run of pull request `number` that ended `status`. */
const ran = (id: string, number: number, status = "passed") =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const event = { _tag: "PullRequest", number, base: "main", head: `pr-${number}`, fork: false }
    yield* insertRun(id, { at: 1, status, trust: "pr", event: JSON.stringify(event) })
    yield* sql`update runs set pr = ${number} where id = ${id}`
  })

/**
 * Gitea with `pulls`, and the runs Calder started and cancelled. A started run leaves no row, as a closed
 * run that matches no rule doesn't.
 */
const world = (pulls: ReadonlyArray<Pull>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const started: Array<RunInput> = []
    const cancelled: Array<string> = []
    const layer = closes.pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient)(sql),
      config(),
      Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: () => Effect.succeed(project) }),
      Layer.succeed(Mirror)({
        path: () => "/mirror",
        fetch: () => Effect.void,
        hasPipeline: () => Effect.succeed(true),
        pipelineTree: unused,
        commit: unused,
        between: unused,
        contains: unused,
        pipelineDir: unused,
        flake: () => "",
        byUrl: () => ({}),
        train: unused,
        trainOf: unused,
        push: unused,
      }),
      Layer.succeed(Runs)({
        create: (input) => Effect.sync(() => void started.push(input)).pipe(Effect.as({} as never)),
        ensure: () => Effect.succeed({} as never),
        cancel: (runId) => Effect.sync(() => void cancelled.push(runId)),
        rerun: unused,
        audit: unused,
      }),
      Layer.succeed(Gitea)({
        head: () => Effect.succeed("main-sha"),
        openPulls: () =>
          Effect.succeed(pulls.filter((p) => p.closedAt === null).map((p) => ({ number: p.number, base: "main", head: p.head, sha: `sha-${p.number}`, fork: false }))),
        closedPulls: (_repo, since) =>
          Effect.succeed(
            pulls.flatMap((p) => (p.closedAt === null || p.closedAt < since ? [] : [{ number: p.number, base: "main", head: p.head, closedAt: p.closedAt }]))
              .sort((a, b) => b.closedAt - a.closedAt),
          ),
        status: unused, requiredChecks: unused, pullTitle: unused, comment: unused, dispatch: unused, repos: unused, hasFile: unused,
        pull: unused, mergedPull: unused, updatePull: unused, mergePull: unused,
      }),
    )))
    const closed = () => started.map((r) => (r.event._tag === "PullRequestClosed" ? `#${r.event.number} ${r.event.head}@${r.sha}` : r.event._tag))
    return { started, cancelled, closed, layer }
  })

/** Gitea's webhook of `pull`'s closing, signed with the test config's empty secret. */
const webhook = (pull: Pull) => {
  const body = JSON.stringify({
    action: "closed",
    number: pull.number,
    repository: { full_name: project.repo, default_branch: "main" },
    pull_request: { closed_at: new Date(pull.closedAt!).toISOString(), head: { ref: pull.head, sha: `sha-${pull.number}` }, base: { ref: "main" } },
  })
  return Webhook.handle(HttpServerRequest.fromWeb(new Request("http://calder.test/hooks/gitea", {
    method: "POST",
    headers: { "x-gitea-event": "pull_request", "x-gitea-signature": createHmac("sha256", "").update(body).digest("hex") },
    body,
  })))
}

/** Gitea's `closed_at` has whole seconds. */
const secondsAgo = (seconds: number) => Math.floor(Date.now() / 1000 - seconds) * 1000

describe("a closed pull request", () => {
  it.live("whose webhook never came gets its closed run from the catch-up, once, also when the webhook comes late", () =>
    Effect.gen(function*() {
      // Studienbuch #121: Calder's merge queue merged it while a host switch restarted the controller.
      const merged = secondsAgo(60)
      const { closed, layer } = yield* world([
        { number: 121, head: "m1/icons-stickers", closedAt: merged },
        { number: 7, head: "never-ran", closedAt: merged },
      ])
      yield* ran("app-1", 121)
      yield* Effect.gen(function*() {
        const sweep = yield* Catchup.make
        yield* sweep
        expect(closed()).toEqual(["#121 m1/icons-stickers@main-sha"])
        yield* sweep
        yield* (yield* Closes).close(project, { number: 121, base: "main", head: "m1/icons-stickers", closedAt: merged })
      }).pipe(Effect.provide(layer))
      expect(closed()).toEqual(["#121 m1/icons-stickers@main-sha"])
    }).pipe(Effect.provide(sqlite)))

  it.live("whose webhook came gets no second closed run from the catch-up, but one for its closing after a reopen", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const pull: Pull = { number: 122, head: "m1/homework", closedAt: secondsAgo(60) }
      const { closed, cancelled, started, layer } = yield* world([pull])
      yield* ran("app-1", 122, "running")
      yield* Effect.gen(function*() {
        const sweep = yield* Catchup.make
        yield* webhook(pull)
        // The webhook starts the run in the background.
        yield* Effect.sync(() => started.length).pipe(
          Effect.repeat({ until: (n) => n > 0, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("5 seconds"),
        )
        expect(cancelled).toEqual(["app-1"])
        expect(yield* sql`select settled from pull_closes where pr = 122`).toEqual([{ settled: pull.closedAt }])
        yield* sweep
        expect(closed()).toEqual(["#122 m1/homework@main-sha"])
        pull.closedAt = secondsAgo(1)
        yield* sweep
      }).pipe(Effect.provide(layer))
      expect(closed()).toEqual(["#122 m1/homework@main-sha", "#122 m1/homework@main-sha"])
    }).pipe(Effect.provide(sqlite)))
})
