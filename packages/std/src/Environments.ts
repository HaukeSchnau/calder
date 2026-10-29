import { Calder, type Files, On, type Step } from "@calder-ci/core"
import type { Schema } from "effect"
import * as Alchemy from "./Alchemy.ts"

/** What deploys an environment: pushes to a branch, or `calder trigger --inputs` with matching inputs. */
export type Trigger =
  | { readonly push: string }
  | { readonly manual: Schema.Struct.Fields }

export interface Environment<A> {
  readonly on: Trigger
  /** Steps that must pass before it deploys, such as the checks. Its artifacts it waits for anyway. */
  readonly after?: ReadonlyArray<Step.Any>
  /**
   * Steps that run once it is deployed and ready, such as an OTA update or app store builds. They get
   * the step that deployed it, whose value is the stack's outputs, to wait for or read.
   */
  readonly then?: (deployed: Step.Step<A, any, any, any, any>) => ReadonlyArray<Step.Any>
}

export interface Options<A> {
  /** The stack, whose stages are the environments and the previews `pr-<number>`. */
  readonly stack: Alchemy.Stack<A>
  /** Checks that pull requests and pushes to `defaultBranch` run. Deploys wait for them only where `after` says so. */
  readonly checks?: ReadonlyArray<Step.Step<unknown, unknown, never, any, never>>
  /**
   * What every deploy hands the stack, by environment variable, such as `{ CALDER_BUNDLE: bundle }`. Pull
   * requests build them; a deploy that holds the lease publishes them to the binary cache first.
   */
  readonly artifacts?: Alchemy.Artifacts
  /**
   * The URL, from the stack's outputs, whose JSON `revision` must report the deployed commit before an
   * environment or a preview counts as ready.
   */
  readonly readiness?: (outputs: A) => string
  /**
   * A stage `pr-<number>` for each same-repo pull request, deployed once its artifacts are built, so it
   * doesn't wait for the checks unless `after` says so. Calder's comment on the pull request links it at
   * `url` and reports the checks next to it. Closing the pull request destroys the stage.
   */
  readonly previews?: {
    readonly url: (pr: number, outputs: A) => string
    /**
     * Steps the preview waits for, on its critical path: they take the latency lane with it, so keep
     * them few and quick, such as a smoke test of what it deploys.
     */
    readonly after?: ReadonlyArray<Step.Any>
    /** Steps such as E2E tests against the preview. Like the rest of a pull request's, they may not have grants. */
    readonly then?: (deployed: Step.Step<A, any, any, any, any>) => ReadonlyArray<Step.Step<any, any, any, any, never>>
  }
  /** Each environment by its stage name, which is what the stack sees as its stage. */
  readonly environments: { readonly [stage: string]: Environment<A> }
  readonly defaultBranch?: string
  readonly shared?: Files.Files
  /** A cron schedule that runs every check on the default branch without reusing anything. */
  readonly nightly?: string
  /** More rules of the project, such as a mobile pipeline's. */
  readonly rules?: ReadonlyArray<On.Rule<"pr" | "trusted", any>>
}

/** The steps that deploy one environment: `deploy-<stage>`, then `ready-<stage>` when there is a readiness URL. */
export const deploy = <A>(
  options: Pick<Options<A>, "stack" | "artifacts" | "readiness">,
  stage: string,
  environment: Pick<Environment<A>, "after"> = {},
) => {
  const deployed = Alchemy.deploy(options.stack, {
    stage,
    ...(environment.after === undefined ? {} : { after: environment.after }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
  })
  const ready = options.readiness === undefined ? undefined : Alchemy.ready(deployed, { name: `ready-${stage}`, readiness: options.readiness })
  return { deployed, ready, last: (ready ?? deployed) as Step.Step<A, any, any, any, any> }
}

/**
 * The rules of the previews: a same-repo pull request deploys stage `pr-<number>` on each update and
 * Calder's comment links it, then closing the pull request destroys the stage. The deploy waits for
 * `gate` on its critical path and for `after` in their usual turn.
 */
export const preview = <A>(
  options: Pick<Options<A>, "stack" | "artifacts" | "readiness">,
  preview: Pick<NonNullable<Options<A>["previews"]>, "url" | "then"> & {
    readonly gate?: ReadonlyArray<Step.Any>
    readonly after?: ReadonlyArray<Step.Any>
  },
) => {
  const [deployed, link] = Alchemy.preview(options.stack, {
    url: preview.url,
    ...(preview.gate === undefined ? {} : { gate: preview.gate }),
    ...(preview.after === undefined ? {} : { after: preview.after }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
  })
  return [
    On.preview([deployed, link, ...(preview.then?.(link as Step.Step<A, any, any, any, any>) ?? [])]),
    On.pullRequestClosed([Alchemy.destroy(options.stack)]),
  ]
}

const ruleOf = (trigger: Trigger, targets: ReadonlyArray<Step.Any>) =>
  "push" in trigger ? On.push(trigger.push, targets) : On.manual({ inputs: trigger.manual }, targets)

/**
 * The pipeline of a project whose Alchemy stack deploys its environments: pull requests run the checks
 * and build the artifacts, same-repo pull requests deploy a preview of their own, and each environment
 * deploys its stage when its trigger fires. Every deploy holds the project's lease, checks on a push
 * that the branch still points at its revision, publishes the artifacts, hands the stack the lease's
 * fencing token, and waits for readiness before the steps after it run.
 */
export const project = <A = void>(options: Options<A>): Calder.Project => {
  const checks = options.checks ?? []
  const artifacts = Object.values(options.artifacts ?? {})
  const branch = options.defaultBranch ?? "main"
  const previews = options.previews === undefined ? [] : preview(options, {
    url: options.previews.url,
    ...(options.previews.after === undefined ? {} : { gate: options.previews.after }),
    ...(options.previews.then === undefined ? {} : { then: options.previews.then }),
  })
  const environments = Object.entries(options.environments).map(([name, environment]) => {
    const stage = Alchemy.stageName(name)
    const { deployed, ready, last } = deploy(options, stage, environment)
    return ruleOf(environment.on, [deployed, ...(ready === undefined ? [] : [ready]), ...(environment.then?.(last) ?? [])])
  })
  return Calder.project({
    ...(options.shared === undefined ? {} : { shared: options.shared }),
    rules: [
      On.pullRequest([...checks, ...artifacts]),
      ...previews,
      On.push(branch, checks),
      ...environments,
      ...(options.nightly === undefined ? [] : [On.schedule(options.nightly, { reuse: "none" }, [...checks, ...artifacts])]),
      ...(options.rules ?? []),
    ],
  })
}
