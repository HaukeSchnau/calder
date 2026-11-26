import { Effect, Layer, Schedule } from "effect";
import { Closes } from "./Closes.ts";
import { Gitea } from "./Gitea.ts";
import { Mirror } from "./Mirror.ts";
import { Projects } from "./Projects.ts";
import { type RunInput, Runs } from "./Workflow.ts";

/**
 * Gitea gives up on a webhook the controller missed while it restarted. Shortly after start and
 * every five minutes, each project's default branch head and open pull requests get the run they
 * should have, if they don't have it yet, and its closed pull requests their closed run (Closes.ts).
 * This is one such pass.
 */
export const make = Effect.gen(function* () {
  const projects = yield* Projects;
  const gitea = yield* Gitea;
  const mirror = yield* Mirror;
  const runs = yield* Runs;
  const closes = yield* Closes;
  // Heads already looked at, so a revision whose plan matches no rule isn't planned again and again.
  const seen = new Set<string>();

  const ensure = (project: string, sha: string, run: RunInput) =>
    Effect.gen(function* () {
      const key = `${project}|${sha}|${JSON.stringify(run.event)}`;

      if (seen.has(key)) return;
      yield* mirror.fetch(project);

      // Seen only once it ran or can't, so a sweep after a failure tries again.
      if (yield* mirror.hasPipeline(project, sha)) yield* runs.ensure(run);
      seen.add(key);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`catching up on ${project}@${sha.slice(0, 12)} failed`, cause),
      ),
    );

  const sweep = Effect.forEach(
    projects.all(),
    (project) =>
      Effect.gen(function* () {
        const head = yield* gitea.head(project.repo, project.defaultBranch);
        yield* ensure(project.name, head, {
          project: project.name,
          event: { _tag: "Push", branch: project.defaultBranch },
          sha: head,
        });

        for (const pull of yield* gitea.openPulls(project.repo)) {
          yield* ensure(project.name, pull.sha, {
            project: project.name,
            event: {
              _tag: "PullRequest",
              number: pull.number,
              base: pull.base,
              head: pull.head,
              fork: pull.fork,
            },
            sha: pull.sha,
            fork: pull.fork,
          });
        }

        yield* closes.catchUp(project);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`catching up on ${project.name} failed`, cause),
        ),
      ),
    { discard: true },
  );

  return sweep;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* make;
    yield* sweep.pipe(
      Effect.delay("30 seconds"),
      Effect.repeat(Schedule.spaced("5 minutes")),
      Effect.forkScoped,
    );
  }),
);
