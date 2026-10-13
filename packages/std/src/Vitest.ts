import { cmd, Files, type Flake, Report, type Setup, Task } from "@kiln/core"

export interface FilesOptions {
  /** The step's name, `test` by default. */
  readonly name?: string
  /** The dev shell with node. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The setup that installs the package's vitest, such as `Pnpm.install`. */
  readonly setup?: Setup.Setup
  /** The package vitest runs in, relative to the repository root. The root by default. */
  readonly dir?: string
  /** Globs of the test files, relative to `dir`. */
  readonly tests: ReadonlyArray<string>
  /**
   * What every test file runs with besides its imports: vitest configs and setup files. By default
   * the root manifest and lockfiles, as for a task's `each`; list those too when you add to them.
   */
  readonly inputs?: Files.Files
  /** The import aliases of the vitest config, so that following a test file's imports finds them. */
  readonly aliases?: { readonly [prefix: string]: string }
  /** Spreads the files that need to run over at most this many parallel jobs. */
  readonly shards?: number
  /** Arguments after `vitest run`, such as `--maxWorkers 3` or `--project unit`. */
  readonly args?: ReadonlyArray<string>
  /** The command that runs vitest: `vitest` by default, `["vp", "test"]` with Vite+. */
  readonly vitest?: ReadonlyArray<string>
  /** A command run in `dir` before vitest, such as one that fetches a runtime the tests launch. */
  readonly before?: ReadonlyArray<string>
  readonly env?: { readonly [env: string]: string }
}

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`

/**
 * Runs the command after `$1` and `$2` in the package directory `$1`, with the package's own binaries
 * first on PATH as for a package script, and has vitest write its JSON report to the repository path
 * `$2`. Tasks start at the repository root, hence the `cd`. The report path is absolute because
 * vitest resolves it against its root, which a config may move.
 */
const script = (before: ReadonlyArray<string>) =>
  [
    "set -eu",
    "report=$PWD/$2",
    'cd "$1"',
    "shift 2",
    "PATH=$PWD/node_modules/.bin:$PATH",
    ...(before.length === 0 ? [] : [before.map(quote).join(" ")]),
    'exec "$@" --reporter=default --reporter=json "--outputFile.json=$report"',
  ].join("; ")

/**
 * A package's vitest suite as a task with `each`: a test file runs again only when it, what it
 * imports or `inputs` changed. Vitest runs in `dir` and gets the files relative to it.
 */
export const files = (options: FilesOptions) => {
  const dir = options.dir ?? "."
  const inDir = (path: string) => (dir === "." ? path : `${dir}/${path}`)
  const fromDir = (file: string) => (dir !== "." && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file)
  const report = inDir(".vitest-report.json")
  return Task.make(options.name ?? "test", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.shards === undefined ? {} : { shards: { count: options.shards } }),
    ...(options.env === undefined ? {} : { env: options.env }),
    each: Files.imports(options.tests.map(inDir), { aliases: options.aliases ?? {} }),
    run: ({ files }) =>
      cmd`bash -c ${script(options.before ?? [])} vitest ${dir} ${report} ${options.vitest ?? ["vitest"]} run ${options.args ?? []} ${files.map(fromDir)}`,
    report: Report.vitest(report),
  })
}
