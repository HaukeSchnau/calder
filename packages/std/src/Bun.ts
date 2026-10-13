import { cmd, Files, type Flake, Setup } from "@kiln/core"

export interface InstallOptions {
  /** The dev shell with bun. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** Arguments after `bun install --frozen-lockfile`. */
  readonly args?: ReadonlyArray<string>
  /** More of what tasks build that later tasks reuse, as gitignore patterns (`dist`). */
  readonly keep?: ReadonlyArray<string>
}

/**
 * `bun install` of the committed lockfile as a setup: current as long as manifests, the lockfile,
 * Bun's configuration and the patches it applies are. `node_modules` and TypeScript build info stay
 * across tasks, and `node_modules/.bin` is on PATH.
 */
export const install = (options: InstallOptions = {}) =>
  Setup.make("install", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    inputs: Files.union(
      Files.glob("**/package.json"),
      Files.optional(Files.glob("bun.lock", "bun.lockb", "bunfig.toml", ".npmrc", "patches/**/*.patch")),
    ),
    run: cmd`bun install --frozen-lockfile ${[...(options.args ?? [])]}`,
    keep: ["node_modules", "*.tsbuildinfo", ...(options.keep ?? [])],
    path: ["node_modules/.bin"],
  })
