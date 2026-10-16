import { describe, expect, it } from "@effect/vitest"
import { Cmd, Flake } from "@kiln/core"
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
})
