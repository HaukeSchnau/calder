# Kiln

CI/CD for Hauke's fleet. Pipelines are Effect TypeScript in `.kiln/ci.ts`, Nix decides what needs
building, and every task result is keyed by the git trees it read, so identical work is reused
across pull requests and revisions. The design is in `~/Code/CI-CD-Lab`
(https://files.schnau.dev/html/ci-cd-lab/); the NixOS module is `~/infra/modules/features/kiln`.

## A pipeline

Most projects run the standard pipeline, which `kiln gen` writes into a repository without one:

```ts
// .kiln/ci.ts
import { Step, Task, cmd } from "@kiln/core"
import { Pnpm, Project } from "@kiln/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.ci
const install = Pnpm.install({ shell })

export const qa = Task.make("qa", { shell, setup: install, run: cmd`just qa` }).pipe(Step.timeout("30 minutes"))

export default Project.standard({ flake, checks: [qa] })
```

Every flake check is a step, plus `checks`. Pull requests run them and build `packages.projectRelease`;
the default branch reuses identical results (also from same-repo pull requests) and promotes the release
once every check passed. `afterDeploy` adds steps that run after the release is live. A pipeline beyond
that is a `Kiln.project({ rules: [...] })` of the steps below (see `@kiln/std` `Project.ts`).

- **build** (`Nix.build`): a derivation of the repository's flake. Its value is the output path.
- **setup** (`Setup.make`, or `Pnpm.install` from `@kiln/std`): prepares a workspace once per key,
  which comes from its `inputs` (manifests, lockfiles, patches), toolchain and command. Tasks that
  name it (`setup: install`) wait for it and start from a copy of the prepared workspace; a key
  prepared before settles at once. `keep` names what survives a task's `git clean`, `path` what goes
  in front of PATH.
- **task** (`Task.make`): a command in a dev shell, run in a persistent workspace of the repository.
  Before each task the workspace is checked out and cleaned with `git clean -ffdx`, except what its
  setup keeps. A task is reused
  when its key matches: git tree ids of its inputs (`inputs: Files.workspace(...)`, the whole
  repository by default), the dev shell, the command and the values it interpolates. Pull requests
  reuse everything; pushes rerun tasks unless they build `outputs`. A task with another `platform`
  than the controller's runs on an agent of that platform (`kiln agent`, trusted runs only).
  Pull-request tasks reach the network only through the controller's egress allowlist.
- **action** (`Action.make`): Effect code with side effects. `needs` are the steps whose values the
  body reads, `after` the steps that must pass first, `grants` what it may do (`deploy`, `secrets`).
  Pull-request rules refuse steps with grants. Actions with grants also wait for the checks branch
  protection requires (`kiln/<step>`).

`kiln gen` writes `.kiln/flake.ts` and `.kiln/tsconfig.json` in its own style; if the repository runs a
formatter over everything, format `.kiln/` with it. Task workspaces get the same `.kiln/node_modules` link
as `kiln gen` creates, so the repository's type-aware lint can check `ci.ts` in CI too.

`Step.exit(step)` hands an action a step's outcome instead of blocking on its failure. `Step.retry`
and `Step.timeout` take Effect's options and apply in pipe order. Task shards (`shards: { count }`)
run in parallel and report as one step.

## Commands

```
kiln gen [dir]                       # writes .kiln/flake.ts, .kiln/tsconfig.json, links .kiln/node_modules,
                                     # and the standard .kiln/ci.ts if there is none
kiln plan [dir] --event push:main    # what a push, pr:<n>, check, schedule:<cron> or manual run would run
kiln check [dir]                     # runs the working copy (jj or git) like a pull request, before pushing
kiln trigger <project> [--branch b]  # runs a branch head on the controller and follows it
kiln status <run>                    # a run's steps, with why those that failed did
kiln logs <run> [step] [-f]          # a step's output, or every step's with its name in front
kiln rerun <run> | kiln cancel <run>  # run ids look like studienbuch-12
kiln controller --config <file>      # the service
kiln worker <job>                    # started by the controller in a systemd unit, or by an agent
kiln agent --url <controller> --token-file <f> --name <n> --workspaces <dir> [--slots n] [--admission cmd]
                                     # runs the controller's jobs for this host's platform
```

## Layout

| Path | What |
| --- | --- |
| `packages/core` | `@kiln/core`: the API and the plan engine (`Kiln.plan` is pure and testable) |
| `packages/std` | `@kiln/std`: `Project.standard`, `Release.promote` (deploy lease, preflight, head check, fencing token, readiness) |
| `packages/api` | Schemas and the RPC group the UI speaks |
| `packages/kiln` | The CLI: controller (Gitea webhooks, runs driven from a SQLite journal, statuses, leases, agents, egress proxy), worker and agent |
| `packages/ui` | The web UI (React, Vite), served by the controller |
| `sdk` | What `.kiln/node_modules` links to, so ci.ts and the worker share one copy of Effect |

```
pnpm install
pnpm check      # tsc for every package
pnpm test       # vitest
nix build .#kiln
```
