import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { Migrator, SqlClient } from "effect/sql";
import { vi } from "vite-plus/test";
import { migrations } from "../src/controller/Db.ts";
import * as Rows from "../src/controller/Rows.ts";
import { client } from "./sqlite.ts";

vi.mock("@effect/sql-sqlite-bun", () => ({}));

const migrate = (upTo: string) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= upTo)),
    ),
    table: "calder_migrations",
  }).pipe(Effect.orDie);

describe("migrations", () => {
  it.effect("0026 moves each run's plan out of runs and keeps it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate("0025_overview_and_sweep_indexes");
      yield* sql`insert into runs (id, project, number, event, sha, commit_title, author, commit_time, trust, status, created_at, trace_id, span_id, plan)
        values ('p-1', 'p', 1, '{}', 'a', 't', 'h', 1, 'trusted', 'passed', 1, 't', 's', '{"steps":[]}'),
          ('p-2', 'p', 2, '{}', 'b', 't', 'h', 2, 'trusted', 'errored', 2, 't', 's', null)`;
      yield* migrate("0026_run_plans");
      expect((yield* Rows.loadRun("p-1"))?.plan).toBe('{"steps":[]}');
      expect((yield* Rows.loadRun("p-2"))?.plan).toBeNull();
      const columns = yield* sql<{ name: string }>`select name from pragma_table_info('runs')`;
      expect(columns.map((c) => c.name)).not.toContain("plan");
    }).pipe(
      Effect.provide(
        Layer.effect(SqlClient.SqlClient)(client).pipe(Layer.provide(Reactivity.layer)),
      ),
    ),
  );

  it.effect("0028 counts every pull request's closings up to the newest run as handled", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate("0027_counts_and_durations_indexes");
      yield* sql`insert into runs (id, project, number, event, sha, pr, commit_title, author, commit_time, trust, status, created_at, trace_id, span_id)
        values ('p-1', 'p', 1, '{"_tag":"PullRequest"}', 'a', 121, 't', 'h', 1, 'pr', 'passed', 10, 't', 's'),
          ('p-2', 'p', 2, '{"_tag":"PullRequestClosed"}', 'b', 122, 't', 'h', 1, 'trusted', 'passed', 20, 't', 's'),
          ('p-3', 'p', 3, '{"_tag":"Push"}', 'c', null, 't', 'h', 1, 'trusted', 'passed', 30, 't', 's')`;
      yield* migrate("0028_pull_closes");
      expect(yield* sql`select project, pr, settled from pull_closes order by pr`).toEqual([
        { project: "p", pr: 121, settled: 30 },
        { project: "p", pr: 122, settled: 30 },
      ]);
    }).pipe(
      Effect.provide(
        Layer.effect(SqlClient.SqlClient)(client).pipe(Layer.provide(Reactivity.layer)),
      ),
    ),
  );
});
