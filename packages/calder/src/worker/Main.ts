import { Flake, Calder } from "@calder-ci/core"
import { Cause, Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { link, sdkPath } from "../Gen.ts"
import type { Job as JobSpec, JobResult, PlanSpec } from "../Protocol.ts"
import * as Client from "./Client.ts"
import * as Egress from "./Egress.ts"
import * as Load from "./Load.ts"
import * as Redact from "./Redact.ts"
import * as Repo from "./Repo.ts"
import { FetchEnv, lock as lockFile, resolve } from "./Resolve.ts"
import * as Steps from "./Steps.ts"

const plan = (spec: Extract<JobSpec, { readonly _tag: "Plan" }>) =>
  Effect.gen(function*() {
    const project = yield* Load.project(spec.run.pipelineDir)
    const planned = yield* Calder.plan(project, spec.run.event, { requiredChecks: spec.requiredChecks })
    // Nothing to run (a push to a branch no rule names): skip evaluating the flake.
    if (planned.steps.length === 0) {
      const empty: PlanSpec = { version: 1, app: null, trust: planned.trust, reuse: planned.reuse, schedules: planned.schedules, pushes: planned.pushes, steps: [] }
      return { _tag: "Planned", plan: empty } satisfies JobResult
    }
    const repo = yield* Repo.make(spec.run.mirror, spec.run.revision)
    const plan = yield* resolve(planned, project, spec.run, repo, spec.earlier ?? undefined, { records: spec.records, audit: spec.audit })
    return { _tag: "Planned", plan } satisfies JobResult
  }).pipe(
    Effect.catchTags({
      LoadFailed: (e) => Effect.succeed({ _tag: "PlanFailed", message: e.message } satisfies JobResult),
      PlanError: (e) => Effect.succeed({ _tag: "PlanFailed", message: e.message } satisfies JobResult),
    }),
  )

/** An agent's worker extracts the revision's `.calder/` itself, once per revision. */
const pipelineDir = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    const job = yield* Client.Job
    if (job.remote === null) return spec.run.pipelineDir
    const root = join(job.remote.workspaces, ".revs", spec.run.project, spec.run.revision)
    if (existsSync(join(root, ".calder", "ci.ts"))) return join(root, ".calder")
    const scratch = `${root}.${job.id}`
    mkdirSync(scratch, { recursive: true })
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "--git-dir", join(scratch, "git"), ...args], { env: Client.gitEnv(job) })
    yield* git(["init", "-q", "--bare"])
    yield* Client.fetching(git(["fetch", "-q", "--no-tags", "--depth=1", spec.run.mirror, spec.run.revision]))
    yield* git(["archive", `--output=${join(scratch, "pipeline.tar")}`, spec.run.revision, ".calder"])
    yield* Exec.run(["tar", "-x", "-C", scratch, "-f", join(scratch, "pipeline.tar")])
    rmSync(join(scratch, "git"), { recursive: true, force: true })
    link(join(scratch, ".calder", "node_modules"), sdkPath)
    if (existsSync(root)) rmSync(scratch, { recursive: true, force: true })
    else renameSync(scratch, root)
    return join(root, ".calder")
  })

/**
 * The run as an evaluator agent's worker evaluates it: from a full mirror of the project in the agent's
 * workspaces, fetched from the controller, so Nix gets the same source, `lastModified` and `revCount`, and
 * so the same derivations, as from the controller's mirror. A shallow copy would lack `revCount`.
 */
export const evaluatedRun = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    const job = yield* Client.Job
    if (job.remote === null) return spec.run
    const dir = join(job.remote.workspaces, ".mirrors")
    mkdirSync(dir, { recursive: true })
    const mirror = join(dir, `${spec.run.project}.git`)
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "--git-dir", mirror, ...args], { env: Client.gitEnv(job) })
    // Jobs of one project share the mirror; a fetch holds it.
    yield* Effect.acquireRelease(lockFile(`${mirror}.lock`), (path) => Effect.sync(() => rmSync(path, { force: true })))
    if (!existsSync(join(mirror, "HEAD"))) {
      yield* git(["init", "-q", "--bare"])
      // Objects of every revision fetched stay, though no ref points at them.
      yield* git(["config", "gc.auto", "0"])
    }
    const has = yield* git(["cat-file", "-e", `${spec.run.revision}^{commit}`]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
    // One ref, moved to the latest revision fetched, so the next fetch sends only what is new: Nix
    // evaluates a commit by its id, and the mirror never collects garbage.
    if (!has) yield* Client.fetching(git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", spec.run.mirror, `+${spec.run.revision}:refs/calder/last`]))
    return { ...spec.run, mirror, flake: `git+file://${mirror}?rev=${spec.run.revision}` }
  }).pipe(Effect.scoped)

export const step = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    // An evaluation runs no ci.ts, only Calder's evaluator, so nothing of a pull request's code runs in
    // its worker: what it records counts like a trusted run's when it ran on an evaluator agent.
    if (spec.evaluate !== undefined) {
      const job = yield* Client.Job
      const run = yield* evaluatedRun(spec)
      // Nix fetches the flake's forge inputs from the controller's mirrors, like a local evaluation.
      const fetching = job.remote === null ? {} : Client.evaluationEnv(spec.run.mirrors, job)
      return yield* Steps.evaluate({ ...spec, run }, spec.evaluate).pipe(Effect.provideService(FetchEnv, fetching))
    }
    const project = yield* Load.project(yield* pipelineDir(spec).pipe(Effect.orDie))
    const step = yield* Load.step(project, spec.step)
    const def = step.def
    if ((yield* Client.Job).remote !== null && def._tag !== "Task" && def._tag !== "Setup") {
      return { _tag: "Died", message: "agents only run tasks and setups" } satisfies JobResult
    }
    switch (def._tag) {
      case "Build":
        return yield* Steps.build(spec, step, Flake.attrPath(def.ref, spec.run.system))
      case "Setup":
        return yield* Steps.setup(spec, step)
      case "Task":
        return yield* Steps.task(spec, step, Steps.values(spec))
      case "Action":
        return yield* Steps.action(spec, project, step)
      case "Output":
        return { _tag: "Died", message: "outputs are resolved by the controller" } satisfies JobResult
    }
  }).pipe(Effect.catchTag("LoadFailed", (e) => Effect.succeed({ _tag: "Died", message: e.message } satisfies JobResult)))

/**
 * `calder worker <job>`: fetches the job from the controller, runs it and reports the result. Local
 * workers use the socket and a token file; an agent hands its workers the controller's URL and the token.
 */
export const run = (
  id: string,
  options: { readonly socket: string; readonly tokenFile: string } | { readonly remote: Client.Remote; readonly token: string },
) =>
  Effect.gen(function*() {
    // An agent hands its worker the job's token in CALDER_TOKEN, and the job's commands inherit the
    // worker's environment.
    delete process.env.CALDER_TOKEN
    if (process.env.CALDER_EGRESS !== undefined) yield* Egress.bridge(process.env.CALDER_EGRESS)
    const remote = "remote" in options ? options.remote : null
    const token = "token" in options ? options.token : readFileSync(options.tokenFile, "utf8").trim()
    const connected = yield* Client.make(id, token, remote)
    const spec = yield* Client.reconnecting(connected.client.job({ job: id, token }))
    Object.assign(process.env, Repo.insteadOf(spec.run.mirrors))
    // Nothing the job prints, says or fails with leaves the worker with its secrets or its token in it.
    const redact = Redact.make([...(spec._tag === "Step" ? Object.values(spec.secrets) : []), token])
    const job: Client.Job["Service"] = {
      ...connected,
      client: {
        ...connected.client,
        pullRequestComment: (payload) => connected.client.pullRequestComment({ ...payload, markdown: redact(payload.markdown) }),
        giteaDispatch: (payload) =>
          connected.client.giteaDispatch({ ...payload, inputs: Object.fromEntries(Object.entries(payload.inputs).map(([k, v]) => [k, redact(v)])) }),
      },
      emit: (event) => connected.emit(Redact.event(redact, event)),
      log: (stream, text) => connected.log(stream, redact(text)),
      redact,
    }
    const result: JobResult = yield* (spec._tag === "Plan" ? plan(spec) : step(spec)).pipe(
      Effect.provideService(Client.Job, job),
      Effect.catchCause((cause) => Effect.succeed({ _tag: "Died", message: Cause.pretty(cause) } satisfies JobResult)),
    )
    yield* job.flush
    yield* Client.reconnecting(job.client.finish({ job: id, token, result: Redact.result(redact, result) }))
  }).pipe(Effect.scoped, Effect.provide("remote" in options ? Client.layerClientRemote(options.remote) : Client.layerClient(options.socket)))
