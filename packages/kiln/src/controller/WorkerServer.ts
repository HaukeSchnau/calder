import { BunSocketServer } from "@effect/platform-bun"
import type { Domain } from "@kiln/api"
import { Deferred, Effect, Layer, References, Schedule } from "effect"
import { HttpClient } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { FleetRejected, Unauthorized, WorkerRpcs } from "../Protocol.ts"
import { Config } from "./Config.ts"
import * as Fleet from "./Fleet.ts"
import { Gitea } from "./Gitea.ts"
import { type ActiveJob, Jobs } from "./Jobs.ts"
import { Leases } from "./Leases.ts"
import * as Rows from "./Rows.ts"

const handlers = WorkerRpcs.toLayer(Effect.gen(function*() {
  const config = yield* Config
  const jobs = yield* Jobs
  const leases = yield* Leases
  const fleet = yield* Fleet.Fleet
  const gitea = yield* Gitea
  const sql = yield* SqlClient.SqlClient
  const http = yield* HttpClient.HttpClient
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)

  const refuse = (reason: string) => Effect.fail(new Unauthorized({ reason }))

  /** The job and its run, for calls only steps of trusted runs may make. */
  const trusted = (job: string, token: string) =>
    Effect.gen(function*() {
      const active = yield* jobs.authorize(job, token)
      if (active.spec._tag !== "Step" || active.spec.run.trust !== "trusted") return yield* refuse("only steps of trusted runs may do this")
      return active
    })

  /** An action of a trusted run that declared `grants: { deploy: true }`. */
  const deployer = (job: string, token: string) =>
    Effect.gen(function*() {
      const active = yield* trusted(job, token)
      if (active.spec._tag !== "Step") return yield* refuse("not a step")
      const row = yield* db(Rows.loadStep(active.spec.run.id, active.spec.step))
      if (row === undefined || Rows.spec(row).action?.deploy !== true) return yield* refuse(`${active.spec.step} has no deploy grant`)
      return active
    })

  const runOf = (active: ActiveJob) => active.spec.run

  const holding = (active: ActiveJob) =>
    active.lease === undefined
      ? refuse("deploy calls need the project's lease (Fleet.deploying)")
      : Effect.succeed({ project: active.lease, fence: leases.fenceOf(active.lease, active.id) })

  const targetUrl = (project: string, host: string) =>
    config.projects[project]?.targets.find((t) => Fleet.hostOf(t) === host)

  return {
    job: ({ job, token }) => Effect.map(jobs.authorize(job, token), (active) => active.spec),
    events: ({ job, token, events }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        yield* Effect.forEach(events, active.onEvent, { discard: true })
      }),
    finish: ({ job, token, result }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        if (active.lease !== undefined) yield* leases.release(active.lease, active.id)
        active.lease = undefined
        yield* Deferred.succeed(active.result, result)
      }),
    gitHead: ({ job, token, branch }) =>
      Effect.gen(function*() {
        const active = yield* trusted(job, token)
        return yield* gitea.head(config.projects[runOf(active).project]!.repo, branch)
      }),
    giteaDispatch: ({ job, token, workflow, ref, inputs }) =>
      Effect.gen(function*() {
        const active = yield* trusted(job, token)
        const run = runOf(active)
        yield* gitea.dispatch(config.projects[run.project]!.repo, workflow, ref ?? run.branch ?? config.projects[run.project]!.defaultBranch, inputs)
      }),
    atticPush: ({ job, token, path }) =>
      Effect.gen(function*() {
        yield* trusted(job, token)
        const hash = /^\/nix\/store\/([a-z0-9]{32})-/.exec(path)?.[1]
        if (hash === undefined) return yield* Effect.die(new Error(`not a store path: ${path}`))
        const url = `${config.cacheUrl.replace(/\/$/, "")}/${hash}.narinfo`
        yield* http.head(url).pipe(
          Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail(new Error(`${url} answered ${r.status}`)))),
          Effect.retry({ schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })) }),
          Effect.orDie,
        )
      }),
    pullRequestComment: ({ job, token, markdown }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        if (active.spec._tag !== "Step") return yield* refuse("not a step")
        const run = runOf(active)
        const event = run.event as Domain.Event
        if (event._tag !== "PullRequest") return yield* refuse("not a pull-request run")
        const step = active.spec.step
        const existing = yield* db(sql<{ comment_id: number }>`select comment_id from comments
          where project = ${run.project} and pr = ${event.number} and step = ${step}`)
        const body = `${markdown}\n\n<sub>Kiln · ${step} · [run ${run.number}](${config.publicUrl.replace(/\/$/, "")}/#/run/${run.id})</sub>`
        const id = yield* gitea.comment(config.projects[run.project]!.repo, event.number, body, existing[0]?.comment_id ?? null)
        yield* db(sql`insert into comments (project, pr, step, comment_id) values (${run.project}, ${event.number}, ${step}, ${id})
          on conflict (project, pr, step) do update set comment_id = ${id}`)
      }),
    fleetAcquire: ({ job, token, project }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        const run = runOf(active)
        if (project !== run.project) return yield* refuse(`a run of ${run.project} can't deploy ${project}`)
        const grant = yield* leases.acquire(project, { job: active.id, run: run.number })
        if (grant._tag === "Replaced") return grant
        active.lease = project
        return { _tag: "Held" as const, fence: grant.fence, targets: config.projects[project]!.targets.map(Fleet.hostOf) }
      }),
    fleetRelease: ({ job, token }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        if (active.lease !== undefined) yield* leases.release(active.lease, active.id)
        active.lease = undefined
      }),
    fleetPreflight: ({ job, token, target, descriptor }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        const { project } = yield* holding(active)
        const url = targetUrl(project, target)
        if (url === undefined) return yield* new FleetRejected({ target, status: 0, reason: `${target} is not a target of ${project}` })
        const run = runOf(active)
        const parent = yield* stepSpan(run.id, active)
        yield* fleet.preflight(url, project, descriptor, parent)
      }),
    fleetDeploy: ({ job, token, target, revision, storePath }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        const { project, fence } = yield* holding(active)
        if (fence === undefined) return yield* refuse("the lease was lost")
        const url = targetUrl(project, target)
        if (url === undefined) return yield* new FleetRejected({ target, status: 0, reason: `${target} is not a target of ${project}` })
        const run = runOf(active)
        if (revision !== run.revision) return yield* refuse("a run may only deploy its own revision")
        const parent = yield* stepSpan(run.id, active)
        yield* fleet.deploy(url, project, { revision, storePath, fence }, parent)
        yield* db(sql`insert into deployments (project, host, revision, store_path, run_id, at)
          values (${project}, ${target}, ${revision}, ${storePath}, ${run.id}, ${Date.now()})`)
      }),
  }

  function stepSpan(runId: string, active: ActiveJob) {
    return Effect.gen(function*() {
      const run = yield* db(Rows.loadRun(runId))
      const step = active.spec._tag === "Step" ? yield* db(Rows.loadStep(runId, active.spec.step)) : undefined
      return { traceId: run?.trace_id ?? "", spanId: step?.span_id ?? run?.span_id ?? "" }
    })
  }
}))

export const layer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* Config
  const path = join(config.runtimeDir, "worker.sock")
  if (existsSync(path)) rmSync(path)
  const permissions = Layer.effectDiscard(Effect.sync(() => {
    chmodSync(path, 0o660)
    const group = readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith("kiln-workers:"))
    if (group !== undefined) chownSync(path, process.getuid!(), Number(group.split(":")[2]))
  }))
  const server = RpcServer.layer(WorkerRpcs).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
  )
  // Workers exit right after reporting, which resets their connection; that's not worth an error log.
  return Layer.provideMerge(permissions, server).pipe(
    Layer.provide(BunSocketServer.layer({ path })),
    Layer.provide(Layer.succeed(References.UnhandledLogLevel, "Debug")),
  )
}))
