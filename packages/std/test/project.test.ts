import { describe, expect, it } from "@effect/vitest"
import { Calder, Cmd, Event, Flake, type Step, Task, cmd } from "@calder-ci/core"
import { Effect, Schema } from "effect"
import * as Pnpm from "../src/Pnpm.ts"
import * as Project from "../src/Project.ts"

const flake = Flake.make({ packages: ["projectRelease"], checks: ["artifact", "projectRelease"], devShells: ["ci"] })
const qa = Task.make("qa", { shell: flake.devShells.ci, run: cmd`just qa` })

describe("Project.standard", () => {
  it.effect("pull requests run every check and build the release, but don't deploy", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(Project.standard({ flake, checks: [qa] }), Event.pullRequest({ number: 1 }))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["artifact", "projectRelease", "qa", "release"])
      expect(plan.reuse).toBe("all")
    }))

  it.effect("main reuses identical results and deploys after every check", () =>
    Effect.gen(function*() {
      const project = Project.standard({ flake, checks: [qa], afterDeploy: (promote) => [Task.make("apple", { run: cmd`true`, after: [promote] })] })
      const plan = yield* Calder.plan(project, Event.push("main"))
      expect(plan.reuse).toBe("all")
      expect(plan.get("promote")?.after).toEqual(["artifact", "projectRelease", "qa"])
      expect(plan.get("apple")?.after).toEqual(["promote"])
    }))

  it.effect("main deploys the placement after the checks and promotes after it", () =>
    Effect.gen(function*() {
      const shell = flake.devShells.ci
      const placement = {
        shell,
        setup: Pnpm.install({ shell }),
        env: "cloudflare",
        secrets: { FLEET_TOKEN_FILE: "placement-token" },
      }
      const project = Project.standard({ flake, checks: [qa], placement })
      const plan = yield* Calder.plan(project, Event.push("main"))
      expect(plan.get("placement")?.after).toEqual(["artifact", "projectRelease", "qa"])
      expect(plan.get("promote")?.after).toEqual(["artifact", "projectRelease", "qa", "placement"])

      // A same-repo pull request plans the placement without deploying it; a fork's doesn't plan.
      const pr = yield* Calder.plan(project, Event.pullRequest({ number: 1 }))
      expect(pr.get("placement")).toBeUndefined()
      expect(pr.get("placement-plan")?.preview).toBe(true)
      expect((yield* Calder.plan(project, Event.pullRequest({ number: 1, fork: true }))).get("placement-plan")).toBeUndefined()
      const optedOut = Project.standard({ flake, checks: [qa], placement, planDeploys: false })
      expect((yield* Calder.plan(optedOut, Event.pullRequest({ number: 1 }))).get("placement-plan")).toBeUndefined()
    }))

  it.effect("a nightly run checks everything again and deploys nothing", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(Project.standard({ flake, checks: [qa], nightly: "0 3 * * *" }), Event.schedule("0 3 * * *"))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["artifact", "projectRelease", "qa"])
      expect(plan.reuse).toBe("none")
    }))

  it.effect("without a release, main runs the checks again", () =>
    Effect.gen(function*() {
      const checksOnly = Flake.make({ packages: ["default"], checks: ["package"], devShells: [] })
      const plan = yield* Calder.plan(Project.standard({ flake: checksOnly }), Event.push("main"))
      expect(plan.steps.map((s) => s.name)).toEqual(["package"])
      expect(plan.reuse).toBe("all")
    }))
})

describe("Project.alchemy", () => {
  const site = Flake.make({ packages: ["site"], checks: ["artifact"], devShells: ["ci"] })
  const stack = { shell: site.devShells.ci, setup: Pnpm.install({ shell: site.devShells.ci }), env: "cloudflare" }
  const project = Project.alchemy({ flake: site, stack, previews: { url: (pr) => `https://pr-${pr}.example.workers.dev` } })

  it.effect("main deploys production after the checks, holding the deploy lease", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.push("main"))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["artifact", "deploy-prod", "install"])
      const deploy = plan.get("deploy-prod")!
      expect(deploy.after).toEqual(["artifact"])
      expect(deploy.step.def._tag === "Task" && deploy.step.def.lease).toBe(true)
    }))

  it.effect("a same-repo pull request deploys its own stage and links it; a fork only checks", () =>
    Effect.gen(function*() {
      const same = yield* Calder.plan(project, Event.pullRequest({ number: 7 }))
      expect(same.steps.map((s) => s.name).sort()).toEqual(["artifact", "install", "plan-prod", "preview", "preview-url"])
      // It waits for every check in their usual turn: none gates it into the latency lane.
      expect(same.get("preview")).toMatchObject({ preview: true, after: ["artifact"], gates: [] })
      const fork = yield* Calder.plan(project, Event.pullRequest({ number: 7, fork: true }))
      expect(fork.steps.map((s) => s.name)).toEqual(["artifact"])
    }))

  it.effect("closing a pull request removes its stage", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.pullRequestClosed({ number: 7 }))
      expect(plan.trust).toBe("trusted")
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["destroy-preview", "install"])
    }))

  it.effect("production reads no outputs that no step reads, while a preview reads them for its link", () =>
    Effect.gen(function*() {
      const outputs = { name: "Site", schema: Schema.Struct({ url: Schema.String }) }
      const site = Project.alchemy({ flake: Flake.make({ checks: ["artifact"], devShells: ["ci"] }), stack: { ...stack, outputs }, previews: { url: (_pr, o) => o.url } })
      const command = (def: Step.Any["def"]) => (def._tag === "Task" && typeof def.run !== "function" ? Cmd.show(def.run) : "")
      const prod = (yield* Calder.plan(site, Event.push("main"))).get("deploy-prod")!.step.def
      expect(prod._tag === "Task" && prod.value).toBeUndefined()
      expect(command(prod)).not.toContain("state read")
      const preview = (yield* Calder.plan(site, Event.pullRequest({ number: 7 }))).get("preview")!.step.def
      expect(preview._tag === "Task" && preview.value?.path).toBe(".calder-alchemy-outputs.json")
      expect(command(preview)).toContain("state read 'Site/'")
    }))

  it.effect("without previews, pull requests check and plan production", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(Project.alchemy({ flake: site, stack }), Event.pullRequest({ number: 8 }))
      expect(plan.steps.map((s) => s.name)).toEqual(["artifact", "install", "plan-prod"])
      const closed = yield* Calder.plan(Project.alchemy({ flake: site, stack }), Event.pullRequestClosed({ number: 8 }))
      expect(closed.steps).toEqual([])
    }))
})
