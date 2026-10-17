import { cmd, Files, type Flake, Setup } from "@calder-ci/core"

export interface InstallOptions {
  /** The step's name, `install` by default. Name a second install that needs another shell or `keep`. */
  readonly name?: string
  /** The dev shell with bun. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The directory with its own lockfile, relative to the repository root. The root by default. */
  readonly dir?: string
  /** Arguments after `bun install --frozen-lockfile`. */
  readonly args?: ReadonlyArray<string>
  /**
   * More caches that tools check against the sources themselves (`.vite`), as gitignore patterns.
   * Not build output such as `dist`: see `Setup.Options.keep`.
   */
  readonly keep?: ReadonlyArray<string>
}

/**
 * `bun install` of the committed lockfile as a setup: current as long as manifests, the lockfile,
 * Bun's configuration and the patches it applies are. `node_modules` and TypeScript build info stay
 * across tasks, and `node_modules/.bin` is on PATH.
 */
export const install = (options: InstallOptions = {}) => {
  const dir = options.dir ?? "."
  const inDir = (path: string) => (dir === "." ? path : `${dir}/${path}`)
  const args = [...(options.args ?? [])]
  return Setup.make(options.name ?? "install", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    inputs: Files.union(
      Files.glob(inDir("**/package.json")),
      Files.optional(Files.glob(...["bun.lock", "bun.lockb", "bunfig.toml", ".npmrc", "patches/**/*.patch"].map(inDir))),
    ),
    run: dir === "." ? cmd`bun install --frozen-lockfile ${args}` : cmd`bun --cwd ${dir} install --frozen-lockfile ${args}`,
    keep: ["node_modules", "*.tsbuildinfo", ...(options.keep ?? [])],
    path: [inDir("node_modules/.bin")],
  })
}
