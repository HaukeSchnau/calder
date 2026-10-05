import { Flake, Kiln } from "@kiln/core"
import { Cause, Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Exec from "../Exec.ts"
import { link, sdkPath } from "../Gen.ts"
import type { Job as JobSpec, JobResult } from "../Protocol.ts"
import * as Client from "./Client.ts"
import * as Egress from "./Egress.ts"
import * as Load from "./Load.ts"
import * as Repo from "./Repo.ts"
import { resolve } from "./Resolve.ts"
import * as Steps from "./Steps.ts"

const plan = (spec: Extract<JobSpec, { readonly _tag: "Plan" }>) =>
  Effect.gen(function*() {
    const project = yield* Load.project(spec.run.kilnDir)
    const planned = yield* Kiln.plan(project, spec.run.event, { requiredChecks: spec.requiredChecks })
    const repo = yield* Repo.make(spec.run.mirror, spec.run.revision)
    return { _tag: "Planned", plan: yield* resolve(planned, project, spec.run, repo) } satisfies JobResult
  }).pipe(
    Effect.catchTags({
      LoadFailed: (e) => Effect.succeed({ _tag: "PlanFailed", message: e.message } satisfies JobResult),
      PlanError: (e) => Effect.succeed({ _tag: "PlanFailed", message: e.message } satisfies JobResult),
    }),
  )

/** An agent's worker extracts the revision's `.kiln/` itself, once per revision. */
const kilnDir = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    const job = yield* Client.Job
    if (job.remote === null) return spec.run.kilnDir
    const root = join(job.remote.workspaces, ".revs", spec.run.project, spec.run.revision)
    if (existsSync(join(root, ".kiln", "ci.ts"))) return join(root, ".kiln")
    const scratch = `${root}.${job.id}`
    mkdirSync(scratch, { recursive: true })
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "--git-dir", join(scratch, "git"), ...args], { env: Client.gitEnv(job) })
    yield* git(["init", "-q", "--bare"])
    yield* git(["fetch", "-q", "--no-tags", "--depth=1", spec.run.mirror, spec.run.revision])
    yield* git(["archive", `--output=${join(scratch, "kiln.tar")}`, spec.run.revision, ".kiln"])
    yield* Exec.run(["tar", "-x", "-C", scratch, "-f", join(scratch, "kiln.tar")])
    rmSync(join(scratch, "git"), { recursive: true, force: true })
    link(join(scratch, ".kiln", "node_modules"), sdkPath)
    if (existsSync(root)) rmSync(scratch, { recursive: true, force: true })
    else renameSync(scratch, root)
    return join(root, ".kiln")
  })

const step = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    const project = yield* Load.project(yield* kilnDir(spec).pipe(Effect.orDie))
    const step = yield* Load.step(project, spec.step)
    const def = step.def
    if ((yield* Client.Job).remote !== null && def._tag !== "Task") {
      return { _tag: "Died", message: "agents only run tasks" } satisfies JobResult
    }
    switch (def._tag) {
      case "Build":
        return yield* Steps.build(spec, step, Flake.attrPath(def.ref, spec.run.system))
      case "Task":
        return yield* Steps.task(spec, step, Steps.values(spec))
      case "Action":
        return yield* Steps.action(spec, project, step)
      case "Output":
        return { _tag: "Died", message: "outputs are resolved by the controller" } satisfies JobResult
    }
  }).pipe(Effect.catchTag("LoadFailed", (e) => Effect.succeed({ _tag: "Died", message: e.message } satisfies JobResult)))

/**
 * `kiln worker <job>`: fetches the job from the controller, runs it and reports the result. Local
 * workers use the socket and a token file; an agent hands its workers the controller's URL and the token.
 */
export const run = (
  id: string,
  options: { readonly socket: string; readonly tokenFile: string } | { readonly remote: Client.Remote; readonly token: string },
) =>
  Effect.gen(function*() {
    if (process.env.KILN_EGRESS !== undefined) yield* Egress.bridge(process.env.KILN_EGRESS)
    const remote = "remote" in options ? options.remote : null
    const token = "token" in options ? options.token : readFileSync(options.tokenFile, "utf8").trim()
    const job = yield* Client.make(id, token, remote)
    const spec = yield* Client.reconnecting(job.client.job({ job: id, token }))
    const result: JobResult = yield* (spec._tag === "Plan" ? plan(spec) : step(spec)).pipe(
      Effect.provideService(Client.Job, job),
      Effect.catchCause((cause) => Effect.succeed({ _tag: "Died", message: Cause.pretty(cause) } satisfies JobResult)),
    )
    yield* job.flush
    yield* Client.reconnecting(job.client.finish({ job: id, token, result }))
  }).pipe(Effect.scoped, Effect.provide("remote" in options ? Client.layerClientRemote(options.remote) : Client.layerClient(options.socket)))
