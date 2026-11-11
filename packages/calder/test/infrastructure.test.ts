import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { Calder } from "@calder-ci/core"
import { SqlClient } from "effect/sql"
import type { JobResult, PlannedStep } from "../src/Protocol.ts"
import * as Values from "../src/Values.ts"
import { infrastructure } from "../src/worker/BuildFailure.ts"
import * as Workflow from "../src/controller/Workflow.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

describe("an infrastructure failure of a build", () => {
  it("is a dropped SSH connection to a remote builder", () => {
    // infra-887's m1 build.
    expect(infrastructure([
      "created 0 symlinks in user environment",
      "cannot build on 'ssh-ng://haukeschnau@100.83.228.36?remote-program=/run/current-system/sw/bin/nix-builder-admitted': error: failed to start SSH connection to '100.83.228.36'",
      "Failed to find a machine for remote build!",
      "error: Cannot build '/nix/store/hszhn7fsm1466f5l12z86j5cg9gnrwr9-system-path.drv'.\n       Reason: platform mismatch",
      "error: Cannot build '/nix/store/jxiqv3hmbv9faavc229rbhixi0zvh8r1-darwin-system-26.11.ff0e21a.drv'.\n       Reason: 1 dependency failed.",
    ])).toBe("the builder 100.83.228.36 could not be reached: failed to start SSH connection")
  })

  it("is a derivation the store lost", () => {
    // infra-909's mbp build, after srv-2's garbage collector deleted its derivation.
    const drv = "/nix/store/lnzag4r77ibzyc7xxvqmk2yd8qbd791a-darwin-system-26.11.ff0e21a.drv"
    expect(infrastructure([
      "don't know how to build these paths:",
      `error: failed to obtain derivation of '${drv}'`,
    ])).toBe(`the store lost ${drv}`)
  })

  it("is a builder whose host refuses connections", () => {
    expect(infrastructure(["ssh: connect to host tower port 22: Connection refused", "error: unexpected end-of-file"]))
      .toBe("the builder tower could not be reached: Connection refused")
  })

  it("is a dropped SSH connection beside a binary cache that timed out", () => {
    expect(infrastructure([
      "warning: error: unable to download 'https://cache.nixos.org/x.narinfo': Timeout was reached (28) Operation timed out after 30001 milliseconds with 0 bytes received",
      "cannot build on 'ssh-ng://haukeschnau@100.83.228.36': error: failed to start SSH connection to '100.83.228.36'",
    ])).toBe("the builder 100.83.228.36 could not be reached: failed to start SSH connection")
  })

  it("is a builder's connection that dropped in the middle of the build", () => {
    // calder-672's sleeper on the Mac builder, whose SSH connection from srv-2 was killed 20 s in.
    expect(infrastructure([
      "this derivation will be built:",
      "these 25 paths will be fetched (9.3 MiB download, 49.8 MiB unpacked):",
      "error: Nix daemon disconnected unexpectedly (maybe it crashed?)",
      "error: Cannot build '/nix/store/2i46gkrrwr08pxp6bf2y0b0jym5b5arg-calder-demo-sleeper-a11faf1c.drv'.\n       Reason: builder failed with exit code 1.",
    ])).toBe("Nix lost its connection to a Nix daemon, its own or a builder's, in the middle of the build")
    // A derivation that failed for real on the builder says so, also when another connection dropped beside it.
    expect(infrastructure([
      "error: build of '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tests.drv' on 'ssh-ng://haukeschnau@100.83.228.36' failed: Cannot build '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tests.drv'.\n       Reason: builder failed with exit code 2.",
      "error: Nix daemon disconnected unexpectedly (maybe it crashed?)",
      "error: Cannot build '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tests.drv'.\n       Reason: builder failed with exit code 1.",
    ])).toBe(null)
  })

  it("isn't a derivation that failed to build, even with an unreachable builder beside it", () => {
    expect(infrastructure([
      "cannot build on 'ssh-ng://haukeschnau@100.83.228.36': error: failed to start SSH connection to '100.83.228.36'",
      "error: builder for '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tests.drv' failed with exit code 1",
      "error: Cannot build '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tests.drv'.\n       Reason: builder failed with exit code 1.",
    ])).toBe(null)
    expect(infrastructure(["error: Cannot build '/nix/store/x.drv'.\n       Reason: 1 dependency failed."])).toBe(null)
  })

  it("isn't a build that timed out or left a cycle or a reference out, whatever else Nix said", () => {
    for (const failure of ["timed out after 3600 seconds", "cycle detected in build of '/nix/store/x.drv' in the references of output 'out'",
      "no output reference for 'dev' in build of '/nix/store/x.drv'"]) {
      expect(infrastructure(["Connection closed by 10.0.0.1 port 22", `error: ${failure}`])).toBe(null)
    }
  })
})

const drv = "/nix/store/00000000000000000000000000000000-m1.drv"
const shell = "/nix/store/11111111111111111111111111111111-shell.drv"
const m1: PlannedStep = {
  ...step,
  name: "m1",
  kind: "build",
  needs: [],
  detail: "checks.aarch64-darwin.m1",
  build: { attr: "checks.aarch64-darwin.m1", drv, out: "/nix/store/00000000000000000000000000000000-m1", system: "aarch64-darwin" },
}
const cause = "the builder 100.83.228.36 could not be reached: failed to start SSH connection"
// As the worker sends it (Steps.ts `toResult`).
const unreachable: JobResult = {
  _tag: "Failed",
  tag: "Infrastructure",
  message: `nix build checks.aarch64-darwin.m1 failed: ${cause}`,
  error: Values.encode(new Calder.Infrastructure({ attr: "checks.aarch64-darwin.m1", drv, cause })),
  key: drv,
}

describe("a build that failed for an infrastructure reason", () => {
  it.live("runs again and passes", () =>
    Effect.gen(function*() {
      let tries = 0
      const { status, jobs, steps } = yield* drive({
        steps: [m1],
        value: () => "/nix/store/00000000000000000000000000000000-m1",
        result: () => (++tries === 1 ? unreachable : undefined),
      })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["m1", "m1"])
      expect(steps.get("m1")?.attempts).toBe(2)
    }))

  it.live("fails as an infrastructure failure once its last attempt failed the same way", () =>
    Effect.gen(function*() {
      const { status, jobs, steps } = yield* drive({ steps: [m1], result: () => unreachable })
      expect(status).toBe("failed")
      expect(jobs).toEqual(["m1", "m1", "m1"])
      const failed = steps.get("m1")!
      expect(failed.attempts).toBe(3)
      expect(failed.error?.tag).toBe("Infrastructure")
      expect(failed.error?.excerpt).toContain(`\n${cause}; an infrastructure failure, so it runs again in`)
      expect(failed.error?.excerpt).toContain("(attempt 3 of 3)")
    }))

  it.live("goes on from the attempt it waited for when the controller restarted", () =>
    Effect.gen(function*() {
      const { status, jobs, steps } = yield* drive({
        steps: [m1],
        result: () => unreachable,
        resume: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`update steps set status = 'queued', attempts = 3, waiting = ${`another attempt after an infrastructure failure: ${cause}`}
            where run_id = 'app-2' and name = 'm1'`
        }),
      })
      expect(status).toBe("failed")
      expect(jobs).toEqual(["m1"])
      expect(steps.get("m1")?.attempts).toBe(3)
    }))

  it.live("goes on from the attempt it ran when the controller restarted", () =>
    Effect.gen(function*() {
      const { status, jobs, steps } = yield* drive({
        steps: [m1],
        result: () => unreachable,
        resume: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`update steps set status = 'running', attempts = 2 where run_id = 'app-2' and name = 'm1'`
        }),
      })
      expect(status).toBe("failed")
      expect(jobs).toEqual(["m1", "m1"])
      expect(steps.get("m1")?.attempts).toBe(3)
    }))

  it.live("gets all its attempts again when a rerun runs it again in place", () =>
    Effect.gen(function*() {
      const { status, jobs, steps } = yield* drive({
        steps: [m1],
        result: () => unreachable,
        meanwhile: Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const ended = sql<{ status: string }>`select status from runs where id = 'app-2'`.pipe(Effect.map((rows) => rows[0]?.status), Effect.orDie)
          yield* ended.pipe(Effect.repeat({ until: (s) => s === "failed", schedule: Schedule.spaced("10 millis") }))
          yield* (yield* Workflow.Runs).rerun("app-2").pipe(Effect.orDie)
        }),
      })
      expect(status).toBe("failed")
      expect(jobs).toEqual(["m1", "m1", "m1", "m1", "m1", "m1"])
      expect(steps.get("m1")?.attempts).toBe(3)
    }))

  it.live("a build that failed for real runs once", () =>
    Effect.gen(function*() {
      const { status, jobs } = yield* drive({
        steps: [m1],
        result: () => ({ _tag: "Failed", tag: "BuildFailed", message: "nix build checks.aarch64-darwin.m1 failed", error: null, key: drv }),
      })
      expect(status).toBe("failed")
      expect(jobs).toEqual(["m1"])
    }))
})

describe("a run's derivations", () => {
  it.live("are rooted once its plan is stored, and unrooted when it ends", () =>
    Effect.gen(function*() {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-roots-"))
      const roots = join(stateDir, "derivations", "app-2")
      // A run that ended while the controller was down left its roots behind.
      const stale = join(stateDir, "derivations", "app-0")
      const nix: Array<ReadonlyArray<string>> = []
      let rootedWhileBuilding = false
      const { status } = yield* drive({
        steps: [m1],
        unplanned: true,
        plan: { derivations: { "devShells.x86_64-linux.default": { drv: shell, out: "/nix/store/11111111111111111111111111111111-shell", system: "x86_64-linux" } } },
        stateDir,
        nix,
        seed: Effect.sync(() => void mkdirSync(stale, { recursive: true })),
        work: () => Effect.sync(() => void (rootedWhileBuilding = existsSync(roots))),
      })
      expect(status).toBe("passed")
      const built = nix.filter((args) => args.includes("build") && args.includes("--out-link"))
      expect(built[0]?.slice(-2)).toEqual([drv, shell])
      expect(built[0]?.[built[0].indexOf("--out-link") + 1]?.startsWith(roots)).toBe(true)
      expect(rootedWhileBuilding).toBe(true)
      expect(existsSync(roots)).toBe(false)
      expect(existsSync(stale)).toBe(false)
    }))
})
