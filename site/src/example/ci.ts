import { Action, Calder, Files, Nix, On, Step, Task, cmd } from "@calder-ci/core"
import { Pnpm, Vitest } from "@calder-ci/std"
import * as Deploy from "./deploy.ts"
import { flake } from "./flake.ts"

const shell = flake.devShells.default
const install = Pnpm.install({ shell })

const typecheck = Task.make("typecheck", {
  shell,
  setup: install,
  inputs: Files.of("apps", "tsconfig.json"),
  run: cmd`pnpm tsc -b`,
})

const test = Vitest.files({
  shell,
  setup: install,
  tests: ["apps/*/src/**/*.test.ts"],
})

const site = Nix.build(flake.packages.site)

const deploy = Action.make("deploy", {
  needs: { site },
  after: [typecheck, test],
  grants: { secrets: ["deploy-token"] },
}, function*({ site }) {
  yield* Deploy.publish(site)
}).pipe(Step.retry({ times: 2 }))

export default Calder.project({
  rules: [
    On.pullRequest([typecheck, test, site]),
    On.push("main", [deploy]),
  ],
})
