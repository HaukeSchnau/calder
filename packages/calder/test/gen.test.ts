import { Calder, Cmd, Event } from "@calder-ci/core"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { link, pipeline, sdkPath, stableSdk, tsconfig } from "../src/Gen.ts"

describe("stableSdk", () => {
  // A store path with the SDK and a profile that links its lib/, like /run/current-system/sw.
  const root = mkdtempSync(join(tmpdir(), "calder-gen-"))
  const store = join(root, "store/calder")
  const sdk = join(store, "lib/calder/sdk/node_modules")
  mkdirSync(sdk, { recursive: true })
  mkdirSync(join(root, "profile/bin"), { recursive: true })
  symlinkSync(join(store, "lib"), join(root, "profile/lib"))

  it("links through the profile on PATH that exposes this SDK, so upgrades follow", () => {
    const path = [join(root, "elsewhere/bin"), join(root, "profile/bin")].join(":")
    expect(stableSdk(sdk, path)).toBe(join(root, "profile/lib/calder/sdk/node_modules"))
  })

  it("falls back to the SDK itself when no profile exposes it", () => {
    expect(stableSdk(sdk, join(root, "elsewhere/bin"))).toBe(sdk)
  })
})

describe("the generated tsconfig", () => {
  it("type-checks ci.ts with the SDK's compiler options and Bun's types through .calder/node_modules", () => {
    const calder = join(mkdtempSync(join(tmpdir(), "calder-gen-")), ".calder")
    mkdirSync(calder)
    writeFileSync(join(calder, "tsconfig.json"), JSON.stringify(tsconfig))
    link(join(calder, "node_modules"), sdkPath)
    writeFileSync(
      join(calder, "ci.ts"),
      `import { Flake, Task, cmd } from "@calder-ci/core"
import { Pnpm, Project } from "@calder-ci/std"

const flake = Flake.make({ packages: [], checks: [], devShells: ["ci"] })
const qa = Task.make("qa", { shell: flake.devShells.ci, setup: Pnpm.install(), run: cmd\`true\` })
export const size: Promise<number> = Bun.file("x").text().then((text) => text.length)
export default Project.standard({ flake, checks: [qa] })
`,
    )
    const tsrs = spawnSync(resolve(import.meta.dirname, "../../../node_modules/.bin/tsrs"), ["-p", calder], { encoding: "utf8" })
    expect(tsrs.stdout + tsrs.stderr).toBe("")
    expect(tsrs.status).toBe(0)
  })
})

describe("the generated ci.ts", () => {
  const vitePlus = JSON.stringify({ devDependencies: { "vite-plus": "1.8.0" } })

  /**
   * Plans a pull request with the ci.ts `calder gen` writes into a repository of `files` (path to content)
   * whose flake has a `ci` dev shell and `checks`.
   */
  const plan = (files: { readonly [path: string]: string }, checks: ReadonlyArray<string> = ["build"]) => {
    const dir = mkdtempSync(join(tmpdir(), "calder-gen-"))
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
    const calder = join(dir, ".calder")
    mkdirSync(calder)
    writeFileSync(
      join(calder, "flake.ts"),
      `import { Flake } from "@calder-ci/core"\nexport const flake = Flake.make({ packages: [], checks: ${JSON.stringify(checks)}, devShells: ["ci"] })\n`,
    )
    link(join(calder, "node_modules"), sdkPath)
    writeFileSync(join(calder, "ci.ts"), pipeline(dir, { checks, devShells: ["ci"] }))
    return Effect.runPromise(Effect.gen(function*() {
      const { default: project } = (yield* Effect.promise(() => import(join(calder, "ci.ts")))) as { readonly default: Calder.Project }
      return yield* Calder.plan(project, Event.pullRequest({ number: 1 }))
    }))
  }
  const names = (plan: Calder.Plan) => plan.steps.map((step) => step.name).sort()
  const installer = (plan: Calder.Plan) => {
    const def = plan.get("install")?.step.def
    return def?._tag === "Setup" ? Cmd.render(def.run, {})[0] : undefined
  }

  // The first import transforms @calder-ci/std, which takes seconds on a busy host.
  it("turns on Vite+'s checks in a repository with a root vite.config.ts and vite-plus", async () => {
    const pnpm = await plan({ "vite.config.ts": "", "package.json": vitePlus, "pnpm-lock.yaml": "" })
    expect(names(pnpm)).toEqual(["build", "check", "install", "test"])
    expect(installer(pnpm)).toBe("pnpm")
    expect(installer(await plan({ "vite.config.ts": "", "package.json": vitePlus, "bun.lock": "" }))).toBe("bun")
  }, 30_000)

  it("is the plain standard pipeline without vite.config.ts or without vite-plus", async () => {
    expect(names(await plan({ "package.json": vitePlus, "pnpm-lock.yaml": "" }))).toEqual(["build"])
    const vite = JSON.stringify({ devDependencies: { vite: "8.0.0", vitest: "5.0.3" } })
    expect(names(await plan({ "vite.config.ts": "", "package.json": vite, "pnpm-lock.yaml": "" }))).toEqual(["build"])
  })

  it("is the plain standard pipeline when a flake check already takes the name of a step it adds", async () => {
    const files = { "vite.config.ts": "", "package.json": vitePlus, "pnpm-lock.yaml": "" }
    expect(names(await plan(files, ["test"]))).toEqual(["test"])
    expect(names(await plan(files, ["install"]))).toEqual(["install"])
  })
})
