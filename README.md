# Calder

CI/CD for Hauke's fleet. Pipelines are Effect TypeScript in `.calder/ci.ts`, Nix decides what needs
building, and every task result is keyed by the git trees it read, so identical work is reused
across pull requests and revisions.

## A pipeline

Most projects run the standard pipeline, which `calder gen` writes into a repository without one:

```ts
// .calder/ci.ts
import { Step, Task, cmd } from "@calder-ci/core"
import { Pnpm, Project } from "@calder-ci/std"
import { flake } from "./flake.ts"

const shell = flake.devShells.ci
const install = Pnpm.install({ shell })

const qa = Task.make("qa", { shell, setup: install, run: cmd`just qa` }).pipe(Step.timeout("30 minutes"))

export default Project.standard({ flake, checks: [qa] })
```

Calder reads only the default export and finds the steps by following the rules, so steps need no `export`.

Every flake check is a step, plus `checks`. Pull requests run them and build `packages.projectRelease`;
the default branch reuses identical results (also from same-repo pull requests) and promotes the release
once every check passed. With `placement`, an Alchemy stack with the release's `Fleet.Placement` (`@schnau/fleet`: its hostname, secret bindings and limits on its host, within the grant the host's configuration gives it), the default branch deploys that stack before the promotion. The stack reads the project's token from `FLEET_TOKEN_FILE` when its `secrets` map it to `placement-token`, which Calder derives for every project when the controller has a `placementKeyFile`. `afterDeploy` adds steps that run after the release is live. A pipeline beyond
that is a `Calder.project({ rules: [...] })` of the steps below (see `@calder-ci/std` `Project.ts`).

- **build** (`Nix.build`): a derivation of the repository's flake. Its value is the output path.
  Flake inputs that name another project's repository (`git+ssh` or `git+https` on the forge) come
  from Calder's mirror of it, in plans, builds and tasks alike, so a flake with private inputs
  evaluates without credentials, also in a pull request's sandbox. Agents fetch inputs themselves.
- **setup** (`Setup.make`, or `Pnpm.install` and `Bun.install` from `@calder-ci/std`): prepares a workspace once per key,
  which comes from its `inputs` (manifests, lockfiles, patches), toolchain and command. Tasks that
  name it (`setup: install`) wait for it and start from a copy of the prepared workspace; a key
  prepared before settles at once. A setup runs only once one of those tasks runs. When all of them
  reuse their results, it doesn't run and counts as reused: the UI, `calder status` and its commit status
  say it wasn't needed. A task that can't reuse anything (`reuse: "never"`, a schedule without reuse)
  starts its setup at once. A setup that fails leaves no key on its workspace, so the next task
  sets it up again. `keep` names what survives a task's `git clean`, `path` what goes in front of PATH.
  Kept files carry over to tasks of other revisions without entering their keys, so
  keep only caches that tools check against the sources themselves (`node_modules`, `*.tsbuildinfo`,
  `.vite`). Build output such as `dist` doesn't belong in `keep`, because a task would read what another
  revision built. `Pnpm.install` and `Bun.install` name their step `install`; a second install, say
  with another shell, needs its own `name`. With `dir` they install a directory with its own lockfile
  instead of the root, and put its `node_modules/.bin` on PATH.
- **task** (`Task.make`): a command in a dev shell, run in a persistent workspace of the repository.
  Before each task the workspace is checked out and cleaned with `git clean -ffdx`, except what its
  setup keeps. A task is reused
  when its key matches: git tree ids of its inputs (`inputs: Files.workspace(...)`, the whole
  repository by default), its setup's key, the dev shell, the command and the values it interpolates.
  A task with a setup needn't list manifests or lockfiles, since the setup's key covers them. A path
  or pattern in a step's files that matches no file fails the plan, since that part of the key would
  never change; `calder plan` checks the working copy for this before you push. Wrap files that may be
  missing in `Files.optional(...)`. Pull requests and pushes
  reuse everything by default. Schedules and manual runs (`reuse: "builds"`) run tasks without
  `outputs` again, files of tasks with `each` included. A task with `reuse: "never"` runs every time,
  for checks of the machine rather than the code. When a task's outcome differs from an earlier one
  with the same key, the UI and `calder status` flag it: the key misses an input, or the task is flaky.
  The paths a task names in `outputs` go to the Nix store, also when the task fails, and the UI and
  `calder status` link to them; a failed task's outputs are never reused. `value: { path, schema }`
  gives a task a value like an action's: the JSON file the command wrote at `path`, decoded with
  `schema` once it passed. Only what the schema decodes reaches the journal and the file never enters
  the store, so it may hold secrets the schema leaves out. A task with another `platform`
  than the controller's runs on an agent of that platform (`calder agent`, trusted runs only). An agent of
  the controller's platform with a free slot also takes trusted tasks off the controller, unless the
  task says `offload: false` because it needs the controller's host. Pull-request
  tasks always run on the controller, because agents run every worker as one user without a sandbox.
  Tasks get `GOMEMLIMIT` at 90% of their worker's memory limit, so Go tools such as tsgo collect
  garbage before the limit throttles them; a task's own `env` overrides it.
  Pull-request tasks reach the network only through the controller's egress allowlist. `secrets:
  { ENV: Secret.file("name") }` hands a trusted task the path of a file holding the project's secret
  `name`, and ``cmd`... ${Secret.file("name")}` `` passes that path as an argument; a step that names a
  secret the project doesn't configure dies saying so. ``cmd`... ${Cmd.pullRequest}` `` passes the
  run's pull-request number. `lease: true` makes a trusted task hold the project's deploy lease while
  it runs, like `Release.promote`: one deploy at a time, and a run a newer one replaced passes without
  running. Deploys of the same run take the lease in turn.
- **action** (`Action.make`): Effect code with side effects. `needs` are the steps whose values the
  body reads, `after` the steps that must pass first, `grants` what it may do (`deploy`, `secrets`).
  Pull-request rules refuse steps with grants. Actions with grants also wait for the checks branch
  protection requires (`calder/<step>`).

`On.preview` rules run next to the pull-request rules, but only for pull requests from a branch of the
same repository, never for forks or `calder check`. Their tasks may read secrets: whoever can push a branch
is someone a trusted run trusts. Such a task runs as a trusted job, in the trusted pool with its network
and home. Actions with grants and tasks with `lease` stay refused. `On.pullRequestClosed` rules run when
a pull request is merged or closed, as a trusted run of the base branch's head that knows the pull
request's number, such as to remove its preview. `calder plan --event closed:<n>` shows them.

`Project.alchemy` from `@calder-ci/std` is the pipeline of a repository its [Alchemy](https://alchemy.run)
stack deploys. The default branch deploys the production stage (`Alchemy.deploy`, holding the lease)
once the checks passed; with `previews`, same-repo pull requests deploy a stage `pr-<n>` of their own
and comment its URL (`Alchemy.preview`), and closing them destroys it (`Alchemy.destroy`). The project's
secret `env` is a dotenv file of the providers' credentials, which the CLI reads with `--env-file`.
The CLI starts as `pnpm exec alchemy`; a Bun repository sets `runner: "bun"` and installs with
`Bun.install`, and its steps run `bun alchemy`. A stack whose package has its own lockfile in a
directory, such as a website in `site/`, sets `dir` on the stack and on its install, and the CLI runs
there.

A stack with `outputs` makes what it returns, an object, the value of its deploys: after deploying,
the step reads it with `alchemy state read <name>/<stage>/output` and decodes it with the schema,
which leaves out secrets such as tokens. A preview's `url` gets the outputs as its second argument.

```ts
export default Project.alchemy({
  flake,
  stack: {
    shell,
    setup: Pnpm.install({ shell }),
    env: "cloudflare",
    outputs: { name: "Site", schema: Schema.Struct({ url: Schema.String }) },
  },
  previews: { url: (_pr, outputs) => outputs.url },
})
```

`Npm.publish` from `@calder-ci/std` stages a package's version on npm, or the `registry` given, for a maintainer to
approve with 2FA (`npm stage approve <id>`, or Staged Packages on npmjs.com). It leaves a version that is already
published or staged alone, so it can run on every push and a release is a commit that raises the version. Staging
needs only a granular token without 2FA bypass, ideally "Read and write (stage only)": npm retires direct publishing
with bypass tokens around January 2027, and its trusted publishing accepts only GitHub Actions, GitLab and CircleCI. The
token comes from the project's secret `token` through a user config of its own, never the command line. `pnpm pack`
packs the package, so `workspace:` versions resolve, and a prerelease (`1.2.0-beta.1`) is tagged `next`. The step
holds the deploy lease, and its value says where the version stands: `{ name, version, state, stage, staged }`.

```ts
const publish = Npm.publish({ shell, setup: install, token: "npm", after: checks })

export default Calder.project({ rules: [On.pullRequest(checks), On.push("main", [publish])] })
```

`ci.ts` runs on the worker's Bun. `.calder/tsconfig.json` extends `@calder-ci/tsconfig` from the SDK, which gives it Bun's
types, so an action can use `fetch`, `node:crypto` or `Bun.file` and still type-check. `.calder/node_modules` links
through the profile that put Calder on PATH (`/run/current-system/sw/lib/calder/...`), so it follows upgrades; `calder plan`
repairs an older link. The compiler options come through that link too, so a new Calder changes them in every project
without another `calder gen`. A `.calder/tsconfig.json` that lists the options itself is from an older `calder gen`; run it
once more.

`calder gen` writes `.calder/flake.ts` and `.calder/tsconfig.json` in its own style; if the repository runs a
formatter over everything, format `.calder/` with it. Task workspaces get the same `.calder/node_modules` link
as `calder gen` creates, so the repository's type-aware lint can check `ci.ts` in CI too.

`Step.exit(step)` hands an action a step's outcome instead of blocking on its failure. `Step.retry`
and `Step.timeout` take Effect's options and apply in pipe order. A step counts each test of its
report once, with its last outcome, so a test that failed on one attempt and passed on a retry counts
as flaky rather than failed. Task shards (`shards: { count }`) run in parallel and report as one step.

`Vitest.files` from `@calder-ci/std` is a task that runs a package's vitest file by file. Its `each` follows
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
calder gen [dir]                       # writes .calder/flake.ts, .calder/tsconfig.json, links .calder/node_modules,
                                     # and the standard .calder/ci.ts if there is none
calder plan [dir] --event push:main    # what push[:branch], pr[:n], check[:ref], schedule:<cron> or
                                     # manual[:<json object>] would run; exits 1 when a path or pattern
                                     # matches no file of the working copy (jj or git); --json prints
                                     # the steps with their kind and edges
calder check [dir]                     # runs the working copy (jj or git) like a pull request, before pushing
calder trigger <project> [--branch b]  # runs a branch head on the controller, follows it, and exits 1 unless
  [--inputs '{"release":"ios"}']     # it passes; with --inputs a manual run of the On.manual rules they match
calder runs [project] [--limit n]      # recent runs with their status, event, commit and age
calder projects                        # the projects and the latest run of each default branch
calder status <run>                    # a run's steps, with why those that failed did and links to outputs
calder logs <run> [step] [-f]          # a step's output, or every step's with its name in front; -f follows
                                     # until the step ends, or the run without a step
calder rerun <run> | calder cancel <run>  # run ids look like studienbuch-12
calder controller --config <file>      # the service
calder worker <job>                    # started by the controller in a systemd unit, or by an agent
calder agent --url <controller> --token-file <f> --name <n> --workspaces <dir> [--slots n] [--admission cmd]
                                     # runs the controller's jobs for this host's platform
```

`calder <command> --help` describes each argument and flag.

An agent gets jobs only while it has the controller's compatibility version (`compatibility` in
`packages/calder/src/Protocol.ts`), so deploying the controller stalls agents only when that version
changed. The UI lists each agent's version and Calder build and marks an agent of another version as
incompatible. A reconnecting agent reports the workers it still runs, and the controller stops those it
doesn't know, such as jobs from before its restart, before it gives that agent new jobs. An agent that
restarts stops the workers its earlier run left behind before it takes jobs, from the pids it keeps in
`<workspaces>/.workers`.

## Two addresses

The controller listens twice. `listen` is for the private network: Gitea's webhook, agents and their
workers (who fetch revisions at `url`), the CLI and the UI at `/`, none of it behind a sign-in. `web`
is the UI for everyone else, at the path of `publicUrl` (`/app`), for a proxy to expose: it serves only
the UI, its RPC and task outputs, and only to the Gitea users in `web.users` once they signed in
through the Gitea OAuth2 application `web.oauth` (redirect URI `<publicUrl>/auth/callback`). Sessions
last 30 days and are signed with a key the controller keeps in its state directory;
`<publicUrl>/auth/sign-out` ends one. In the fleet, `https://calder.schnau.dev` serves the website at
`/` and the app at `/app/`, and agents and the CLI use `https://ci.schnau.dev` on the Tailnet
(`$CALDER_URL`).

## Projects and history

A repository of one of the controller's `owners` becomes a project once a push, a pull request or `calder check`
brings `.calder/ci.ts`, or once its default branch carries it. At startup the controller forgets enrolled projects
that never ran and whose default branch has no `ci.ts`, and then removes their mirrors.

Finished runs keep their steps, shards and test results for `retention.days` in the controller's config (30 by
default). After that those go, and so do results Calder won't reuse. A result stays while it is the newest for its
key or a run inside the window reused it, and its run keeps a row without its plan. The newest run of each branch
and pull request keeps its row too, so the catch-up after a restart doesn't start it again. Each project's newest
planned run stays whole. Extracted `.calder/` directories go after a day without use. Task outputs have GC roots in
`gcroots/` under the controller's state directory while a step of a run inside the window or a passed result names
them, so Nix's garbage collector leaves them alone; reuse skips a result whose outputs left the store anyway.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | `@calder-ci/core`: the API and the plan engine (`Calder.plan` is pure and testable) |
| `packages/std` | `@calder-ci/std`: `Project.standard`, `Project.alchemy` and `Alchemy`, `Npm.publish`, `Release.promote` (deploy lease, preflight, head check, fencing token, readiness; fails when a host can't be reached or none runs the app), `Pnpm.install`, `Bun.install`, `Vitest.files` |
| `packages/api` | Schemas and the RPC group the UI speaks |
| `packages/calder` | The CLI: controller (Gitea webhooks, runs driven from a SQLite journal, statuses, leases, agents, egress proxy), worker and agent |
| `packages/ui` | The web UI (React, Vite), served by the controller |
| `sdk` | What `.calder/node_modules` links to, so ci.ts and the worker share one copy of Effect, and the tsconfig `.calder/tsconfig.json` extends |
| `site` | The website, plain HTML, CSS and JavaScript that the flake packages as `packages.site` and the proxy serves at `/` of https://calder.schnau.dev |

```
pnpm install
pnpm check      # tsc for every package
pnpm test       # vitest
nix build .#calder
```
