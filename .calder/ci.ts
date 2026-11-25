import { Pnpm, Project } from "@calder-ci/std";
import { flake } from "./flake.ts";

const shell = flake.devShells.default;

/**
 * The flake's checks build the package and the website, which infra deploys with the controller.
 * `vp test` runs file by file: a test file runs again only when it, something it imports, the
 * Vite+ config or a tsconfig changed.
 */
export default Project.standard({
  flake,
  vp: {
    shell,
    setup: Pnpm.install({ shell }),
    test: { tests: ["packages/*/test/**/*.test.ts"], shards: 2 },
  },
});
