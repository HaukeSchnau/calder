import { describe, expect, it } from "@effect/vitest"
import { Cmd, Files, Flake, Secret } from "@calder-ci/core"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Alchemy from "../src/Alchemy.ts"
import * as Bun from "../src/Bun.ts"
import * as Pnpm from "../src/Pnpm.ts"

const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci

const argv = (step: ReturnType<typeof Alchemy.deploy<unknown>>) => {
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

  it("hands the stack's secrets to the task by environment variable", () => {
    const step = Alchemy.deploy(
      { shell, setup: Pnpm.install({ shell }), env: "cloudflare", secrets: { FLEET_TOKEN_FILE: "placement-token" } },
      { stage: "prod" },
    )
    if (step.def._tag !== "Task") throw new Error("not a task")
    expect(step.def.secrets).toEqual({ FLEET_TOKEN_FILE: Secret.file("placement-token") })
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

  it("with outputs, deploys and then writes what the stack returned where the task's value comes from", () => {
    const dir = mkdtempSync(join(tmpdir(), "alchemy-outputs-"))
    mkdirSync(join(dir, "bin"))
    // Stands in for `pnpm exec alchemy`: records each call and answers `state read` like Alchemy does, status lines first.
    writeFileSync(
      join(dir, "bin", "pnpm"),
      `#!/usr/bin/env bash\necho "$*" >> calls\n[[ " $* " == *" state read "* ]] && printf '%s\\n' '• Refreshing credentials' '[12:00:00] INFO (#1): from the environment' '{' '  "url": "https://site.example",' '  "token": { "__redacted__": "s3cret" }' '}'\ntrue\n`,
      { mode: 0o755 },
    )
    const outputs = { name: "Site", schema: Schema.Struct({ url: Schema.String }) }
    const step = Alchemy.deploy({ shell, setup: Pnpm.install({ shell }), env: "cloudflare", outputs }, { stage: "prod" })
    const [command, ...args] = argv(step)
    // With a socket for stdin, as in Calder's workers, NixOS's bash sources /etc/bashrc, which resets PATH.
    execFileSync(command!, args, {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    })

    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual([
      "exec alchemy deploy --stage prod --yes --env-file /secrets/cloudflare",
      "exec alchemy state read Site/prod/output --env-file /secrets/cloudflare",
    ])
    if (step.def._tag !== "Task" || step.def.value === undefined) throw new Error("not a task with a value")
    const written: unknown = JSON.parse(readFileSync(join(dir, step.def.value.path), "utf8"))
    expect(Schema.decodeUnknownSync(step.def.value.schema)(written)).toEqual({ url: "https://site.example" })
  })
})
