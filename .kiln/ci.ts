import { Files, Report, Task, cmd } from "@kiln/core"
import { Pnpm, Project } from "@kiln/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.default
const install = Pnpm.install({ shell })

export const check = Task.make("check", { shell, setup: install, run: cmd`pnpm run check` })

/** A test file runs again only when it or something it imports changed. */
export const test = Task.make("test", {
  shell,
  setup: install,
  each: Files.imports("packages/*/test/**/*.test.ts"),
  inputs: Files.of("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vitest.config.ts"),
  shards: { count: 2 },
  run: ({ files }) => cmd`pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml ${files}`,
  report: Report.junit("reports/junit.xml"),
})

export default Project.standard({ flake, checks: [check, test] })
