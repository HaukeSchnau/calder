import { Flake } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Layer } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunInfo } from "../src/Protocol.ts"
import { only } from "../src/StorePaths.ts"
import { derivations, nixString, recorder, withOwnNix } from "../src/worker/Resolve.ts"
import { memoryRepo } from "./memoryRepo.ts"

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


describe("an evaluation", () => {
  it.live.skipIf(spawnSync("nix", ["--version"]).status !== 0)("reads no nix.conf from the job's home, where another pull request's job may have left one", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-userconf-"))
      writeFileSync(
        join(dir, "flake.nix"),
        `{ outputs = _: let deep = n: if n == 0 then "/bin/sh" else deep (n - 1); in {
          checks.x86_64-linux.a = derivation { name = "a"; system = "x86_64-linux"; builder = deep 20; };
        }; }\n`,
      )
      const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
      git("init", "-q")
      git("add", "-A")
      git("commit", "-q", "-m", "flake")
      const run = { flake: `git+file://${dir}?rev=${git("rev-parse", "HEAD")}` } as RunInfo
      // A setting that changes what the flake evaluates to, as an attacker's would.
      const home = mkdtempSync(join(tmpdir(), "calder-home-"))
      mkdirSync(join(home, ".config", "nix"), { recursive: true })
      writeFileSync(join(home, ".config", "nix", "nix.conf"), "max-call-depth = 5\n")
      const before = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NIX_USER_CONF_FILES: process.env.NIX_USER_CONF_FILES }
      const restore = Effect.sync(() => {
        for (const [name, value] of Object.entries(before)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      })
      yield* Effect.sync(() => {
        process.env.HOME = home
        delete process.env.XDG_CONFIG_HOME
        delete process.env.NIX_USER_CONF_FILES
      })
      // Without the evaluation's own configuration, Nix applied it: `nix eval` failed with the call depth exceeded.
      expect(spawnSync("nix", ["eval", "--json", `${run.flake}#checks.x86_64-linux.a.drvPath`]).status).not.toBe(0)
      const result = yield* derivations(run, ["checks.x86_64-linux.a"], null).pipe(withOwnNix, Effect.provide(processes), Effect.ensuring(restore))
      expect(result.derivations.get("checks.x86_64-linux.a")?.drv).toMatch(/-a\.drv$/)
    }))

  it.live.skipIf(process.platform !== "linux" || spawnSync("nix", ["--version"]).status !== 0 || spawnSync("strace", ["-V"]).status !== 0)(
    "records the revision's own source, whatever a fetcher cache or nix.conf in the job's home says",
    () =>
      Effect.gen(function*() {
        const flake = (name: string) => `{ outputs = _: { checks.x86_64-linux.a = derivation { name = "${name}"; system = "x86_64-linux"; builder = "/bin/sh"; }; }; }\n`
        const dir = mkdtempSync(join(tmpdir(), "calder-fetchercache-"))
        writeFileSync(join(dir, "flake.nix"), flake("a"))
        const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim()
        git("init", "-q")
        git("add", "-A")
        git("commit", "-q", "-m", "flake")
        const run = { flake: `git+file://${dir}?rev=${git("rev-parse", "HEAD")}`, system: "x86_64-linux" } as RunInfo
        // The job's environment with a home another pull request's job wrote to.
        const home = mkdtempSync(join(tmpdir(), "calder-home-"))
        const env: Record<string, string> = {
          ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] =>
            e[1] !== undefined && !/^(NIX|XDG)_(CACHE|CONFIG|DATA|STATE)_HOME$|^NIX_USER_CONF_FILES$|^GIT_CONFIG_GLOBAL$/.test(e[0])
          )),
          HOME: home,
        }
        const nix = (...args: Array<string>) => spawnSync("nix", args, { encoding: "utf8", env })
        const path = (out: ReturnType<typeof nix>) => (JSON.parse(out.stdout) as { path: string }).path
        const source = path(nix("flake", "metadata", "--json", run.flake))
        // A source put in the store, and an entry that says it is the revision's.
        const forged = mkdtempSync(join(tmpdir(), "calder-forged-"))
        writeFileSync(join(forged, "flake.nix"), flake("forged"))
        const stored = nix("store", "add", "--name", "source", forged).stdout.trim()
        const db = new DatabaseSync(join(home, ".cache", "nix", "fetcher-cache-v4.sqlite"))
        db.prepare("update Cache set value = json_object('hash', ?) where domain = 'sourcePathToHash'").run(nix("hash", "path", forged).stdout.trim())
        db.close()
        expect(path(nix("flake", "metadata", "--json", run.flake))).toBe(stored)
        expect(path(nix("flake", "archive", "--json", "--dry-run", run.flake))).toBe(stored)
        const recorded = Effect.gen(function*() {
          const before = { ...process.env }
          yield* Effect.sync(() => {
            for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]
            Object.assign(process.env, env)
          })
          const got = yield* recorder(run, memoryRepo({ "flake.nix": flake("a") })).pipe(
            withOwnNix,
            Effect.provide(processes),
            Effect.ensuring(Effect.sync(() => {
              for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]
              Object.assign(process.env, before)
            })),
          )
          expect(got?.source).toBe(source)
          expect(got?.url.startsWith(`path:${source}?`)).toBe(true)
          expect(got?.pinned.has(stored)).toBe(false)
        })
        yield* recorded
        mkdirSync(join(home, ".config", "nix"), { recursive: true })
        writeFileSync(join(home, ".config", "nix", "nix.conf"), "store = dummy://\n")
        expect(nix("flake", "metadata", "--json", run.flake).status).not.toBe(0)
        yield* recorded
      }),
  )
})
