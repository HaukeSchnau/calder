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
const job = {
  run: { id: "app-1", project: "app", revision: "a".repeat(40), event: Event.push("main") },
  derivation: "/nix/store/00000000000000000000000000000000-app.drv",
} as unknown as Extract<JobSpec, { _tag: "Step" }>
const app = Nix.build(Flake.attr("packages.x86_64-linux.app"), { name: "app" })

describe("a job's commands", () => {
  it.live("see the worker's environment as it is when they start, not as it was when Steps.ts loaded", () =>
    Effect.gen(function*() {
      const bin = mkdtempSync(join(tmpdir(), "calder-env-"))
      writeFileSync(
        join(bin, "nix"),
        `#!/usr/bin/env bash\nprintf '%s' "$HTTPS_PROXY" > ${bin}/seen\necho /nix/store/00000000000000000000000000000000-app\n`,
        { mode: 0o755 },
      )
      // As Main.run sets the egress proxy and the mirrors' redirects once the worker has its job.
      const before = { PATH: process.env.PATH, HTTPS_PROXY: process.env.HTTPS_PROXY }
      process.env.PATH = `${bin}:${process.env.PATH}`
      process.env.HTTPS_PROXY = "http://127.0.0.1:3128"
      const result = yield* Steps.build(job, app, "packages.x86_64-linux.app").pipe(
        Effect.provideService(Job, self),
        Effect.provide(processes),
        Effect.ensuring(Effect.sync(() => Object.assign(process.env, before))),
      )
      expect(result._tag).toBe("Passed")
      expect(readFileSync(join(bin, "seen"), "utf8")).toBe("http://127.0.0.1:3128")
    }))
})
