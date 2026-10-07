import { readFileSync } from "node:fs"

/**
 * This install's Kiln build: the start of its source's content hash, which `nix/package.nix` writes,
 * or "dev" in a checkout. An agent must run the controller's build: each host loads a revision's
 * `.kiln/ci.ts` against its own copy of the SDK.
 */
export const id = (() => {
  try {
    return readFileSync(new URL("../../../build", import.meta.url), "utf8").trim()
  } catch {
    return "dev"
  }
})()
