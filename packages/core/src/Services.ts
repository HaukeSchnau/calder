import { Context, Effect, Schema, type Scope } from "effect"
import type { HttpClient } from "effect/http"
import type { Event } from "./Event.ts"
import { Failure, type Sha, type StorePath } from "./Calder.ts"
import type { Secret } from "./Secret.ts"

/** The run an action belongs to. */
export class CurrentRun extends Context.Service<CurrentRun, {
  readonly id: string
  readonly project: string
  readonly revision: Sha
  /** The pushed branch, or the head branch of a pull request. */
  readonly branch: string | undefined
  readonly trust: "pr" | "trusted"
  readonly event: Event
  /** The repository's `.#lib.project` descriptor at this revision. */
  readonly descriptor: Effect.Effect<unknown>
}>()("@calder-ci/core/CurrentRun") {}

export class Git extends Context.Service<Git, {
  /** The branch's current head on Gitea. */
  readonly head: (branch: string) => Effect.Effect<Sha>
}>()("@calder-ci/core/Git") {
  static head = (branch: string) => Git.use((git) => git.head(branch))
}

export class Gitea extends Context.Service<Gitea, {
  /** Starts a Gitea Actions workflow of this repository (for jobs that stay on act_runner). */
  readonly dispatch: (
    workflow: string,
    options?: { readonly ref?: string; readonly inputs?: { readonly [name: string]: string } },
  ) => Effect.Effect<void>
}>()("@calder-ci/core/Gitea") {
  static dispatch = (
    workflow: string,
    options?: { readonly ref?: string; readonly inputs?: { readonly [name: string]: string } },
  ) => Gitea.use((gitea) => gitea.dispatch(workflow, options))
}

export class Cache extends Context.Service<Cache, {
  /**
   * Readies a release for the hosts it goes to. When one of them isn't the controller's host, the fleet's
   * binary cache gets the release's closure and keeps it as the project's release.
   */
  readonly publish: (path: StorePath) => Effect.Effect<void>
}>()("@calder-ci/core/Cache") {
  static publish = (path: StorePath) => Cache.use((cache) => cache.publish(path))
}

export class PullRequest extends Context.Service<PullRequest, {
  readonly number: number
  readonly base: string
  readonly head: string
  /** Posts or updates this step's comment on the pull request. The controller posts it. */
  readonly comment: (markdown: string) => Effect.Effect<void>
}>()("@calder-ci/core/PullRequest") {
  static comment = (markdown: string) => PullRequest.use((pr) => pr.comment(markdown))
}

export class Busy extends Failure<Busy>("@calder-ci/core/Fleet")("Busy", { target: Schema.String }) {
  override get message() {
    return `${this.target} is busy with another deployment`
  }
}
export class Rejected extends Failure<Rejected>("@calder-ci/core/Fleet")("Rejected", {
  target: Schema.String,
  status: Schema.Number,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.target} rejected the release (${this.status}): ${this.reason}`
  }
}

export interface Target {
  readonly host: string
  /** Checks the release contract against the host's bindings. */
  readonly preflight: (descriptor: unknown) => Effect.Effect<void, Rejected>
  /** Activates the release. The request carries the lease's fencing token. */
  readonly deploy: (release: { readonly revision: Sha; readonly storePath: StorePath }) => Effect.Effect<void, Busy | Rejected>
}

export type Lease =
  | {
    readonly _tag: "Held"
    readonly fence: number
    readonly targets: ReadonlyArray<Target>
    /** Hosts whose `/health` couldn't be read, which might run the app; a deploy must not go on without them. */
    readonly unreachable: ReadonlyArray<string>
  }
  /** A newer run of the same project asked for the lease, so this one should stop. */
  | { readonly _tag: "Replaced" }

/** Only actions with `grants: { deploy: true }` get Fleet. */
export class Fleet extends Context.Service<Fleet, {
  readonly deploying: (project: string, options: { readonly queue: "latest-wins" }) => Effect.Effect<Lease, never, Scope.Scope>
}>()("@calder-ci/core/Fleet") {
  static deploying = (project: string, options: { readonly queue: "latest-wins" }) =>
    Fleet.use((fleet) => fleet.deploying(project, options))
}

/** What trusted rules (push, schedule, manual) provide. */
export type Base = CurrentRun | Git | Gitea | Cache | HttpClient.HttpClient

/** What pull-request rules provide. */
export type PrBase = CurrentRun | PullRequest | HttpClient.HttpClient

/** The services grants add. */
export type Granted<G> =
  | (G extends { readonly deploy: true } ? Fleet : never)
  | (G extends { readonly secrets: ReadonlyArray<infer S extends string> } ? Secret<S> : never)
