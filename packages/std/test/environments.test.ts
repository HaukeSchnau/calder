import { describe, expect, it } from "@effect/vitest"
import { Calder, Event, Flake, Nix, type Step, Task, cmd } from "@calder-ci/core"
import { Effect, Schema } from "effect"
import * as Environments from "../src/Environments.ts"
import * as Pnpm from "../src/Pnpm.ts"

const flake = Flake.make({ packages: ["bundle"], checks: ["serverSmoke"], devShells: ["ci"] })
const shell = flake.devShells.ci
const lint = Task.make("lint", { shell, run: cmd`vp lint` })
const smoke = Nix.build(flake.checks.serverSmoke, { name: "serverSmoke" })
const checks = [lint, smoke]
const bundle = Nix.build(flake.packages.bundle, { name: "bundle" })
const Outputs = Schema.Struct({ url: Schema.String, readiness: Schema.String })
const stack = {
  shell,
  dir: "deploy",
  env: "cloudflare",
  setup: Pnpm.install({ shell, dir: "deploy", name: "deploy-install" }),
  secrets: { FLEET_TOKEN_FILE: "placement-token" },
  outputs: { name: "Studienbuch", schema: Outputs },
}
const after = (name: string, deployed: Step.Any) => Task.make(name, { shell, run: cmd`true`, after: [deployed] })

const project = Environments.project({
  stack,
  checks,
  artifacts: { CALDER_BUNDLE: bundle },
  readiness: (outputs) => outputs.readiness,
  previews: { url: (_pr, outputs) => outputs.url, then: (deployed) => [after("e2e-web", deployed)] },
  environments: {
    beta: { on: { push: "main" }, after: checks, then: (deployed) => [after("ota-beta", deployed)] },
    prod: { on: { manual: { release: Schema.Literal("prod") } } },
  },
  nightly: "0 3 * * *",
})

describe("Environments.project", () => {
  it.effect("a pull request deploys its preview as soon as the bundle is built, beside the checks", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.pullRequest({ number: 5 }))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(
        ["bundle", "deploy-install", "e2e-web", "lint", "preview", "preview-url", "serverSmoke"].sort(),
      )
      expect(plan.get("preview")).toMatchObject({ needs: ["deploy-install", "bundle"], after: [], preview: true })
      expect(plan.get("preview-url")).toMatchObject({ needs: ["preview"], preview: true })
      expect(plan.get("e2e-web")?.after).toEqual(["preview-url"])
    }))

  it.effect("a preview is gated on what its after names, while beta waits for the checks in their turn", () =>
    Effect.gen(function*() {
      const gated = Environments.project({
        stack,
        checks,
        artifacts: { CALDER_BUNDLE: bundle },
        previews: { url: (_pr, outputs) => outputs.url, after: [smoke] },
        environments: { beta: { on: { push: "main" }, after: checks } },
      })
      const pr = yield* Calder.plan(gated, Event.pullRequest({ number: 5 }))
      expect(pr.get("preview")).toMatchObject({ after: ["serverSmoke"], gates: ["serverSmoke"] })
      const push = yield* Calder.plan(gated, Event.push("main"))
      expect(push.get("deploy-beta")).toMatchObject({ after: ["lint", "serverSmoke"], gates: [] })
    }))

  it.effect("a fork's pull request runs the checks and builds the bundle, but has no preview", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.pullRequest({ number: 5, fork: true }))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["bundle", "lint", "serverSmoke"])
    }))

  it.effect("main deploys the stage beta after the checks, waits for its readiness, then runs what follows", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.push("main"))
      expect(plan.get("deploy-beta")).toMatchObject({ needs: ["deploy-install", "bundle"], after: ["lint", "serverSmoke"] })
      expect(plan.get("ready-beta")?.needs).toEqual(["deploy-beta"])
      expect(plan.get("ota-beta")?.after).toEqual(["ready-beta"])
      expect(plan.get("deploy-prod")).toBeUndefined()
      const deploy = plan.get("deploy-beta")!.step.def
      expect(deploy._tag === "Task" && deploy.lease).toBe(true)
    }))

  it.effect("prod deploys only when asked, with the same artifacts, and without checks it doesn't name", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.manual({ release: "prod" }))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["bundle", "deploy-install", "deploy-prod", "ready-prod"])
      const other = yield* Effect.flip(Calder.plan(project, Event.manual({ release: "beta" })))
      expect(other.message).toContain("no manual rule takes the inputs")
    }))

  it.effect("closing a pull request destroys its stage, and the nightly run builds everything without reuse", () =>
    Effect.gen(function*() {
      const closed = yield* Calder.plan(project, Event.pullRequestClosed({ number: 5 }))
      expect(closed.steps.map((s) => s.name).sort()).toEqual(["deploy-install", "destroy-preview"])
      const nightly = yield* Calder.plan(project, Event.schedule("0 3 * * *"))
      expect(nightly.reuse).toBe("none")
      expect(nightly.steps.map((s) => s.name).sort()).toEqual(["bundle", "lint", "serverSmoke"])
    }))
})
