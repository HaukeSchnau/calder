import { Attic, Busy, Cmd, CurrentRun, Flake, Fleet, Git, Gitea, Kiln, PullRequest, Rejected, Report, Secret, type Step } from "@kiln/core"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { link, sdkPath } from "../Gen.ts"
import type { Job as JobSpec, JobResult, Outcome, RunInfo } from "../Protocol.ts"
import * as Values from "../Values.ts"
import { Job } from "./Client.ts"
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

const preserved = (workspace: string): ReadonlyArray<string> => {
  const file = join(workspace, ".ci/preserve")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"))
}

/** Checks out the revision in the slot's checkout and removes everything `.ci/preserve` doesn't keep. */
const checkout = (job: StepJob, src: string) =>
  Effect.gen(function*() {
    const { log } = yield* Job
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "-C", src, ...args], { env: { ...process.env, ...Repo.gitEnv } })
    if (!existsSync(join(src, ".git"))) yield* git(["init", "-q"])
    const started = Date.now()
    yield* git(["fetch", "-q", "--no-tags", "--depth=1", job.run.mirror, job.run.revision])
    yield* git(["-c", "advice.detachedHead=false", "checkout", "-q", "-f", "--detach", job.run.revision])
    yield* git(["clean", "-q", "-ffdx", ...preserved(src).flatMap((p) => ["-e", p])])
    // What `kiln gen` sets up locally, so the repository's own tools (type-aware lint) resolve ci.ts too.
    if (existsSync(join(src, ".kiln"))) link(join(src, ".kiln", "node_modules"), sdkPath)
    yield* log("kiln", `checked out ${job.run.revision.slice(0, 12)} in ${Date.now() - started} ms`)
  })

const shardFiles = (files: ReadonlyArray<string>, index: number, count: number) =>
  [...files].sort().filter((_, i) => i % count === index - 1)

export const task = (job: StepJob, step: Step.Any, values: Record<string, unknown>) =>
  Effect.gen(function*() {
    const def = step.def
    if (def._tag !== "Task") return yield* Effect.die(new Error(`${step.name} is not a task`))
    const { emit, log } = yield* Job
    if (job.workspace === null) return yield* Effect.die(new Error("tasks need a workspace"))
    const opened = Date.now()
    const slot = yield* Workspace.open(job.workspace, job.deps)
    if (slot.restored) yield* log("kiln", `cloned a slot set up for these dependencies in ${Date.now() - opened} ms`)
    const workspace = slot.src
    yield* checkout(job, workspace)

    const shard = job.shard ?? { index: 1, count: 1 }
    let files: ReadonlyArray<string> = []
    if (typeof def.run === "function" && def.shards?.split !== undefined) {
      const repo = yield* Repo.make(job.run.mirror, job.run.revision)
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

    const inShell = (argv: ReadonlyArray<string>) =>
      def.shell === undefined ? argv : ["nix", "develop", `${job.run.flake}#${Flake.attrPath(def.shell, job.run.system)}`, "--command", ...argv]
    const environment = "set -euo pipefail; if [ -f .ci/environment ]; then source .ci/environment; fi"
    const full = inShell(["bash", "-c", `${environment}; exec "$@"`, "kiln-task", ...argv])
    const taskEnv = env(job.run, step.name, {
      CI_CACHE_ROOT: slot.cache,
      CI_WORKSPACE_SLOT: job.workspace.split("/").at(-1) ?? "",
      KILN_SHARD_INDEX: String(shard.index),
      KILN_SHARD_COUNT: String(shard.count),
      ...def.env,
      ...secretEnv,
    })

    // Setup runs once, before any attempt, so its result can become the slot snapshot others clone.
    if (existsSync(join(workspace, ".ci/setup"))) {
      const setupStarted = Date.now()
      const setupExit = yield* Exec.stream(
        inShell(["bash", "-c", `${environment}; .ci/setup`]),
        { cwd: workspace, env: taskEnv },
        (stream, line) => log(stream, line),
      )
      if (setupExit !== 0) return toResult(Exit.fail(new Kiln.TaskFailed({ exitCode: setupExit, failures: [] })))
      if (slot.fresh && job.deps !== null) {
        yield* Workspace.remember(slot, job.deps)
        yield* log("kiln", `set up dependencies in ${Math.round((Date.now() - setupStarted) / 1000)} s; other slots clone this one`)
      }
    } else if (slot.fresh && job.deps !== null) {
      yield* Workspace.remember(slot, job.deps)
    }

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
          yield* emit({
            _tag: "Tests",
            results: results.map((r) => ({ ...r, file: r.file ?? null, message: r.message ?? null })),
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
      const added = yield* Exec.run(["nix", "store", "add", "--name", `${step.name}-${name}`.replace(/[^A-Za-z0-9+._?=-]/g, "-"), join(workspace, path)])
      outputs[name] = added.trim()
    }
    return toResult(exit, { outputs })
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
    const { client, id, token } = yield* Job
    const auth = { job: id, token }
    const rpc = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect)
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
        Context.add(Attic, { push: (path) => rpc(client.atticPush({ ...auth, path })) }),
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
                  client.fleetPreflight({ ...auth, target, descriptor }).pipe(
                    Effect.catchTag("FleetRejected", (e) => Effect.fail(new Rejected({ target, status: e.status, reason: e.reason }))),
                    Effect.catchTag("Unauthorized", (e) => Effect.die(e)),
                    Effect.catchTag("RpcClientError", (e) => Effect.die(e)),
                  ),
                deploy: (release: { readonly revision: Kiln.Sha; readonly storePath: Kiln.StorePath }) =>
                  client.fleetDeploy({ ...auth, target, revision: release.revision, storePath: release.storePath }).pipe(
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
