import { Effect } from "effect"
import * as Exec from "./Exec.ts"
import { sha256 } from "./Keys.ts"

/**
 * This host's Nix version, import-from-derivation setting and a hash of `NIX_CONFIG`, which decide what
 * an evaluation gives.
 */
export const nixSettings = Effect.gen(function*() {
  const nix = (yield* Exec.run(["nix", "--version"])).trim()
  const ifd = (yield* Exec.run(["nix", "config", "show", "allow-import-from-derivation"]).pipe(Effect.orElseSucceed(() => "?"))).trim()
  return { nix, ifd, config: sha256(process.env.NIX_CONFIG ?? "").slice(0, 12) }
})
