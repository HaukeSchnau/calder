import { describe, expect, it } from "@effect/vitest"
import { Cmd, Files, Flake } from "@kiln/core"
import * as Alchemy from "../src/Alchemy.ts"
import * as Bun from "../src/Bun.ts"
import * as Pnpm from "../src/Pnpm.ts"

const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci

const argv = (step: ReturnType<typeof Alchemy.deploy>) => {
  if (step.def._tag !== "Task" || typeof step.def.run === "function") throw new Error("not a task with one command")
  return Cmd.render(step.def.run, {}, { secrets: { cloudflare: "/secrets/cloudflare" } })
}

describe("Alchemy.deploy", () => {
  it("starts the CLI through the stack's runner", () => {
    const pnpm = Alchemy.deploy({ shell, setup: Pnpm.install({ shell }), env: "cloudflare" }, { stage: "prod" })
    const bun = Alchemy.deploy({ shell, setup: Bun.install({ shell }), runner: "bun", env: "cloudflare" }, { stage: "prod" })
    const rest = ["deploy", "--stage", "prod", "--yes", "--env-file", "/secrets/cloudflare"]
    expect(argv(pnpm)).toEqual(["pnpm", "exec", "alchemy", ...rest])
    expect(argv(bun)).toEqual(["bun", "alchemy", ...rest])
  })

  it("runs the CLI in the stack's directory, from that directory's install", () => {
    const pnpmInstall = Pnpm.install({ name: "site-install", shell, dir: "site" })
    const bunInstall = Bun.install({ name: "site-install", shell, dir: "site" })
    const pnpm = Alchemy.deploy({ shell, setup: pnpmInstall, dir: "site", env: "cloudflare" }, { stage: "prod" })
    const bun = Alchemy.deploy({ shell, setup: bunInstall, runner: "bun", dir: "site", env: "cloudflare" }, { stage: "prod" })
    const rest = ["deploy", "--stage", "prod", "--yes", "--env-file", "/secrets/cloudflare"]
    expect(argv(pnpm)).toEqual(["pnpm", "--dir", "site", "exec", "alchemy", ...rest])
    expect(argv(bun)).toEqual(["bun", "--cwd", "site", "alchemy", ...rest])
    if (pnpmInstall.def._tag !== "Setup" || bunInstall.def._tag !== "Setup") throw new Error("not a setup")
    expect(Cmd.render(pnpmInstall.def.run, {})).toEqual(["pnpm", "--dir", "site", "install", "--frozen-lockfile"])
    expect(Cmd.render(bunInstall.def.run, {})).toEqual(["bun", "--cwd", "site", "install", "--frozen-lockfile"])
    expect(pnpmInstall.def.path).toEqual(["site/node_modules/.bin"])
    expect(pnpmInstall.def.inputs).toEqual(
      Files.union(
        Files.glob("site/**/package.json", "site/pnpm-lock.yaml"),
        Files.optional(
          Files.glob("site/pnpm-workspace.yaml", "site/.npmrc", "site/.pnpmfile.cjs", "site/pnpmfile.cjs", "site/patches/**/*.patch"),
        ),
      ),
    )
  })
})
