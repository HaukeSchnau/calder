import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { Config } from "./Config.ts"

const migrations = {
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
}

export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const client = SqliteClient.layer({ filename: join(config.stateDir, "kiln.db") })
  const migrate = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations), table: "kiln_migrations" })
  return Layer.provideMerge(migrate, client)
}))
