# Kiln

CI/CD for Hauke's fleet. Pipelines are Effect TypeScript in `.kiln/ci.ts`, Nix decides what needs
building, and every task result is keyed by the git trees it read, so identical work is reused
across pull requests and revisions. The design is in `~/Code/CI-CD-Lab`
(https://files.schnau.dev/html/ci-cd-lab/); the NixOS module is `~/infra/modules/features/kiln`.

## A pipeline

```ts
// .kiln/ci.ts
import { Action, Kiln, Nix, On, Step, Task, cmd } from "@kiln/core"
import { Release } from "@kiln/std"
import { flake } from "./flake.ts"

export const qa = Task.make("qa", { shell: flake.devShells.ci, run: cmd`just qa` }).pipe(Step.timeout("30 minutes"))
export const release = Nix.build(flake.packages.projectRelease, { name: "release" })

export const promote = Action.make("promote", { needs: { release }, after: [qa], grants: { deploy: true } }, function*({ release }) {
  return yield* Release.promote(release)
})

export default Kiln.project({
  rules: [On.pullRequest([qa, release]), On.push("main", [promote])],
})
```

- **build** (`Nix.build`): a derivation of the repository's flake. Its value is the output path.
- **task** (`Task.make`): a command in a dev shell, run in a persistent workspace of the repository.
  Before each task the workspace is checked out and cleaned with `git clean -ffdx`, except what
  `.ci/preserve` lists; `.ci/environment` is sourced and `.ci/setup` runs first. A task is reused
  when its key matches: git tree ids of its inputs (`inputs: Files.workspace(...)`, the whole
  repository by default), the dev shell, the command and the values it interpolates. Pull requests
  reuse everything; pushes rerun tasks unless they build `outputs`.
- **action** (`Action.make`): Effect code with side effects. `needs` are the steps whose values the
  body reads, `after` the steps that must pass first, `grants` what it may do (`deploy`, `secrets`).
  Pull-request rules refuse steps with grants. Actions with grants also wait for the checks branch
  protection requires (`kiln/<step>`).

`Step.exit(step)` hands an action a step's outcome instead of blocking on its failure. `Step.retry`
and `Step.timeout` take Effect's options and apply in pipe order. Task shards (`shards: { count }`)
run in parallel and report as one step.

## Commands

```
kiln gen [dir]                       # writes .kiln/flake.ts, .kiln/tsconfig.json, links .kiln/node_modules
kiln plan [dir] --event push:main    # what a push, pr:<n>, schedule:<cron> or manual run would run
kiln trigger <project> [--branch b]  # runs a branch head on the controller and follows it
kiln controller --config <file>      # the service
kiln worker <job>                    # started by the controller in a systemd unit
```

## Layout

| Path | What |
| --- | --- |
| `packages/core` | `@kiln/core`: the API and the plan engine (`Kiln.plan` is pure and testable) |
| `packages/std` | `@kiln/std`: `Release.promote` (deploy lease, preflight, head check, fencing token, readiness) |
| `packages/api` | Schemas and the RPC group the UI speaks |
| `packages/kiln` | The CLI: controller (Gitea webhooks, durable runs on effect/workflow + SQLite, statuses, leases) and worker |
| `packages/ui` | The web UI (React, Vite), served by the controller |
| `sdk` | What `.kiln/node_modules` links to, so ci.ts and the worker share one copy of Effect |

```
pnpm install
pnpm check      # tsc for every package
pnpm test       # vitest
nix build .#kiln
```
