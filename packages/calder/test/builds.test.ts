import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { vi } from "vitest"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const build = (name: string, system: string): PlannedStep => ({
  ...step,
  name,
  kind: "build",
  needs: [],
  detail: `checks.${system}.${name}`,
  build: { attr: `checks.${system}.${name}`, drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system },
})

describe("builds", () => {
  it.live("a build for another system doesn't hold the slot this host's builds need", () =>
    Effect.gen(function*() {
      // The test config has one build slot. The darwin build waits for its remote builder until the linux one ran.
      const linuxRan = yield* Deferred.make<void>()
      const { status, jobs } = yield* drive({
        steps: [build("darwin", "aarch64-darwin"), build("linux", "x86_64-linux")],
        work: (name) => (name === "darwin" ? Deferred.await(linuxRan) : Deferred.succeed(linuxRan, undefined)),
      })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["darwin", "linux"])
    }))

  it.live("evaluates the builds its plan left unevaluated once, then builds each where its system builds and reuses what exists", () =>
    Effect.gen(function*() {
      // Each other build of the run waits for the first one's evaluation; none evaluates the flake itself.
      const deferred = (name: string, system: string | null = null): PlannedStep => ({
        ...build(name, "x86_64-linux"),
        build: { attr: `checks.x86_64-linux.${name}`, drv: null, out: null, system },
      })
      const derivation = (name: string, system = "x86_64-linux") => ({ drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system })
      const asked: Array<unknown> = []
      const { status, jobs, steps, plan } = yield* drive({
        steps: [
          deferred("lib"), deferred("app"), deferred("docs"), deferred("huge"), deferred("mac", "aarch64-darwin"), build("planned", "x86_64-linux"),
          { ...step, name: "ship", kind: "action", needs: ["app"], detail: "ship", action: { deploy: false, secrets: [], preview: true } },
        ],
        // The order the plan would have evaluated them in.
        plan: { deferred: ["mac", "lib", "app", "docs", "huge"].map((name) => `checks.x86_64-linux.${name}`) },
        cache: { has: (out) => Effect.succeed(out === "/nix/store/docs"), publish: () => Effect.void },
        value: (name) => `/nix/store/${name}`,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          asked.push(job.evaluate)
          return {
            _tag: "Evaluated",
            derivations: { lib: derivation("lib"), app: derivation("app"), docs: derivation("docs"), huge: null, mac: derivation("mac", "aarch64-darwin") },
            tooLarge: { huge: "Evaluating huge alone took more than 3.0 GiB" },
            // `planned` using `app`, which uses it, would close a cycle.
            uses: { app: ["lib", "planned"], planned: ["app"] },
          }
        },
      })
      expect(status).toBe("failed")
      expect(asked).toEqual([{
        builds: ["mac", "lib", "app", "docs", "huge"].map((name) => ({ name, attr: `checks.x86_64-linux.${name}` })),
        planned: [{ name: "planned", drv: "/nix/store/planned.drv" }],
      }])
      expect(jobs.filter((j) => j.endsWith("evaluates"))).toHaveLength(1)
      // The output that exists is reused, the build too large to evaluate fails without a job, and a build
      // waits for the builds it uses.
      expect(steps.get("docs")).toMatchObject({ status: "reused" })
      expect(steps.get("huge")).toMatchObject({ status: "failed", error: { tag: "TooLarge" } })
      expect(jobs).not.toContain("huge")
      expect(jobs.indexOf("app")).toBeGreaterThan(Math.max(jobs.indexOf("lib"), jobs.indexOf("planned")))
      expect(steps.get("app")?.needs).toEqual(["lib", "planned"])
      expect(steps.get("planned")?.needs).toEqual([])
      // What the deploy now waits for through `app` is on its critical path.
      expect(steps.get("lib")?.critical).toBe(true)
      expect(steps.get("docs")?.critical).toBe(false)
      // Later plans of the same tree find every build's derivation.
      expect(plan.derivations).toMatchObject({ "checks.x86_64-linux.mac": derivation("mac", "aarch64-darwin") })
    }))

  it.live("tries evaluating the builds together once more, then evaluates each attribute on its own", () =>
    Effect.gen(function*() {
      const derivations: Array<string | null> = []
      const { status, jobs } = yield* drive({
        steps: ["a", "b"].map((name) => ({ ...build(name, "x86_64-linux"), build: { attr: name, drv: null, out: null, system: null } })),
        result: (_step, job) => {
          if (job.evaluate !== undefined) return { _tag: "Died", message: "error: flake.nix:1: syntax error" }
          derivations.push(job.derivation)
          return undefined
        },
      })
      expect(status).toBe("passed")
      expect(jobs.filter((j) => j.endsWith("evaluates"))).toHaveLength(2)
      // Without a derivation, each build's job evaluates its attribute alone (Steps.ts `evaluateAlone`).
      expect(derivations).toEqual([null, null])
    }))
})
