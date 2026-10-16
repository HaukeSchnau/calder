import { Files, Task, cmd } from "@kiln/core"
import { Pnpm, Project, Vitest } from "@kiln/std"
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

/** The website has a lockfile of its own, so that Astro and Alchemy stay out of Kiln's package. */
const siteInstall = Pnpm.install({ name: "site-install", shell, dir: "site" })
const site = Task.make("site", {
  shell,
  setup: siteInstall,
  inputs: Files.of("site"),
  run: cmd`pnpm --dir site check`,
})

/** Pushes to main deploy the website (site/alchemy.run.ts) once every check passed. */
export default Project.alchemy({
  flake,
  stack: { shell, setup: siteInstall, dir: "site", env: "cloudflare" },
  checks: [check, test, site],
  previews: { url: (pr) => `https://pr-${pr}-kiln-site.hauke-911.workers.dev` },
})
