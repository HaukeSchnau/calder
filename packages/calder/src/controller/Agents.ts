import { type Cause, Clock, Context, Deferred, Duration, Effect, Layer, Queue, Stream } from "effect"
import { readFileSync } from "node:fs"
import * as Exec from "../Exec.ts"
import { type AgentOrder, compatibility, Unauthorized } from "../Protocol.ts"
import { Config } from "./Config.ts"

interface Connection {
  readonly name: string
  readonly platform: string
  slots: number
  readonly compatibility: number
  /** Takes evaluation jobs only. */
  readonly evaluator: boolean
  readonly orders: Queue.Queue<AgentOrder, Cause.Done>
}

interface Placed {
  readonly agent: string
  readonly exited: Deferred.Deferred<number>
  /** When the agent got the job. */
  readonly at: number
  /**
   * The controller wants the worker gone: it stopped the job, or never knew it (the worker ran across
   * a restart). Its workspace may belong to another job already, so its agent gets no new jobs until
   * it reports the worker gone.
   */
  stopping: boolean
}

interface Waiter {
  readonly job: { readonly id: string; readonly token: string }
  readonly platform: string
  /** An evaluation job, which only evaluator agents take, whatever their platform. */
  readonly evaluation: boolean
  readonly placed: Deferred.Deferred<Placed>
  /** Completes when the job stops waiting without an agent: the last evaluator agent left. */
  readonly abandoned: Deferred.Deferred<void>
  readonly onWaiting: (reason: string) => Effect.Effect<void>
  readonly onLog: (text: string) => Effect.Effect<void>
}

/** An agent whose host sleeps while idle. `wake` wakes the host, and the agent connects once the host is up. */
export interface Sleeper {
  readonly name: string
  readonly platform: string
  readonly wake: Effect.Effect<unknown, { readonly message: string }>
}

/** A sleeper's latest wake. */
interface Wake {
  readonly at: number
  /** Why it came to nothing; null while it may still bring the agent. */
  failure: string | null
  connected: boolean
}

/** A sleeper's host is woken at most once in this time, however many jobs wait for it. */
export const wakeEvery = "2 minutes"
/** How long a wake may take, from the start of its command until the agent connects. */
export const wakeTimeout = "3 minutes"
/** How often a waiting job checks whether a sleeper's host is due for another wake. */
const wakeCheck = "15 seconds"

export interface AgentUsage {
  readonly name: string
  readonly platform: string
  readonly slots: number
  readonly running: number
  readonly connected: boolean
  readonly build: string
  readonly compatibility: number
  /** Whether it has the controller's compatibility version; only such agents get jobs. */
  readonly current: boolean
  /** Whether it takes evaluation jobs only (`calder agent --evaluator`). */
  readonly evaluator: boolean
}

/** How long an evaluator's job counts as progress for the evaluations waiting behind it: 3x infra's 5 minutes. */
export const evaluationCap = "15 minutes"

/** How long evaluations keep waiting for an evaluator agent that lost the controller to come back. */
export const evaluatorGrace = "30 seconds"

/** How long an agent may stay away before the jobs it ran count as lost. */
const reconnectGrace = "5 minutes"

/**
 * Agents on other hosts (`calder agent`) that start workers for their platform. A job waits until an
 * agent of its platform has a free slot; its worker then talks to the controller like a local one.
 */
export class Agents extends Context.Service<Agents, {
  /**
   * Starts the job's worker on an agent and waits for it to exit; returns the exit code, -1 if it was
   * lost. Without `wait`, a job no agent can take right now returns -2 at once. `onPlaced` runs once an
   * agent took the job. While the job waits, the hosts of its platform's sleepers that are away are
   * woken; `onWaiting` hears what the job waits for whenever that changes, and `onLog` how the wakes go.
   * An `evaluation` job goes to an evaluator agent of any platform, and only evaluator agents take one.
   * `onPlaced` hears the agent's name.
   */
  readonly run: (
    job: { readonly id: string; readonly token: string },
    platform: string,
    options?: {
      readonly wait?: boolean
      readonly onPlaced?: (agent: string) => Effect.Effect<void>
      readonly evaluation?: boolean
      /** Gives up with -2 once no evaluator agent ran a job for this long without taking this one. */
      readonly within?: Duration.Input
      readonly onWaiting?: (reason: string) => Effect.Effect<void>
      readonly onLog?: (text: string) => Effect.Effect<void>
    },
  ) => Effect.Effect<number>
  readonly stop: (job: string) => Effect.Effect<void>
  readonly connect: (auth: { readonly token: string; readonly name: string }, agent: {
    readonly platform: string
    readonly slots: number
    readonly running: ReadonlyArray<string>
    readonly build: string
    readonly compatibility: number
    readonly evaluator?: boolean
  }) => Stream.Stream<AgentOrder, Unauthorized>
  readonly exited: (auth: { readonly token: string; readonly name: string }, job: string, code: number) => Effect.Effect<void, Unauthorized>
  readonly offer: (auth: { readonly token: string; readonly name: string }, slots: number) => Effect.Effect<void, Unauthorized>
  readonly usage: () => ReadonlyArray<AgentUsage>
}>()("calder/controller/Agents") {}

/**
 * Agents authenticate with `secret`; with none, no agent may connect. `version` is the controller's
 * compatibility, and `sleepers` are the agents whose hosts it wakes for waiting jobs.
 */
export const make = (secret: string | null, version: number = compatibility, sleepers: ReadonlyArray<Sleeper> = []): Agents["Service"] => {
  const connections = new Map<string, Connection>()
  const placed = new Map<string, Placed>()
  const waiters: Array<Waiter> = []
  const wakes = new Map<string, Wake>()
  // Bumped on every connect, so a grace timer knows whether its agent came back.
  const generations = new Map<string, number>()
  // Every agent seen since start, so a missing one stays visible.
  const seen = new Map<
    string,
    { readonly platform: string; slots: number; readonly build: string; readonly compatibility: number; readonly evaluator: boolean }
  >()

  const check = (auth: { readonly token: string; readonly name: string }) =>
    secret !== null && auth.token === secret ? Effect.void : Effect.fail(new Unauthorized({ reason: "wrong agent token" }))

  const evaluatorConnected = () => [...connections.values()].some((c) => c.evaluator && c.compatibility === version)
  /** When the last evaluator agent disconnected, while none has connected since. */
  let evaluatorLeft: number | null = null
  /**
   * Whether a connected evaluator agent runs a job, so the evaluations waiting for it make progress: one
   * that the agent took less than `evaluationCap` ago and that isn't being stopped. A hung evaluation
   * would otherwise keep every waiting one from the controller until its worker's limit.
   */
  const evaluatorBusy = (now: number) =>
    [...connections.values()].some((c) => {
      const jobs = on(c.name)
      return c.evaluator && c.compatibility === version && !jobs.some((p) => p.stopping) &&
        jobs.some((p) => now - p.at < Duration.toMillis(evaluationCap))
    })

  const on = (agent: string) => [...placed.values()].filter((p) => p.agent === agent)

  const takes = (c: Connection, waiter: Pick<Waiter, "platform" | "evaluation">) => {
    const jobs = on(c.name)
    const kind = waiter.evaluation ? c.evaluator : !c.evaluator && c.platform === waiter.platform
    return kind && c.compatibility === version && jobs.length < c.slots && !jobs.some((p) => p.stopping)
  }

  const assign = Effect.gen(function*() {
    for (const waiter of [...waiters]) {
      const agent = [...connections.values()].find((c) => takes(c, waiter))
      if (agent === undefined) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      const p: Placed = { agent: agent.name, exited: Deferred.makeUnsafe<number>(), at: yield* Clock.currentTimeMillis, stopping: false }
      placed.set(waiter.job.id, p)
      Queue.offerUnsafe(agent.orders, { _tag: "Start", job: waiter.job.id, token: waiter.job.token })
      yield* Deferred.succeed(waiter.placed, p)
    }
  })

  const finish = (job: string, code: number) =>
    Effect.gen(function*() {
      const p = placed.get(job)
      if (p === undefined) return
      placed.delete(job)
      yield* Deferred.succeed(p.exited, code)
      yield* assign
    })

  /** What a job of `platform` waits for: an agent, and how the wakes of the platform's sleepers went. */
  const reason = (platform: string, evaluation = false) =>
    evaluation ? "an evaluator agent to take it" : [`an agent of ${platform} to take it`, ...sleepers.flatMap((s) => {
      const wake = wakes.get(s.name)
      return s.platform !== platform || wake === undefined || wake.connected ? [] : [wake.failure ?? `waking ${s.name}`]
    })].join("; ")

  /** Tells the jobs that wait for `platform` what happened, and what they wait for now. */
  const tell = (platform: string, text: string) =>
    Effect.forEach(waiters.filter((w) => w.platform === platform && !w.evaluation), (w) =>
      Effect.suspend(() =>
        // A job an agent took meanwhile no longer waits.
        waiters.includes(w) ? Effect.andThen(w.onLog(text), w.onWaiting(reason(platform, w.evaluation))) : Effect.void
      ), { discard: true })

  /**
   * Wakes a sleeper's host in a fiber of its own, which outlives the job that asked: other jobs wait for
   * the agent too, and the wake on record has to settle before another starts.
   */
  const wake = (sleeper: Sleeper, at: number) => {
    const attempt: Wake = { at, failure: null, connected: false }
    const fail = (failure: string) =>
      Effect.gen(function*() {
        if (wakes.get(sleeper.name) !== attempt || attempt.connected) return
        attempt.failure = failure
        yield* Effect.logWarning(failure)
        yield* tell(sleeper.platform, failure)
      })
    const failed = (why: string) => fail(`waking ${sleeper.name} failed: ${why.split("\n")[0]}`)
    return Effect.sync(() => wakes.set(sleeper.name, attempt)).pipe(
      Effect.andThen(Effect.forkDetach(Effect.gen(function*() {
        yield* Effect.logInfo(`waking ${sleeper.name}`)
        yield* tell(sleeper.platform, `waking ${sleeper.name}`)
        yield* sleeper.wake.pipe(
          // The host is up, and its agent connects by itself.
          Effect.andThen(Effect.never),
          Effect.timeoutOrElse({ duration: wakeTimeout, orElse: () => fail(`${sleeper.name} didn't connect within ${wakeTimeout} of waking it`) }),
          Effect.catch((error) => failed(error.message)),
          Effect.catchDefect((defect) => failed(String(defect))),
        )
      }))),
      Effect.uninterruptible,
    )
  }

  /**
   * Wakes the hosts of the platform's sleepers that are away, each once per `wakeEvery` and only after
   * its last wake brought the agent or failed.
   */
  const rouse = (platform: string) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      for (const sleeper of sleepers) {
        if (sleeper.platform !== platform || connections.has(sleeper.name)) continue
        const last = wakes.get(sleeper.name)
        const due = last === undefined ||
          (now - last.at >= Duration.toMillis(wakeEvery) && (last.connected || last.failure !== null))
        if (due) yield* wake(sleeper, now)
      }
    })

  return {
    run: (job, platform, options) =>
      Effect.gen(function*() {
        const waiter: Waiter = {
          job,
          platform,
          evaluation: options?.evaluation === true,
          placed: Deferred.makeUnsafe<Placed>(),
          abandoned: Deferred.makeUnsafe<void>(),
          onWaiting: options?.onWaiting ?? (() => Effect.void),
          onLog: options?.onLog ?? (() => Effect.void),
        }
        waiters.push(waiter)
        yield* assign
        const waits = waiters.includes(waiter)
        // An evaluation no evaluator agent can take runs on the controller instead of waiting, unless the
        // last one left only moments ago: agents lose the controller for a few seconds about 20 times an hour.
        const now = yield* Clock.currentTimeMillis
        const gone = !evaluatorConnected() && (evaluatorLeft === null || now - evaluatorLeft >= Duration.toMillis(evaluatorGrace))
        if (waits && (options?.wait === false || (waiter.evaluation && gone))) {
          waiters.splice(waiters.indexOf(waiter), 1)
          return -2
        }
        if (waits) yield* waiter.onWaiting(reason(platform, waiter.evaluation))
        // While the job waits, no connected agent of its platform has a free slot. Sleepers take no evaluations.
        const rousing = waiter.evaluation ? Effect.never : rouse(platform).pipe(Effect.andThen(Effect.sleep(wakeCheck)), Effect.forever)
        // An evaluation gives up only once the evaluators stalled for `within`: none runs a job, such as
        // one that offers no slots. Behind a busy one it waits, since its own turn there comes sooner than
        // the controller's evaluation: infra-1036 gave up after 2 minutes behind another run's 5-minute
        // evaluation, and srv-2 then took 10.
        const stalled = (within: Duration.Input) =>
          Effect.gen(function*() {
            let since = yield* Clock.currentTimeMillis
            while (true) {
              yield* Effect.sleep(wakeCheck)
              const now = yield* Clock.currentTimeMillis
              if (evaluatorBusy(now)) since = now
              else if (now - since >= Duration.toMillis(within)) return
            }
          })
        const given = Deferred.await(waiter.abandoned).pipe(
          options?.within === undefined ? (e) => e : Effect.raceFirst(stalled(options.within)),
          Effect.as(undefined),
        )
        const p = yield* (waits ? Effect.raceFirst(Effect.raceFirst(Deferred.await(waiter.placed), rousing), given) : Deferred.await(waiter.placed)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => waiters.includes(waiter) && waiters.splice(waiters.indexOf(waiter), 1))),
        )
        if (p === undefined) {
          // Placed in the same instant: it runs after all.
          if (!waiters.includes(waiter)) {
            const placedNow = yield* Deferred.await(waiter.placed)
            if (options?.onPlaced !== undefined) yield* options.onPlaced(placedNow.agent)
            return yield* Deferred.await(placedNow.exited)
          }
          waiters.splice(waiters.indexOf(waiter), 1)
          return -2
        }
        if (options?.onPlaced !== undefined) yield* options.onPlaced(p.agent)
        return yield* Deferred.await(p.exited)
      }),
    stop: (job) =>
      Effect.sync(() => {
        const p = placed.get(job)
        if (p === undefined) return
        p.stopping = true
        const agent = connections.get(p.agent)
        if (agent !== undefined) Queue.offerUnsafe(agent.orders, { _tag: "Stop", job })
      }),
    connect: (auth, agent) =>
      Stream.unwrap(Effect.gen(function*() {
        yield* check(auth)
        return Stream.callback<AgentOrder>((orders) =>
          Effect.gen(function*() {
            const previous = connections.get(auth.name)
            if (previous !== undefined) Queue.endUnsafe(previous.orders)
            const generation = (generations.get(auth.name) ?? 0) + 1
            generations.set(auth.name, generation)
            const evaluator = agent.evaluator === true
            const connection: Connection = {
              name: auth.name,
              platform: agent.platform,
              slots: agent.slots,
              compatibility: agent.compatibility,
              evaluator,
              orders,
            }
            connections.set(auth.name, connection)
            if (evaluatorConnected()) evaluatorLeft = null
            seen.set(auth.name, { platform: agent.platform, slots: agent.slots, build: agent.build, compatibility: agent.compatibility, evaluator })
            const unknown = agent.running.filter((job) => !placed.has(job))
            for (const job of unknown) placed.set(job, { agent: auth.name, exited: Deferred.makeUnsafe<number>(), at: 0, stopping: true })
            for (const [job, p] of [...placed]) {
              if (p.agent !== auth.name) continue
              // Workers that exited while the agent was away can't report it any more.
              if (!agent.running.includes(job)) yield* finish(job, -1)
              else if (p.stopping) Queue.offerUnsafe(orders, { _tag: "Stop", job })
            }
            yield* Effect.logInfo(`agent ${auth.name} (${agent.platform}, ${agent.slots} slots${evaluator ? ", evaluations only" : ""}) connected`)
            const woken = wakes.get(auth.name)
            if (woken !== undefined && !woken.connected) {
              woken.connected = true
              const connected = `${auth.name} connected after ${Math.round(((yield* Clock.currentTimeMillis) - woken.at) / 1000)} s`
              yield* Effect.logInfo(connected)
              yield* tell(agent.platform, connected)
            }
            if (unknown.length > 0) {
              yield* Effect.logWarning(`agent ${auth.name} runs ${unknown.length} workers of jobs this controller doesn't know: it stops them before it gets new jobs`)
            }
            if (agent.compatibility !== version) {
              const behind = agent.compatibility < version ? "it is" : "the controller is"
              yield* Effect.logWarning(
                `agent ${auth.name} (Calder build ${agent.build}) has compatibility version ${agent.compatibility}, not ${version}: it gets no jobs until ${behind} deployed`,
              )
            }
            yield* assign
            yield* Effect.addFinalizer(() =>
              Effect.gen(function*() {
                if (connections.get(auth.name) !== connection) return
                connections.delete(auth.name)
                yield* Effect.logInfo(`agent ${auth.name} disconnected`)
                // Evaluations give up on the agents once none came back within the grace, not at the first
                // dropped connection: dev-hauke's reconnects within seconds, about 20 times an hour.
                if (evaluator && connection.compatibility === version && !evaluatorConnected()) {
                  const left = yield* Clock.currentTimeMillis
                  evaluatorLeft = left
                  yield* Effect.sleep(evaluatorGrace).pipe(
                    Effect.andThen(Effect.gen(function*() {
                      // An evaluator came back since, or left again and has a grace of its own.
                      if (evaluatorLeft !== left || evaluatorConnected()) return
                      for (const w of waiters.filter((w) => w.evaluation)) yield* Deferred.succeed(w.abandoned, undefined)
                    })),
                    Effect.forkDetach,
                  )
                }
                yield* Effect.sleep(reconnectGrace).pipe(
                  Effect.andThen(Effect.gen(function*() {
                    if (generations.get(auth.name) !== generation) return
                    for (const [job, p] of placed) if (p.agent === auth.name) yield* finish(job, -1)
                  })),
                  Effect.forkDetach,
                )
              })
            )
          })
        )
      })),
    exited: (auth, job, code) => check(auth).pipe(Effect.andThen(finish(job, code))),
    offer: (auth, slots) =>
      check(auth).pipe(Effect.andThen(Effect.gen(function*() {
        const connection = connections.get(auth.name)
        const known = seen.get(auth.name)
        if (connection === undefined || known === undefined || connection.slots === slots) return
        connection.slots = slots
        known.slots = slots
        yield* Effect.logInfo(`agent ${auth.name} offers ${slots} slots`)
        yield* assign
      }))),
    usage: () =>
      [...seen].map(([name, a]) => ({ name, ...a, running: on(name).length, connected: connections.has(name), current: a.compatibility === version })),
  }
}

export const layer = Layer.effect(Agents)(Effect.gen(function*() {
  const config = yield* Config
  const spawner = yield* Exec.SpawnerTag
  if (config.agents === null) return make(null)
  const sleepers = config.agents.wake.map(({ command, ...sleeper }) => ({
    ...sleeper,
    wake: Exec.run(command).pipe(Effect.provideService(Exec.SpawnerTag, spawner)),
  }))
  return make(readFileSync(config.agents.tokenFile, "utf8").trim(), compatibility, sleepers)
}))
