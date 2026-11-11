import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Event, Flake, Nix } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Job as JobSpec } from "../src/Protocol.ts"
import { Job } from "../src/worker/Client.ts"
import * as Steps from "../src/worker/Steps.ts"

const processes = BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]))
const self = { emit: () => Effect.void, log: () => Effect.void, redact: (text: string) => text } as unknown as Job["Service"]
const drv = "/nix/store/00000000000000000000000000000000-app.drv"
const job = {
  run: { id: "app-1", project: "app", revision: "a".repeat(40), event: Event.push("main"), flake: "git+file:///mirror?rev=a" },
  derivation: drv,
} as unknown as Extract<JobSpec, { _tag: "Step" }>
const app = Nix.build(Flake.attr("packages.x86_64-linux.app"), { name: "app" })

describe("a build whose derivation the store lost", () => {
  it.live("evaluates its attribute again and builds once more", () =>
    Effect.gen(function*() {
      const bin = mkdtempSync(join(tmpdir(), "calder-lost-"))
      // Nix as srv-2's had it after its garbage collector deleted the plan's derivation: the build
      // can't find it until an evaluation writes it back.
      writeFileSync(
        join(bin, "nix"),
        `#!/usr/bin/env bash
echo "$1" >> ${bin}/calls
if [ "$1" = eval ]; then touch ${bin}/evaluated; printf '%s' ${drv}; exit 0; fi
if [ ! -e ${bin}/evaluated ]; then
  echo "@nix {\\"action\\":\\"msg\\",\\"level\\":0,\\"msg\\":\\"error: failed to obtain derivation of '${drv}'\\"}" >&2
  exit 1
fi
echo /nix/store/00000000000000000000000000000000-app
`,
        { mode: 0o755 },
      )
      const path = process.env.PATH
      process.env.PATH = `${bin}:${path}`
      const result = yield* Steps.build(job, app, "packages.x86_64-linux.app").pipe(
        Effect.provideService(Job, self),
        Effect.provide(processes),
        Effect.ensuring(Effect.sync(() => void (process.env.PATH = path))),
      )
      expect(result._tag).toBe("Passed")
      expect(readFileSync(join(bin, "calls"), "utf8")).toBe("build\neval\nbuild\n")
    }))
})

describe("a build that couldn't reach its builder", () => {
  it.live("fails as an infrastructure failure, naming the builder", () =>
    Effect.gen(function*() {
      const bin = mkdtempSync(join(tmpdir(), "calder-ssh-"))
      // Nix as srv-2's had it in infra-887, when the SSH connection to the Mac builder dropped.
      writeFileSync(
        join(bin, "nix"),
        `#!/usr/bin/env bash
echo "@nix {\\"action\\":\\"msg\\",\\"level\\":0,\\"msg\\":\\"cannot build on 'ssh-ng://hauke@100.83.228.36': error: failed to start SSH connection to '100.83.228.36'\\"}" >&2
echo "@nix {\\"action\\":\\"msg\\",\\"level\\":0,\\"msg\\":\\"error: Cannot build '${drv}'. Reason: platform mismatch\\"}" >&2
exit 1
`,
        { mode: 0o755 },
      )
      const path = process.env.PATH
      process.env.PATH = `${bin}:${path}`
      const result = yield* Steps.build(job, app, "packages.x86_64-linux.app").pipe(
        Effect.provideService(Job, self),
        Effect.provide(processes),
        Effect.ensuring(Effect.sync(() => void (process.env.PATH = path))),
      )
      expect(result._tag).toBe("Failed")
      expect(result._tag === "Failed" ? [result.tag, result.message] : null).toEqual([
        "Infrastructure",
        "nix build packages.x86_64-linux.app failed: the builder 100.83.228.36 could not be reached: failed to start SSH connection",
      ])
    }))
})

const fakeNix = (script: string) =>
  Effect.gen(function*() {
    const bin = mkdtempSync(join(tmpdir(), "calder-nix-"))
    writeFileSync(join(bin, "nix"), `#!/usr/bin/env bash\n${script}`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    return yield* Steps.build(job, app, "packages.x86_64-linux.app").pipe(
      Effect.provideService(Job, self),
      Effect.provide(processes),
      Effect.ensuring(Effect.sync(() => void (process.env.PATH = path))),
    )
  })
/** A line of Nix's internal JSON log on stderr. */
const nixLine = (json: object) => `echo '@nix ${JSON.stringify(json)}' >&2`

describe("a build that failed for real", () => {
  it.live("isn't an infrastructure failure because its own log mentions a lost connection", () =>
    Effect.gen(function*() {
      // A VM test that printed "Broken pipe" and then timed out.
      const result = yield* fakeNix([
        nixLine({ action: "result", id: 1, type: 101, fields: ["vm: write: Broken pipe"] }),
        nixLine({ action: "msg", level: 0, msg: `error: Cannot build '${drv}'.\n       Reason: 1 dependency failed.` }),
        "exit 1",
      ].join("\n"))
      expect(result._tag === "Failed" ? result.tag : result._tag).toBe("BuildFailed")
      const timedOut = yield* fakeNix([
        nixLine({ action: "result", id: 1, type: 101, fields: ["vm: write: Broken pipe"] }),
        nixLine({ action: "msg", level: 0, msg: "error: timed out after 3600 seconds" }),
        "exit 1",
      ].join("\n"))
      expect(timedOut._tag === "Failed" ? timedOut.tag : timedOut._tag).toBe("BuildFailed")
    }))

  it.live("isn't an infrastructure failure when evaluating a lost derivation again gives another one", () =>
    Effect.gen(function*() {
      const result = yield* fakeNix([
        `if [ "$1" = eval ]; then printf '%s' /nix/store/11111111111111111111111111111111-app.drv; exit 0; fi`,
        nixLine({ action: "msg", level: 0, msg: `error: failed to obtain derivation of '${drv}'` }),
        "exit 1",
      ].join("\n"))
      expect(result._tag === "Failed" ? result.tag : result._tag).toBe("BuildFailed")
    }))
})
