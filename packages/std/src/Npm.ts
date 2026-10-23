import { cmd, type Flake, Secret, type Setup, type Step, Task } from "@calder-ci/core"
import { Schema } from "effect"

export interface PublishOptions {
  /** The dev shell with node, whose npm stages, and pnpm, which packs. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The installed dependencies that the package's `prepack` and `prepare` scripts run with: `Pnpm.install`. */
  readonly setup: Setup.Setup
  /** The project's secret with a granular access token that may stage the package. */
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

/** A publish step's value: where the package's version stands on the registry. */
export const Release = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  /** `staged` waits for a maintainer to approve it with 2FA: `npm stage approve <stage>`. */
  state: Schema.Literals(["published", "staged"]),
  stage: Schema.NullOr(Schema.String),
  /** Whether this run staged it. */
  staged: Schema.Boolean,
})
export type Release = typeof Release.Type

/** Where the script writes the step's value; `git clean` removes it before the next task. */
const valueFile = ".calder-npm-release.json"

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
pack=$(mktemp -d)
trap 'rm -rf "$NPM_CONFIG_USERCONFIG" "$pack"' EXIT
registry="\${2%/}/"
printf '%s:_authToken=%s\\n' "\${registry#*:}" "$(cat "$1")" > "$NPM_CONFIG_USERCONFIG"
release() {
  printf '{"name":"%s","version":"%s","state":"%s","stage":%s,"staged":%s}\\n' "$name" "$version" "$1" "$2" "$3" > "$value"
}
if [ "$(npm view "$name@$version" version --registry "$registry" 2>/dev/null)" = "$version" ]; then
  echo "$name@$version is published"
  release published null false
  exit 0
fi
stage=$(npm stage list "$name" --json --registry "$registry" | VERSION="$version" node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const item = items.find((item) => item.version === process.env.VERSION && item.status !== "rejected")
  process.stdout.write(item ? String(item.id) : "")')
if [ -n "$stage" ]; then
  echo "$name@$version is staged as $stage and waits for approval: npm stage approve $stage"
  release staged "\\"$stage\\"" false
  exit 0
fi
case "$version" in *-*) tag=next ;; *) tag=latest ;; esac
pnpm pack --pack-destination "$pack"
stage=$(npm stage publish "$pack"/*.tgz --tag "$tag" --access "$4" --registry "$registry" --json |
  node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).stageId))')
echo "Staged $name@$version as $stage. Approve it with 2FA: npm stage approve $stage"
release staged "\\"$stage\\"" true`

/**
 * Stages the package's version for a maintainer to approve with 2FA, unless the registry already has
 * it published or staged, so it can run on every push: a release is a commit that raises the
 * version. npm's staged publishing needs no token that may bypass 2FA, and such tokens lose direct
 * publishing around January 2027. The package is packed with pnpm, which resolves `workspace:`
 * versions, and a prerelease (`1.2.0-beta.1`) is tagged `next`, every other version `latest`. The
 * step holds the project's deploy lease, and its value says where the version stands.
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
    value: { path: valueFile, schema: Release },
  })
