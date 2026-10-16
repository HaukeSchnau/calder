import { cmd, Files, type Flake, Setup } from "@kiln/core"

export interface InstallOptions {
  /** The step's name, `install` by default. Name a second install that needs another shell or `keep`. */
  readonly name?: string
  /** The dev shell with node and pnpm. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /**
   * The directory with its own lockfile, relative to the repository root, such as a website that keeps
   * its dependencies out of the root's workspace. The root by default.
   */
  readonly dir?: string
  /** Arguments after `pnpm install --frozen-lockfile`, such as `--trust-lockfile`. */
  readonly args?: ReadonlyArray<string>
  /**
   * More caches that tools check against the sources themselves (`.vite`), as gitignore patterns.
   * Not build output such as `dist`: see `Setup.Options.keep`.
   */
  readonly keep?: ReadonlyArray<string>
}

/**
 * `pnpm install` of the committed lockfile as a setup: current as long as manifests, the lockfile,
 * pnpm's configuration and the patches it applies are. `node_modules` (with the caches tools keep in
 * it) and TypeScript build info stay across tasks, and `node_modules/.bin` is on PATH.
 */
export const install = (options: InstallOptions = {}) => {
  const dir = options.dir ?? "."
  const inDir = (path: string) => (dir === "." ? path : `${dir}/${path}`)
  const args = [...(options.args ?? [])]
  return Setup.make(options.name ?? "install", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    inputs: Files.union(
      Files.glob(inDir("**/package.json"), inDir("pnpm-lock.yaml")),
      Files.optional(
        Files.glob(...["pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", "patches/**/*.patch"].map(inDir)),
      ),
    ),
    run: dir === "." ? cmd`pnpm install --frozen-lockfile ${args}` : cmd`pnpm --dir ${dir} install --frozen-lockfile ${args}`,
    keep: ["node_modules", ".pnpm-store", "*.tsbuildinfo", ...(options.keep ?? [])],
    path: [inDir("node_modules/.bin")],
  })
}
