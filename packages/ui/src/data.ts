import type { Domain } from "@kiln/api"
import { type Duration, Effect, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { Kiln } from "./client.ts"

const reload = Symbol("reload")
type Next<A> = A | typeof reload

/** Re-subscribes after the socket drops. Other failures, such as `NotFound`, reach the view. */
const retryWhileOffline = <A, E, R>(self: Stream.Stream<A, E | RpcClientError, R>): Stream.Stream<A, Exclude<E, RpcClientError>, R> =>
  Stream.catchIf<A, E | RpcClientError, R, RpcClientError, A, Exclude<E, RpcClientError>, R>(
    self,
    (e): e is RpcClientError => e instanceof RpcClientError,
    () => Stream.fromEffect(Effect.sleep("1500 millis")).pipe(Stream.flatMap(() => retryWhileOffline(self))),
  )

/**
 * A view the controller keeps current: subscribe to `changes` first so nothing slips between the
 * snapshot and the stream, load the snapshot, then fold every change into it. `reload` from `apply`
 * refetches, and `resync` refetches periodically for what changes don't carry, such as slot use.
 */
function live<A, E>(
  load: Effect.Effect<A, E | RpcClientError, Kiln>,
  apply: (current: A, change: Domain.Change) => Next<A>,
  resync?: Duration.Input,
): Stream.Stream<A, Exclude<E, RpcClientError>, Kiln> {
  const connected = Stream.unwrap(Effect.gen(function*() {
    const kiln = yield* Kiln
    const changes = yield* kiln("changes", undefined, { asQueue: true })
    const initial = yield* load
    const ticks: Stream.Stream<typeof reload> = resync === undefined ? Stream.empty : Stream.tick(resync).pipe(Stream.drop(1), Stream.map((): typeof reload => reload))
    return Stream.fromQueue(changes).pipe(
      Stream.merge(ticks),
      Stream.scanEffect(() => initial, (current, message: Domain.Change | typeof reload) => {
        const next = message === reload ? reload : apply(current, message)
        return next === reload ? load : Effect.succeed(next)
      }),
      Stream.changesWith((a, b) => a === b),
    )
  }))
  return retryWhileOffline(connected)
}

function poll<A, E>(load: Effect.Effect<A, E | RpcClientError, Kiln>, every: Duration.Input | null): Stream.Stream<A, Exclude<E, RpcClientError>, Kiln> {
  const stream = every === null ? Stream.fromEffect(load) : Stream.tick(every).pipe(Stream.mapEffect(() => load))
  return retryWhileOffline(stream)
}

export const isActive = (status: Domain.RunStatus) => status === "queued" || status === "planning" || status === "running"
export const isTerminal = (status: Domain.StepStatus) =>
  status === "passed" || status === "reused" || status === "failed" || status === "died" || status === "blocked" || status === "cancelled"

const durationOf = (run: Domain.Run) => (run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : null)

function upsert<A>(list: ReadonlyArray<A>, item: A, same: (a: A) => boolean, at: "start" | "end"): ReadonlyArray<A> {
  const i = list.findIndex(same)
  if (i >= 0) return list.map((x, j) => (j === i ? item : x))
  return at === "start" ? [item, ...list] : [...list, item]
}

const onDefaultBranch = (run: Domain.Run, branch: string) => run.event._tag === "Push" && run.event.branch === branch

export const isSibling = (a: Domain.Run, b: Domain.Run) =>
  a.project === b.project &&
  ((a.event._tag === "PullRequest" && b.event._tag === "PullRequest" && a.event.number === b.event.number) ||
    (a.commit.changeId !== null && a.commit.changeId === b.commit.changeId))

/* ------------------------------------------------------------------ */
/* Overview                                                            */

function applyOverview(ov: Domain.Overview, change: Domain.Change): Next<Domain.Overview> {
  switch (change._tag) {
    case "StepChanged":
      return ov
    case "DeploymentChanged": {
      const d = change.deployment
      return {
        ...ov,
        projects: ov.projects.map((p) => (p.name === d.project ? { ...p, deployments: upsert(p.deployments, d, (x) => x.host === d.host, "end") } : p)),
      }
    }
    case "RunChanged": {
      const run = change.run
      const projects = ov.projects.map((p) => {
        if (p.name !== run.project || !onDefaultBranch(run, p.defaultBranch)) return p
        const entry = { id: run.id, status: run.status, durationMs: durationOf(run) }
        const history = p.history.some((h) => h.id === run.id) ? p.history.map((h) => (h.id === run.id ? entry : h)) : [...p.history, entry].slice(-20)
        return { ...p, main: p.main === null || run.number >= p.main.number ? run : p.main, history }
      })
      const others = ov.active.filter((r) => r.id !== run.id)
      return {
        ...ov,
        projects,
        active: isActive(run.status) ? [run, ...others].sort((a, b) => b.createdAt - a.createdAt) : others,
        recent: upsert(ov.recent, run, (r) => r.id === run.id, "start").slice(0, 40),
      }
    }
  }
}

export const overviewAtom = Kiln.runtime.atom(live(Kiln.use((k) => k("overview", undefined)), applyOverview, "15 seconds")).pipe(Atom.keepAlive)

/* ------------------------------------------------------------------ */
/* One run                                                             */

const applyRun = (id: string) => (d: Domain.RunDetail, change: Domain.Change): Next<Domain.RunDetail> => {
  switch (change._tag) {
    case "RunChanged": {
      const run = change.run
      if (run.id === id) return { ...d, run }
      return isSibling(d.run, run) ? { ...d, siblings: upsert(d.siblings, run, (r) => r.id === run.id, "start") } : d
    }
    case "StepChanged": {
      const step = change.step
      if (step.runId !== id) return d
      const before = d.steps.find((s) => s.name === step.name)
      // Failing tests only come with the run, so a fresh failure refetches it.
      if ((step.status === "failed" || step.status === "died") && before?.status !== step.status) return reload
      return { ...d, steps: upsert(d.steps, step, (s) => s.name === step.name, "end") }
    }
    case "DeploymentChanged":
      return d
  }
}

export const runAtom = Atom.family((id: string) => Kiln.runtime.atom(live(Kiln.use((k) => k("run", { id })), applyRun(id))))

/* ------------------------------------------------------------------ */
/* A project's runs                                                    */

export interface RunsKey {
  readonly project: string
  readonly pullRequest: number | null
}

const applyRuns = (key: RunsKey) => (runs: ReadonlyArray<Domain.Run>, change: Domain.Change): Next<ReadonlyArray<Domain.Run>> => {
  if (change._tag !== "RunChanged") return runs
  const run = change.run
  if (run.project !== key.project) return runs
  if (key.pullRequest !== null && !(run.event._tag === "PullRequest" && run.event.number === key.pullRequest)) return runs
  return upsert(runs, run, (r) => r.id === run.id, "start")
}

export const projectRunsAtom = Atom.family((key: RunsKey) =>
  Kiln.runtime.atom(
    live(
      Kiln.use((k) => k("runs", key.pullRequest === null ? { project: key.project, limit: 60 } : { project: key.project, pullRequest: key.pullRequest, limit: 60 })),
      applyRuns(key),
    ),
  ))

/* ------------------------------------------------------------------ */
/* Telemetry of a step                                                 */

export interface LogsKey {
  readonly runId: string
  readonly step: string | null
  readonly follow: boolean
}

export const logsAtom = Atom.family((key: LogsKey) =>
  Kiln.runtime.atom(
    retryWhileOffline(
      Stream.unwrap(Kiln.use((k) => Effect.succeed(k("logs", key.step === null ? { runId: key.runId, follow: key.follow } : { runId: key.runId, step: key.step, follow: key.follow })))).pipe(
        Stream.groupedWithin(2000, "60 millis"),
        Stream.scan((): ReadonlyArray<Domain.LogLine> => [], (lines, batch) => lines.concat(batch)),
      ),
    ),
  ))

export const traceAtom = Atom.family((key: { readonly runId: string; readonly live: boolean }) =>
  Kiln.runtime.atom(poll(Kiln.use((k) => k("trace", { runId: key.runId })), key.live ? "3 seconds" : null)))

export const metricsAtom = Atom.family((key: { readonly runId: string; readonly step: string; readonly live: boolean }) =>
  Kiln.runtime.atom(poll(Kiln.use((k) => k("stepMetrics", { runId: key.runId, step: key.step })), key.live ? "2 seconds" : null)))
