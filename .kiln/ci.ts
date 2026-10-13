import { Files, Task, cmd } from "@kiln/core"
import { Pnpm, Project, Vitest } from "@kiln/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.default
const install = Pnpm.install({ shell })

const check = Task.make("check", { shell, setup: install, run: cmd`pnpm run check` })

/** A test file runs again only when it, something it imports or the vitest config changed. */
const test = Vitest.files({
  shell,
  setup: install,
  tests: ["packages/*/test/**/*.test.ts"],
  inputs: Files.of("vitest.config.ts"),
  shards: 2,
})

export default Project.standard({ flake, checks: [check, test] })
