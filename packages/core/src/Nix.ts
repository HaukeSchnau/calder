import type { FlakeRef } from "./Flake.ts"
import type { BuildFailed, StorePath } from "./Kiln.ts"
import { make, type Step } from "./Step.ts"

/**
 * A derivation of the repository's flake. Nix decides whether anything needs building, and the value
 * is the output path.
 */
export const build = (
  ref: FlakeRef<"packages" | "checks" | "attr">,
  options: { readonly name?: string } = {},
): Step<StorePath, BuildFailed> =>
  make("build", options.name ?? [ref.name, ...(ref.path ?? [])].join("."), { _tag: "Build", ref }) as Step<StorePath, BuildFailed>
