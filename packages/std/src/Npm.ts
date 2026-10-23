import { cmd, type Flake, Secret, type Setup, type Step, Task } from "@calder-ci/core"
import { Schema } from "effect"

export interface PublishOptions {
  /** The dev shell with node and pnpm. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The installed dependencies that the package's `prepare` and `prepack` scripts run with: `Pnpm.install`. */
  readonly setup: Setup.Setup
  /** The project's secret with an access token that may publish the package. */
  readonly token: string
  /** The package's directory, relative to the repository root. The root by default. */
  readonly dir?: string
  /** The registry, npm's by default. */
  readonly registry?: string
  /** `public` by default, which a scoped package needs to be visible to everyone. */
  readonly access?: "public" | "restricted"
  /** The step's name, `publish` by default. */
  readonly name?: string
  /** Steps that must pass first, such as the checks. */
  readonly after?: ReadonlyArray<Step.Any>
}

/** A publish step's value: the package's version, and whether this run published it. */
export const Published = Schema.Struct({ name: Schema.String, version: Schema.String, published: Schema.Boolean })
export type Published = typeof Published.Type

/** Where the script writes the step's value; `git clean` removes it before the next task. */
const valueFile = ".calder-npm-publish.json"

/**
 * The token goes into a user config of its own rather than onto a command line, where other users
 * of the host could read it. `$1` is the token's file, `$2` the registry, `$3` the package's
 * directory and `$4` the access.
 */
const script = `set -euo pipefail
value="$PWD/${valueFile}"
cd "$3"
name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
export NPM_CONFIG_USERCONFIG=$(mktemp)
trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT
registry="\${2%/}/"
printf '%s:_authToken=%s\\n' "\${registry#*:}" "$(cat "$1")" > "$NPM_CONFIG_USERCONFIG"
if [ "$(npm view "$name@$version" version --registry "$registry" 2>/dev/null)" = "$version" ]; then
  echo "$name@$version is already published"
  published=false
else
  case "$version" in *-*) tag=next ;; *) tag=latest ;; esac
  pnpm publish --no-git-checks --access "$4" --tag "$tag" --registry "$registry"
  published=true
fi
printf '{"name":"%s","version":"%s","published":%s}\\n' "$name" "$version" "$published" > "$value"`

/**
 * Publishes the package's version unless the registry already has it, so it can run on every push:
 * a release is a commit that raises the version. A prerelease version (`1.2.0-beta.1`) goes to the
 * `next` tag, every other to `latest`. It holds the project's deploy lease, so two runs never publish
 * at once, and its value says what it did.
 */
export const publish = (options: PublishOptions) =>
  Task.make(options.name ?? "publish", {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    setup: options.setup,
    after: options.after ?? [],
    lease: true,
    reuse: "never",
    run: cmd`bash -c ${script} calder-npm ${Secret.file(options.token)} ${options.registry ?? "https://registry.npmjs.org"} ${
      options.dir ?? "."
    } ${options.access ?? "public"}`,
    value: { path: valueFile, schema: Published },
  })
