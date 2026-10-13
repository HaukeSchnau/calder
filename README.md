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

const qa = Task.make("qa", { shell, setup: install, run: cmd`just qa` }).pipe(Step.timeout("30 minutes"))

export default Project.standard({ flake, checks: [qa] })
```

Kiln reads only the default export and finds the steps by following the rules, so steps need no `export`.

Every flake check is a step, plus `checks`. Pull requests run them and build `packages.projectRelease`;
the default branch reuses identical results (also from same-repo pull requests) and promotes the release
once every check passed. `afterDeploy` adds steps that run after the release is live. A pipeline beyond
that is a `Kiln.project({ rules: [...] })` of the steps below (see `@kiln/std` `Project.ts`).

- **build** (`Nix.build`): a derivation of the repository's flake. Its value is the output path.
- **setup** (`Setup.make`, or `Pnpm.install` and `Bun.install` from `@kiln/std`): prepares a workspace once per key,
  which comes from its `inputs` (manifests, lockfiles, patches), toolchain and command. Tasks that
  name it (`setup: install`) wait for it and start from a copy of the prepared workspace; a key
  prepared before settles at once. A setup runs only once one of those tasks runs. When all of them
  reuse their results, it doesn't run and counts as reused: the UI, `kiln status` and its commit status
  say it wasn't needed. A task that can't reuse anything (`reuse: "never"`, a schedule without reuse)
  starts its setup at once. A setup that fails leaves no key on its workspace, so the next task
  sets it up again. `keep` names what survives a task's `git clean`, `path` what goes in front of PATH.
  Kept files carry over to tasks of other revisions without entering their keys, so
  keep only caches that tools check against the sources themselves (`node_modules`, `*.tsbuildinfo`,
  `.vite`). Build output such as `dist` doesn't belong in `keep`, because a task would read what another
  revision built. `Pnpm.install` and `Bun.install` name their step `install`; a second install, say
  with another shell, needs its own `name`.
- **task** (`Task.make`): a command in a dev shell, run in a persistent workspace of the repository.
  Before each task the workspace is checked out and cleaned with `git clean -ffdx`, except what its
  setup keeps. A task is reused
  when its key matches: git tree ids of its inputs (`inputs: Files.workspace(...)`, the whole
  repository by default), its setup's key, the dev shell, the command and the values it interpolates.
  A task with a setup needn't list manifests or lockfiles, since the setup's key covers them. A path
  or pattern in a step's files that matches no file fails the plan, since that part of the key would
  never change; `kiln plan` checks the working copy for this before you push. Wrap files that may be
  missing in `Files.optional(...)`. Pull requests and pushes
  reuse everything by default. Schedules and manual runs (`reuse: "builds"`) run tasks without
  `outputs` again, files of tasks with `each` included. A task with `reuse: "never"` runs every time,
  for checks of the machine rather than the code. When a task's outcome differs from an earlier one
  with the same key, the UI and `kiln status` flag it: the key misses an input, or the task is flaky.
  The paths a task names in `outputs` go to the Nix store, also when the task fails, and the UI and
  `kiln status` link to them; a failed task's outputs are never reused. A task with another `platform`
  than the controller's runs on an agent of that platform (`kiln agent`, trusted runs only). An agent of
  the controller's platform with a free slot also takes trusted tasks off the controller. Pull-request
  tasks always run on the controller, because agents run every worker as one user without a sandbox.
  Tasks get `GOMEMLIMIT` at two thirds of their worker's memory limit, so Go tools such as tsgo
  collect garbage before the limit throttles them; a task's own `env` overrides it.
  Pull-request tasks reach the network only through the controller's egress allowlist. `secrets:
  { ENV: Secret.file("name") }` hands a trusted task the path of a file holding the project's secret
  `name`; a step that names a secret the project doesn't configure dies saying so.
- **action** (`Action.make`): Effect code with side effects. `needs` are the steps whose values the
  body reads, `after` the steps that must pass first, `grants` what it may do (`deploy`, `secrets`).
  Pull-request rules refuse steps with grants. Actions with grants also wait for the checks branch
  protection requires (`kiln/<step>`).

`ci.ts` runs on the worker's Bun. `.kiln/tsconfig.json` extends `@kiln/tsconfig` from the SDK, which gives it Bun's
types, so an action can use `fetch`, `node:crypto` or `Bun.file` and still type-check. `.kiln/node_modules` links
through the profile that put Kiln on PATH (`/run/current-system/sw/lib/kiln/...`), so it follows upgrades; `kiln plan`
repairs an older link. The compiler options come through that link too, so a new Kiln changes them in every project
without another `kiln gen`. A `.kiln/tsconfig.json` that lists the options itself is from an older `kiln gen`; run it
once more.

`kiln gen` writes `.kiln/flake.ts` and `.kiln/tsconfig.json` in its own style; if the repository runs a
formatter over everything, format `.kiln/` with it. Task workspaces get the same `.kiln/node_modules` link
as `kiln gen` creates, so the repository's type-aware lint can check `ci.ts` in CI too.

`Step.exit(step)` hands an action a step's outcome instead of blocking on its failure. `Step.retry`
and `Step.timeout` take Effect's options and apply in pipe order. A step counts each test of its
report once, with its last outcome, so a test that failed on one attempt and passed on a retry counts
as flaky rather than failed. Task shards (`shards: { count }`) run in parallel and report as one step.

`Vitest.files` from `@kiln/std` is a task that runs a package's vitest file by file. Its `each` follows
the test files' imports, so a file runs again only when it, what it imports or `inputs` changed. Vitest
runs in `dir`, with that package's `node_modules/.bin` first on PATH, gets the files relative to `dir`,
and writes its JSON report to where the task reads it.

```ts
const testServer = Vitest.files({
  name: "test-server",
  shell,
  setup: install,
  dir: "apps/server",
  tests: ["src/**/*.test.ts"],
  inputs: Files.of("package.json", "pnpm-lock.yaml", "apps/server/vitest.config.ts"),
  shards: 4,
  args: ["--maxWorkers", "3"],
})
```

`vitest: ["vp", "test"]` runs it through Vite+, and `before` is a command that runs in `dir` first.

## Commands

```
kiln gen [dir]                       # writes .kiln/flake.ts, .kiln/tsconfig.json, links .kiln/node_modules,
                                     # and the standard .kiln/ci.ts if there is none
kiln plan [dir] --event push:main    # what push[:branch], pr[:n], check[:ref], schedule:<cron> or
                                     # manual[:<json object>] would run; exits 1 when a path or pattern
                                     # matches no file of the working copy (jj or git)
kiln check [dir]                     # runs the working copy (jj or git) like a pull request, before pushing
kiln trigger <project> [--branch b]  # runs a branch head on the controller, follows it, and exits 1 unless
  [--inputs '{"release":"ios"}']     # it passes; with --inputs a manual run of the On.manual rules they match
kiln runs [project] [--limit n]      # recent runs with their status, event, commit and age
kiln projects                        # the projects and the latest run of each default branch
kiln status <run>                    # a run's steps, with why those that failed did and links to outputs
kiln logs <run> [step] [-f]          # a step's output, or every step's with its name in front; -f follows
                                     # until the step ends, or the run without a step
kiln rerun <run> | kiln cancel <run>  # run ids look like studienbuch-12
kiln controller --config <file>      # the service
kiln worker <job>                    # started by the controller in a systemd unit, or by an agent
kiln agent --url <controller> --token-file <f> --name <n> --workspaces <dir> [--slots n] [--admission cmd]
                                     # runs the controller's jobs for this host's platform
```

`kiln <command> --help` describes each argument and flag.

An agent gets jobs only while it has the controller's compatibility version (`compatibility` in
`packages/kiln/src/Protocol.ts`), so deploying the controller stalls agents only when that version
changed. The UI lists each agent's version and Kiln build and marks an agent of another version as
incompatible. A reconnecting agent reports the workers it still runs, and the controller stops those it
doesn't know, such as jobs from before its restart, before it gives that agent new jobs. An agent that
restarts stops the workers its earlier run left behind before it takes jobs, from the pids it keeps in
`<workspaces>/.workers`.

## Projects and history

A repository of one of the controller's `owners` becomes a project once a push, a pull request or `kiln check`
brings `.kiln/ci.ts`, or once its default branch carries it. At startup the controller forgets enrolled projects
that never ran and whose default branch has no `ci.ts`, and then removes their mirrors.

Finished runs keep their steps, shards and test results for `retention.days` in the controller's config (30 by
default). After that those go, and so do results Kiln won't reuse. A result stays while it is the newest for its
key or a run inside the window reused it, and its run keeps a row without its plan. The newest run of each branch
and pull request keeps its row too, so the catch-up after a restart doesn't start it again. Each project's newest
planned run stays whole. Extracted `.kiln/` directories go after a day without use. Task outputs have GC roots in
`gcroots/` under the controller's state directory while a step of a run inside the window or a passed result names
them, so Nix's garbage collector leaves them alone; reuse skips a result whose outputs left the store anyway.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | `@kiln/core`: the API and the plan engine (`Kiln.plan` is pure and testable) |
| `packages/std` | `@kiln/std`: `Project.standard`, `Release.promote` (deploy lease, preflight, head check, fencing token, readiness; fails when a host can't be reached or none runs the app), `Pnpm.install`, `Bun.install`, `Vitest.files` |
| `packages/api` | Schemas and the RPC group the UI speaks |
| `packages/kiln` | The CLI: controller (Gitea webhooks, runs driven from a SQLite journal, statuses, leases, agents, egress proxy), worker and agent |
| `packages/ui` | The web UI (React, Vite), served by the controller |
| `sdk` | What `.kiln/node_modules` links to, so ci.ts and the worker share one copy of Effect, and the tsconfig `.kiln/tsconfig.json` extends |

```
pnpm install
pnpm check      # tsc for every package
pnpm test       # vitest
nix build .#kiln
```
