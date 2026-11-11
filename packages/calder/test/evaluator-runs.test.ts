import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { vi } from "vitest"
import type { Job, JobResult, PlannedStep } from "../src/Protocol.ts"
import { RunsCore } from "../src/controller/Runs.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const derivation = (name: string) => ({ drv: `/nix/store/00000000000000000000000000000000-${name}.drv`, out: `/nix/store/00000000000000000000000000000000-${name}`, system: "aarch64-linux" })
const deferred = (name: string): PlannedStep => ({
  ...step,
  name,
  kind: "build",
  needs: [],
  detail: `checks.aarch64-linux.${name}`,
  build: { attr: `checks.aarch64-linux.${name}`, drv: null, out: null, system: null },
})
/** What an evaluation of `srv-1` returns, with the footprint it recorded. */
const evaluated: JobResult = {
  _tag: "Evaluated",
  derivations: { "srv-1": derivation("srv-1") },
  tooLarge: {},
  uses: {},
  recorded: {
    footprints: [{ id: "1", revision: "a".repeat(40), entries: [["flake.nix", "blob"]] }],
    evaluations: [{ attr: "checks.aarch64-linux.srv-1", footprint: "1", count: 1, digest: "d", derivation: derivation("srv-1") }],
  },
} as unknown as JobResult
const pullRequest = { _tag: "PullRequest", number: 7, head: "feature", base: "main", fork: false } as const

describe("evaluating a run's builds with an evaluator agent connected", () => {
  it.live("goes to the agent for a trusted run, whose derivations then build here", () =>
    Effect.gen(function*() {
      let sent: Extract<Job, { _tag: "Step" }> | undefined
      const { status, jobs, evaluations } = yield* drive({
        steps: [deferred("srv-1")],
        evaluator: true,
        valid: () => true,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          sent = job
          return evaluated
        },
      })
      expect(status).toBe("passed")
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(jobs).toEqual(["srv-1 evaluates", "srv-1"])
      // The flake's forge inputs come from the controller's mirrors, through its git endpoint.
      expect(sent?.run.mirrors).toEqual({ "ssh://git@gitea.test/schnau/lib.git": "http://calder.test/git/lib.git" })
      expect(sent?.run.mirror).toBe("http://calder.test/git/app.git")
    }))

  it.live("goes to the agent for a same-repo pull request, whose records then count for trusted runs", () =>
    Effect.gen(function*() {
      const { evaluations, records, trusted } = yield* drive({
        steps: [deferred("srv-1")],
        event: pullRequest,
        evaluator: true,
        valid: () => true,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(records).toEqual([{ attr: "checks.aarch64-linux.srv-1", trust: "trusted" }])
      // The push run after the merge, of the same tree, takes it instead of evaluating again.
      expect(trusted?.evaluations.map((e) => e.attr)).toEqual(["checks.aarch64-linux.srv-1"])
    }))

  it.live("stays in the forks' sandbox for a fork's pull request, whose records count for none but pull requests", () =>
    Effect.gen(function*() {
      const { evaluations, jobs, pools } = yield* drive({
        steps: [deferred("srv-1")],
        event: { ...pullRequest, fork: true },
        evaluator: true,
        valid: () => true,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(evaluations).toEqual([])
      expect(jobs[0]).toBe("srv-1 evaluates")
      expect(pools.get("srv-1")).toBe("fork")
    }))

  it.live("keeps a same-repo pull request's records its own when it evaluated here", () =>
    Effect.gen(function*() {
      const { records } = yield* drive({
        steps: [deferred("srv-1")],
        event: pullRequest,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(records).toEqual([{ attr: "checks.aarch64-linux.srv-1", trust: "pr" }])
    }))

  it.live("evaluates here when the agent's derivations didn't reach this store", () =>
    Effect.gen(function*() {
      const { status, jobs, evaluations, records } = yield* drive({
        steps: [deferred("srv-1")],
        evaluator: true,
        valid: () => false,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(status).toBe("passed")
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(jobs).toEqual(["srv-1 evaluates", "srv-1 evaluates", "srv-1"])
      // The local evaluation's records are the run's: a push to main is trusted either way.
      expect(records.map((r) => r.trust)).toEqual(["trusted"])
    }))

  it.live("evaluates here when the agent's evaluation died", () =>
    Effect.gen(function*() {
      let tries = 0
      const { status, jobs } = yield* drive({
        steps: [deferred("srv-1")],
        event: pullRequest,
        evaluator: true,
        valid: () => true,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          tries++
          return tries === 1 ? { _tag: "Died", message: "pushing the derivations to the controller's store failed" } : evaluated
        },
      })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["srv-1 evaluates", "srv-1 evaluates", "srv-1"])
    }))

  it.live("never starts for a plan with an attribute path that could be Nix code", () =>
    Effect.gen(function*() {
      const injected = { ...deferred("srv-1"), build: { attr: 'checks.aarch64-linux.srv-1 or { drvPath = "/nix/store/forged.drv"; }', drv: null, out: null, system: null } }
      const { status, jobs } = yield* drive({ steps: [injected], unplanned: true, event: pullRequest, evaluator: true })
      expect(status).toBe("errored")
      expect(jobs).toEqual(["plan"])
    }))

  it.live("evaluates here what the agent couldn't, such as an import from another system's build, and keeps each part's trust", () =>
    Effect.gen(function*() {
      const asked: Array<{ readonly where: string; readonly builds: ReadonlyArray<string>; readonly planned: ReadonlyArray<string> }> = []
      const { status, jobs, evaluations, records, steps } = yield* drive({
        steps: [deferred("srv-1"), deferred("mbp"), deferred("throws")],
        event: pullRequest,
        evaluator: true,
        valid: () => true,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          const where = job.run.flake === "" ? "agent" : "here"
          asked.push({ where, builds: job.evaluate.builds.map((b) => b.name), planned: job.evaluate.planned.map((p) => p.name) })
          const recorded = (attr: string) => ({
            footprints: [{ id: "1", revision: "a".repeat(40), entries: [["flake.nix", "read"] as const] }],
            evaluations: [{ attr, footprint: "1", count: 1, digest: "d", derivation: null }],
          })
          return where === "agent"
            ? { _tag: "Evaluated", derivations: { "srv-1": derivation("srv-1"), mbp: null, throws: null }, tooLarge: {}, uses: {},
              errors: { mbp: "a 'aarch64-darwin' with features {} is required to build it" }, recorded: recorded("checks.aarch64-linux.srv-1") }
            : { _tag: "Evaluated", derivations: { mbp: derivation("mbp") }, tooLarge: {}, uses: { mbp: ["srv-1"] }, recorded: recorded("checks.aarch64-linux.mbp") }
        },
      })
      // The build that threw, which tryEval caught on the agent, isn't evaluated again with the others.
      expect(status).toBe("failed")
      expect(steps.get("throws")?.status).toBe("failed")
      expect(asked).toEqual([
        { where: "agent", builds: ["srv-1", "mbp", "throws"], planned: [] },
        { where: "here", builds: ["mbp"], planned: ["srv-1"] },
        // Its step then evaluates it alone, here, as any build left without a derivation does.
        { where: "here", builds: ["throws"], planned: [] },
      ])
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(jobs.filter((j) => !j.endsWith("evaluates")).sort()).toEqual(["mbp", "srv-1"])
      expect(steps.get("throws")?.error?.tag).toBe("EvaluationFailed")
      expect(steps.get("mbp")?.needs).toEqual(["srv-1"])
      // The fake's evaluations here all record mbp, the alone one of `throws` too.
      expect(records).toEqual([
        { attr: "checks.aarch64-linux.srv-1", trust: "trusted" },
        { attr: "checks.aarch64-linux.mbp", trust: "pr" },
        { attr: "checks.aarch64-linux.mbp", trust: "pr" },
      ])
    }))

  it.live("evaluates a build alone here, not on the agent, once evaluating them together failed", () =>
    Effect.gen(function*() {
      let tries = 0
      const { status, evaluations, jobs } = yield* drive({
        steps: [deferred("srv-1")],
        evaluator: true,
        valid: () => true,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          tries++
          // Together, on the agent and here, twice, it fails; alone it evaluates.
          return job.run.flake === "" || tries <= 4
            ? { _tag: "Died", message: "out of memory" }
            : evaluated
        },
      })
      expect(status).toBe("passed")
      expect(evaluations).toEqual(["srv-1 evaluates", "srv-1 evaluates"])
      expect(jobs).toEqual(["srv-1 evaluates", "srv-1 evaluates", "srv-1 evaluates", "srv-1 evaluates", "srv-1 evaluates", "srv-1"])
    }))

  it.live("of a superseded run stops on the agent at once, and nothing evaluates it here instead", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let stopped = false
      let first = true
      const { status, jobs, evaluations, steps } = yield* drive({
        steps: [deferred("srv-1")],
        evaluator: true,
        valid: () => true,
        work: () => {
          if (!first) return Effect.void
          first = false
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => void (stopped = true))))
        },
        meanwhile: Effect.gen(function*() {
          yield* Deferred.await(started)
          yield* (yield* RunsCore).supersede("app-2", "superseded by #3")
        }),
      })
      expect(status).toBe("cancelled")
      expect(stopped).toBe(true)
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(jobs).toEqual(["srv-1 evaluates"])
      expect(steps.get("srv-1")?.status).toBe("cancelled")
    }))

  it.live("goes on in the local worker a restart left running, whose records stay the pull request's, with an evaluator connected since", () =>
    Effect.gen(function*() {
      const { status, jobs, evaluations, records } = yield* drive({
        steps: [deferred("srv-1")],
        event: pullRequest,
        evaluator: true,
        adoptedEvaluations: ["srv-1"],
        valid: () => true,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(status).toBe("passed")
      expect(evaluations).toEqual([])
      expect(jobs).toEqual(["srv-1 evaluates (adopted)", "srv-1"])
      expect(records).toEqual([{ attr: "checks.aarch64-linux.srv-1", trust: "pr" }])
    }))

  it.live("stays here when a derivation of the plan the agent would get isn't a store path", () =>
    Effect.gen(function*() {
      const planned: PlannedStep = {
        ...step,
        name: "lib",
        kind: "build",
        needs: [],
        detail: "checks.aarch64-linux.lib",
        build: { attr: "checks.aarch64-linux.lib", drv: "--option-builders.drv", out: "/nix/store/lib", system: "aarch64-linux" },
      }
      const { evaluations, jobs } = yield* drive({
        steps: [planned, deferred("srv-1")],
        evaluator: true,
        valid: () => true,
        result: (_step, job) => (job.evaluate === undefined ? undefined : evaluated),
      })
      expect(evaluations).toEqual([])
      expect(jobs).toContain("srv-1 evaluates")
    }))

  it.live("drops an agent's evaluation that reports an option for a derivation, which never reaches a Nix command", () =>
    Effect.gen(function*() {
      const { evaluations, jobs, commands, steps } = yield* drive({
        steps: [deferred("srv-1"), deferred("evil")],
        event: pullRequest,
        evaluator: true,
        valid: () => true,
        result: (_step, job) => {
          if (job.evaluate === undefined) return undefined
          // The agent's: what a flake whose drvPath is an option made it report.
          if (job.run.flake === "") {
            return { _tag: "Evaluated", derivations: { "srv-1": derivation("srv-1"), evil: { drv: "--plugin-files", out: "/nix/store/x/evil.so", system: "" } }, tooLarge: {}, uses: {} }
          }
          // This host's, sanitized too.
          return { _tag: "Evaluated", derivations: { "srv-1": derivation("srv-1"), evil: { drv: "--plugin-files", out: "", system: "" } }, tooLarge: {}, uses: {} }
        },
      })
      expect(evaluations).toEqual(["srv-1 evaluates"])
      expect(jobs[1]).toBe("srv-1 evaluates")
      expect(steps.get("evil")?.status).toBe("failed")
      expect(commands.flat().filter((arg) => arg.startsWith("--plugin") || arg.includes("evil.so"))).toEqual([])
    }))

  it.live("never takes a build's output that isn't a store path as built, since nix-store asked about nothing says yes", () =>
    Effect.gen(function*() {
      const odd: PlannedStep = { ...deferred("srv-1"), build: { attr: "checks.aarch64-linux.srv-1", drv: derivation("srv-1").drv, out: "--x", system: "aarch64-linux" } }
      const { jobs, commands, steps } = yield* drive({ steps: [odd], value: () => derivation("srv-1").out })
      expect(commands.filter((c) => c[0] === "nix-store" && c.length === 2)).toEqual([])
      expect(jobs).toEqual(["srv-1"])
      expect(steps.get("srv-1")?.status).toBe("passed")
    }))
})

