import { Files, Task, cmd } from "@calder-ci/core"
import { Pnpm, Project, Vitest } from "@calder-ci/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.default
const install = Pnpm.install({ shell })

const check = Task.make("check", {
  shell,
  setup: install,
  inputs: Files.of("packages", "sdk", "tsconfig.base.json"),
  run: cmd`pnpm run check`,
})

/** A test file runs again only when it, something it imports or the vitest config changed. */
const test = Vitest.files({
  shell,
  setup: install,
  tests: ["packages/*/test/**/*.test.ts"],
  inputs: Files.of("vitest.config.ts"),
  shards: 2,
})

/** The website has a lockfile of its own, so that Astro stays out of Calder's package. */
const siteInstall = Pnpm.install({ name: "site-install", shell, dir: "site" })
const siteCheck = Task.make("site-check", {
  shell,
  setup: siteInstall,
  inputs: Files.of("site", ".calder/ci.ts"),
  run: cmd`pnpm --dir site check`,
})

/** The flake's checks build the package and the website, which infra deploys with the controller. */
export default Project.standard({ flake, checks: [check, test, siteCheck] })
