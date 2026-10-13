import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { link, sdkPath, stableSdk, tsconfig } from "../src/Gen.ts"

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

describe("the generated tsconfig", () => {
  it("type-checks ci.ts with the SDK's compiler options and Bun's types through .kiln/node_modules", () => {
    const kiln = join(mkdtempSync(join(tmpdir(), "kiln-gen-")), ".kiln")
    mkdirSync(kiln)
    writeFileSync(join(kiln, "tsconfig.json"), JSON.stringify(tsconfig))
    link(join(kiln, "node_modules"), sdkPath)
    writeFileSync(
      join(kiln, "ci.ts"),
      `import { Flake, Task, cmd } from "@kiln/core"
import { Pnpm, Project } from "@kiln/std"

const flake = Flake.make({ packages: [], checks: [], devShells: ["ci"] })
const qa = Task.make("qa", { shell: flake.devShells.ci, setup: Pnpm.install(), run: cmd\`true\` })
export const size: Promise<number> = Bun.file("x").text().then((text) => text.length)
export default Project.standard({ flake, checks: [qa] })
`,
    )
    const tsc = spawnSync(resolve(import.meta.dirname, "../../../node_modules/.bin/tsc"), ["-p", kiln], { encoding: "utf8" })
    expect(tsc.stdout + tsc.stderr).toBe("")
    expect(tsc.status).toBe(0)
  })
})
