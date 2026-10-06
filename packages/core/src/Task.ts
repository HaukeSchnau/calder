import type { Cmd } from "./Cmd.ts"
import * as Files from "./Files.ts"
import type { FlakeRef } from "./Flake.ts"
import type { TaskFailed } from "./Kiln.ts"
import type { ReportSpec } from "./Report.ts"
import type { SecretRef } from "./Secret.ts"
import type { Setup } from "./Setup.ts"
import { make as makeStep, type Platform, type Shard, type Step } from "./Step.ts"

export interface Options<R, O extends { readonly [name: string]: string }> {
  /** The toolchain: a dev shell of the repository's flake. Without it the task runs with the host's PATH. */
  readonly shell?: FlakeRef<"devShells">
  /** The setup the workspace starts from, such as installed dependencies. */
  readonly setup?: Setup
  readonly run: Cmd<R> | ((shard: Shard) => Cmd<R>)
  /**
   * What the task reads. Defaults to the whole repository; with `each`, what every file's key shares,
   * by default the root manifest and lockfiles (add configs and setup files the files run with).
   */
  readonly inputs?: Files.Files
  /**
   * Files the task checks one by one, such as test files, usually `Files.imports(...)`. Each has its own
   * key, a file that passed with its key doesn't run again, and `run` gets the files a job should
   * check. Needs a `report` that names files, so Kiln knows which passed.
   */
  readonly each?: Files.Files
  /** Steps that must pass first. They don't enter the task's key. */
  readonly after?: ReadonlyArray<Step.Any>
  readonly report?: ReportSpec
  /** Runs the task as `count` parallel shards. With `split`, each shard gets a share of the files; with `each`, at most `count` jobs run. */
  readonly shards?: { readonly count: number; readonly split?: Files.Files }
  /** Paths the task writes, added to the Nix store by content. Each becomes a step: `task.outputs.name`. */
  readonly outputs?: O
  /** Environment variables pointing at secret files. Trusted runs only. */
  readonly secrets?: { readonly [env: string]: SecretRef }
  readonly env?: { readonly [env: string]: string }
  readonly platform?: Platform
}

/** What a task with `each` shares by default: the root manifest and lockfiles. */
const dependencyFiles = Files.glob("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", ".npmrc")

/**
 * A command in a pinned toolchain, run in a persistent workspace of the repository. It is keyed by the
 * git tree ids of its inputs, the toolchain, the command and the values it interpolates.
 */
export const make = <R = never, const O extends { readonly [name: string]: string } = {}>(
  name: string,
  options: Options<R, O>,
): Step<void, TaskFailed, R, O> =>
  makeStep("task", name, {
    _tag: "Task",
    shell: options.shell,
    setup: options.setup,
    run: options.run,
    // Every file's key would change with every commit if each one read the whole repository.
    inputs: options.inputs ?? (options.each === undefined ? Files.all() : dependencyFiles),
    each: options.each,
    after: options.after ?? [],
    report: options.report,
    shards: options.shards === undefined ? undefined : { count: options.shards.count, split: options.shards.split },
    outputs: options.outputs ?? {},
    secrets: options.secrets ?? {},
    env: options.env ?? {},
    platform: options.platform,
  }) as Step<void, TaskFailed, R, O>
