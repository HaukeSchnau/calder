import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { Config } from "./Config.ts"
import * as Outputs from "./Outputs.ts"

export const migrations = {
  "0001_init": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`create table runs (
      id text primary key,
      project text not null,
      number integer not null,
      event text not null,
      sha text not null,
      branch text,
      pr integer,
      title text,
      commit_title text not null,
      author text not null,
      change_id text,
      commit_time integer not null,
      trust text not null,
      status text not null,
      created_at integer not null,
      started_at integer,
      finished_at integer,
      error text,
      trace_id text not null,
      span_id text not null,
      plan text
    )`
    yield* sql`create index runs_project on runs (project, created_at desc)`
    yield* sql`create index runs_status on runs (status)`
    yield* sql`create table steps (
      run_id text not null,
      name text not null,
      kind text not null,
      status text not null,
      spec text not null,
      position integer not null,
      key text,
      reused_from text,
      queued_at integer,
      started_at integer,
      finished_at integer,
      attempts integer not null default 0,
      value text,
      outputs text,
      error_tag text,
      error_message text,
      error_json text,
      excerpt text,
      cpu_seconds real,
      memory_peak integer,
      span_id text not null,
      tests_passed integer,
      tests_failed integer,
      tests_skipped integer,
      primary key (run_id, name)
    )`
    yield* sql`create table results (
      key text not null,
      run_id text not null,
      step text not null,
      trust text not null,
      value text,
      outputs text,
      created_at integer not null
    )`
    yield* sql`create index results_key on results (key, created_at desc)`
    yield* sql`create table tests (
      run_id text not null,
      project text not null,
      step text not null,
      suite text not null,
      name text not null,
      file text,
      status text not null,
      duration_ms integer not null,
      message text,
      created_at integer not null
    )`
    yield* sql`create index tests_name on tests (project, suite, name, created_at desc)`
    yield* sql`create index tests_run on tests (run_id)`
    yield* sql`create table counters (name text primary key, value integer not null)`
    yield* sql`create table comments (project text not null, pr integer not null, step text not null, comment_id integer not null, primary key (project, pr, step))`
    yield* sql`create table deployments (
      project text not null,
      host text not null,
      revision text not null,
      store_path text not null,
      run_id text not null,
      at integer not null
    )`
    yield* sql`create index deployments_project on deployments (project, host, at desc)`
    yield* sql`create table schedules (project text not null, cron text not null, primary key (project, cron))`
  }),
  "0002_forks": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Pull requests from forks never count for trusted runs; same-repo ones may.
    yield* sql`alter table runs add column fork integer not null default 0`
  }),
  "0003_projects": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`create table projects (name text primary key, repo text not null, default_branch text not null, created_at integer not null)`
  }),
  "0004_no_workflow_engine": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Runs are driven from the journal; effect/cluster's tables held the old workflow engine's state.
    for (const table of ["cluster_messages", "cluster_replies", "cluster_runners", "cluster_locks", "cluster_migrations"]) {
      yield* sql`drop table if exists ${sql(table)}`
    }
  }),
  "0005_shards": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Each shard has its own key, result and timing, so a rerun repeats only the shards that didn't pass.
    yield* sql`create table shards (
      run_id text not null,
      step text not null,
      shard integer not null,
      key text not null,
      status text not null,
      reused_from text,
      started_at integer,
      finished_at integer,
      cpu_seconds real,
      memory_peak integer,
      primary key (run_id, step, shard)
    )`
  }),
  "0006_jobs": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Local step workers, so a restarted controller adopts the ones still running. Specs without secrets.
    yield* sql`create table jobs (
      id text primary key,
      token_hash text not null,
      pool text not null,
      spec text not null,
      created_at integer not null
    )`
  }),
  "0007_file_results": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Outcomes of the files of tasks with `each`, by the file's key: passed, flaky (passed on retry) or failed.
    yield* sql`create table file_results (
      key text not null,
      project text not null,
      step text not null,
      file text not null,
      run_id text not null,
      trust text not null,
      status text not null,
      duration_ms integer not null,
      created_at integer not null
    )`
    yield* sql`create index file_results_key on file_results (key, created_at desc)`
    yield* sql`create index file_results_file on file_results (project, step, file, created_at desc)`
  }),
  "0008_step_files": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`alter table steps add column files_total integer`
    yield* sql`alter table steps add column files_ran integer`
    yield* sql`alter table steps add column files_flaky integer`
  }),
  "0009_merges": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Pull requests Kiln merges once they are green and up to date with their base.
    yield* sql`create table merges (
      project text not null,
      pr integer not null,
      base text not null,
      status text not null,
      message text,
      requested_at integer not null,
      primary key (project, pr)
    )`
  }),
  "0010_file_jobs": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // The job a file first ran in, so a file that passed only on retry can name the files it ran with.
    yield* sql`alter table file_results add column job integer`
    yield* sql`create index file_results_job on file_results (run_id, step, job)`
  }),
  "0011_test_retries": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // A test that ran again in its step keeps every record; the last one holds its outcome.
    yield* sql`alter table tests add column superseded integer not null default 0`
    yield* sql`alter table steps add column tests_flaky integer`
  }),
  "0012_result_outcomes": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Failed results too, so a key whose outcome changes shows. Only passed ones are reused.
    yield* sql`alter table results add column status text not null default 'passed'`
    yield* sql`alter table steps add column contradicts text`
  }),
  "0013_retention_indexes": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // What pruning a run looks up: its results, and newer runs that reused them.
    yield* sql`create index results_run on results (run_id)`
    yield* sql`create index steps_reused_from on steps (reused_from) where reused_from is not null`
  }),
}

/**
 * Prunes runs that finished more than `days` ago, one at a time so other queries get their turn: their
 * steps, shards and tests go, and so do results Kiln won't reuse or compare with. A result stays while
 * it's the newest of its key with its outcome (per trust, and for pull requests per fork) or a run
 * inside the window reused its run; a file result only while it's the newest passing one.
 * Such a run keeps its row, without its plan, so the result stays reusable and links to it resolve;
 * so does the newest run of each branch push and pull request, which the catch-up looks for. Each
 * project's newest planned run stays whole.
 */
export const prune = (days: number, now = Date.now()) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const cutoff = now - days * 86_400_000
    const old = yield* sql<{ id: string; project: string; event: string; tag: string; fork: number; created_at: number }>`
      select id, project, event, json_extract(event, '$._tag') as tag, fork, created_at from runs
      where finished_at < ${cutoff} and status not in ('queued', 'planning', 'running')
        and id not in (select id from (
          select id, row_number() over (partition by project order by created_at desc) as n from runs where plan is not null
        ) where n = 1)
      order by finished_at`
    // bun:sqlite blocks the event loop while a query runs, and a worker drops its connection after five
    // seconds without a ping; pauses between small deletes let pings through.
    const pause = Effect.sleep("50 millis")
    const counts = { deleted: 0, trimmed: 0 }
    for (const run of old) {
      // A run can have tens of thousands of test results, too many for one statement.
      while ((yield* sql`delete from tests where rowid in (select rowid from tests where run_id = ${run.id} limit 1000) returning 1`).length > 0) {
        yield* pause
      }
      const outcome = yield* sql.withTransaction(Effect.gen(function*() {
        const recent = sql`(runs.finished_at is null or runs.finished_at >= ${cutoff})`
        const reused = (yield* sql`select 1 from steps join runs on runs.id = steps.run_id where steps.reused_from = ${run.id} and ${recent}
          union all select 1 from shards join runs on runs.id = shards.run_id where shards.reused_from = ${run.id} and ${recent}
          limit 1`).length > 0
        const latest = (run.tag === "Push" || run.tag === "PullRequest") && (yield* sql`select 1 from runs
          where project = ${run.project} and event = ${run.event} and created_at > ${run.created_at} limit 1`).length === 0
        if (!reused) {
          yield* sql`delete from results where run_id = ${run.id} and exists (
            select 1 from results as newer join runs on runs.id = newer.run_id
            where newer.key = results.key and newer.status = results.status and newer.trust = results.trust
              and runs.fork = ${run.fork} and newer.created_at > results.created_at)`
        }
        yield* sql`delete from file_results where run_id = ${run.id} and (status = 'failed' or exists (
          select 1 from file_results as newer join runs on runs.id = newer.run_id
          where newer.key = file_results.key and newer.trust = file_results.trust and newer.status != 'failed'
            and runs.fork = ${run.fork} and newer.created_at > file_results.created_at))`
        yield* sql`delete from shards where run_id = ${run.id}`
        yield* sql`delete from steps where run_id = ${run.id}`
        const holds = (yield* sql`select 1 from results where run_id = ${run.id}
          union all select 1 from file_results where run_id = ${run.id} limit 1`).length > 0
        if (reused || latest || holds) {
          const trimmed = yield* sql`update runs set plan = null where id = ${run.id} and plan is not null returning id`
          return trimmed.length > 0 ? "trimmed" : "kept"
        }
        yield* sql`delete from runs where id = ${run.id}`
        return "deleted"
      }))
      if (outcome !== "kept") counts[outcome]++
      yield* pause
    }
    return counts
  })

export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const client = SqliteClient.layer({ filename: join(config.stateDir, "kiln.db") })
  const migrate = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations), table: "kiln_migrations" })
  const retention = Layer.effectDiscard(
    prune(config.retention.days).pipe(
      Effect.tap(({ deleted, trimmed }) =>
        deleted + trimmed === 0 ? Effect.void : Effect.logInfo(`pruned runs past retention: deleted ${deleted}, trimmed ${trimmed}`)
      ),
      Effect.andThen(Outputs.sweep(config.stateDir)),
      Effect.catchCause((cause) => Effect.logWarning("pruning history failed", cause)),
      Effect.repeat(Schedule.spaced("6 hours")),
      Effect.forkScoped,
    ),
  )
  return Layer.provideMerge(retention, Layer.provideMerge(migrate, client))
}))
