import { describe, expect, it } from "@effect/vitest"
import { Event, Flake, Calder, Task, cmd } from "@calder-ci/core"
import { Effect } from "effect"
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
      expect(same.steps.map((s) => s.name).sort()).toEqual(["artifact", "install", "preview", "preview-url"])
      expect(same.get("preview")?.preview).toBe(true)
      const fork = yield* Calder.plan(project, Event.pullRequest({ number: 7, fork: true }))
      expect(fork.steps.map((s) => s.name)).toEqual(["artifact"])
    }))

  it.effect("closing a pull request removes its stage", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(project, Event.pullRequestClosed({ number: 7 }))
      expect(plan.trust).toBe("trusted")
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["destroy-preview", "install"])
    }))

  it.effect("without previews, pull requests only check", () =>
    Effect.gen(function*() {
      const plan = yield* Calder.plan(Project.alchemy({ flake: site, stack }), Event.pullRequest({ number: 8 }))
      expect(plan.steps.map((s) => s.name)).toEqual(["artifact"])
      const closed = yield* Calder.plan(Project.alchemy({ flake: site, stack }), Event.pullRequestClosed({ number: 8 }))
      expect(closed.steps).toEqual([])
    }))
})
