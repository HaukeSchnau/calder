import type { Cmd } from "./Cmd.ts"
import * as Files from "./Files.ts"
import type { FlakeRef } from "./Flake.ts"
import type { TaskFailed } from "./Kiln.ts"
import { make as makeStep, type Platform, type Step } from "./Step.ts"

/** A step that prepares a workspace for tasks. */
export interface Setup extends Step<void, TaskFailed> {
  readonly kind: "setup"
}

export interface Options {
  /** The toolchain, as for a task. Without it the setup runs with the host's PATH. */
  readonly shell?: FlakeRef<"devShells">
  /** The files that decide whether a prepared workspace is still current: manifests, lockfiles, patches. */
  readonly inputs: Files.Files
  readonly run: Cmd<never>
  /** What the setup creates that a task's `git clean` keeps, as gitignore patterns (`node_modules`). */
  readonly keep?: ReadonlyArray<string>
  /** Directories of the checkout put in front of the tasks' PATH, such as `node_modules/.bin`. */
  readonly path?: ReadonlyArray<string>
  readonly env?: { readonly [env: string]: string }
  readonly platform?: Platform
}

/**
 * Prepares a workspace once per key, which comes from the inputs, the toolchain and the command. Tasks
 * that name it wait for it and start from a copy of the prepared workspace, and a run whose key was
 * prepared before skips it.
 */
export const make = (name: string, options: Options): Setup =>
  makeStep("setup", name, {
    _tag: "Setup",
    shell: options.shell,
    run: options.run,
    inputs: options.inputs,
    keep: options.keep ?? [],
    path: options.path ?? [],
    env: options.env ?? {},
    platform: options.platform,
  }) as Setup
