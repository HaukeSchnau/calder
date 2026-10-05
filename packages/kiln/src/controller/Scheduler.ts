import { Cron, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Config } from "./Config.ts"
import { Gitea } from "./Gitea.ts"
import { Projects } from "./Projects.ts"
import { Runs } from "./Workflow.ts"

/** Starts the runs of `On.schedule` rules. The schedules come from the last plan of each default branch. */
export const layer = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* Config
  const sql = yield* SqlClient.SqlClient
  const gitea = yield* Gitea
  const runs = yield* Runs
  const projects = yield* Projects
  const tick = Effect.gen(function*() {
    const now = new Date()
    now.setSeconds(0, 0)
    const rows = yield* sql<{ project: string; cron: string }>`select project, cron from schedules`
    for (const row of rows) {
      const project = projects.get(row.project)
      if (project === undefined) continue
      const cron = Cron.parse(row.cron)
      if (cron._tag === "Failure" || !Cron.match(cron.success, now)) continue
      const sha = yield* gitea.head(project.repo, project.defaultBranch)
      yield* runs.create({ project: row.project, event: { _tag: "Schedule", cron: row.cron }, sha })
    }
  }).pipe(Effect.catchCause((cause) => Effect.logError("scheduler tick failed", cause)))
  // Wake a second into every minute, so a cron match uses the minute it was due.
  const untilNextMinute = Effect.suspend(() => Effect.sleep(60_000 - (Date.now() % 60_000) + 1_000))
  yield* untilNextMinute.pipe(Effect.andThen(tick), Effect.forever, Effect.forkScoped)
}))
