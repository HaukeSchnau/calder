import { Report, Task, cmd } from "@kiln/core"
import { Pnpm, Project } from "@kiln/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.default
const install = Pnpm.install({ shell })

export const check = Task.make("check", { shell, setup: install, run: cmd`pnpm run check` })

export const test = Task.make("test", {
  shell,
  setup: install,
  run: cmd`pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml`,
  report: Report.junit("reports/junit.xml"),
})

export default Project.standard({ flake, checks: [check, test] })
