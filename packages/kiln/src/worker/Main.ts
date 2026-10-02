import { Flake, Kiln } from "@kiln/core"
import { Cause, Effect } from "effect"
import { readFileSync } from "node:fs"
import type { Job as JobSpec, JobResult } from "../Protocol.ts"
import * as Client from "./Client.ts"
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

const step = (spec: Extract<JobSpec, { readonly _tag: "Step" }>) =>
  Effect.gen(function*() {
    const project = yield* Load.project(spec.run.kilnDir)
    const step = yield* Load.step(project, spec.step)
    const def = step.def
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

/** `kiln worker <job>`: fetches the job from the controller, runs it and reports the result. */
export const run = (id: string, options: { readonly socket: string; readonly tokenFile: string }) =>
  Effect.gen(function*() {
    const token = readFileSync(options.tokenFile, "utf8").trim()
    const job = yield* Client.make(id, token)
    const spec = yield* job.client.job({ job: id, token })
    const result: JobResult = yield* (spec._tag === "Plan" ? plan(spec) : step(spec)).pipe(
      Effect.provideService(Client.Job, job),
      Effect.catchCause((cause) => Effect.succeed({ _tag: "Died", message: Cause.pretty(cause) } satisfies JobResult)),
    )
    yield* job.flush
    yield* job.client.finish({ job: id, token, result })
  }).pipe(Effect.scoped, Effect.provide(Client.layerClient(options.socket)))
