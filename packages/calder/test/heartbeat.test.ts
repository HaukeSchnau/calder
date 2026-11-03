import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "../src/Exec.ts"
import type { RunInfo } from "../src/Protocol.ts"
import * as Footprint from "../src/worker/Footprint.ts"
import * as Heartbeat from "../src/worker/Heartbeat.ts"
import { derivations, jobMemory } from "../src/worker/Resolve.ts"

const GiB = 2 ** 30
const minutes = (n: number) => n * 60_000

describe("a heartbeat", () => {
  it("says in one line what a stalled evaluation waits for, and leaves out what the platform doesn't show", () => {
    // casa-crema's plan on 2026-11-03: 24 minutes loading the flake while the daemon's slice sat at its memory.high.
    const start = 1_000_000
    const progress: Heartbeat.Progress = {
      started: start,
      loaded: false,
      budget: 2.6 * GiB,
      activity: { text: "copying '«github:NixOS/nixpkgs/c59305b»/' to the store", started: start + 30_000 },
    }
    const trace = { path: "/nix/store/00000000000000000000000000000000-source/flake.lock", size: 52_000 }
    const daemon = (over: number, some: number, full: number) => ({
      unit: "nix-daemon.service",
      current: 3.9 * GiB,
      memory: { some, full },
      limit: { name: "nix-builds.slice", current: 4 * GiB, high: 4 * GiB, over },
    })
    const before: Heartbeat.Sample = {
      at: start + minutes(21),
      cpu: 11.6,
      opened: trace,
      host: { memory: { some: 0, full: 0 }, io: { some: 0, full: 0 } },
      daemon: daemon(1_000, 0, 0),
    }
    const now: Heartbeat.Sample = {
      at: start + minutes(24),
      cpu: 12,
      resident: 0.4 * GiB,
      main: { state: "S", wchan: "unix_stream_read_generic" },
      opened: trace,
      host: { memory: { some: 0.61 * minutes(3) * 1000, full: 0.45 * minutes(3) * 1000 }, io: { some: 0.03 * minutes(3) * 1000, full: 0 } },
      daemon: daemon(1_840_221, 0.6 * minutes(3) * 1000, 0.58 * minutes(3) * 1000),
    }
    expect(Heartbeat.describe(progress, before, now)).toBe(
      "Still evaluating after 24 min 0 s, loading the flake. Nix holds 0.4 GiB of its 2.6 GiB budget. " +
        "Its main thread waits for the Nix daemon (unix_stream_read_generic). " +
        "The last file it opened is /nix/store/00000000000000000000000000000000-source/flake.lock, and it touched no file since the last heartbeat. " +
        "Nix has been copying '«github:NixOS/nixpkgs/c59305b»/' to the store for 23 min 30 s. " +
        "The Nix daemon's nix-daemon.service is in nix-builds.slice, which holds 4.0 of its 4.0 GiB memory.high. " +
        "In the last 3 min 0 s, Nix used 0.4 s of CPU, 12 s in all; the host's memory pressure was 61% some and 45% full; " +
        "its io pressure was 3% some and 0% full; the Nix daemon's memory pressure was 60% some and 58% full; " +
        "nix-builds.slice went over its memory.high 1839221 times.",
    )

    // A macOS agent has no /proc, PSI or systemd: what's left is what the evaluator knows.
    const mac = { started: start, loaded: true, budget: null, attr: { index: 2, total: 6, name: "packages.aarch64-darwin.app" }, said: { text: "warning: Git tree is dirty", at: start + minutes(1) } }
    expect(Heartbeat.describe(mac, { at: start }, { at: start + minutes(4) })).toBe(
      "Still evaluating after 4 min 0 s, at attribute 2 of 6, packages.aarch64-darwin.app. Nix last said, 3 min 0 s ago: \"warning: Git tree is dirty\".",
    )
  })

  const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux`
  const can = (argv: ReadonlyArray<string>) => spawnSync(argv[0]!, argv.slice(1)).status === 0
  const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))

  it.live.skipIf(process.platform !== "linux" || !can(["nix", "--version"]) || !can(["strace", "-V"]))(
    "finds nix under strace and says it waits for the daemon while the daemon builds what it imports",
    () =>
      Effect.gen(function*() {
        const dir = mkdtempSync(join(tmpdir(), "calder-heartbeat-"))
        // An import from a derivation that takes a few seconds to build: nix eval waits on the daemon meanwhile.
        writeFileSync(join(dir, "flake.nix"), `{
          outputs = _: {
            waits = import (derivation {
              name = "calder-heartbeat-${randomBytes(6).toString("hex")}";
              system = "${system}";
              preferLocalBuild = true;
              allowSubstitutes = false;
              builder = "/bin/sh";
              args = [ "-c" "i=0; while [ $i -lt 1000000 ]; do i=$((i+1)); done; echo 'derivation { name = \\"waited\\"; system = \\"${system}\\"; builder = \\"/bin/sh\\"; }' > $out" ];
            });
          };
        }`)
        const meta = JSON.parse(yield* Exec.run(["nix", "flake", "metadata", "--json", `path:${dir}`])) as {
          readonly url: string
          readonly path: string
          readonly locked: { readonly narHash: string }
        }
        const recorder = {
          source: meta.path, url: meta.url, revision: "1", at: Footprint.tree([]), marks: [], pinned: new Set<string>(),
          context: "nix", nonce: "5eed", narHash: meta.locked.narHash, read: () => Effect.succeed(new Map<string, string>()),
        }
        const logged: Array<string> = []
        const log = (text: string) => Effect.sync(() => void logged.push(text))
        const { derivations: result } = yield* derivations({ flake: meta.url } as RunInfo, ["waits"], undefined, log, jobMemory(), {
          recorder,
          heartbeat: { first: "300 millis", every: "300 millis" },
        })
        expect(result.get("waits")?.drv).toMatch(/-waited\.drv$/)
        const beats = logged.filter((line) => line.startsWith("Still evaluating"))
        expect(beats.length).toBeGreaterThan(0)
        // A line from while the daemon builds: before, it may still add the flake's source or set the build up.
        const building = beats.find((line) => line.includes("waits for the Nix daemon") && line.includes("Nix has been building"))
        expect(building, logged.join("\n")).toMatch(new RegExp(
          "^Still evaluating after \\d+ s, at attribute 1 of 1, waits\\. Nix holds [\\d.]+ GiB.*" +
            "Its main thread waits for the Nix daemon \\(unix_\\w+\\)\\. " +
            `The last file it opened is ${meta.path}/.*` +
            "Nix has been building '/nix/store/\\w{32}-calder-heartbeat-\\w+\\.drv' for \\d+ s\\..*" +
            "In the last \\d+ s, Nix used [\\d.]+ s of CPU",
        ))
      }).pipe(Effect.provide(processes)),
    60_000,
  )
})
