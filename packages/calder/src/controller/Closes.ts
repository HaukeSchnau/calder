import { Context, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { type Closing, Gitea } from "./Gitea.ts";
import { Mirror } from "./Mirror.ts";
import type { Project } from "./Projects.ts";
import { Runs } from "./Workflow.ts";

/** How far back the catch-up looks for closings no webhook brought. */
const lookback = 7 * 86_400_000;

/**
 * Starts the "closed pull request" run of each closing once. The webhook brings a closing as it happens, and
 * the catch-up finds the ones the controller missed while it wasn't listening, such as Studienbuch #121's,
 * which Calder's merge queue merged while a host switch restarted the controller. Whichever of the two comes
 * second starts nothing: `pull_closes` keeps, per pull request, up to when its closings were handled, since a
 * closed run that matches no rule leaves no row.
 */
export class Closes extends Context.Service<
  Closes,
  {
    /** The webhook's closing: cancels the pull request's active runs and starts its closed run. */
    readonly close: (project: Project, closing: Closing) => Effect.Effect<void>;
    /** Closes the project's pull requests that ran and that Gitea closed in the last week, if nothing did yet. */
    readonly catchUp: (project: Project) => Effect.Effect<void>;
  }
>()("calder/controller/Closes") {}

export const layer = Layer.effect(Closes)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const gitea = yield* Gitea;
    const mirror = yield* Mirror;
    const runs = yield* Runs;
    // One closing at a time, so the webhook and the catch-up never both find the same one unhandled.
    const lock = yield* Semaphore.make(1);

    const handled = (project: Project, closing: Closing) =>
      Effect.gen(function* () {
        const settled =
          yield* sql`select 1 from pull_closes where project = ${project.name} and pr = ${closing.number}
        and settled >= ${closing.closedAt}`;

        if (settled.length > 0) return true;

        // A closed run started for it counts too, so a stop between its start and `settle` doesn't start another.
        const started =
          yield* sql`select 1 from runs where project = ${project.name} and pr = ${closing.number}
        and json_extract(event, '$._tag') = 'PullRequestClosed' and created_at >= ${closing.closedAt} limit 1`;

        return started.length > 0;
      }).pipe(Effect.orDie);

    const settle = (project: Project, closing: Closing) =>
      sql`insert into pull_closes (project, pr, settled) values (${project.name}, ${closing.number}, ${closing.closedAt})
      on conflict do update set settled = max(settled, excluded.settled)`.pipe(Effect.orDie);

    const start = (project: Project, closing: Closing) =>
      Effect.gen(function* () {
        const active = yield* sql<{
          id: string;
        }>`select id from runs where project = ${project.name} and pr = ${closing.number}
        and status in ('queued', 'planning', 'running')`.pipe(Effect.orDie);

        yield* Effect.forEach(active, (r) => runs.cancel(r.id, "pull request closed"), {
          discard: true,
        });
        // `On.pullRequestClosed` rules run the base branch's head, which the repository's owners pushed.
        const sha = yield* gitea.head(project.repo, closing.base);
        yield* mirror.fetch(project.name);

        if (!(yield* mirror.hasPipeline(project.name, sha))) {
          return yield* Effect.logInfo(
            `closing #${closing.number} of ${project.name}: ${sha.slice(0, 12)} has no .calder/ci.ts, ignored`,
          );
        }

        yield* Effect.logInfo(
          `closing #${closing.number} of ${project.name} at ${sha.slice(0, 12)}`,
        );
        yield* runs.create({
          project: project.name,
          event: {
            _tag: "PullRequestClosed",
            number: closing.number,
            base: closing.base,
            head: closing.head,
          },
          sha,
        });
      });

    /**
     * Starts a closing's closed run unless it was handled. `starts` says whether this caller starts it; one that
     * doesn't leaves the closing unhandled, so its webhook, when it comes, still does.
     */
    const handle = (project: Project, closing: Closing, starts: Effect.Effect<boolean>) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if ((yield* handled(project, closing)) || !(yield* starts)) return;
            yield* start(project, closing);
            yield* settle(project, closing);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`closing #${closing.number} of ${project.name} failed`, cause),
          ),
        );

    const ranAsPullRequest = (project: Project, closing: Closing) =>
      Effect.map(
        sql`select 1 from runs where project = ${project.name} and pr = ${closing.number}
        and json_extract(event, '$._tag') = 'PullRequest' limit 1`,
        (rows) => rows.length > 0,
      ).pipe(Effect.orDie);

    return {
      close: (project, closing) => handle(project, closing, Effect.succeed(true)),
      catchUp: (project) =>
        Effect.gen(function* () {
          const closings = yield* gitea.closedPulls(project.repo, Date.now() - lookback);
          yield* Effect.forEach(
            closings,
            (closing) =>
              handle(
                project,
                closing,
                Effect.tap(ranAsPullRequest(project, closing), (ran) =>
                  ran
                    ? Effect.logInfo(
                        `no webhook brought the closing of #${closing.number} of ${project.name}, so the catch-up handles it`,
                      )
                    : Effect.void,
                ),
              ),
            { discard: true },
          );
        }),
    };
  }),
);
