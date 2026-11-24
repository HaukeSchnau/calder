import { describe, expect, it } from "@effect/vitest"
import { Calder, Cmd, Event, Files, Flake, type Step } from "@calder-ci/core"
import { Effect } from "effect"
import * as Pnpm from "../src/Pnpm.ts"
import * as Project from "../src/Project.ts"
import * as Vp from "../src/Vp.ts"

const flake = Flake.make({ packages: ["projectRelease"], checks: ["artifact"], devShells: ["ci"] })
const shell = flake.devShells.ci
const setup = Pnpm.install({ shell })

const task = (step: Step.Any) => {
  if (step.def._tag !== "Task") throw new Error("not a task")
  return step.def
}

/** The command a job of `files` runs, from `vp` on. */
const command = (step: Step.Any, files: ReadonlyArray<string>) => {
  const { run } = task(step)
  if (typeof run !== "function") throw new Error("not a task with each")
  const argv = Cmd.render(run({ index: 1, count: 1, files }), {})
  return argv.slice(argv.indexOf("vp"))
}

describe("Vp.check", () => {
  it("runs `vp check` after the install, keyed by the whole repository", () => {
    const check = task(Vp.check({ shell, setup }))
    if (typeof check.run === "function") return expect.unreachable()
    expect(Cmd.render(check.run, {})).toEqual(["vp", "check"])
    expect(check.setup).toBe(setup)
    expect(check.inputs).toEqual(Files.all())
  })
})

describe("Vp.test", () => {
  const tests = ["**/*.test.ts"]

  it("without `tests`, runs the whole suite in one task keyed by the whole repository", () => {
    const test = task(Vp.test({ shell, setup }))
    if (typeof test.run === "function") return expect.unreachable()
    expect(Cmd.render(test.run, {})).toEqual(["vp", "test", "run", "--passWithNoTests"])
    expect(test.each).toBeUndefined()
    expect(test.inputs).toEqual(Files.all())
  })

  it("runs the whole suite of `dir` with the arguments it's given", () => {
    const test = task(Vp.test({ setup, dir: "site", args: ["--maxWorkers", "2"] }))
    if (typeof test.run === "function") return expect.unreachable()
    expect(Cmd.render(test.run, {})).toEqual(["vp", "test", "run", "--root", "site", "--passWithNoTests", "--maxWorkers", "2"])
  })

  it("with `tests`, runs `vp test` file by file, passing a job whose files the config leaves out", () => {
    const step = Vp.test({ shell, setup, tests })
    expect(task(step).each).toEqual(Files.imports(tests))
    expect(command(step, ["src/a.test.ts"])).toEqual(["vp", "test", "run", "--passWithNoTests", "src/a.test.ts"])
  })

  it("is keyed by vite.config.ts with what it imports and every tsconfig", () => {
    expect(task(Vp.test({ setup, tests })).inputs).toEqual(
      Files.union(Files.imports("vite.config.ts"), Files.optional(Files.glob("**/tsconfig*.json"))),
    )
  })

  it("keeps the config and tsconfigs in the key when given more inputs, such as setup files", () => {
    expect(task(Vp.test({ setup, tests, inputs: Files.imports("test/setup.ts") })).inputs).toEqual(
      Files.union(
        Files.imports("vite.config.ts"),
        Files.optional(Files.glob("**/tsconfig*.json")),
        Files.imports("test/setup.ts"),
      ),
    )
  })

  it("keys file by file on the config `--config` names instead of vite.config.ts", () => {
    const keyed = (args: ReadonlyArray<string>) => task(Vp.test({ setup, dir: "site", tests, args })).inputs
    const on = (config: string) => Files.union(Files.imports(config), Files.optional(Files.glob("**/tsconfig*.json")))
    expect(keyed(["--config", "config/unit.ts"])).toEqual(on("site/config/unit.ts"))
    expect(keyed(["--config=config/unit.ts"])).toEqual(on("site/config/unit.ts"))
    expect(keyed(["-c", "config/unit.ts"])).toEqual(on("site/config/unit.ts"))
  })

  it("holds the globs it's given to matching a file, and reads the config of `dir`", () => {
    const test = task(Vp.test({ setup, dir: "site", tests: ["src/**/*.test.ts"] }))
    expect(test.each).toEqual(Files.imports(["site/src/**/*.test.ts"]))
    expect(test.inputs).toEqual(
      Files.union(Files.imports("site/vite.config.ts"), Files.optional(Files.glob("**/tsconfig*.json"))),
    )
  })

  it("keeps the arguments it's given after its own", () => {
    expect(command(Vp.test({ setup, tests, args: ["--maxWorkers", "2"] }), ["a.test.ts"])).toEqual([
      "vp",
      "test",
      "run",
      "--passWithNoTests",
      "--maxWorkers",
      "2",
      "a.test.ts",
    ])
  })
})

describe("the `vp` option", () => {
  const vp = { shell, setup }

  it.effect("adds `check` and `test` to Project.standard's checks, which gate the promotion", () =>
    Effect.gen(function*() {
      const project = Project.standard({ flake, vp })
      const pr = yield* Calder.plan(project, Event.pullRequest({ number: 1 }))
      expect(pr.steps.map((s) => s.name).sort()).toEqual(["artifact", "check", "install", "release", "test"])
      expect((yield* Calder.plan(project, Event.push("main"))).get("promote")?.after).toEqual(["artifact", "check", "test"])
    }))

  it.effect("passes `test` on to Vp.test", () =>
    Effect.gen(function*() {
      const project = Project.standard({ flake, vp: { ...vp, test: { tests: ["src/**/*.test.ts"] } } })
      const test = (yield* Calder.plan(project, Event.pullRequest({ number: 1 }))).get("test")!.step
      expect(task(test).each).toEqual(Files.imports(["src/**/*.test.ts"]))
    }))

  it.effect("adds them to Project.alchemy's checks, which gate production's deploy", () =>
    Effect.gen(function*() {
      const project = Project.alchemy({ flake, stack: { shell, setup, env: "cloudflare" }, vp })
      expect((yield* Calder.plan(project, Event.push("main"))).get("deploy-prod")?.after).toEqual(["artifact", "check", "test"])
    }))
})
