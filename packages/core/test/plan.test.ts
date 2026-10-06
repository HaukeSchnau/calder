import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { Action, Event, Files, Kiln, Nix, On, Setup, Step, Task, cmd } from "../src/index.ts"
import { comment, flake, gate, preview, project, promote, qa, release, smoke } from "./fixtures.ts"

const names = (plan: Kiln.Plan) => plan.steps.map((s) => s.name)

describe("Kiln.plan", () => {
  it.effect("pull requests never deploy", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(project, Event.pullRequest({ number: 57 }))
      expect(plan.trust).toBe("pr")
      expect(plan.reuse).toBe("all")
      expect(plan.runs(qa)).toBe(true)
      expect(plan.runs(promote)).toBe(false)
      expect(names(plan).sort()).toEqual(["comment", "gate", "preview", "qa", "release", "smoke"])
    }))

  it.effect("the deploy needs the release and waits for the checks", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(project, Event.push("main"))
      expect(plan.trust).toBe("trusted")
      expect(plan.reuse).toBe("builds")
      expect(plan.needs(promote)).toEqual([release])
      expect(plan.waitsFor(promote)).toEqual(expect.arrayContaining([qa, gate]))
      expect(names(plan).indexOf("promote")).toBe(names(plan).length - 1)
    }))

  it.effect("branch protection adds required checks to steps with grants", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(project, Event.push("main"), { requiredChecks: ["kiln/smoke"] })
      expect(plan.get(promote)?.required).toEqual(["smoke"])
      expect(plan.runs(smoke)).toBe(true)
      expect(plan.runs(preview)).toBe(true)
    }))

  it.effect("required checks Kiln doesn't report are a plan error", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Kiln.plan(project, Event.push("main"), { requiredChecks: ["CI / lint (pull_request)"] }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("required checks must be kiln/<step>")
    }))

  it.effect("tasks downstream of an action are never reused", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(project, Event.pullRequest({ number: 1 }))
      expect(plan.get(smoke)?.neverReuse).toBe(true)
      expect(plan.get(qa)?.neverReuse).toBe(false)
      expect(plan.get(comment)?.exits).toEqual(["qa"])
    }))

  it.effect("schedules and manual runs", () =>
    Effect.gen(function*() {
      const nightly = yield* Kiln.plan(project, Event.schedule("0 3 * * *"))
      expect(names(nightly)).toEqual(["qa"])
      expect(nightly.reuse).toBe("none")
      expect(nightly.schedules).toEqual(["0 3 * * *"])
      const manual = yield* Kiln.plan(project, Event.manual({ reason: "hotfix" }))
      expect(manual.runs(promote)).toBe(true)
      const bad = yield* Effect.exit(Kiln.plan(project, Event.manual({ reason: 1 })))
      expect(Exit.isFailure(bad)).toBe(true)
    }))

  it.effect("rejects grants in pull-request rules even without types", () =>
    Effect.gen(function*() {
      const sneaky = Kiln.project({ rules: [On.pullRequest([promote as never])] })
      const exit = yield* Effect.exit(Kiln.plan(sneaky, Event.pullRequest({ number: 2 })))
      expect(String(exit)).toContain("don't run steps with grants")
    }))

  it.effect("rejects two steps with one name, but merges identical builds", () =>
    Effect.gen(function*() {
      const a = Task.make("dup", { run: cmd`a` })
      const b = Task.make("dup", { run: cmd`b` })
      const dup = yield* Effect.exit(Kiln.plan(Kiln.project({ rules: [On.push("main", [a, b])] }), Event.push("main")))
      expect(String(dup)).toContain(`two different steps are named "dup"`)

      const r1 = Nix.build(flake.packages.projectRelease)
      const r2 = Nix.build(flake.packages.projectRelease)
      const t = Task.make("t", { run: cmd`echo ${r2}` })
      const ok = yield* Kiln.plan(Kiln.project({ rules: [On.push("main", [r1, t])] }), Event.push("main"))
      expect(names(ok)).toEqual(["projectRelease", "t"])
    }))

  it.effect("rejects cycles and contradictions", () =>
    Effect.gen(function*() {
      const contradiction = Action.make("announce", { needs: { qa: Step.exit(qa) }, after: [qa] }, function*() {})
      const exit = yield* Effect.exit(Kiln.plan(Kiln.project({ rules: [On.push("main", [contradiction])] }), Event.push("main")))
      expect(String(exit)).toContain("contradict each other")
    }))

  it.effect("outputs are steps that depend on their task", () =>
    Effect.gen(function*() {
      const archive = Task.make("archive", { run: cmd`make`, outputs: { ipa: "build/app.ipa" }, inputs: Files.of("ios") })
      const upload = Action.make("upload", { needs: { ipa: archive.outputs.ipa } }, function*({ ipa }) {
        return ipa
      })
      const plan = yield* Kiln.plan(Kiln.project({ rules: [On.push("main", [upload])] }), Event.push("main"))
      expect(names(plan)).toEqual(["archive", "archive.ipa", "upload"])
    }))

  it.effect("tasks need their setup, which a plan pulls in once", () =>
    Effect.gen(function*() {
      const install = Setup.make("install", { inputs: Files.of("pnpm-lock.yaml"), run: cmd`pnpm install`, keep: ["node_modules"] })
      const lint = Task.make("lint", { setup: install, run: cmd`just lint` })
      const test = Task.make("test", { setup: install, run: cmd`just test` })
      const plan = yield* Kiln.plan(Kiln.project({ rules: [On.pullRequest([lint, test])] }), Event.pullRequest({ number: 1 }))
      expect(names(plan)).toEqual(["install", "lint", "test"])
      expect(plan.get(lint)?.needs).toEqual(["install"])
      expect(plan.get(install)?.kind).toBe("setup")
    }))

  it.effect("a task and its setup run on the same platform", () =>
    Effect.gen(function*() {
      const install = Setup.make("install", { inputs: Files.of("pnpm-lock.yaml"), run: cmd`pnpm install` })
      const apple = Task.make("apple", { setup: install, platform: "aarch64-darwin", run: cmd`just apple` })
      const exit = yield* Effect.exit(Kiln.plan(Kiln.project({ rules: [On.push("main", [apple])] }), Event.push("main")))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
