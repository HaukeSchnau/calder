import { Context, Deferred, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as Counters from "./Counters.ts"

export type Grant = { readonly _tag: "Held"; readonly fence: number } | { readonly _tag: "Replaced" }

interface Holder {
  readonly job: string
  readonly run: number
}
interface Waiter extends Holder {
  readonly granted: Deferred.Deferred<Grant>
}
interface State {
  holder: Holder | undefined
  /** In the order they asked, all of one run: a newer run's request replaces an older run's. */
  waiters: Array<Waiter>
  /** The newest run that held the lease; older runs are replaced. */
  newest: number
}

/**
 * One deploy at a time per project, latest wins: a run waiting for the lease gives way to a newer one,
 * and a run older than the last holder never gets it. Deploys of the same run take it in turn. Every grant carries a fencing token from a counter
 * that survives restarts, so a promotion endpoint can refuse a stale holder.
 */
export class Leases extends Context.Service<Leases, {
  readonly acquire: (project: string, holder: Holder) => Effect.Effect<Grant>
  readonly release: (project: string, job: string) => Effect.Effect<void>
  readonly holder: (project: string) => Holder | undefined
  readonly fenceOf: (project: string, job: string) => number | undefined
}>()("calder/controller/Leases") {}

/** `nextFence` returns a fencing token higher than any it returned before for the project. */
export const make = (nextFence: (project: string) => Effect.Effect<number>): Leases["Service"] => {
  const states = new Map<string, State>()
  const fences = new Map<string, number>()
  const state = (project: string) => {
    let s = states.get(project)
    if (s === undefined) {
      s = { holder: undefined, waiters: [], newest: 0 }
      states.set(project, s)
    }
    return s
  }
  const grant = (project: string, holder: Holder) =>
    Effect.gen(function*() {
      const s = state(project)
      s.holder = holder
      s.newest = Math.max(s.newest, holder.run)
      const fence = yield* nextFence(project)
      fences.set(`${project}/${holder.job}`, fence)
      return { _tag: "Held", fence } satisfies Grant
    })

  /** Tells the waiters `keep` drops that a newer run replaced them. */
  const replaceWaiters = (s: State, keep: (waiter: Waiter) => boolean) =>
    Effect.gen(function*() {
      const replaced = s.waiters.filter((waiter) => !keep(waiter))
      s.waiters = s.waiters.filter(keep)
      yield* Effect.forEach(replaced, (waiter) => Deferred.succeed(waiter.granted, { _tag: "Replaced" }), { discard: true })
    })

  const release: Leases["Service"]["release"] = (project, job) =>
    Effect.gen(function*() {
      const s = state(project)
      yield* replaceWaiters(s, (waiter) => waiter.job !== job)
      if (s.holder?.job !== job) return
      fences.delete(`${project}/${job}`)
      s.holder = undefined
      yield* replaceWaiters(s, (waiter) => waiter.run >= s.newest)
      const next = s.waiters.shift()
      if (next !== undefined) yield* Deferred.succeed(next.granted, yield* grant(project, next))
    })

  return {
    acquire: (project, holder) =>
      Effect.gen(function*() {
        const s = state(project)
        // A worker that lost its connection asks again for the lease it already holds.
        const held = fences.get(`${project}/${holder.job}`)
        if (s.holder?.job === holder.job && held !== undefined) return { _tag: "Held", fence: held } satisfies Grant
        if (holder.run < s.newest) return { _tag: "Replaced" } satisfies Grant
        if (s.holder === undefined) return yield* grant(project, holder)
        if (s.waiters.some((waiter) => waiter.run > holder.run)) return { _tag: "Replaced" } satisfies Grant
        yield* replaceWaiters(s, (waiter) => waiter.run === holder.run)
        const granted = yield* Deferred.make<Grant>()
        s.waiters.push({ ...holder, granted })
        return yield* Deferred.await(granted).pipe(Effect.onInterrupt(() => release(project, holder.job)))
      }),
    release,
    holder: (project) => states.get(project)?.holder,
    fenceOf: (project, job) => fences.get(`${project}/${job}`),
  }
}

export const layer = Layer.effect(Leases)(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return make((project) =>
    Counters.nextAtLeast(`fence:${project}`, Date.now()).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
  )
}))
