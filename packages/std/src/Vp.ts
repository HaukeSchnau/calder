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

export interface TestOptions extends Omit<Vitest.FilesOptions, "tests" | "setup" | "vitest"> {
  /** The setup that installs the repository's `vite-plus`, such as `Pnpm.install`. */
  readonly setup: Setup.Setup
  /**
   * Globs of the test files, relative to `dir`, to run them file by file. Without them, `vp test run`
   * runs the whole suite in one task keyed by the whole repository, because only the config knows which
   * files its `test.include` names and which `setupFiles` they run with.
   */
  readonly tests?: ReadonlyArray<string>
  /**
   * With `tests`: more files every test file runs with, such as the config's `setupFiles`, which it names
   * as paths rather than imports: `Files.imports("test/setup.ts")`. Every test file's key always covers
   * `vite.config.ts` in `dir` (or the config `args` name with `--config`) with the repository files it imports, and every tsconfig, whose compiler
   * options Vite's transform reads.
   */
  readonly inputs?: Files.Files
}

/**
 * `vp test`. Without `tests`, the whole suite in one task. With them, file by file as `Vitest.files`: a
 * test file runs again only when it, what it imports, the config or `inputs` changed, and a job whose files
 * the config leaves out passes. Either way a repository without tests passes (`--passWithNoTests`).
 */
export const test = (options: TestOptions) => {
  const dir = options.dir ?? "."
  const args = ["--passWithNoTests", ...(options.args ?? [])]
  if (options.tests === undefined) {
    return Task.make(options.name ?? "test", {
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      setup: options.setup,
      ...(options.env === undefined ? {} : { env: options.env }),
      run: cmd`vp test run ${dir === "." ? [] : ["--root", dir]} ${args}`,
    })
  }
  const config = configIn(options.args ?? []) ?? "vite.config.ts"
  return Vitest.files({
    ...options,
    tests: options.tests,
    inputs: Files.union(
      Files.imports(dir === "." ? config : `${dir}/${config}`),
      Files.optional(Files.glob("**/tsconfig*.json")),
      ...(options.inputs === undefined ? [] : [options.inputs]),
    ),
    args,
    vitest: ["vp", "test"],
  })
}

/** The config `--config` (or `-c`) names in vitest's arguments, relative to the directory vitest runs in. */
const configIn = (args: ReadonlyArray<string>) => {
  const at = args.findIndex((arg) => arg === "--config" || arg === "-c")
  if (at !== -1) return args[at + 1]
  return args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length)
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
