import { Context, Deferred, Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import * as Db from "./Db.ts"

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
  waiter: Waiter | undefined
  /** The newest run that held the lease; older runs are replaced. */
  newest: number
}

/**
 * One deploy at a time per project, latest wins: a run waiting for the lease gives way to a newer one,
 * and a run older than the last holder never gets it. Every grant carries a fencing token from a counter
 * that survives restarts, so a promotion endpoint can refuse a stale holder.
 */
export class Leases extends Context.Service<Leases, {
  readonly acquire: (project: string, holder: Holder) => Effect.Effect<Grant, never, SqlClient.SqlClient>
  readonly release: (project: string, job: string) => Effect.Effect<void, never, SqlClient.SqlClient>
  readonly holder: (project: string) => Holder | undefined
  readonly fenceOf: (project: string, job: string) => number | undefined
}>()("kiln/controller/Leases") {}

export const layer = Layer.sync(Leases)(() => {
  const states = new Map<string, State>()
  const fences = new Map<string, number>()
  const state = (project: string) => {
    let s = states.get(project)
    if (s === undefined) {
      s = { holder: undefined, waiter: undefined, newest: 0 }
      states.set(project, s)
    }
    return s
  }
  const grant = (project: string, holder: Holder) =>
    Effect.gen(function*() {
      const s = state(project)
      s.holder = holder
      s.newest = Math.max(s.newest, holder.run)
      const fence = yield* Db.next(`fence:${project}`).pipe(Effect.orDie)
      fences.set(`${project}/${holder.job}`, fence)
      return { _tag: "Held", fence } satisfies Grant
    })

  const release: Leases["Service"]["release"] = (project, job) =>
    Effect.gen(function*() {
      const s = state(project)
      if (s.waiter?.job === job) {
        yield* Deferred.succeed(s.waiter.granted, { _tag: "Replaced" })
        s.waiter = undefined
      }
      if (s.holder?.job !== job) return
      fences.delete(`${project}/${job}`)
      s.holder = undefined
      const next = s.waiter
      if (next !== undefined) {
        s.waiter = undefined
        const granted: Grant = next.run < s.newest ? { _tag: "Replaced" } : yield* grant(project, next)
        yield* Deferred.succeed(next.granted, granted)
      }
    })

  return {
    acquire: (project, holder) =>
      Effect.gen(function*() {
        const s = state(project)
        if (holder.run < s.newest) return { _tag: "Replaced" } satisfies Grant
        if (s.holder === undefined) return yield* grant(project, holder)
        if (s.waiter !== undefined) {
          if (s.waiter.run > holder.run) return { _tag: "Replaced" } satisfies Grant
          yield* Deferred.succeed(s.waiter.granted, { _tag: "Replaced" })
        }
        const granted = yield* Deferred.make<Grant>()
        s.waiter = { ...holder, granted }
        return yield* Deferred.await(granted).pipe(Effect.onInterrupt(() => release(project, holder.job)))
      }),
    release,
    holder: (project) => states.get(project)?.holder,
    fenceOf: (project, job) => fences.get(`${project}/${job}`),
  }
})
