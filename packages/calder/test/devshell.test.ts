import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Flake } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Job as JobSpec } from "../src/Protocol.ts"
import { inShell } from "../src/worker/Steps.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci
const github = (rev: string) => ({ type: "github", owner: "NixOS", repo: "nixpkgs", rev, narHash: "sha256-IoNisKcGbUjdd45qCqywGMCYmZ5EnkxezvLII0FWwNA=", lastModified: 1 })
const [a, b] = ["02c087f3fe673c9e317f206a627cb6b910336dbe", "c59305bab2065cfecc4944690d9eedbb56f3a9fa"]

describe("a task's dev shell", () => {
  it.live.skipIf(spawnSync("nix", ["--version"]).status !== 0)(
    "is the plan's derivation with bash from the flake's own nixpkgs, or the flake where the store lacks it",
    () =>
      Effect.gen(function*() {
        const workspace = mkdtempSync(join(tmpdir(), "calder-devshell-"))
        const lock = (nixpkgs: string | ReadonlyArray<string>) =>
          writeFileSync(join(workspace, "flake.lock"), JSON.stringify({
            version: 7,
            root: "root",
            nodes: {
              root: { inputs: { nixpkgs, tools: "tools" } },
              nixpkgs: { locked: github(a) },
              tools: { inputs: { nixpkgs: "nixpkgs_2" }, locked: { type: "github", owner: "o", repo: "tools", rev: b, narHash: "sha256-AAAA" } },
              nixpkgs_2: { locked: github(b) },
            },
          }))
        // Stands in for the derivation in the store.
        const drv = join(workspace, "0000-nix-shell.drv")
        writeFileSync(drv, "")
        const job = {
          run: { flake: "git+file:///mirror?rev=abc", revision: "abc", system: "x86_64-linux" },
          shells: { "devShells.x86_64-linux.ci": drv },
        } as unknown as Extract<JobSpec, { _tag: "Step" }>
        const command = (j = job) => inShell(j, workspace, shell, ["bash", "-c", "true"])

        lock("nixpkgs")
        expect(yield* command()).toEqual([
          "nix", "develop", `${drv}^*`, "--override-flake", "nixpkgs", expect.stringMatching(new RegExp(`^github:NixOS/nixpkgs/${a}\\?`)),
          "--command", "bash", "-c", "true",
        ])
        // A nixpkgs that follows another input's is that one.
        lock(["tools", "nixpkgs"])
        expect((yield* command())[5]).toMatch(new RegExp(`^github:NixOS/nixpkgs/${b}\\?`))
        // An agent's store lacks the controller's derivation.
        const agent = { ...job, shells: { "devShells.x86_64-linux.ci": "/nix/store/00000000000000000000000000000000-missing.drv" } }
        expect(yield* command(agent)).toEqual(["nix", "develop", "git+file:///mirror?rev=abc#devShells.x86_64-linux.ci", "--command", "bash", "-c", "true"])
      }).pipe(Effect.provide(processes)),
  )
})
