import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { SqlClient } from "effect/sql"
import * as Counters from "./Counters.ts"
import { Jobs } from "./Jobs.ts"

export type Grant = { readonly _tag: "Held"; readonly fence: number } | { readonly _tag: "Replaced"; readonly by: number }

export interface Holder {
  readonly job: string
  readonly run: number
  /** The step asking: what it deploys, such as one host, which only the same step of a newer run replaces. */
  readonly step: string
}
interface Waiter extends Holder {
  readonly granted: Deferred.Deferred<Grant>
}
interface State {
  holder: Holder | undefined
  /** In the order they asked. */
  waiters: Array<Waiter>
}

/** Where grants outlive the controller. */
export interface Store {
  /** A fencing token higher than any it returned before for the project. */
  readonly nextFence: (project: string) => Effect.Effect<number>
  /** Records the holder, and its run as the newest whose step held the lease. */
  readonly held: (project: string, holder: Holder, fence: number) => Effect.Effect<void>
  readonly released: (project: string, job: string) => Effect.Effect<void>
}

/** What the store kept, so a restart neither lets an older deploy in nor starts a second one beside a running one. */
export interface Saved {
  /** The newest run each step held the lease in. */
  readonly newest: ReadonlyArray<{ readonly project: string; readonly step: string; readonly run: number }>
  /** Holders from before the restart whose workers still run. */
  readonly holders: ReadonlyArray<Holder & { readonly project: string; readonly fence: number }>
}

/**
 * One deploy at a time per project, latest wins per step: once a step of a run held the lease, the
 * same step of an older run never gets it. Other steps of a newer run don't replace it, nor does the
 * same step of a newer run that still waits, which may be cancelled before its turn. Every grant
 * carries a fencing token from a counter that survives restarts, so a promotion endpoint can refuse
 * a stale holder.
 */
export class Leases extends Context.Service<Leases, {
  readonly acquire: (project: string, holder: Holder) => Effect.Effect<Grant>
  readonly release: (project: string, job: string) => Effect.Effect<void>
  readonly holder: (project: string) => Holder | undefined
  readonly fenceOf: (project: string, job: string) => number | undefined
}>()("calder/controller/Leases") {}

export const make = (store: Store, saved: Saved = { newest: [], holders: [] }): Leases["Service"] => {
  const states = new Map<string, State>()
  const fences = new Map<string, number>()
  const newest = new Map(saved.newest.map((n) => [`${n.project}/${n.step}`, n.run]))
  const newestOf = (project: string, step: string) => newest.get(`${project}/${step}`) ?? 0
  const state = (project: string) => {
    let s = states.get(project)
    if (s === undefined) {
      s = { holder: undefined, waiters: [] }
      states.set(project, s)
    }
    return s
  }
  for (const { project, fence, ...holder } of saved.holders) {
    state(project).holder = holder
    fences.set(`${project}/${holder.job}`, fence)
  }

  const grant = (project: string, holder: Holder) =>
    Effect.gen(function*() {
      state(project).holder = holder
      newest.set(`${project}/${holder.step}`, Math.max(newestOf(project, holder.step), holder.run))
      const fence = yield* store.nextFence(project)
      fences.set(`${project}/${holder.job}`, fence)
      yield* store.held(project, holder, fence)
      return { _tag: "Held", fence } satisfies Grant
    })

  /**
   * Hands the free lease to the step that asked first, in the newest run waiting with that step, and
   * tells the older runs waiting with it that they were replaced. Deploys of the same run take it in turn.
   */
  const next = (project: string): Effect.Effect<void> =>
    Effect.gen(function*() {
      const s = state(project)
      const first = s.waiters[0]
      if (s.holder !== undefined || first === undefined) return
      const same = s.waiters.filter((waiter) => waiter.step === first.step)
      const chosen = same.reduce((a, b) => (b.run > a.run ? b : a))
      const by = Math.max(chosen.run, newestOf(project, first.step))
      const replaced = same.filter((waiter) => waiter.run < by)
      s.waiters = s.waiters.filter((waiter) => waiter !== chosen && !replaced.includes(waiter))
      if (chosen.run === by) yield* Deferred.succeed(chosen.granted, yield* grant(project, chosen))
      yield* Effect.forEach(replaced, (waiter) => Deferred.succeed(waiter.granted, { _tag: "Replaced", by }), { discard: true })
      yield* next(project)
    })

  const release: Leases["Service"]["release"] = (project, job) =>
    Effect.gen(function*() {
      const s = state(project)
      s.waiters = s.waiters.filter((waiter) => waiter.job !== job)
      if (s.holder?.job !== job) return
      fences.delete(`${project}/${job}`)
      s.holder = undefined
      yield* next(project)
      yield* store.released(project, job)
    })

  return {
    acquire: (project, holder) =>
      Effect.gen(function*() {
        const s = state(project)
        // A worker that lost its connection asks again for the lease it already holds.
        const held = fences.get(`${project}/${holder.job}`)
        if (s.holder?.job === holder.job && held !== undefined) return { _tag: "Held", fence: held } satisfies Grant
        const by = newestOf(project, holder.step)
        if (holder.run < by) return { _tag: "Replaced", by } satisfies Grant
        if (s.holder === undefined) return yield* grant(project, holder)
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
  const jobs = yield* Jobs
  const db = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
  const store: Store = {
    nextFence: (project) => db(Counters.nextAtLeast(`fence:${project}`, Date.now())),
    held: (project, holder, fence) =>
      db(sql.withTransaction(Effect.gen(function*() {
        yield* sql`insert into lease_steps (project, step, run) values (${project}, ${holder.step}, ${holder.run})
          on conflict (project, step) do update set run = max(run, ${holder.run})`
        yield* sql`insert or replace into lease_holders (project, job, run, step, fence)
          values (${project}, ${holder.job}, ${holder.run}, ${holder.step}, ${fence})`
      }))),
    released: (project, job) => db(sql`delete from lease_holders where project = ${project} and job = ${job}`).pipe(Effect.asVoid),
  }

  // A holder whose worker the restart adopted keeps the lease until that worker ends; the others are gone.
  const holders = yield* db(sql<Saved["holders"][number]>`select project, job, run, step, fence from lease_holders`)
  const adopted = holders.filter((h) => jobs.get(h.job) !== undefined)
  yield* Effect.forEach(holders.filter((h) => !adopted.includes(h)), (h) => store.released(h.project, h.job), { discard: true })
  const newest = yield* db(sql<Saved["newest"][number]>`select project, step, run from lease_steps`)
  const leases = make(store, { newest, holders: adopted })
  yield* Effect.forEach(adopted, (h) => Scope.addFinalizer(jobs.get(h.job)!.scope, leases.release(h.project, h.job)), { discard: true })
  return leases
}))
