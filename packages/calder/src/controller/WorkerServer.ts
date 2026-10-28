import { BunSocketServer } from "@effect/platform-bun"
import type { Domain } from "@calder-ci/api"
import { Deferred, Effect, Layer, References, Scope } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { chmodSync, chownSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { FleetRejected, type RunInfo, Unauthorized, WorkerRpcs } from "../Protocol.ts"
import * as Cache from "./Cache.ts"
import { Comments } from "./Comments.ts"
import { Config } from "./Config.ts"
import * as Fleet from "./Fleet.ts"
import { Gitea } from "./Gitea.ts"
import { type ActiveJob, Jobs, workersGroup } from "./Jobs.ts"
import { Leases } from "./Leases.ts"
import { Live } from "./Live.ts"
import { Projects } from "./Projects.ts"
import * as Rows from "./Rows.ts"

/**
 * Which lease a deploy takes, and which branch's head its run must still be. A task deploys its
 * branch's head, so a run of another revision gives way when its turn comes, a rerun of an older one
 * included; a manual or scheduled run's branch is the default branch, so `calder trigger` of another
 * branch's head deploys nothing. A pull request's previews and their removal take the pull request's own
 * lease, so they take turns without waiting for the project's deploys, and removing one deploys nothing.
 * Actions (`Release.promote`) check the head themselves.
 */
export const leaseOf = (run: RunInfo, task: boolean) => {
  const event = run.event
  const pr = task && (event._tag === "PullRequest" || event._tag === "PullRequestClosed") ? event.number : undefined
  return {
    key: pr === undefined ? run.project : `${run.project}#pr-${pr}`,
    branch: task && event._tag !== "PullRequestClosed" ? run.branch : null,
  }
}

export const handlers = WorkerRpcs.toLayer(Effect.gen(function*() {
  const config = yield* Config
  const jobs = yield* Jobs
  const leases = yield* Leases
  const fleet = yield* Fleet.Fleet
  const live = yield* Live
  const gitea = yield* Gitea
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const cache = yield* Cache.Cache
  const comments = yield* Comments
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

  /** An action of a trusted run that declared `grants: { deploy: true }`, or a task with `lease: true`. */
  const deployer = (job: string, token: string) =>
    Effect.gen(function*() {
      const active = yield* trusted(job, token)
      if (active.spec._tag !== "Step") return yield* refuse("not a step")
      const row = yield* db(Rows.loadStep(active.spec.run.id, active.spec.step))
      const spec = row === undefined ? undefined : Rows.spec(row)
      if (spec?.action?.deploy !== true && spec?.task?.lease !== true) return yield* refuse(`${active.spec.step} has no deploy grant`)
      return active
    })

  const runOf = (active: ActiveJob) => active.spec.run

  const holding = (active: ActiveJob) => {
    const lease = active.lease
    if (lease === undefined) return refuse("deploy calls need the project's lease (Fleet.deploying)")
    if (lease.targets === null) return refuse("a task's lease has no promotion endpoints")
    return Effect.succeed({ ...lease, targets: lease.targets, fence: leases.fenceOf(lease.project, active.id) })
  }

  const targetUrl = (targets: ReadonlyArray<string>, host: string) => targets.find((t) => Fleet.hostOf(t) === host)

  /** The app a run's release deploys as: what its flake declares, else the project's name. */
  const appOf = (runId: string, project: string) =>
    Effect.map(db(Rows.loadRun(runId)), (row) => (row?.plan ? (JSON.parse(row.plan) as { app?: string | null }).app : null) ?? project)

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
        yield* Deferred.succeed(active.result, result)
      }),
    gitHead: ({ job, token, branch }) =>
      Effect.gen(function*() {
        const active = yield* trusted(job, token)
        return yield* gitea.head(projects.get(runOf(active).project)!.repo, branch)
      }),
    giteaDispatch: ({ job, token, workflow, ref, inputs }) =>
      Effect.gen(function*() {
        const active = yield* trusted(job, token)
        const run = runOf(active)
        const project = projects.get(run.project)!
        yield* gitea.dispatch(project.repo, workflow, ref ?? run.branch ?? project.defaultBranch, inputs)
      }),
    cachePublish: ({ job, token, path, artifact }) =>
      Effect.gen(function*() {
        const active = yield* trusted(job, token)
        if (Cache.hashOf(path) === undefined) return yield* Effect.die(new Error(`not a store path: ${path}`))
        const lease = active.lease
        if (lease === undefined || active.spec._tag !== "Step") return
        // A task's stack decides where it deploys, so the artifacts it declares always go to the cache,
        // each kept as that artifact's release of the step; a pull request's previews keep none. A
        // promotion's targets say whether a host other than this one substitutes the release.
        const task = lease.targets === null
        if (!task && !Cache.leavesHost(lease.targets!, config.host)) return
        const project = active.spec.run.project
        const pin = !task ? project
          : lease.project === project && artifact !== undefined ? Cache.pinName(`${project}-${active.spec.step}-${artifact}`)
          : undefined
        yield* cache.publish(path, { ...(pin === undefined ? {} : { pin }), urgent: task }).pipe(
          Effect.mapError((e) => new Error(`publishing ${path} to the binary cache failed: ${e.message}`)),
          Effect.orDie,
        )
        if (!(yield* cache.has(path))) return yield* Effect.die(new Error(`${path} is not in the binary cache after publishing`))
      }),
    pullRequestComment: ({ job, token, markdown }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        if (active.spec._tag !== "Step") return yield* refuse("not a step")
        const run = runOf(active)
        const event = run.event as Domain.Event
        if (event._tag !== "PullRequest") return yield* refuse("not a pull-request run")
        yield* comments.note(run.id, active.spec.step, markdown)
      }),
    fleetAcquire: ({ job, token, project }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        if (active.spec._tag !== "Step") return yield* refuse("not a step")
        const { run, step } = active.spec
        if (project !== run.project) return yield* refuse(`a run of ${run.project} can't deploy ${project}`)
        const row = yield* db(Rows.loadStep(run.id, step))
        const task = row !== undefined && Rows.spec(row).task?.lease === true
        const { key, branch } = leaseOf(run, task)
        const stale = branch === null ? undefined : gitea.head(projects.get(project)!.repo, branch).pipe(
          Effect.map((head) => (head === run.revision ? undefined : head)),
          // Gitea not answering doesn't stop deploys; the worker looks at the head again before it runs.
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        const holder = leases.holder(key)
        const reason = holder === undefined || holder.job === active.id ? null : `the deploy lease, which #${holder.run} ${holder.step} holds`
        const waits = (text: string | null) => db(sql`update steps set waiting = ${text} where run_id = ${run.id} and name = ${step}`)
        if (reason !== null) yield* waits(reason)
        const grant = yield* Effect.uninterruptibleMask((restore) =>
          restore(leases.acquire(key, { job: active.id, run: run.number, step, ...(stale === undefined ? {} : { stale }) })).pipe(
            // Released when the job ends, however it ends, and at once if it already has.
            Effect.tap((grant) => grant._tag === "Held" ? Scope.addFinalizer(active.scope, leases.release(key, active.id)) : Effect.void),
          )
        )
        if (reason !== null) yield* waits(null)
        if (grant._tag !== "Held") return grant
        // A task deploys through its own tool, such as an Alchemy stack, so the promotion endpoints don't
        // matter to it: asking them would wait up to a minute for one that doesn't answer.
        if (task) {
          active.lease = { project: key, app: project, targets: null }
          return { _tag: "Held" as const, fence: grant.fence, targets: [], unreachable: [] }
        }
        const app = yield* appOf(run.id, project)
        const { targets, unreachable } = yield* fleet.deployTargets(projects.get(project)!, app)
        active.lease = { project, app, targets }
        return { _tag: "Held" as const, fence: grant.fence, targets: targets.map(Fleet.hostOf), unreachable: unreachable.map(Fleet.hostOf) }
      }),
    fleetRelease: ({ job, token }) =>
      Effect.gen(function*() {
        const active = yield* jobs.authorize(job, token)
        if (active.lease !== undefined) yield* leases.release(active.lease.project, active.id)
        active.lease = undefined
      }),
    fleetPreflight: ({ job, token, target, descriptor }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        const { project, app, targets } = yield* holding(active)
        const url = targetUrl(targets, target)
        if (url === undefined) return yield* new FleetRejected({ target, status: 0, reason: `${target} is not a target of ${project}` })
        const run = runOf(active)
        const parent = yield* stepSpan(run.id, active)
        yield* fleet.preflight(url, app, descriptor, parent)
      }),
    fleetDeploy: ({ job, token, target, revision, storePath }) =>
      Effect.gen(function*() {
        const active = yield* deployer(job, token)
        const { project, app, targets, fence } = yield* holding(active)
        if (fence === undefined) return yield* refuse("the lease was lost")
        const url = targetUrl(targets, target)
        if (url === undefined) return yield* new FleetRejected({ target, status: 0, reason: `${target} is not a target of ${project}` })
        const run = runOf(active)
        if (revision !== run.revision) return yield* refuse("a run may only deploy its own revision")
        const parent = yield* stepSpan(run.id, active)
        yield* fleet.deploy(url, app, { revision, storePath, fence }, parent)
        const row: Rows.DeploymentRow = { project, host: target, revision, store_path: storePath, run_id: run.id, at: Date.now() }
        yield* db(sql`insert into deployments ${sql.insert(row)}`)
        yield* live.publish({ _tag: "DeploymentRecorded", record: Rows.deployment(row) })
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
    const group = workersGroup(config.jobs.mode)
    if (group !== undefined) chownSync(path, process.getuid!(), group)
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
