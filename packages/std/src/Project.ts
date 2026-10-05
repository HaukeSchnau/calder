import { Action, type Base, type Files, type Flake, Kiln, Nix, On, type Step } from "@kiln/core"
import * as Release from "./Release.ts"

/** The parts of `.kiln/flake.ts` the standard pipeline reads. */
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
}

/**
 * The pipeline every project of the fleet runs: each flake check is a step, plus `checks`; pull
 * requests run them and build the release; the default branch reuses identical results (also from
 * same-repo pull requests) and promotes the release once every check passed.
 */
export const standard = (options: StandardOptions): Kiln.Project => {
  const flakeChecks = Object.entries(options.flake.checks).map(([name, ref]) => Nix.build(ref, { name }))
  const checks = [...flakeChecks, ...(options.checks ?? [])]
  const branch = options.defaultBranch ?? "main"
  const shared = options.shared === undefined ? {} : { shared: options.shared }
  const ref = options.flake.packages.projectRelease
  if (ref === undefined) {
    return Kiln.project({ ...shared, rules: [On.pullRequest(checks), On.push(branch, { reuse: "all" }, checks)] })
  }
  const release = Nix.build(ref, { name: "release" })
  const promote = Action.make("promote", { needs: { release }, after: checks, grants: { deploy: true } }, function*({ release }) {
    return yield* Release.promote(release, options.readiness === undefined ? {} : { readiness: options.readiness })
  })
  return Kiln.project({
    ...shared,
    rules: [
      On.pullRequest([...checks, release]),
      On.push(branch, { reuse: "all" }, [promote, ...(options.afterDeploy?.(promote) ?? [])]),
    ],
  })
}
