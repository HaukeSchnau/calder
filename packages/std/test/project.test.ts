import { describe, expect, it } from "@effect/vitest"
import { Event, Flake, Kiln, Task, cmd } from "@kiln/core"
import { Effect } from "effect"
import * as Project from "../src/Project.ts"

const flake = Flake.make({ packages: ["projectRelease"], checks: ["artifact", "projectRelease"], devShells: ["ci"] })
const qa = Task.make("qa", { shell: flake.devShells.ci, run: cmd`just qa` })

describe("Project.standard", () => {
  it.effect("pull requests run every check and build the release, but don't deploy", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(Project.standard({ flake, checks: [qa] }), Event.pullRequest({ number: 1 }))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["artifact", "projectRelease", "qa", "release"])
      expect(plan.reuse).toBe("all")
    }))

  it.effect("main reuses identical results and deploys after every check", () =>
    Effect.gen(function*() {
      const project = Project.standard({ flake, checks: [qa], afterDeploy: (promote) => [Task.make("apple", { run: cmd`true`, after: [promote] })] })
      const plan = yield* Kiln.plan(project, Event.push("main"))
      expect(plan.reuse).toBe("all")
      expect(plan.get("promote")?.after).toEqual(["artifact", "projectRelease", "qa"])
      expect(plan.get("apple")?.after).toEqual(["promote"])
    }))

  it.effect("a nightly run checks everything again and deploys nothing", () =>
    Effect.gen(function*() {
      const plan = yield* Kiln.plan(Project.standard({ flake, checks: [qa], nightly: "0 3 * * *" }), Event.schedule("0 3 * * *"))
      expect(plan.steps.map((s) => s.name).sort()).toEqual(["artifact", "projectRelease", "qa"])
      expect(plan.reuse).toBe("none")
    }))

  it.effect("without a release, main runs the checks again", () =>
    Effect.gen(function*() {
      const checksOnly = Flake.make({ packages: ["default"], checks: ["package"], devShells: [] })
      const plan = yield* Kiln.plan(Project.standard({ flake: checksOnly }), Event.push("main"))
      expect(plan.steps.map((s) => s.name)).toEqual(["package"])
      expect(plan.reuse).toBe("all")
    }))
})
