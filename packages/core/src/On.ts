import type { Schema } from "effect"
import type { Step } from "./Step.ts"

export const TypeId = "~@kiln/core/Rule" as const

/** How much of an earlier run a run may reuse. Builds are always reused by Nix. */
export type Reuse =
  /** Tasks with the same key, from any run this run trusts (for pushes: trusted runs and same-repo pull requests). */
  | "all"
  /** Only tasks with outputs; other tasks run again. */
  | "builds"
  /** Every task runs again. */
  | "none"

export type Trigger =
  | { readonly _tag: "PullRequest" }
  | { readonly _tag: "Preview" }
  | { readonly _tag: "PullRequestClosed" }
  | { readonly _tag: "Push"; readonly branch: string }
  | { readonly _tag: "Schedule"; readonly cron: string }
  | { readonly _tag: "Manual"; readonly inputs: Schema.Struct.Fields }

export interface Rule<out T extends "pr" | "trusted", out R> {
  readonly [TypeId]: { readonly _R: (_: never) => R }
  readonly trust: T
  readonly trigger: Trigger
  readonly reuse: Reuse
  readonly targets: ReadonlyArray<Step.Any>
}

const variance = { _R: (_: never) => _ }

const make = <T extends "pr" | "trusted", R>(
  trust: T,
  trigger: Trigger,
  reuse: Reuse,
  targets: ReadonlyArray<Step.Any>,
): Rule<T, R> => ({ [TypeId]: variance, trust, trigger, reuse, targets })

/** Runs on every pull request. Steps with grants are refused, and the run gets `PrBase`. */
export const pullRequest = <const T extends ReadonlyArray<Step<any, any, any, any, never>>>(
  targets: T,
): Rule<"pr", Step.Services<T[number]>> => make("pr", { _tag: "PullRequest" }, "all", targets)

/**
 * Runs on pull requests from a branch of the same repository, next to the `pullRequest` rules. Its
 * tasks may read secrets, such as the token a preview deploy needs: the people who can push a branch
 * are the ones a trusted run trusts. Fork pull requests and `kiln check` don't run it. Actions with
 * grants and tasks that hold the deploy lease are still refused, and the run gets `PrBase`.
 */
export const preview = <const T extends ReadonlyArray<Step<any, any, any, any, never>>>(
  targets: T,
): Rule<"pr", Step.Services<T[number]>> => make("pr", { _tag: "Preview" }, "all", targets)

/**
 * Runs when a pull request is merged or closed, on the base branch's head: a trusted run, with the
 * pull request's number for `Cmd.pullRequest`, such as to remove what its previews deployed.
 */
export const pullRequestClosed = <const T extends ReadonlyArray<Step.Any>>(
  targets: T,
): Rule<"trusted", Step.Services<T[number]>> => make("trusted", { _tag: "PullRequestClosed" }, "builds", targets)

/**
 * Runs on pushes to `branch` (`*` matches within a segment). A push reuses results with the same key,
 * also from pull requests of the same repository, so merging a green pull request without new commits
 * on the branch reruns nothing; `reuse: "builds"` runs tasks without outputs again.
 */
export const push: {
  <const T extends ReadonlyArray<Step.Any>>(branch: string, targets: T): Rule<"trusted", Step.Services<T[number]>>
  <const T extends ReadonlyArray<Step.Any>>(
    branch: string,
    options: { readonly reuse?: Reuse },
    targets: T,
  ): Rule<"trusted", Step.Services<T[number]>>
} = (branch: string, ...args: ReadonlyArray<unknown>) => {
  const [options, targets] = (args.length === 1 ? [{}, args[0]] : args) as [{ readonly reuse?: Reuse }, ReadonlyArray<Step.Any>]
  return make("trusted", { _tag: "Push", branch }, options.reuse ?? "all", targets)
}

/** Runs the default branch's head on a cron schedule. */
export const schedule: {
  <const T extends ReadonlyArray<Step.Any>>(cron: string, targets: T): Rule<"trusted", Step.Services<T[number]>>
  <const T extends ReadonlyArray<Step.Any>>(
    cron: string,
    options: { readonly reuse?: Reuse },
    targets: T,
  ): Rule<"trusted", Step.Services<T[number]>>
} = (cron: string, ...args: ReadonlyArray<unknown>) => {
  const [options, targets] = (args.length === 1 ? [{}, args[0]] : args) as [{ readonly reuse?: Reuse }, ReadonlyArray<Step.Any>]
  return make("trusted", { _tag: "Schedule", cron }, options.reuse ?? "builds", targets)
}

/**
 * Runs when started with `kiln trigger --inputs` and the inputs match. A manual run starts every
 * manual rule whose inputs match, so rules that take different inputs start separately.
 */
export const manual: {
  <const T extends ReadonlyArray<Step.Any>>(targets: T): Rule<"trusted", Step.Services<T[number]>>
  <const I extends Schema.Struct.Fields, const T extends ReadonlyArray<Step.Any>>(
    options: { readonly inputs?: I; readonly reuse?: Reuse },
    targets: T,
  ): Rule<"trusted", Step.Services<T[number]>>
} = (...args: ReadonlyArray<unknown>) => {
  const [options, targets] = (args.length === 1 ? [{}, args[0]] : args) as [
    { readonly inputs?: Schema.Struct.Fields; readonly reuse?: Reuse },
    ReadonlyArray<Step.Any>,
  ]
  return make("trusted", { _tag: "Manual", inputs: options.inputs ?? {} }, options.reuse ?? "builds", targets)
}

export const matchesBranch = (pattern: string, branch: string) =>
  pattern === branch || new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(branch)
