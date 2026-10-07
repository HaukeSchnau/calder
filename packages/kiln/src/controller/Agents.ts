import { type Cause, Context, Deferred, Effect, Layer, Queue, Stream } from "effect"
import { readFileSync } from "node:fs"
import * as Build from "../Build.ts"
import { type AgentOrder, Unauthorized } from "../Protocol.ts"
import { Config } from "./Config.ts"

interface Connection {
  readonly name: string
  readonly platform: string
  slots: number
  readonly build: string
  readonly orders: Queue.Queue<AgentOrder, Cause.Done>
}

interface Placed {
  readonly agent: string
  readonly exited: Deferred.Deferred<number>
}

interface Waiter {
  readonly job: { readonly id: string; readonly token: string }
  readonly platform: string
  readonly placed: Deferred.Deferred<Placed>
}

export interface AgentUsage {
  readonly name: string
  readonly platform: string
  readonly slots: number
  readonly running: number
  readonly connected: boolean
  readonly build: string
  /** Whether it runs the controller's Kiln build; only such agents get jobs. */
  readonly current: boolean
}

/** How long an agent may stay away before the jobs it ran count as lost. */
const reconnectGrace = "5 minutes"

/**
 * Agents on other hosts (`kiln agent`) that start workers for their platform. A job waits until an
 * agent of its platform has a free slot; its worker then talks to the controller like a local one.
 */
export class Agents extends Context.Service<Agents, {
  /**
   * Starts the job's worker on an agent and waits for it to exit; returns the exit code, -1 if it was
   * lost. Without `wait`, a job no agent can take right now returns -2 at once.
   */
  readonly run: (job: { readonly id: string; readonly token: string }, platform: string, options?: { readonly wait?: boolean }) => Effect.Effect<number>
  readonly stop: (job: string) => Effect.Effect<void>
  readonly connect: (auth: { readonly token: string; readonly name: string }, agent: {
    readonly platform: string
    readonly slots: number
    readonly running: ReadonlyArray<string>
    readonly build: string
  }) => Stream.Stream<AgentOrder, Unauthorized>
  readonly exited: (auth: { readonly token: string; readonly name: string }, job: string, code: number) => Effect.Effect<void, Unauthorized>
  readonly offer: (auth: { readonly token: string; readonly name: string }, slots: number) => Effect.Effect<void, Unauthorized>
  readonly usage: () => ReadonlyArray<AgentUsage>
}>()("kiln/controller/Agents") {}

/** Agents authenticate with `secret`; with none, no agent may connect. `build` is the controller's. */
export const make = (secret: string | null, build: string = Build.id): Agents["Service"] => {
  const connections = new Map<string, Connection>()
  const placed = new Map<string, Placed>()
  const waiters: Array<Waiter> = []
  // Bumped on every connect, so a grace timer knows whether its agent came back.
  const generations = new Map<string, number>()
  // Every agent seen since start, so a missing one stays visible.
  const seen = new Map<string, { readonly platform: string; slots: number; readonly build: string }>()

  const check = (auth: { readonly token: string; readonly name: string }) =>
    secret !== null && auth.token === secret ? Effect.void : Effect.fail(new Unauthorized({ reason: "wrong agent token" }))

  const runningOn = (agent: string) => [...placed.values()].filter((p) => p.agent === agent).length

  const assign = Effect.gen(function*() {
    for (const waiter of [...waiters]) {
      const agent = [...connections.values()].find((c) =>
        c.platform === waiter.platform && c.build === build && runningOn(c.name) < c.slots
      )
      if (agent === undefined) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      const p: Placed = { agent: agent.name, exited: Deferred.makeUnsafe<number>() }
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

  return {
    run: (job, platform, options) =>
      Effect.gen(function*() {
        const waiter: Waiter = { job, platform, placed: Deferred.makeUnsafe<Placed>() }
        waiters.push(waiter)
        yield* assign
        if (options?.wait === false && waiters.includes(waiter)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          return -2
        }
        const p = yield* Deferred.await(waiter.placed).pipe(
          Effect.onInterrupt(() => Effect.sync(() => waiters.includes(waiter) && waiters.splice(waiters.indexOf(waiter), 1))),
        )
        return yield* Deferred.await(p.exited)
      }),
    stop: (job) =>
      Effect.sync(() => {
        const p = placed.get(job)
        const agent = p === undefined ? undefined : connections.get(p.agent)
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
            const connection: Connection = { name: auth.name, platform: agent.platform, slots: agent.slots, build: agent.build, orders }
            connections.set(auth.name, connection)
            seen.set(auth.name, { platform: agent.platform, slots: agent.slots, build: agent.build })
            // Workers that exited while the agent was away can't report it any more.
            for (const [job, p] of placed) {
              if (p.agent === auth.name && !agent.running.includes(job)) yield* finish(job, -1)
            }
            yield* Effect.logInfo(`agent ${auth.name} (${agent.platform}, ${agent.slots} slots) connected`)
            if (agent.build !== build) {
              yield* Effect.logWarning(`agent ${auth.name} runs Kiln build ${agent.build}, not ${build}: it gets no jobs until it is deployed`)
            }
            yield* assign
            yield* Effect.addFinalizer(() =>
              Effect.gen(function*() {
                if (connections.get(auth.name) !== connection) return
                connections.delete(auth.name)
                yield* Effect.logInfo(`agent ${auth.name} disconnected`)
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
      [...seen].map(([name, a]) => ({ name, ...a, running: runningOn(name), connected: connections.has(name), current: a.build === build })),
  }
}

export const layer = Layer.effect(Agents)(Effect.gen(function*() {
  const config = yield* Config
  return make(config.agents === null ? null : readFileSync(config.agents.tokenFile, "utf8").trim())
}))
