import { Attic, CurrentRun, Fleet, Git, Kiln, type StorePath } from "@kiln/core"
import { Effect, Schedule, Schema, type Duration } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export class Live extends Kiln.Result<Live>("@kiln/std/Release")("Live", {
  revision: Schema.String,
  hosts: Schema.Array(Schema.String),
}) {}

export class Skipped extends Kiln.Result<Skipped>("@kiln/std/Release")("Skipped", {
  reason: Schema.Literals(["Superseded"]),
}) {}

export class NotReady extends Kiln.Failure<NotReady>("@kiln/std/Release")("NotReady", {
  url: Schema.String,
  revision: Schema.String,
  seen: Schema.NullOr(Schema.String),
}) {
  override get message() {
    return `${this.url} did not report ${this.revision.slice(0, 12)} in time (last seen ${this.seen ?? "nothing"})`
  }
}

const every = (interval: Duration.Input, deadline: Duration.Input) =>
  Schedule.spaced(interval).pipe(Schedule.upTo({ duration: deadline }))

const Readiness = Schema.Struct({ revision: Schema.optional(Schema.String) })

/** Polls a readiness URL until its JSON reports `revision`. */
export const awaitReadiness = Effect.fn("Release.awaitReadiness")(function*(url: string, revision: string) {
  const client = yield* HttpClient.HttpClient
  let seen: string | null = null
  const check = client.get(url).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Readiness)),
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed({ revision: undefined })),
    Effect.flatMap((body) => {
      seen = body.revision ?? seen
      return body.revision === revision ? Effect.void : Effect.fail(new NotReady({ url, revision, seen }))
    }),
  )
  yield* check.pipe(Effect.retry({ schedule: every("5 seconds", "5 minutes") }))
})

/**
 * Promotes a release to the project's hosts. Takes the project's deploy lease (latest wins, so an
 * older run gives way to a newer one), preflights every host, waits for the binary cache, checks before
 * each host that the branch still points at this revision, and deploys with the lease's fencing token.
 */
export const promote = Effect.fn("Release.promote")(
  function*(release: StorePath, options: { readonly readiness?: string } = {}) {
    const run = yield* CurrentRun
    const branch = run.branch
    if (branch === undefined) return yield* Effect.die(new Error("Release.promote needs a branch to check the head against"))

    const lease = yield* Fleet.deploying(run.project, { queue: "latest-wins" })
    if (lease._tag === "Replaced") return new Skipped({ reason: "Superseded" })

    const descriptor = yield* run.descriptor
    yield* Effect.forEach(lease.targets, (target) => target.preflight(descriptor), { concurrency: "unbounded", discard: true })
    yield* Attic.push(release)

    for (const target of lease.targets) {
      const head = yield* Git.head(branch)
      if (head !== run.revision) return new Skipped({ reason: "Superseded" })
      yield* target
        .deploy({ revision: run.revision, storePath: release })
        .pipe(Effect.retry({ while: (e) => e._tag === "Busy", schedule: every("10 seconds", "5 minutes") }))
    }

    if (options.readiness !== undefined) yield* awaitReadiness(options.readiness, run.revision)
    return new Live({ revision: run.revision, hosts: lease.targets.map((t) => t.host) })
  },
  Effect.scoped,
)
