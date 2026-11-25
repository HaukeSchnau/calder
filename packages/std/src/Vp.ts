import { cmd, Files, type Flake, type Setup, Task } from "@calder-ci/core";
import * as Vitest from "./Vitest.ts";

export interface CheckOptions {
  /** The dev shell with node. */
  readonly shell?: Flake.FlakeRef<"devShells">;
  /** The setup that installs the repository's `vite-plus`, such as `Pnpm.install`. */
  readonly setup: Setup.Setup;
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
  });

/** The whole suite in one task, keyed by the whole repository, since only the config knows what runs. */
export interface SuiteOptions
  extends Omit<Vitest.SuiteOptions, "shell" | "setup" | "vitest">, CheckOptions {
  readonly tests?: undefined;
  // What picks or keys test files applies only with `tests`, so passing it here fails to compile.
  readonly allowEmpty?: never;
  readonly inputs?: never;
  readonly aliases?: never;
  readonly shards?: never;
}

/** File by file, as `Vitest.files`. */
export interface FilesOptions
  extends Omit<Vitest.FilesOptions, "shell" | "setup" | "vitest">, CheckOptions {
  /** Globs of the test files, relative to `dir`. They must cover the config's `test.include`, or a file they miss never runs. */
  readonly tests: ReadonlyArray<string>;
  /**
   * More files every test file runs with, such as the config's `setupFiles`, which it names as paths
   * rather than imports: `Files.imports("test/setup.ts")`, and a config `args` name with `--config`.
   * Every test file's key always covers `vite.config.ts` in `dir` with the repository files it imports,
   * and every tsconfig, whose compiler options Vite's transform reads.
   */
  readonly inputs?: Files.Files;
}

export type TestOptions = SuiteOptions | FilesOptions;

/**
 * `vp test`. Without `tests`, the whole suite in one task. With them, file by file: a test file runs again
 * only when it, what it imports, the config or `inputs` changed, and a job whose files the config leaves
 * out passes. Either way a repository without tests passes (`--passWithNoTests`).
 */
export const test = (options: TestOptions) => {
  const args = ["--passWithNoTests", ...(options.args ?? [])];
  if (options.tests === undefined)
    return Vitest.suite({ ...options, args, vitest: ["vp", "test"] });
  const dir = options.dir ?? ".";
  return Vitest.files({
    ...options,
    inputs: Files.union(
      Files.imports(dir === "." ? "vite.config.ts" : `${dir}/vite.config.ts`),
      Files.optional(Files.glob("**/tsconfig*.json")),
      ...(options.inputs === undefined ? [] : [options.inputs]),
    ),
    args,
    vitest: ["vp", "test"],
  });
};

type WithoutToolchain<T> = T extends unknown ? Omit<T, "shell" | "setup"> : never;

export interface TasksOptions extends CheckOptions {
  /** `test`'s options besides the shell and setup, such as `tests` and `shards`. */
  readonly test?: WithoutToolchain<TestOptions>;
}

/** Both tasks of a Vite+ repository: `check` runs `vp check` and `test` runs `vp test`. */
export const tasks = (options: TasksOptions) => {
  const toolchain = {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    setup: options.setup,
  };
  return [check(toolchain), test({ ...options.test, ...toolchain })] as const;
};
