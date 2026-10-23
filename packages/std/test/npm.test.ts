import { describe, expect, it } from "@effect/vitest"
import { Cmd, Flake } from "@calder-ci/core"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Npm from "../src/Npm.ts"
import * as Pnpm from "../src/Pnpm.ts"

const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci

/**
 * Runs a publish step in a scratch repository whose registry already holds `published` versions.
 * `npm` and `pnpm` are stand-ins: `npm view` answers from that list, and `pnpm publish` records its
 * arguments and the user config it was given.
 */
const run = (step: ReturnType<typeof Npm.publish>, options: { version: string; published?: ReadonlyArray<string>; dir?: string }) => {
  const repo = mkdtempSync(join(tmpdir(), "npm-publish-"))
  const bin = join(repo, ".bin")
  mkdirSync(bin)
  const pkg = join(repo, options.dir ?? ".")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/pkg", version: options.version }))
  writeFileSync(join(repo, "token"), "npm_s3cret\n")
  writeFileSync(join(repo, "published"), (options.published ?? []).join("\n"))
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash\n[ "$1" = view ] || exit 2\nwanted=\${2##*@}\ngrep -qx "$wanted" ${join(repo, "published")} && echo "$wanted"\ntrue\n`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash\necho "$PWD $*" >> ${join(repo, "calls")}\ncat "$NPM_CONFIG_USERCONFIG" >> ${join(repo, "userconfig")}\n`,
    { mode: 0o755 },
  )
  if (step.def._tag !== "Task" || typeof step.def.run === "function" || step.def.value === undefined) {
    throw new Error("not a task with one command and a value")
  }
  const [command, ...args] = Cmd.render(step.def.run, {}, { secrets: { npm: join(repo, "token") } })
  // With a socket for stdin, as in Calder's workers, NixOS's bash sources /etc/bashrc, which resets PATH.
  execFileSync(command!, args, { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] })
  const read = (file: string) => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8").trim() : undefined)
  return {
    repo,
    calls: read("calls"),
    userconfig: read("userconfig"),
    value: Schema.decodeUnknownSync(step.def.value.schema)(JSON.parse(read(step.def.value.path)!)),
  }
}

describe("Npm.publish", () => {
  const setup = Pnpm.install({ shell })

  it("publishes a version the registry doesn't have, with the token in a user config of its own", () => {
    const result = run(Npm.publish({ shell, setup, token: "npm" }), { version: "1.2.0", published: ["1.1.0"] })
    expect(result.calls).toBe(`${result.repo} publish --no-git-checks --access public --tag latest --registry https://registry.npmjs.org/`)
    expect(result.userconfig).toBe("//registry.npmjs.org/:_authToken=npm_s3cret")
    expect(result.value).toEqual({ name: "@scope/pkg", version: "1.2.0", published: true })
  })

  it("leaves a version the registry has alone, so every push can run it", () => {
    const result = run(Npm.publish({ shell, setup, token: "npm" }), { version: "1.2.0", published: ["1.1.0", "1.2.0"] })
    expect(result.calls).toBeUndefined()
    expect(result.value).toEqual({ name: "@scope/pkg", version: "1.2.0", published: false })
  })

  it("publishes a prerelease to the next tag", () => {
    const result = run(Npm.publish({ shell, setup, token: "npm" }), { version: "2.0.0-beta.1" })
    expect(result.calls).toContain("--tag next")
  })

  it("publishes the package in its directory to the given registry", () => {
    const step = Npm.publish({ shell, setup, token: "npm", dir: "packages/lib", registry: "https://npm.example/", access: "restricted" })
    const result = run(step, { version: "0.1.0", dir: "packages/lib" })
    expect(result.calls).toBe(`${result.repo}/packages/lib publish --no-git-checks --access restricted --tag latest --registry https://npm.example/`)
    expect(result.userconfig).toBe("//npm.example/:_authToken=npm_s3cret")
  })

  it("holds the deploy lease and reads the token from the project's secret", () => {
    const step = Npm.publish({ shell, setup, token: "npm-token" })
    if (step.def._tag !== "Task" || typeof step.def.run === "function") throw new Error("not a task")
    expect(step.def.lease).toBe(true)
    expect(step.def.reuse).toBe("never")
    expect(Cmd.render(step.def.run, {}, { secrets: { "npm-token": "/secrets/npm" } })).toContain("/secrets/npm")
  })
})
