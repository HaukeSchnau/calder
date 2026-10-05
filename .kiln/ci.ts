import { Report, Task, cmd } from "@kiln/core"
import { Project } from "@kiln/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.default

export const check = Task.make("check", { shell, run: cmd`pnpm run check` })

export const test = Task.make("test", {
  shell,
  run: cmd`pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=reports/junit.xml`,
  report: Report.junit("reports/junit.xml"),
})

export default Project.standard({ flake, checks: [check, test] })
