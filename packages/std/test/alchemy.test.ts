import { describe, expect, it } from "@effect/vitest"
import { Cmd, Files, Flake, Nix, Secret, Step } from "@calder-ci/core"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Alchemy from "../src/Alchemy.ts"
import * as Bun from "../src/Bun.ts"
import * as Pnpm from "../src/Pnpm.ts"

const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci

const argv = (step: ReturnType<typeof Alchemy.deploy<unknown>>, values: Record<string, unknown> = {}) => {
  if (step.def._tag !== "Task" || typeof step.def.run === "function") throw new Error("not a task with one command")
  return Cmd.render(step.def.run, values, { secrets: { cloudflare: "/secrets/cloudflare" }, pullRequest: 7 })
}

/**
 * Runs a step's command in a fresh workspace where `<dir>/node_modules/.bin/alchemy` and `bun` stand in
 * for the CLI: each records its directory and arguments, and answers `state read` like Alchemy does,
 * status lines first. Returns the workspace and the calls.
 */
const execute = (step: ReturnType<typeof Alchemy.deploy<unknown>>, options: { readonly dir?: string; readonly values?: Record<string, unknown> } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-"))
  const at = options.dir === undefined ? root : join(root, options.dir)
  const fake = `#!/usr/bin/env bash\necho "$(basename "$0") $PWD $* ${"$"}{CALDER_BUNDLE:-}" >> ${join(root, "calls")}\n` +
    `[[ " $* " == *" state read "* ]] && printf '%s\\n' '• Refreshing credentials' '[12:00:00] INFO (#1): from the environment' '{' '  "url": "https://site.example",' '  "token": { "__redacted__": "s3cret" }' '}'\ntrue\n`
  mkdirSync(join(at, "node_modules", ".bin"), { recursive: true })
  mkdirSync(join(root, "bin"))
  writeFileSync(join(at, "node_modules", ".bin", "alchemy"), fake, { mode: 0o755 })
  writeFileSync(join(root, "bin", "bun"), fake.replace('$(basename "$0")', "bun"), { mode: 0o755 })
  const [command, ...args] = argv(step, options.values)
  // With a socket for stdin, as in Calder's workers, NixOS's bash sources /etc/bashrc, which resets PATH.
  execFileSync(command!, args, { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] })
  const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n").map((line) => line.replaceAll(root, "<root>").trim())
  return { root, calls }
}

const rest = "deploy --stage prod --yes --env-file /secrets/cloudflare"

describe("Alchemy.deploy", () => {
  it("starts the installed CLI, without pnpm checking the install again, or bun's", () => {
    const pnpm = Alchemy.deploy({ shell, setup: Pnpm.install({ shell }), env: "cloudflare" }, { stage: "prod" })
    const bun = Alchemy.deploy({ shell, setup: Bun.install({ shell }), runner: "bun", env: "cloudflare" }, { stage: "prod" })
    expect(execute(pnpm).calls).toEqual([`alchemy <root> ${rest}`])
    expect(execute(bun).calls).toEqual([`bun <root> alchemy ${rest}`])
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
    expect(execute(pnpm, { dir: "site" }).calls).toEqual([`alchemy <root>/site ${rest}`])
    expect(execute(bun, { dir: "site" }).calls).toEqual([`bun <root>/site alchemy ${rest}`])
    if (pnpmInstall.def._tag !== "Setup" || bunInstall.def._tag !== "Setup") throw new Error("not a setup")
    expect(Cmd.render(pnpmInstall.def.run, {})).toEqual(["pnpm", "--dir", "site", "install", "--frozen-lockfile"])
    expect(Cmd.render(bunInstall.def.run, {})).toEqual(["bun", "--cwd=site", "install", "--frozen-lockfile"])
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
    const outputs = { name: "Site", schema: Schema.Struct({ url: Schema.String }) }
    const step = Alchemy.deploy({ shell, setup: Pnpm.install({ shell }), dir: "site", env: "cloudflare", outputs }, { stage: "prod" })
    const { root, calls } = execute(step, { dir: "site" })
    expect(calls).toEqual([
      `alchemy <root>/site ${rest}`,
      "alchemy <root>/site state read Site/prod/output --env-file /secrets/cloudflare",
    ])
    if (step.def._tag !== "Task" || step.def.value === undefined) throw new Error("not a task with a value")
    const written: unknown = JSON.parse(readFileSync(join(root, step.def.value.path), "utf8"))
    expect(Schema.decodeUnknownSync(step.def.value.schema)(written)).toEqual({ url: "https://site.example" })
  })

  it("declares its artifacts, which the worker hands the stack by variable and publishes, and waits for those builds", () => {
    const flake = Flake.make({ packages: ["bundle"], checks: [], devShells: ["ci"] })
    const bundle = Nix.build(flake.packages.bundle, { name: "bundle" })
    const step = Alchemy.deploy({ shell, setup: Pnpm.install({ shell }), env: "cloudflare" }, { stage: "prod", artifacts: { CALDER_BUNDLE: bundle } })
    if (step.def._tag !== "Task") throw new Error("not a task")
    expect(step.def.artifacts).toEqual({ CALDER_BUNDLE: bundle })
    expect(execute(step).calls).toEqual([`alchemy <root> ${rest}`])
    expect(Step.dependencies(step).map((d) => [d.step.name, d.via])).toContainEqual(["bundle", "needs"])
  })

  it("holds the lease for a pull request's preview and its removal, which then take turns", () => {
    const stack = { shell, setup: Pnpm.install({ shell }), env: "cloudflare" }
    const [preview] = Alchemy.preview(stack, { url: () => "https://pr.example" })
    const destroy = Alchemy.destroy(stack)
    expect([preview.def, destroy.def].map((def) => def._tag === "Task" && def.lease)).toEqual([true, true])
  })

  it("deploys and destroys a pull request's own stage", () => {
    const stack = { shell, setup: Pnpm.install({ shell }), env: "cloudflare" }
    const [preview] = Alchemy.preview(stack, { url: () => "https://pr.example" })
    expect(execute(preview as ReturnType<typeof Alchemy.deploy<unknown>>).calls).toEqual([
      "alchemy <root> deploy --stage pr-7 --yes --env-file /secrets/cloudflare",
    ])
    expect(execute(Alchemy.destroy(stack) as ReturnType<typeof Alchemy.deploy<unknown>>).calls).toEqual([
      "alchemy <root> destroy --stage pr-7 --yes --env-file /secrets/cloudflare",
    ])
  })
})
