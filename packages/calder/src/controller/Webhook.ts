import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Closes } from "./Closes.ts";
import { Config } from "./Config.ts";
import { Gitea } from "./Gitea.ts";
import { Mirror } from "./Mirror.ts";
import { Projects } from "./Projects.ts";
import * as Rows from "./Rows.ts";
import * as Trust from "./Trust.ts";
import { Runs } from "./Workflow.ts";

interface User {
  readonly login?: string;
}

interface Payload {
  readonly ref?: string;
  /** The revision a push, or one to a pull request's branch (`synchronized`), moved the branch from and to. */
  readonly before?: string;
  readonly after?: string;
  readonly action?: string;
  readonly number?: number;
  readonly repository?: { readonly full_name?: string; readonly default_branch?: string };
  /** Who pushed, of a push. */
  readonly pusher?: User | null;
  /** Who did what the webhook says, such as push `after` to a pull request's branch (`synchronized`). */
  readonly sender?: User | null;
  readonly pull_request?: {
    readonly closed_at?: string | null;
    readonly head?: {
      readonly ref?: string;
      readonly sha?: string;
      readonly repo?: { readonly full_name?: string };
    };
    readonly base?: { readonly ref?: string; readonly repo?: { readonly full_name?: string } };
  };
}

const zero = /^0+$/;

const verified = (secret: string, body: string, signature: string | undefined) => {
  if (signature === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");

  return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * Gitea's system webhook: pushes and pull requests of every repository. Repositories that aren't
 * enrolled, and revisions without `.calder/ci.ts`, are ignored, so a repository switches by committing it.
 */
export const handle = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const config = yield* Config;
    const mirror = yield* Mirror;
    const runs = yield* Runs;
    const projects = yield* Projects;
    const closes = yield* Closes;
    const gitea = yield* Gitea;
    const sql = yield* SqlClient.SqlClient;

    const db = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>) =>
      Effect.provideService(effect, SqlClient.SqlClient, sql);

    const body = yield* request.text;

    if (!verified(config.webhookSecret, body, request.headers["x-gitea-signature"])) {
      return HttpServerResponse.text("bad signature", { status: 401 });
    }

    const event = request.headers["x-gitea-event"];

    const payload = yield* Effect.try({
      try: () => JSON.parse(body) as Payload,
      catch: () => "malformed JSON",
    });

    const head = event === "push" ? payload.after : payload.pull_request?.head?.sha;

    const enrolled = yield* projects.byRepo(payload.repository?.full_name ?? "", {
      sha: head === undefined || zero.test(head) ? undefined : head,
      defaultBranch: payload.repository?.default_branch,
    });

    if (enrolled === undefined) return HttpServerResponse.text("not enrolled");
    const project = enrolled.name;

    const start = (sha: string, run: Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        yield* mirror.fetch(project);

        if (!(yield* mirror.hasPipeline(project, sha))) {
          return yield* Effect.logInfo(
            `${event} for ${project}@${sha.slice(0, 12)} has no .calder/ci.ts, ignored`,
          );
        }

        yield* Effect.logInfo(`${event} for ${project}@${sha.slice(0, 12)}`);
        yield* run;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`webhook for ${project}@${sha} failed`, cause),
        ),
        Effect.forkDetach,
      );

    // Who Calder trusts. When Gitea doesn't say which user Calder is, no push counts as Calder's: its own
    // run like a fork's, and everyone else's as they would.
    const whom = gitea.self.pipe(
      Effect.map((bot): Trust.Trusted => ({ pushers: config.trustedPushers, bot })),
      Effect.catch((why) =>
        Effect.logWarning(why).pipe(
          Effect.as<Trust.Trusted>({ pushers: config.trustedPushers, bot: undefined }),
        ),
      ),
    );

    const said = (sha: string | undefined) =>
      sha === undefined || zero.test(sha) ? Effect.undefined : db(Rows.pushedTrusted(project, sha));

    if (event === "push") {
      const sha = payload.after;

      if (payload.ref?.startsWith("refs/heads/") !== true || sha === undefined || zero.test(sha))
        return HttpServerResponse.text("ignored");
      const branch = payload.ref.slice("refs/heads/".length);

      // `calder check` pushes its working copies here and starts their runs itself.
      if (branch.startsWith("calder/check/")) return HttpServerResponse.text("ignored");

      const trusted = Trust.push(
        yield* whom,
        enrolled,
        branch,
        payload.pusher?.login,
        yield* said(payload.before),
      );

      yield* db(Rows.pushed(project, sha, trusted));
      yield* start(sha, runs.ensure({ project, event: { _tag: "Push", branch }, sha }));

      return HttpServerResponse.text("accepted", { status: 202 });
    }

    if (event === "pull_request") {
      const pr = payload.pull_request;
      const number = payload.number;

      if (pr === undefined || number === undefined) return HttpServerResponse.text("ignored");

      if (payload.action === "closed") {
        const closedAt = Date.parse(pr.closed_at ?? "");
        yield* closes
          .close(enrolled, {
            number,
            base: pr.base?.ref ?? enrolled.defaultBranch,
            head: pr.head?.ref ?? `pr-${number}`,
            closedAt: Number.isNaN(closedAt) ? Date.now() : closedAt,
          })
          .pipe(Effect.forkDetach);

        return HttpServerResponse.text("accepted", { status: 202 });
      }

      if (!["opened", "reopened", "synchronized"].includes(payload.action ?? ""))
        return HttpServerResponse.text("ignored");
      const sha = pr.head?.sha;

      if (sha === undefined) return HttpServerResponse.text("ignored");
      const synchronized = payload.action === "synchronized";

      // Gitea reads the head from the branch when it sends the webhook, which another push may have moved
      // on since `after`. That push's own webhook brings the head, with whoever pushed it.
      if (synchronized && payload.after !== undefined && payload.after !== sha)
        return HttpServerResponse.text("ignored");

      const fork =
        pr.head?.repo?.full_name !== undefined &&
        pr.head.repo.full_name !== pr.base?.repo?.full_name;

      // `sender` pushed `after`. Calder's own push there merged the default branch into the head it moved
      // from (Merges.ts `update`), which Gitea's merge commit names first and the default branch's revision
      // second; the mirror, fetched by now, knows them. Gitea says so to every pull request of the branch,
      // also one into the default branch when Calder merged another base, so the revision must be the
      // default branch's.
      const vouch =
        !fork && synchronized && payload.after !== undefined
          ? Effect.gen(function* () {
              const parents = yield* mirror
                .parents(project, sha)
                .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

              const merged =
                parents.length === 2 &&
                parents[0] === payload.before &&
                (yield* mirror.contains(
                  project,
                  `refs/heads/${enrolled.defaultBranch}`,
                  parents[1]!,
                ))
                  ? parents[1]!
                  : null;

              const trusted = Trust.update(
                yield* whom,
                enrolled,
                pr.base?.ref,
                payload.sender?.login,
                yield* said(payload.before),
                merged === null ? null : yield* said(merged),
              );

              yield* db(Rows.pushed(project, sha, trusted));
            })
          : Effect.void;

      yield* start(
        sha,
        Effect.andThen(
          vouch,
          runs.ensure({
            project,
            event: {
              _tag: "PullRequest",
              number,
              base: pr.base?.ref ?? "main",
              head: pr.head?.ref ?? `pr-${number}`,
              fork,
            },
            sha,
            fork,
          }),
        ),
      );

      return HttpServerResponse.text("accepted", { status: 202 });
    }

    return HttpServerResponse.text("ignored");
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("bad request", { status: 400 })));
