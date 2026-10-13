import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { stableSdk } from "../src/Gen.ts"

describe("stableSdk", () => {
  // A store path with the SDK and a profile that links its lib/, like /run/current-system/sw.
  const root = mkdtempSync(join(tmpdir(), "kiln-gen-"))
  const store = join(root, "store/kiln")
  const sdk = join(store, "lib/kiln/sdk/node_modules")
  mkdirSync(sdk, { recursive: true })
  mkdirSync(join(root, "profile/bin"), { recursive: true })
  symlinkSync(join(store, "lib"), join(root, "profile/lib"))

  it("links through the profile on PATH that exposes this SDK, so upgrades follow", () => {
    const path = [join(root, "elsewhere/bin"), join(root, "profile/bin")].join(":")
    expect(stableSdk(sdk, path)).toBe(join(root, "profile/lib/kiln/sdk/node_modules"))
  })

  it("falls back to the SDK itself when no profile exposes it", () => {
    expect(stableSdk(sdk, join(root, "elsewhere/bin"))).toBe(sdk)
  })
})
