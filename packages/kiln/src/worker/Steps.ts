import { Busy, Cache, Cmd, CurrentRun, Flake, Fleet, Git, Gitea, Kiln, PullRequest, Rejected, Report, Secret, type Step } from "@kiln/core"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import * as Exec from "../Exec.ts"
import { link, sdkPath } from "../Gen.ts"
import type { Job as JobSpec, JobResult, Outcome, RunInfo } from "../Protocol.ts"
import * as Values from "../Values.ts"
import { fetching, gitEnv, Job, reconnecting } from "./Client.ts"
import * as NixLog from "./NixLog.ts"
import * as Repo from "./Repo.ts"
import { paths } from "./Resolve.ts"
import * as Workspace from "./Workspace.ts"

type StepJob = Extract<JobSpec, { readonly _tag: "Step" }>

/** Applies `Step.retry` and `Step.timeout` in pipe order. */
const withPolicies = <A, E, R>(effect: Effect.Effect<A, E, R>, policies: ReadonlyArray<Step.Policy>) =>
  policies.reduce<Effect.Effect<A, any, R>>(
    (eff, policy) =>
      policy._tag === "Retry"
        ? Effect.retry(eff, policy.options)
        : Effect.timeoutOrElse(eff, {
          duration: policy.duration,
          orElse: () => Effect.fail(new Kiln.TimedOut({ after: Duration.format(policy.duration) })),
        }),
    effect,
  )

const isKilnFailure = (error: unknown): error is { readonly _tag: string; readonly message: string } =>
  typeof error === "object" && error !== null && [...Kiln.registry.values()].some((entry) =>
    error instanceof (entry.schema as unknown as abstract new(...args: never) => unknown)
  )

/** Turns the exit of a step body into what the controller journals. Typed failures stay typed; the rest died. */
const toResult = <A>(exit: Exit.Exit<A, unknown>, extra: { readonly outputs?: Record<string, string>; readonly key?: string | null } = {}): JobResult => {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Passed", value: Values.encode(exit.value), outputs: extra.outputs ?? {}, key: extra.key ?? null }
  }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure) && isKilnFailure(failure.value)) {
    return {
      _tag: "Failed",
      error: Values.encode(failure.value),
      tag: failure.value._tag,
      message: failure.value.message,
      key: extra.key ?? null,
    }
  }
  return { _tag: "Died", message: Cause.pretty(exit.cause) }
}

// Gitea's host runners gave jobs the system profile (curl, ssh, ...) and pipelines rely on it.
const hostPath = existsSync("/run/current-system/sw/bin") ? ":/run/current-system/sw/bin" : ""

const env = (run: RunInfo, step: string, extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...process.env,
  PATH: `${process.env.PATH ?? ""}${hostPath}`,
  CI: "true",
  KILN: "1",
  KILN_RUN: run.id,
  KILN_PROJECT: run.project,
  KILN_STEP: step,
  KILN_REVISION: run.revision,
  CI_PROJECT_ID: run.project,
  NIX_CONFIG: "experimental-features = nix-command flakes",
  ...extra,
})

// ---------------------------------------------------------------------------------------------- build

export const build = (job: StepJob, step: Step.Any, attr: string) =>
  Effect.gen(function*() {
    const { emit, log } = yield* Job
    const parse = NixLog.parser()
    let drv: string | null = job.derivation
    const ref = drv === null ? `${job.run.flake}#${attr}` : `${drv}^*`
    yield* log("kiln", `nix build ${attr}`)
    if (drv === null) {
      drv = (yield* Exec.run(["nix", "eval", "--raw", `${ref}.drvPath`], { env: env(job.run, step.name) }).pipe(
        Effect.orElseSucceed(() => ""),
      )).trim() || null
    }
    const attempt = Effect.gen(function*() {
      const out: Array<string> = []
      const exitCode = yield* Exec.stream(
        ["nix", "build", "--no-link", "--print-out-paths", "--log-format", "internal-json", "-L", ref],
        { env: env(job.run, step.name) },
        (stream, line) =>
          Effect.gen(function*() {
            if (stream === "stdout") {
              out.push(line.trim())
              return
            }
            for (const msg of parse(line, Date.now())) {
              if (msg._tag === "Activity") yield* emit({ _tag: "Activity", activity: msg.activity })
              else yield* log(msg.error ? "stderr" : "stdout", msg.text)
            }
          }),
      )
      if (exitCode !== 0) return yield* new Kiln.BuildFailed({ attr, ...(drv === null ? {} : { drv }) })
      return out.find((l) => l.startsWith("/nix/store/")) as Kiln.StorePath
    })
    const exit = yield* Effect.exit(withPolicies(attempt, step.policies))
    return toResult(exit, { key: drv })
  })

// ----------------------------------------------------------------------------------------------- task

// Tasks without a setup still read the repository's `.ci/` (preserve, environment, setup), the Gitea
// runners' contract. Remove this once no branch carries `.ci/`.
const preserved = (workspace: string): ReadonlyArray<string> => {
  const file = join(workspace, ".ci/preserve")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"))
}

/** Checks out the revision in the slot's checkout and removes everything `keep` doesn't name. */
const checkout = (job: StepJob, src: string, keep: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const self = yield* Job
    const { log } = self
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "-C", src, ...args], { env: { ...process.env, ...gitEnv(self) } })
    if (!existsSync(join(src, ".git"))) yield* git(["init", "-q"])
    const started = Date.now()
    // Tasks that need history deepen the checkout from `origin` (local workers only; the controller's
    // URL needs the job's token).
    yield* git(["remote", "add", "origin", job.run.mirror]).pipe(Effect.catch(() => git(["remote", "set-url", "origin", job.run.mirror])))
    yield* fetching(git(["fetch", "-q", "--no-tags", "--depth=1", "origin", job.run.revision]))
    yield* git(["-c", "advice.detachedHead=false", "checkout", "-q", "-f", "--detach", job.run.revision])
    yield* git(["clean", "-q", "-ffdx", ...keep.flatMap((p) => ["-e", p])])
    // What `kiln gen` sets up locally, so the repository's own tools (type-aware lint) resolve ci.ts too.
    if (existsSync(join(src, ".kiln"))) link(join(src, ".kiln", "node_modules"), sdkPath)
    yield* log("kiln", `checked out ${job.run.revision.slice(0, 12)} in ${Date.now() - started} ms`)
  })

/** A snapshot only saves the next slot an install; failing to take one never fails the task. */
const remember = (slot: Workspace.Slot, deps: string) =>
  Workspace.remember(slot, deps).pipe(
    Effect.catch((error) =>
      Effect.gen(function*() {
        const { log } = yield* Job
        yield* log("kiln", `could not snapshot the slot: ${error.message}`)
      })
    ),
  )

type SetupDef = Extract<Step.Any["def"], { readonly _tag: "Setup" }>

const inShell = (job: StepJob, workspace: string, shell: Flake.FlakeRef | undefined, argv: ReadonlyArray<string>) => {
  if (shell === undefined) return argv
  // An agent's workspace is a shallow checkout, which Nix only takes when told so.
  const flake = job.run.flake === "" ? `git+file://${workspace}?rev=${job.run.revision}&shallow=1` : job.run.flake
  return ["nix", "develop", `${flake}#${Flake.attrPath(shell, job.run.system)}`, "--command", ...argv]
}

/**
 * Opens the job's slot for its key, checks out the revision keeping what the setup made, and runs
 * the setup when the slot doesn't start from a prepared copy, which then becomes the copy others
 * clone. Without a setup, the repository's `.ci/` stands in for it.
 */
const prepare = (job: StepJob, name: string, setup: SetupDef | undefined, legacyShell: Flake.FlakeRef | undefined) =>
  Effect.gen(function*() {
    const { log, remote } = yield* Job
    if (job.workspace === null) return yield* Effect.die(new Error(`${name} needs a workspace`))
    const opened = Date.now()
    const slot = yield* Workspace.open(isAbsolute(job.workspace) || remote === null ? job.workspace : join(remote.workspaces, job.workspace), job.deps)
    if (slot.restored) yield* log("kiln", `cloned a prepared workspace in ${Date.now() - opened} ms`)
    const workspace = slot.src
    yield* checkout(job, workspace, setup === undefined ? preserved(workspace) : setup.keep)
    const tmp = join(slot.cache, "tmp")
    mkdirSync(tmp, { recursive: true })
    const prelude = [
      "set -euo pipefail",
      `if [ -n "\${KILN_PATH:-}" ]; then export PATH="$KILN_PATH:$PATH"; fi`,
      ...(setup === undefined ? ["if [ -f .ci/environment ]; then source .ci/environment; fi"] : []),
    ].join("; ")
    const extraEnv: Record<string, string> = {
      ...setup?.env,
      KILN_PATH: (setup?.path ?? []).map((dir) => join(workspace, dir)).join(":"),
      TMPDIR: tmp,
      CI_CACHE_ROOT: slot.cache,
      CI_WORKSPACE_SLOT: job.workspace.split("/").at(-1) ?? "",
    }
    const command = setup === undefined
      ? existsSync(join(workspace, ".ci/setup")) ? [".ci/setup"] : null
      : Cmd.render(setup.run, {})
    if (slot.fresh && command !== null) {
      const started = Date.now()
      const exitCode = yield* Exec.stream(
        inShell(job, workspace, setup === undefined ? legacyShell : setup.shell, ["bash", "-c", `${prelude}; exec "$@"`, "kiln-setup", ...command]),
        { cwd: workspace, env: env(job.run, name, extraEnv) },
        (stream, line) => log(stream, line),
      )
      if (exitCode !== 0) {
        return { _tag: "Failed", result: toResult(Exit.fail(new Kiln.TaskFailed({ exitCode, failures: [] }))) } as const
      }
      yield* log("kiln", `set up in ${Math.round((Date.now() - started) / 1000)} s; other slots clone this one`)
    }
    if (slot.fresh && job.deps !== null) yield* remember(slot, job.deps)
    // The snapshot leaves temporary files out, which removes TMPDIR.
    mkdirSync(tmp, { recursive: true })
    return { _tag: "Ready", slot, workspace, prelude, extraEnv, fresh: slot.fresh && command !== null } as const
  })

/** A setup step: prepares its key's workspace unless a prepared copy exists. Its value says which. */
export const setup = (job: StepJob, step: Step.Any) =>
  Effect.gen(function*() {
    const def = step.def
    if (def._tag !== "Setup") return yield* Effect.die(new Error(`${step.name} is not a setup`))
    const prepared = yield* prepare(job, step.name, def, undefined)
    if (prepared._tag === "Failed") return prepared.result
    return toResult(Exit.succeed({ fresh: prepared.fresh }), { key: job.deps })
  })

const shardFiles = (files: ReadonlyArray<string>, index: number, count: number) =>
  [...files].sort().filter((_, i) => i % count === index - 1)

export const task = (job: StepJob, step: Step.Any, values: Record<string, unknown>) =>
  Effect.gen(function*() {
    const def = step.def
    if (def._tag !== "Task") return yield* Effect.die(new Error(`${step.name} is not a task`))
    const self = yield* Job
    const { emit, log, remote } = self
    const setup = def.setup?.def._tag === "Setup" ? def.setup.def : undefined
    const prepared = yield* prepare(job, step.name, setup, def.shell)
    if (prepared._tag === "Failed") return prepared.result
    const { workspace, prelude, extraEnv } = prepared
    if (remote !== null) yield* fetchInputs(self, values)

    const shard = job.shard ?? { index: 1, count: 1 }
    let files: ReadonlyArray<string> = job.files ?? []
    if (job.files === null && typeof def.run === "function" && def.shards?.split !== undefined) {
      const repo = yield* Repo.make(remote === null ? job.run.mirror : join(workspace, ".git"), job.run.revision)
      files = shardFiles(yield* paths(repo, def.shards.split), shard.index, shard.count)
    }
    const command = typeof def.run === "function" ? def.run({ index: shard.index, count: shard.count, files }) : def.run
    const argv = Cmd.render(command, values)

    const secretsDir = Object.keys(def.secrets).length > 0 ? mkdtempSync(join(tmpdir(), "kiln-secrets-")) : undefined
    const secretEnv: Record<string, string> = {}
    for (const [name, ref] of Object.entries(def.secrets)) {
      const value = job.secrets[ref.name]
      if (value === undefined) return yield* Effect.die(new Error(`secret ${ref.name} was not granted`))
      const path = join(secretsDir!, ref.name)
      writeFileSync(path, value, { mode: 0o600 })
      chmodSync(path, 0o600)
      secretEnv[name] = path
    }

    const full = inShell(job, workspace, def.shell, ["bash", "-c", `${prelude}; exec "$@"`, "kiln-task", ...argv])
    const taskEnv = env(job.run, step.name, {
      ...extraEnv,
      KILN_SHARD_INDEX: String(shard.index),
      KILN_SHARD_COUNT: String(shard.count),
      ...def.env,
      ...secretEnv,
    })

    let attempt = 0
    const once = Effect.gen(function*() {
      attempt += 1
      if (attempt > 1) yield* emit({ _tag: "Attempt", attempt, reason: "retry" })
      yield* log("kiln", `$ ${argv.join(" ")}`)
      const exitCode = yield* Exec.stream(full, { cwd: workspace, env: taskEnv }, (stream, line) => log(stream, line))
      let failures: ReadonlyArray<Kiln.TestFailure> = []
      if (def.report !== undefined) {
        const path = join(workspace, def.report.path)
        if (existsSync(path)) {
          const results = yield* Effect.try(() => Report.parse(def.report!, readFileSync(path, "utf8"))).pipe(
            Effect.tapError((e) => log("kiln", `could not read the report ${def.report!.path}: ${e}`)),
            Effect.orElseSucceed(() => []),
          )
          // Reporters name files by absolute path; the controller compares them with repository paths.
          const relative = (file: string | undefined) => (file === undefined ? null : file.startsWith(`${workspace}/`) ? file.slice(workspace.length + 1) : file)
          yield* emit({
            _tag: "Tests",
            results: results.map((r) => ({ ...r, file: relative(r.file), message: r.message ?? null })),
          })
          failures = Report.failures(results)
        } else {
          yield* log("kiln", `no report at ${def.report.path}`)
        }
      }
      if (exitCode !== 0) return yield* new Kiln.TaskFailed({ exitCode, failures })
    })
    const exit = yield* Effect.exit(withPolicies(once, step.policies))
    if (Exit.isFailure(exit)) return toResult(exit)

    const outputs: Record<string, string> = {}
    for (const [name, path] of Object.entries(def.outputs)) {
      const storeName = `${step.name}-${name}`.replace(/[^A-Za-z0-9+._?=-]/g, "-")
      outputs[name] = remote === null
        ? (yield* Exec.run(["nix", "store", "add", "--name", storeName, join(workspace, path)])).trim()
        : yield* upload(self, storeName, join(workspace, path))
    }
    return toResult(exit, { outputs })
  })

const storePath = /^\/nix\/store\/[a-z0-9]{32}-([^/]+)$/

/**
 * Makes the store paths a task interpolates valid on an agent's host: builds substitute from the
 * binary cache, outputs of tasks that ran on the controller's host come from there.
 */
const fetchInputs = (self: Job["Service"], values: Record<string, unknown>) =>
  Effect.forEach(Object.values(values), (value) =>
    Effect.gen(function*() {
      const match = typeof value === "string" ? storePath.exec(value) : null
      if (match === null || existsSync(value as string)) return
      const path = value as string
      if ((yield* Exec.exec(["nix-store", "--realise", path])).exitCode === 0) return
      const dir = mkdtempSync(join(tmpdir(), "kiln-input-"))
      const response = yield* Effect.tryPromise(() =>
        fetch(`${self.remote!.url}/store?path=${encodeURIComponent(path)}`, {
          headers: { Authorization: `Bearer ${self.id}:${self.token}` },
        })
      )
      if (!response.ok) return yield* Effect.die(new Error(`fetching ${path} failed: ${response.status}`))
      yield* Effect.tryPromise(() => Bun.write(join(dir, "input.tar"), response))
      yield* Exec.run(["tar", "-x", "-C", dir, "-f", join(dir, "input.tar")])
      const added = (yield* Exec.run(["nix", "store", "add", "--name", match[1]!, join(dir, match[1]!)])).trim()
      rmSync(dir, { recursive: true, force: true })
      if (added !== path) return yield* Effect.die(new Error(`${path} arrived as ${added}`))
    }), { discard: true })

/** Sends an output to the controller, which adds it to its store under the same content-addressed path. */
const upload = (self: Job["Service"], name: string, path: string) =>
  Effect.gen(function*() {
    const archive = join(mkdtempSync(join(tmpdir(), "kiln-output-")), "output.tar")
    yield* Exec.run(["tar", "-c", "-f", archive, "-C", dirname(path), basename(path)])
    const response = yield* Effect.tryPromise(() =>
      fetch(`${self.remote!.url}/outputs?name=${encodeURIComponent(name)}`, {
        method: "PUT",
        body: Bun.file(archive),
        headers: { Authorization: `Bearer ${self.id}:${self.token}` },
      })
    )
    const text = yield* Effect.tryPromise(() => response.text())
    rmSync(dirname(archive), { recursive: true, force: true })
    if (!response.ok) return yield* Effect.die(new Error(`uploading ${name} failed: ${response.status} ${text}`))
    return text.trim()
  })

// --------------------------------------------------------------------------------------------- action

const outcome = (o: Outcome | undefined, step: string): Step.Outcome<unknown, unknown> => {
  if (o === undefined) return { _tag: "Blocked", step }
  switch (o._tag) {
    case "Passed":
      return { _tag: "Passed", step, value: Values.decode(o.value) }
    case "Failed":
      return { _tag: "Failed", step, error: Values.decode(o.error) }
    case "Died":
      return { _tag: "Died", step, message: o.message }
    case "Blocked":
      return { _tag: "Blocked", step }
  }
}

/** The values the body sees: step values for plain needs, outcomes for `Step.exit` and `Step.exits`. */
const inputsOf = (needs: Step.Needs, job: StepJob) =>
  Object.fromEntries(
    Object.entries(needs).map(([key, need]) => {
      if ("_tag" in need && need._tag === "Exit") return [key, outcome(job.inputs[need.step.name], need.step.name)]
      if ("_tag" in need && need._tag === "Exits") return [key, need.steps.map((s) => outcome(job.inputs[s.name], s.name))]
      const step = need as Step.Any
      const o = job.inputs[step.name]
      return [key, o?._tag === "Passed" ? Values.decode(o.value) : undefined]
    }),
  )

const services = (job: StepJob, project: Kiln.Project, grants: Step.Grants) =>
  Effect.gen(function*() {
    const { client, id, token, log } = yield* Job
    const auth = { job: id, token }
    const rpc = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(reconnecting(effect))
    const run = job.run
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const descriptor = yield* Effect.cached(
      Exec.run(["nix", "eval", "--json", `${run.flake}#lib.project`]).pipe(
        Effect.map((s) => JSON.parse(s) as unknown),
        Effect.orDie,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    )

    let context = Context.make(CurrentRun, {
      id: run.id,
      project: run.project,
      revision: run.revision as Kiln.Sha,
      branch: run.branch ?? undefined,
      trust: run.trust,
      event: run.event,
      descriptor,
    })
    if (run.trust === "trusted") {
      context = context.pipe(
        Context.add(Git, { head: (branch) => rpc(client.gitHead({ ...auth, branch })).pipe(Effect.map((s) => s as Kiln.Sha)) }),
        Context.add(Gitea, {
          dispatch: (workflow, options) =>
            rpc(client.giteaDispatch({ ...auth, workflow, ref: options?.ref ?? null, inputs: { ...options?.inputs } })),
        }),
        Context.add(Cache, { publish: (path) => rpc(client.cachePublish({ ...auth, path })) }),
      )
    }
    if (run.event._tag === "PullRequest") {
      const pr = run.event
      context = context.pipe(Context.add(PullRequest, {
        number: pr.number,
        base: pr.base,
        head: pr.head,
        comment: (markdown) => rpc(client.pullRequestComment({ ...auth, markdown })),
      }))
    }
    // A check runs the pull-request rules without a pull request; its comments go to the log.
    if (run.event._tag === "Check") {
      context = context.pipe(Context.add(PullRequest, {
        number: 0,
        base: run.event.base,
        head: run.event.ref,
        comment: (markdown) => log("kiln", `pull request comment:\n${markdown}`),
      }))
    }
    if (grants.deploy === true && run.trust === "trusted") {
      context = context.pipe(Context.add(Fleet, {
        deploying: (projectName) =>
          Effect.acquireRelease(
            rpc(client.fleetAcquire({ ...auth, project: projectName })),
            () => rpc(client.fleetRelease(auth)),
          ).pipe(Effect.map((lease) =>
            lease._tag === "Replaced" ? lease : {
              _tag: "Held" as const,
              fence: lease.fence,
              targets: lease.targets.map((target) => ({
                host: target,
                preflight: (descriptor: unknown) =>
                  reconnecting(client.fleetPreflight({ ...auth, target, descriptor })).pipe(
                    Effect.catchTag("FleetRejected", (e) => Effect.fail(new Rejected({ target, status: e.status, reason: e.reason }))),
                    Effect.catchTag("Unauthorized", (e) => Effect.die(e)),
                    Effect.catchTag("RpcClientError", (e) => Effect.die(e)),
                  ),
                deploy: (release: { readonly revision: Kiln.Sha; readonly storePath: Kiln.StorePath }) =>
                  reconnecting(client.fleetDeploy({ ...auth, target, revision: release.revision, storePath: release.storePath })).pipe(
                    Effect.catchTag("FleetBusy", () => Effect.fail(new Busy({ target }))),
                    Effect.catchTag("FleetRejected", (e) => Effect.fail(new Rejected({ target, status: e.status, reason: e.reason }))),
                    Effect.catchTag("Unauthorized", (e) => Effect.die(e)),
                    Effect.catchTag("RpcClientError", (e) => Effect.die(e)),
                  ),
              })),
            }
          )),
      }))
    }
    if (run.trust === "trusted") {
      for (const name of grants.secrets ?? []) {
        const value = job.secrets[name]
        if (value === undefined) continue
        const dir = mkdtempSync(join(tmpdir(), "kiln-secret-"))
        const path = join(dir, name)
        writeFileSync(path, value, { mode: 0o600 })
        context = context.pipe(Context.add(Secret.tag(name), { value: Redacted.make(value), path }))
      }
    }
    const base = Layer.succeedContext(context).pipe(Layer.merge(FetchHttpClient.layer))
    // ci.ts was type-checked: Kiln.project only accepts rules whose services Base and the layer provide.
    return (project.layer === undefined ? base : Layer.provideMerge(project.layer, base)) as Layer.Layer<unknown, never, never>
  })

export const action = (job: StepJob, project: Kiln.Project, step: Step.Any) =>
  Effect.gen(function*() {
    const def = step.def
    if (def._tag !== "Action") return yield* Effect.die(new Error(`${step.name} is not an action`))
    const layer = yield* services(job, project, def.grants)
    const inputs = inputsOf(def.needs, job)
    const body = Effect.gen(() => def.body(inputs)) as Effect.Effect<unknown, unknown, never>
    const exit = yield* Effect.exit(Effect.scoped(withPolicies(body, step.policies)).pipe(Effect.provide(layer)))
    return toResult(exit)
  })

/** Decoded values of a task's interpolated steps, for `cmd`. */
export const values = (job: StepJob): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(job.inputs).flatMap(([name, o]) => (o._tag === "Passed" ? [[name, Values.decode(o.value)]] : [])),
  )
