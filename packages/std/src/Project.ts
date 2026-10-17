import { Action, type Base, type Files, type Flake, Calder, Nix, On, type Step } from "@calder-ci/core"
import * as Alchemy from "./Alchemy.ts"
import * as Release from "./Release.ts"

/** The parts of `.calder/flake.ts` the standard pipeline reads. */
export interface StandardFlake {
  readonly checks: { readonly [name: string]: Flake.FlakeRef<"checks"> }
  /** Without `projectRelease` there is nothing to deploy, and the default branch only runs the checks. */
  readonly packages: {
    readonly projectRelease?: Flake.FlakeRef<"packages">
    readonly [name: string]: Flake.FlakeRef<"packages"> | undefined
  }
}

export interface StandardOptions {
  readonly flake: StandardFlake
  /** Checks beyond the flake's own, such as tasks running the repository's QA. They run on both events. */
  readonly checks?: ReadonlyArray<Step.Step<unknown, unknown, never, any, never>>
  /** A URL whose JSON `revision` must report the deployed commit before the deploy counts. */
  readonly readiness?: string
  /** Steps that run on the default branch after the release is live, such as app store builds. */
  readonly afterDeploy?: (promote: Step.Step<unknown, unknown, Base, {}, { readonly deploy: true }>) => ReadonlyArray<Step.Any>
  readonly defaultBranch?: string
  readonly shared?: Files.Files
  /**
   * A cron schedule that runs every check on the default branch without reusing anything, for tasks
   * with `each` the check that their keys still cover what their files depend on.
   */
  readonly nightly?: string
}

/**
 * The pipeline every project of the fleet runs: each flake check is a step, plus `checks`; pull
 * requests run them and build the release; the default branch reuses identical results (also from
 * same-repo pull requests) and promotes the release once every check passed.
 */
export const standard = (options: StandardOptions): Calder.Project => {
  const flakeChecks = Object.entries(options.flake.checks).map(([name, ref]) => Nix.build(ref, { name }))
  const checks = [...flakeChecks, ...(options.checks ?? [])]
  const branch = options.defaultBranch ?? "main"
  const shared = options.shared === undefined ? {} : { shared: options.shared }
  const nightly = options.nightly === undefined ? [] : [On.schedule(options.nightly, { reuse: "none" }, checks)]
  const ref = options.flake.packages.projectRelease
  if (ref === undefined) {
    return Calder.project({ ...shared, rules: [On.pullRequest(checks), On.push(branch, checks), ...nightly] })
  }
  const release = Nix.build(ref, { name: "release" })
  const promote = Action.make("promote", { needs: { release }, after: checks, grants: { deploy: true } }, function*({ release }) {
    return yield* Release.promote(release, options.readiness === undefined ? {} : { readiness: options.readiness })
  })
  return Calder.project({
    ...shared,
    rules: [
      On.pullRequest([...checks, release]),
      On.push(branch, [promote, ...(options.afterDeploy?.(promote) ?? [])]),
      ...nightly,
    ],
  })
}

export interface AlchemyOptions {
  readonly flake: Pick<StandardFlake, "checks">
  readonly stack: Alchemy.Stack
  /** Checks beyond the flake's own. They run on pull requests and pushes, and gate every deploy. */
  readonly checks?: ReadonlyArray<Step.Step<unknown, unknown, never, any, never>>
  /** The stage the default branch deploys, `prod` by default. */
  readonly production?: string
  /** Previews of same-repo pull requests at the URL `url` gives, removed when the pull request closes. */
  readonly previews?: { readonly url: (pr: number) => string }
  readonly defaultBranch?: string
  readonly shared?: Files.Files
  /** As in `standard`: a cron schedule that runs every check without reusing anything. */
  readonly nightly?: string
}

/**
 * The pipeline of a project its Alchemy stack deploys: pull requests and pushes run the checks, and
 * the default branch deploys the production stage once they passed. With `previews`, a same-repo pull
 * request deploys a stage of its own after its checks, and closing it removes the stage.
 */
export const alchemy = (options: AlchemyOptions): Calder.Project => {
  const flakeChecks = Object.entries(options.flake.checks).map(([name, ref]) => Nix.build(ref, { name }))
  const checks = [...flakeChecks, ...(options.checks ?? [])]
  const branch = options.defaultBranch ?? "main"
  const shared = options.shared === undefined ? {} : { shared: options.shared }
  const nightly = options.nightly === undefined ? [] : [On.schedule(options.nightly, { reuse: "none" }, checks)]
  const deploy = Alchemy.deploy(options.stack, { stage: options.production ?? "prod", after: checks })
  const previews = options.previews === undefined ? [] : [
    On.preview(Alchemy.preview(options.stack, { url: options.previews.url, after: checks })),
    On.pullRequestClosed([Alchemy.destroy(options.stack)]),
  ]
  return Calder.project({ ...shared, rules: [On.pullRequest(checks), ...previews, On.push(branch, [deploy]), ...nightly] })
}
