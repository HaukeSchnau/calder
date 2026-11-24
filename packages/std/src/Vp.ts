import { cmd, Files, type Flake, type Setup, Task } from "@calder-ci/core"
import * as Vitest from "./Vitest.ts"

export interface CheckOptions {
  /** The dev shell with node. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The setup that installs the repository's `vite-plus`, such as `Pnpm.install`. */
  readonly setup: Setup.Setup
}

/**
 * `vp check` as the task `check`: oxfmt, oxlint and, with `lint.options.typeAware` and `typeCheck` in
 * `vite.config.ts`, the type check. Its key is the whole repository, since oxfmt reads nearly every text
 * file and the configs can name any file, such as a lint plugin's.
 */
export const check = (options: CheckOptions) =>
  Task.make("check", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    setup: options.setup,
    run: cmd`vp check`,
  })

const extensions = ["", "c", "m"].flatMap((module) => ["js", "jsx", "ts", "tsx"].map((ext) => `${module}${ext}`))

/** Vitest's default `test.include` as globs Calder reads: `.test` and `.spec` files of every JS and TS extension. */
export const defaultTests: ReadonlyArray<string> = ["test", "spec"].flatMap((kind) => extensions.map((ext) => `**/*.${kind}.${ext}`))

export interface TestOptions extends Omit<Vitest.FilesOptions, "tests" | "setup" | "vitest"> {
  /** The setup that installs the repository's `vite-plus`, such as `Pnpm.install`. */
  readonly setup: Setup.Setup
  /**
   * Globs of the test files, relative to `dir`. Vitest's default `test.include` by default, which may
   * match no file. A file these match that the config leaves out passes without running.
   */
  readonly tests?: ReadonlyArray<string>
  /**
   * More files every test file runs with, such as the config's `setupFiles`, which it names as paths
   * rather than imports: `Files.imports("test/setup.ts")`. Every test file's key always covers
   * `vite.config.ts` in `dir` with the repository files it imports, and every tsconfig, whose compiler
   * options Vite's transform reads.
   */
  readonly inputs?: Files.Files
}

/**
 * `vp test` file by file, as `Vitest.files`: a test file runs again only when it, what it imports, the
 * config or `inputs` changed. A job whose files the config leaves out passes (`--passWithNoTests`), so
 * `tests` may match more than the config's `test.include`.
 */
export const test = (options: TestOptions) => {
  const dir = options.dir ?? "."
  return Vitest.files({
    ...options,
    tests: options.tests ?? defaultTests,
    allowEmpty: options.allowEmpty ?? options.tests === undefined,
    inputs: Files.union(
      Files.imports(dir === "." ? "vite.config.ts" : `${dir}/vite.config.ts`),
      Files.optional(Files.glob("**/tsconfig*.json")),
      ...(options.inputs === undefined ? [] : [options.inputs]),
    ),
    args: ["--passWithNoTests", ...(options.args ?? [])],
    vitest: ["vp", "test"],
  })
}

export interface TasksOptions extends CheckOptions {
  /** `test`'s options besides the shell and setup, such as `tests` or `shards`. */
  readonly test?: Omit<TestOptions, "shell" | "setup">
}

/** Both tasks of a Vite+ repository: `check` runs `vp check` and `test` runs `vp test`. */
export const tasks = (options: TasksOptions) => {
  const toolchain = { ...(options.shell === undefined ? {} : { shell: options.shell }), setup: options.setup }
  return [check(toolchain), test({ ...options.test, ...toolchain })] as const
}
