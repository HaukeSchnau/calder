import type { Domain } from "@kiln/api"
import { type Duration, Effect, PubSub, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { Kiln } from "./client.ts"

const refresh = Symbol("refresh")

/** Re-subscribes after the socket drops. Other failures, such as `NotFound`, reach the view. */
const retryWhileOffline = <A, E, R>(self: Stream.Stream<A, E | RpcClientError, R>): Stream.Stream<A, Exclude<E, RpcClientError>, R> =>
  Stream.catchIf<A, E | RpcClientError, R, RpcClientError, A, Exclude<E, RpcClientError>, R>(
    self,
    (e): e is RpcClientError => e instanceof RpcClientError,
    () => Stream.fromEffect(Effect.sleep("1500 millis")).pipe(Stream.flatMap(() => retryWhileOffline(self))),
  )

/**
 * One `changes` subscription per connection, fanned out to every live view. While the socket is down
 * views miss changes; the gap in seq after it comes back makes them reload.
 */
const changesAtom = Kiln.runtime.atom(Effect.gen(function*() {
  const kiln = yield* Kiln
  const hub = yield* PubSub.unbounded<Domain.Change>()
  yield* retryWhileOffline(kiln("changes", undefined)).pipe(
    Stream.runForEach((change) => PubSub.publish(hub, change)),
    Effect.forkScoped,
  )
  return hub
})).pipe(Atom.keepAlive)

interface Snapshot<A> {
  /** The last change the value includes; null for sources without one, such as deploy history. */
  readonly seq: number | null
  readonly value: A
}

const withSeq = <A extends { readonly seq: number }>(value: A): Snapshot<A> => ({ seq: value.seq, value })

/**
 * A view the controller keeps current: subscribe to `changes`, load the snapshot, then fold in every
 * change newer than it. A gap in the seq reloads. `refresh` refetches on a timer and merges what
 * changes don't carry, such as slot use.
 */
function live<A, E>(get: Atom.AtomContext, options: {
  readonly load: Effect.Effect<Snapshot<A>, E | RpcClientError, Kiln>
  readonly apply: (current: A, change: Domain.Change) => A
  readonly refresh?: { readonly every: Duration.Input; readonly merge: (current: A, fresh: A) => A }
}): Stream.Stream<A, Exclude<E, RpcClientError>, Kiln> {
  const { load, apply, refresh: timer } = options
  const step = (state: Snapshot<A>, change: Domain.Change): Snapshot<A> => ({ seq: change.seq, value: apply(state.value, change) })
  const connected = Stream.unwrap(Effect.gen(function*() {
    const changes = yield* PubSub.subscribe(yield* get.result(changesAtom))
    const initial = yield* load
    const ticks: Stream.Stream<typeof refresh> = timer === undefined ? Stream.empty : Stream.tick(timer.every).pipe(Stream.drop(1), Stream.map((): typeof refresh => refresh))
    return Stream.fromSubscription(changes).pipe(
      Stream.merge(ticks),
      Stream.scanEffect(() => initial, (state, message: Domain.Change | typeof refresh) => {
        if (message === refresh) {
          return timer ? load.pipe(Effect.map((fresh) => ({ seq: state.seq, value: timer.merge(state.value, fresh.value) }))) : Effect.succeed(state)
        }
        if (state.seq === null || message.seq === state.seq + 1) return Effect.succeed(step(state, message))
        if (message.seq <= state.seq) return Effect.succeed(state)
        // A change went missing: start over from a fresh snapshot.
        return load.pipe(Effect.map((fresh) => (fresh.seq !== null && message.seq === fresh.seq + 1 ? step(fresh, message) : fresh)))
      }),
      Stream.map((state) => state.value),
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

function applyOverview(ov: Domain.Overview, change: Domain.Change): Domain.Overview {
  switch (change._tag) {
    case "StepChanged":
    case "DeploymentRecorded":
      return ov
    case "DeploymentChanged": {
      const d = change.deployment
      return {
        ...ov,
        seq: change.seq,
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
        seq: change.seq,
        projects,
        active: isActive(run.status) ? [run, ...others].sort((a, b) => b.createdAt - a.createdAt) : others,
        recent: upsert(ov.recent, run, (r) => r.id === run.id, "start").slice(0, 40),
      }
    }
  }
}

export const overviewAtom = Kiln.runtime.atom((get) => live(get, {
  load: Kiln.use((k) => k("overview", undefined)).pipe(Effect.map(withSeq)),
  apply: applyOverview,
  refresh: { every: "15 seconds", merge: (current, fresh) => ({ ...current, slots: fresh.slots }) },
})).pipe(Atom.keepAlive)

/* ------------------------------------------------------------------ */
/* One run                                                             */

const applyRun = (id: string) => (d: Domain.RunDetail, change: Domain.Change): Domain.RunDetail => {
  switch (change._tag) {
    case "RunChanged": {
      const run = change.run
      if (run.id === id) return { ...d, seq: change.seq, run }
      return isSibling(d.run, run) ? { ...d, seq: change.seq, siblings: upsert(d.siblings, run, (r) => r.id === run.id, "start") } : d
    }
    case "StepChanged": {
      const step = change.step
      if (step.runId !== id) return d
      const failed = step.status === "failed" || step.status === "died"
      return {
        ...d,
        seq: change.seq,
        steps: upsert(d.steps, step, (s) => s.name === step.name, "end"),
        failingTests: failed ? [...d.failingTests.filter((t) => t.step !== step.name), ...change.failingTests] : d.failingTests,
      }
    }
    case "DeploymentChanged":
    case "DeploymentRecorded":
      return d
  }
}

export const runAtom = Atom.family((id: string) =>
  Kiln.runtime.atom((get) => live(get, { load: Kiln.use((k) => k("run", { id })).pipe(Effect.map(withSeq)), apply: applyRun(id) })))

/* ------------------------------------------------------------------ */
/* A project's runs                                                    */

export interface RunsKey {
  readonly project: string
  readonly pullRequest: number | null
}

const applyRuns = (key: RunsKey) => (runs: ReadonlyArray<Domain.Run>, change: Domain.Change): ReadonlyArray<Domain.Run> => {
  if (change._tag !== "RunChanged") return runs
  const run = change.run
  if (run.project !== key.project) return runs
  if (key.pullRequest !== null && !(run.event._tag === "PullRequest" && run.event.number === key.pullRequest)) return runs
  return upsert(runs, run, (r) => r.id === run.id, "start")
}

export const projectRunsAtom = Atom.family((key: RunsKey) =>
  Kiln.runtime.atom((get) =>
    live(get, {
      load: Kiln.use((k) => k("runs", key.pullRequest === null ? { project: key.project, limit: 60 } : { project: key.project, pullRequest: key.pullRequest, limit: 60 }))
        .pipe(Effect.map(({ seq, runs }) => ({ seq, value: runs }))),
      apply: applyRuns(key),
    })
  ))

/* ------------------------------------------------------------------ */
/* Telemetry of a step                                                 */

export interface LogsKey {
  readonly runId: string
  readonly step: string | null
  readonly follow: boolean
}

/** Lines per page: the newest page streams, earlier ones load on request. */
export const LOG_PAGE = 2000

const logsPayload = (runId: string, step: string | null) => (step === null ? { runId } : { runId, step })

export const logsAtom = Atom.family((key: LogsKey) =>
  Kiln.runtime.atom(
    retryWhileOffline(
      Stream.unwrap(Kiln.use((k) => Effect.succeed(k("logs", { ...logsPayload(key.runId, key.step), follow: key.follow, limit: LOG_PAGE })))).pipe(
        Stream.groupedWithin(2000, "60 millis"),
        Stream.scan((): ReadonlyArray<Domain.LogEntry> => [], (lines, batch) => lines.concat(batch)),
      ),
    ),
  ))

export const traceAtom = Atom.family((key: { readonly runId: string; readonly live: boolean }) =>
  Kiln.runtime.atom(poll(Kiln.use((k) => k("trace", { runId: key.runId })), key.live ? "3 seconds" : null)))

export const metricsAtom = Atom.family((key: { readonly runId: string; readonly step: string; readonly live: boolean }) =>
  Kiln.runtime.atom(poll(Kiln.use((k) => k("stepMetrics", { runId: key.runId, step: key.step })), key.live ? "2 seconds" : null)))

/** The page before a line's `index`. */
export const earlierLogs = Kiln.runtime.fn((page: { readonly runId: string; readonly step: string | null; readonly before: number }) =>
  Kiln.use((k) => Stream.runCollect(k("logs", { ...logsPayload(page.runId, page.step), before: page.before, limit: LOG_PAGE }))))

/* ------------------------------------------------------------------ */
/* Deploys                                                             */

interface HistoryKey {
  readonly project: string
  readonly host: string | null
  readonly limit: number
}

const applyHistory = (key: HistoryKey) => (records: ReadonlyArray<Domain.DeploymentRecord>, change: Domain.Change): ReadonlyArray<Domain.DeploymentRecord> => {
  if (change._tag !== "DeploymentRecorded") return records
  const r = change.record
  if (r.project !== key.project || (key.host !== null && r.host !== key.host)) return records
  if (records.some((x) => x.runId === r.runId && x.host === r.host && x.at === r.at)) return records
  return [r, ...records].slice(0, key.limit)
}

/** Deploys Kiln made, newest first, with each new one prepended as it is recorded. */
export const deployHistoryAtom = Atom.family((key: HistoryKey) =>
  Kiln.runtime.atom((get) =>
    live(get, {
      load: Kiln.use((k) => k("deployments", key.host === null ? { project: key.project, limit: key.limit } : { project: key.project, host: key.host, limit: key.limit }))
        .pipe(Effect.map((value) => ({ seq: null, value }))),
      apply: applyHistory(key),
    })
  ))
