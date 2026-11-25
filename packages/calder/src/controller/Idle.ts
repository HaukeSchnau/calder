import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { type ActiveJob, Jobs } from "./Jobs.ts";

/**
 * What a restart of the controller would cut off right now, a line per job. A local step's worker outlives
 * the controller and the next one adopts it, so it counts only while it holds a deploy lease: srv-2's deploy
 * checks right after its switch that Calder answers. Plans, actions and agents' jobs start over, though a
 * job that still waits for an agent only waits again.
 */
export const busy = (jobs: ReadonlyArray<ActiveJob>): ReadonlyArray<string> =>
  jobs.flatMap((job) => {
    const what = `${job.spec.run.id} ${job.spec._tag === "Plan" ? "plan" : job.spec.step}`;

    if (job.lease !== undefined) return [`${what} holds the deploy lease ${job.lease.project}`];

    if (job.persisted || !job.running) return [];

    return [`${what}${job.remote ? " on an agent" : ""} starts over`];
  });

/** `GET /idle`: 200 while a restart cuts nothing off, else 503 with what it would. */
export const handle = Effect.gen(function* () {
  const lines = busy((yield* Jobs).active());

  return lines.length === 0
    ? HttpServerResponse.text("idle\n")
    : HttpServerResponse.text(`${lines.join("\n")}\n`, { status: 503 });
});
