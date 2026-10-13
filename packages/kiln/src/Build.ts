import { readFileSync } from "node:fs"

/**
 * This install's Kiln build: the start of its source's content hash, which `nix/package.nix` writes,
 * or "dev" in a checkout. Agents report theirs so people see what each one runs.
 */
export const id = (() => {
  try {
    return readFileSync(new URL("../../../build", import.meta.url), "utf8").trim()
  } catch {
    return "dev"
  }
})()
