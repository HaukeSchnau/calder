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

interface Registry {
  readonly published?: ReadonlyArray<string>
  readonly staged?: ReadonlyArray<{ readonly id: string; readonly version: string; readonly status: string }>
}

/**
 * Runs a publish step in a scratch repository against stand-ins for npm and pnpm. `npm view` and
 * `npm stage list` answer from `registry`, `npm stage publish` records its arguments and the user
 * config it was given and stages the version as `stg-42`, and `pnpm pack` writes a tarball.
 */
const run = (step: ReturnType<typeof Npm.publish>, options: { version: string; registry?: Registry; dir?: string }) => {
  const repo = mkdtempSync(join(tmpdir(), "npm-publish-"))
  const bin = join(repo, ".bin")
  mkdirSync(bin)
  const pkg = join(repo, options.dir ?? ".")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/pkg", version: options.version }))
  writeFileSync(join(repo, "token"), "npm_s3cret\n")
  writeFileSync(join(repo, "published"), (options.registry?.published ?? []).join("\n"))
  writeFileSync(
    join(repo, "staged.json"),
    JSON.stringify((options.registry?.staged ?? []).map((item) => ({ ...item, packageName: "@scope/pkg" }))),
  )
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "view "*) wanted=\${2##*@}; grep -qx "$wanted" ${join(repo, "published")} && echo "$wanted"; true ;;
  "stage list") cat ${join(repo, "staged.json")} ;;
  "stage publish") echo "$PWD $*" >> ${join(repo, "calls")}; cat "$NPM_CONFIG_USERCONFIG" >> ${join(repo, "userconfig")}
    node -e 'const fs = require("fs"); const list = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      list.push({ id: "stg-42", packageName: "@scope/pkg", version: require(process.cwd() + "/package.json").version, status: "pending" })
      fs.writeFileSync(process.argv[1], JSON.stringify(list))' ${join(repo, "staged.json")}
    echo "+ @scope/pkg (staged)" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash\n[ "$1 $2" = "pack --pack-destination" ] || exit 2\ntouch "$3/scope-pkg.tgz"\n`, {
    mode: 0o755,
  })
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
    value: Schema.decodeUnknownSync(Npm.Release)(JSON.parse(read(step.def.value.path)!)),
  }
}

describe("Npm.publish", () => {
  const setup = Pnpm.install({ shell })
  const step = Npm.publish({ shell, setup, token: "npm" })

  it("stages a new version from pnpm's tarball, with the token in a user config of its own", () => {
    const result = run(step, { version: "1.2.0", registry: { published: ["1.1.0"] } })
    expect(result.calls).toMatch(
      new RegExp(`^${result.repo} stage publish /\\S+/scope-pkg\\.tgz --tag latest --access public --registry https://registry\\.npmjs\\.org/$`),
    )
    expect(result.userconfig).toBe("//registry.npmjs.org/:_authToken=npm_s3cret")
    expect(result.value).toEqual({ name: "@scope/pkg", version: "1.2.0", state: "staged", stage: "stg-42", staged: true })
  })

  it("leaves a published version alone, so every push can run it", () => {
    const result = run(step, { version: "1.2.0", registry: { published: ["1.1.0", "1.2.0"] } })
    expect(result.calls).toBeUndefined()
    expect(result.value).toEqual({ name: "@scope/pkg", version: "1.2.0", state: "published", stage: null, staged: false })
  })

  it("leaves a version that waits for approval alone, and stages one again after a rejection", () => {
    const waiting = run(step, { version: "1.2.0", registry: { staged: [{ id: "stg-7", version: "1.2.0", status: "pending" }] } })
    expect(waiting.calls).toBeUndefined()
    expect(waiting.value).toEqual({ name: "@scope/pkg", version: "1.2.0", state: "staged", stage: "stg-7", staged: false })

    const rejected = run(step, { version: "1.2.0", registry: { staged: [{ id: "stg-7", version: "1.2.0", status: "rejected" }] } })
    expect(rejected.value.staged).toBe(true)
  })

  it("stages a prerelease for the next tag", () => {
    expect(run(step, { version: "2.0.0-beta.1" }).calls).toContain("--tag next")
  })

  it("stages the package in its directory for the given registry", () => {
    const other = Npm.publish({ shell, setup, token: "npm", dir: "packages/lib", registry: "https://npm.example/", access: "restricted" })
    const result = run(other, { version: "0.1.0", dir: "packages/lib" })
    expect(result.calls).toMatch(new RegExp(`^${result.repo}/packages/lib stage publish \\S+ --tag latest --access restricted --registry https://npm\\.example/`))
    expect(result.userconfig).toBe("//npm.example/:_authToken=npm_s3cret")
  })

  it("holds the deploy lease and runs on every push", () => {
    if (step.def._tag !== "Task") throw new Error("not a task")
    expect(step.def.lease).toBe(true)
    expect(step.def.reuse).toBe("never")
  })
})
