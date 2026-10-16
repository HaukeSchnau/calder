import { Action, Files, Kiln, On, Task, cmd } from "@kiln/core"
import { Bun } from "@kiln/std"
import { flake } from "./flake.ts"
import * as WebStore from "./WebStore.ts"

const shell = flake.devShells.ci
const install = Bun.install({ shell })

/** The extension as the store gets it. */
const build = Task.make("build", {
  shell,
  setup: install,
  run: cmd`bun run zip`,
  inputs: Files.glob("src/**", "static/**", "tsconfig.json"),
  outputs: { zip: "ebb.zip" },
})

const qa = Task.make("qa", { shell, setup: install, run: cmd`bun run qa` })

/** Submits the build once qa passed. A pull-request rule refuses it, because it reads a secret. */
const release = Action.make("release", {
  needs: { zip: build.outputs.zip },
  after: [qa],
  grants: { secrets: ["chrome-web-store"] },
}, function*({ zip }) {
  return yield* WebStore.release({ zip })
})

export default Kiln.project({
  rules: [On.pullRequest([qa, build]), On.push("main", [release])],
})
