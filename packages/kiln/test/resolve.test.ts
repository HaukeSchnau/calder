import { cmd, Event, Files, Flake, Kiln, On, Report, Secret, type Step, Task } from "@kiln/core"
import { describe, expect, it } from "@effect/vitest"
import { Pnpm } from "@kiln/std"
import { Effect, Fiber, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import type { PlanSpec, RunInfo } from "../src/Protocol.ts"
import { resolve } from "../src/worker/Resolve.ts"
import { memoryRepo } from "./memoryRepo.ts"

const run = {
  id: "app-1",
  project: "app",
  number: 1,
  revision: "rev",
  branch: "main",
  trust: "trusted",
  event: Event.push("main"),
  flake: "git+file:///mirror",
  mirror: "/mirror",
  kilnDir: "",
  system: "x86_64-linux",
} satisfies RunInfo

// The repository is in memory, and no command runs: `nix eval` fails like a missing nix.
const noProcesses = ChildProcessSpawner.make(() => Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "spawn" })))

const plan = (tree: Record<string, string>, steps: ReadonlyArray<Step.Any>) =>
  Effect.gen(function*() {
    const project = Kiln.project({ rules: [On.push("main", steps)] })
    return yield* resolve(yield* Kiln.plan(project, run.event), project, run, memoryRepo(tree))
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses))

const task = (spec: PlanSpec, name: string) => spec.steps.find((s) => s.name === name)!.task!

const app = {
  "package.json": JSON.stringify({ name: "app" }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'",
  "src/a.ts": "export const a = 1",
  "src/a.test.ts": `import { a } from "./a"`,
}

describe("resolve", () => {
  it.effect("a task's key and its files' keys cover its setup", () =>
    Effect.gen(function*() {
      const test = (args: ReadonlyArray<string>) =>
        Task.make("test", {
          setup: Pnpm.install({ args }),
          each: Files.imports("src/*.test.ts"),
          inputs: Files.of("package.json"),
          run: ({ files }) => cmd`vitest run ${files}`,
          report: Report.junit("junit.xml"),
        })
      const before = task(yield* plan(app, [test([])]), "test")
      const npmrc = task(yield* plan({ ...app, ".npmrc": "node-linker=hoisted" }, [test([])]), "test")
      const args = task(yield* plan(app, [test(["--trust-lockfile"])]), "test")
      for (const changed of [npmrc, args]) {
        expect(changed.inputs).toEqual(["package.json"])
        expect(changed.keyBase).not.toBe(before.keyBase)
        expect(changed.each![0]!.key).not.toBe(before.each![0]!.key)
      }
    }))

  it.effect("a task's key covers the names of its secrets", () =>
    Effect.gen(function*() {
      const publish = (secret: string) => Task.make("publish", { secrets: { TOKEN: Secret.file(secret) }, run: cmd`publish` })
      const staging = task(yield* plan(app, [publish("staging-token")]), "publish")
      const production = task(yield* plan(app, [publish("production-token")]), "publish")
      expect(production.keyBase).not.toBe(staging.keyBase)
    }))

  it.effect("a dev shell that doesn't evaluate fails the plan, after retries", () =>
    Effect.gen(function*() {
      const flake = Flake.make({ devShells: ["ci"] })
      const qa = Task.make("qa", { shell: flake.devShells.ci, run: cmd`just qa` })
      const planning = yield* plan(app, [qa]).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(planning)
      expect(error._tag).toBe("PlanError")
      expect(error.message).toContain("devShells.x86_64-linux.ci")
    }))

  it.effect("a path or pattern that matches no file fails the plan, unless it is optional", () =>
    Effect.gen(function*() {
      const build = (inputs: Files.Files) => Task.make("build", { inputs, run: cmd`make` })
      const error = yield* plan(app, [build(Files.union(Files.glob("src/**"), Files.of("static"), Files.imports("src/**/*.tsx")))]).pipe(Effect.flip)
      expect(error.message).toContain(`No file matches "static" (build's inputs), "src/**/*.tsx" (build's inputs).`)
      yield* plan(app, [build(Files.union(Files.glob("src/**"), Files.optional(Files.of("static"))))])
    }))
})
