import { cmd, Files, type Flake, Setup } from "@kiln/core"

export interface InstallOptions {
  /** The dev shell with node and pnpm. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** Arguments after `pnpm install --frozen-lockfile`, such as `--trust-lockfile`. */
  readonly args?: ReadonlyArray<string>
  /** More of what tasks build that later tasks reuse, as gitignore patterns (`dist`, `.expo`). */
  readonly keep?: ReadonlyArray<string>
}

/**
 * `pnpm install` of the committed lockfile as a setup: current as long as manifests, the lockfile,
 * pnpm's configuration and the patches it applies are. `node_modules` (with the caches tools keep in
 * it) and TypeScript build info stay across tasks, and `node_modules/.bin` is on PATH.
 */
export const install = (options: InstallOptions = {}) =>
  Setup.make("install", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    inputs: Files.glob(
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".pnpmfile.cjs",
      "pnpmfile.cjs",
      "patches/**/*.patch",
    ),
    run: cmd`pnpm install --frozen-lockfile ${[...(options.args ?? [])]}`,
    keep: ["node_modules", ".pnpm-store", "*.tsbuildinfo", ...(options.keep ?? [])],
    path: ["node_modules/.bin"],
  })
