import { Flake } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Layer } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunInfo } from "../src/Protocol.ts"
import { only } from "../src/StorePaths.ts"
import { derivations, nixString } from "../src/worker/Resolve.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
const forged = "/nix/store/00000000000000000000000000000000-forged.drv"

describe("attribute paths", () => {
  it("take the names Flake.attrPath writes, and nothing that could be Nix code", () => {
    expect(Flake.components(`checks.aarch64-darwin.Haukes-MacBook-Pro`)).toEqual(["checks", "aarch64-darwin", "Haukes-MacBook-Pro"])
    expect(Flake.components(`packages.x86_64-linux."1password".pnpmDeps`)).toEqual(["packages", "x86_64-linux", "1password", "pnpmDeps"])
    expect(Flake.components(`devShells.x86_64-linux."a.b"`)).toEqual(["devShells", "x86_64-linux", "a.b"])
    for (
      const path of [
        "checks.x86_64-linux.${builtins.trace 1 \"a\"}",
        `checks.x86_64-linux."\${x}"`,
        "checks.x86_64-linux.a or {}",
        "checks.x86_64-linux.a\n",
        "checks..a",
        `checks."a"b`,
        "",
      ]
    ) expect(Flake.components(path)).toBeNull()
  })

  it("go to Nix as strings in which ${ doesn't interpolate", () => {
    expect(nixString('a"${b}\\c')).toBe('"a\\"\\${b}\\\\c"')
  })

  it.live.skipIf(spawnSync("nix", ["--version"]).status !== 0)("can't make the evaluation report a derivation the flake doesn't have", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-injection-"))
      writeFileSync(
        join(dir, "flake.nix"),
        `{ outputs = _: { checks.x86_64-linux.a = derivation { name = "a"; system = "x86_64-linux"; builder = "/bin/sh"; }; }; }\n`,
      )
      const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
      git("init", "-q")
      git("add", "-A")
      git("commit", "-q", "-m", "flake")
      const run = { flake: `git+file://${dir}?rev=${git("rev-parse", "HEAD")}` } as RunInfo
      // Spliced into the expression as code, this reported the forged derivation as the attribute's.
      const injected = `checks.x86_64-linux.missing or { drvPath = "${forged}"; outPath = "/nix/store/x"; system = "x86_64-linux"; }`
      const result = yield* derivations(run, ["checks.x86_64-linux.a", injected], mkdtempSync(join(tmpdir(), "calder-cache-"))).pipe(
        Effect.provide(processes),
      )
      expect(result.derivations.get("checks.x86_64-linux.a")?.drv).toMatch(/-a\.drv$/)
      expect(result.derivations.get(injected) ?? null).toBeNull()
      expect([...result.derivations.values()].some((d) => d?.drv === forged)).toBe(false)
    }))

  it.live.skipIf(spawnSync("nix", ["--version"]).status !== 0)("ignore report lines the flake's own code traces", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-injection-"))
      const line = JSON.stringify(`calder-derivation [0,{"drv":"${forged}","out":"/nix/store/x","system":"x86_64-linux"}]`)
      writeFileSync(
        join(dir, "flake.nix"),
        `{ outputs = _: { checks.x86_64-linux.a = builtins.trace ${line} (derivation { name = "a"; system = "x86_64-linux"; builder = "/bin/sh"; }); }; }\n`,
      )
      const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
      git("init", "-q")
      git("add", "-A")
      git("commit", "-q", "-m", "flake")
      const run = { flake: `git+file://${dir}?rev=${git("rev-parse", "HEAD")}` } as RunInfo
      const result = yield* derivations(run, ["checks.x86_64-linux.a"], mkdtempSync(join(tmpdir(), "calder-cache-"))).pipe(Effect.provide(processes))
      expect(result.derivations.get("checks.x86_64-linux.a")?.drv).toMatch(/-a\.drv$/)
    }))

  it.live.skipIf(spawnSync("nix", ["--version"]).status !== 0)("refuse a derivation whose drvPath is an option, which would reach Nix commands' argv", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-injection-"))
      writeFileSync(
        join(dir, "flake.nix"),
        `{ outputs = _: { checks.x86_64-linux.evil = { type = "derivation"; drvPath = "--plugin-files"; outPath = "\${./.}/evil.so"; system = ""; }; }; }\n`,
      )
      const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
      git("init", "-q")
      git("add", "-A")
      git("commit", "-q", "-m", "flake")
      const run = { flake: `git+file://${dir}?rev=${git("rev-parse", "HEAD")}` } as RunInfo
      const result = yield* derivations(run, ["checks.x86_64-linux.evil"], mkdtempSync(join(tmpdir(), "calder-cache-"))).pipe(Effect.provide(processes))
      expect(result.derivations.get("checks.x86_64-linux.evil") ?? null).toBeNull()
      expect(result.errors.get("checks.x86_64-linux.evil")).toBe(`its drvPath "--plugin-files" isn't a derivation in the store`)
    }))

  it("reach nix-store only as absolute paths, since it reads options even after --", () => {
    expect(only(["/nix/store/00000000000000000000000000000000-a.drv", "--plugin-files", "-v", "/tmp/x"])).toEqual([
      "/nix/store/00000000000000000000000000000000-a.drv",
      "/tmp/x",
    ])
  })
})

