import { Deferred, Duration, Effect } from "effect"

/** What a step asks the pool for. */
export interface Claim {
  readonly project: string
  /** Expected run time in ms: shorter goes first, and waiting earns the same amount back. */
  readonly expected: number
  /** When the step's run was created: between claims that score the same, the older run goes first. */
  readonly run: number
  /** Work nobody waits for, such as checks of agents' snapshots: it gets a slot only while no other step wants one and another stays free. */
  readonly background?: boolean
  /**
   * On a deploy's or a preview's critical path: it goes before every claim that isn't, and may take one
   * of the lane's slots beyond capacity, so a preview never queues behind a long check.
   */
  readonly critical?: boolean
  /** Who asks, such as `studienbuch-21 lint`, for the reason others wait. */
  readonly label?: string
  /** The run it waits for, whose claims `withdraw` takes out of the queue when the run is superseded. */
  readonly owner?: string
  /**
   * While it waits, an agent of one of the platforms `to` may take it instead (`spill`), which completes
   * `signal`. The claim then no longer waits; its caller runs the job on the agent. The first is the job's
   * own platform, the rest are other systems it may run on.
   */
  readonly spill?: { readonly to: ReadonlyArray<string>; readonly signal: Deferred.Deferred<void> }
}

interface Waiter extends Claim {
  /** The claim as its caller holds it, so `waitsFor` can tell it from the others. */
  readonly claim: Claim
  readonly seq: number
  readonly since: number
  readonly granted: Deferred.Deferred<void>
}

/** A claim that holds a slot. */
interface Holder {
  readonly project: string
  readonly label: string
  readonly critical: boolean
}

/**
 * A pool of slots. The waiting step expected to finish soonest goes first, minus the time it has waited,
 * within a project as across projects, so short work reports quickly and long work still starts once it
 * has waited as long as it is expected to take. Within a project that used to be run order, older runs
 * first, which kept infra's one-file pull requests behind whole-fleet rebuilds of older runs; between
 * claims that score the same, the older run still goes first. `perProject` keeps one project from
 * holding every slot while another project waits; while nobody else waits, it may use them all.
 * `maxPerProject` holds even then. Critical claims go before all others and have `lane` slots beyond
 * `capacity` to themselves.
 */
export const make = (options: {
  readonly capacity: number
  readonly perProject?: number
  /** At most this many slots per project, even while nobody else waits, so one project's stuck jobs can't hold them all. */
  readonly maxPerProject?: number
  /** Slots beyond capacity that only critical claims take. */
  readonly lane?: number
  readonly now?: () => number
  /** How often a waiting claim's reason is read again, for `with`'s `onWaiting`. */
  readonly refresh?: Duration.Input
}) => {
  const now = options.now ?? Date.now
  const lane = options.lane ?? 0
  const waiters: Array<Waiter> = []
  const holders: Array<Holder> = []
  const byProject = new Map<string, number>()
  /** The slot each granted waiter holds, until its fiber picks it up. */
  const holding = new Map<Deferred.Deferred<void>, Holder>()
  let seq = 0

  const fits = (project: string) => options.perProject === undefined || (byProject.get(project) ?? 0) < options.perProject
  const under = (project: string) => options.maxPerProject === undefined || (byProject.get(project) ?? 0) < options.maxPerProject

  const take = (claim: { readonly project: string; readonly label?: string | undefined; readonly critical?: boolean | undefined }) => {
    const holder: Holder = { project: claim.project, label: claim.label ?? claim.project, critical: claim.critical === true }
    holders.push(holder)
    byProject.set(claim.project, (byProject.get(claim.project) ?? 0) + 1)
    return holder
  }

  /** Lower goes first: what the claim is expected to take less what it has waited, then the older run. */
  const before = (a: Waiter, b: Waiter, at: number) =>
    (a.expected - (at - a.since)) - (b.expected - (at - b.since)) || a.run - b.run || a.seq - b.seq

  /**
   * Whether a claim may have a slot now: background work leaves one free and yields to the rest, critical
   * work has the lane. Critical work fills the lane first, so the lane never counts against other work.
   */
  const eligible = (w: Claim) => {
    if (!under(w.project)) return false
    const running = holders.length
    const regular = running - Math.min(lane, holders.filter((h) => h.critical).length)
    if (w.critical === true) return running < options.capacity + lane
    if (w.background === true) return regular < options.capacity - 1 && !waiters.some((o) => o.background !== true)
    return regular < options.capacity
  }

  const grant = () => {
    while (true) {
      const ready = waiters.filter(eligible)
      if (ready.length === 0) return
      const at = now()
      // Each project's front is its critical work first, then the claim that goes first by `before`.
      const fronts = new Map<string, Waiter>()
      for (const waiter of ready) {
        const front = fronts.get(waiter.project)
        const first = front === undefined ||
          ((waiter.critical === true) !== (front.critical === true) ? waiter.critical === true : before(waiter, front, at) < 0)
        if (first) fronts.set(waiter.project, waiter)
      }
      // A project over its share goes only when no other project's front fits; critical work goes first among those that do.
      const fitting = [...fronts.values()].filter((w) => fits(w.project))
      const pool = fitting.length > 0 ? fitting : [...fronts.values()]
      const critical = pool.filter((w) => w.critical === true)
      const candidates = critical.length > 0 ? critical : pool
      const next = candidates.reduce((best, w) => (before(w, best, at) < 0 ? w : best))
      waiters.splice(waiters.indexOf(next), 1)
      holding.set(next.granted, take(next))
      Deferred.doneUnsafe(next.granted, Effect.void)
    }
  }
  const release = (holder: Holder) =>
    Effect.sync(() => {
      const index = holders.indexOf(holder)
      if (index < 0) return
      holders.splice(index, 1)
      byProject.set(holder.project, (byProject.get(holder.project) ?? 1) - 1)
      grant()
    })

  const acquire = (claim: Claim): Effect.Effect<Holder> =>
    Effect.suspend(() => {
      if (eligible(claim) && fits(claim.project) && !waiters.some(eligible)) return Effect.succeed(take(claim))
      const waiter: Waiter = { ...claim, claim, seq: seq++, since: now(), granted: Deferred.makeUnsafe<void>() }
      waiters.push(waiter)
      grant()
      const handOver = Effect.sync(() => {
        const holder = holding.get(waiter.granted)!
        holding.delete(waiter.granted)
        return holder
      })
      return Deferred.await(waiter.granted).pipe(
        Effect.andThen(handOver),
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) {
              waiters.splice(index, 1)
              // Background work may have waited only for this claim.
              return Effect.sync(grant)
            }
            // Granted just as we were interrupted: hand the slot on.
            const holder = holding.get(waiter.granted)
            holding.delete(waiter.granted)
            return holder === undefined ? Effect.void : release(holder)
          })
        ),
      )
    })

  /** Why `claim` would wait for a slot now, or null when it would get one at once. A waiting claim counts only the claims queued before it. */
  const waitsFor = (claim: Claim): string | null => {
    const mine = waiters.find((w) => w.claim === claim)
    if (mine === undefined && eligible(claim) && fits(claim.project) && !waiters.some(eligible)) return null
    // The waiters the queue's order puts first: critical ones, then by `before`.
    const at = now()
    const self = mine ?? { ...claim, claim, seq: seq, since: at, granted: undefined as never }
    const ahead = waiters.filter((w) =>
      w !== mine && ((w.critical === true) !== (self.critical === true) ? w.critical === true : before(w, self, at) < 0)
    ).length
    // A check doesn't count the critical work in the lane, since the lane is beyond the capacity.
    const inLane = Math.min(lane, holders.filter((h) => h.critical).length)
    const busy = claim.critical === true
      ? `${holders.length} of ${options.capacity}${lane > 0 ? ` (+${lane} for deploys)` : ""} busy`
      : `${holders.length - inLane} of ${options.capacity} busy${inLane > 0 ? ` (+${inLane} ${inLane === 1 ? "deploy or preview" : "deploys or previews"})` : ""}`
    // Reasons reach pull requests' comments, so other projects' steps stay nameless.
    const others = holders.filter((h) => h.project !== claim.project).length
    const own = holders.filter((h) => h.project === claim.project).map((h) => h.label)
    const who = [...own.slice(0, 4), ...(own.length > 4 ? ["..."] : []), ...(others === 0 ? [] : [`${others} of other projects`])].join(", ")
    return `${busy}${who === "" ? "" : `: ${who}`}${ahead > 0 ? `; ${ahead} ahead` : ""}`
  }

  /** Waits for a slot, telling `onWaiting` why whenever that changes, from the first moment it has to wait. */
  const reporting = (claim: Claim, onWaiting: (reason: string) => Effect.Effect<void>) =>
    Effect.gen(function*() {
      const first = waitsFor(claim)
      if (first === null) return yield* acquire(claim)
      yield* onWaiting(first)
      let shown = first
      const follow = Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep(options.refresh ?? "15 seconds")
          const reason = waitsFor(claim)
          if (reason !== null && reason !== shown) {
            shown = reason
            yield* onWaiting(reason)
          }
        }
      })
      return yield* Effect.scoped(Effect.forkScoped(follow).pipe(Effect.andThen(acquire(claim))))
    })

  return {
    /**
     * Runs `effect` in a slot. Interrupting it while it waits gives up its place in the queue. While it
     * waits, `onWaiting` hears why, again whenever the queue moves.
     */
    with: <A, E, R>(claim: Claim, effect: Effect.Effect<A, E, R>, onWaiting?: (reason: string) => Effect.Effect<void>) =>
      Effect.uninterruptibleMask((restore) =>
        restore(onWaiting === undefined ? acquire(claim) : reporting(claim, onWaiting)).pipe(
          Effect.flatMap((holder) => restore(effect).pipe(Effect.ensuring(release(holder)))),
        )
      ),
    /**
     * Counts a job that already runs, such as one adopted after a restart, at once and even past
     * capacity. Returns what gives the slot back.
     */
    reserve: (project: string, label?: string) => release(take({ project, label: label ?? `${project} (adopted)` })),
    usage: () => ({ running: holders.length, waiting: waiters.length, capacity: options.capacity }),
    /**
     * Takes the waiting claims of run `owner` out of the queue at once, so no slot goes to them and none
     * counts as waiting. Their callers still wait until interrupted.
     */
    withdraw: (owner: string) => {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.owner === owner) waiters.splice(i, 1)
      // Background work may have waited only for those claims.
      grant()
    },
    /**
     * Gives the waiting claim that goes first among those an agent of `platform` may take (`Claim.spill`) to
     * that agent: takes it out of the queue and completes its signal. False when no such claim waits. An
     * agent that takes only other systems' jobs (`othersOnly`) takes none whose own platform it has.
     */
    spill: (platform: string, othersOnly = false) => {
      const takers = waiters.filter((w) => w.spill !== undefined && (othersOnly ? w.spill.to.slice(1) : w.spill.to).includes(platform))
      if (takers.length === 0) return false
      const at = now()
      const next = takers.reduce((best, w) =>
        (w.critical === true) !== (best.critical === true) ? (w.critical === true ? w : best) : before(w, best, at) < 0 ? w : best
      )
      waiters.splice(waiters.indexOf(next), 1)
      Deferred.doneUnsafe(next.spill!.signal, Effect.void)
      // Background work may have waited only for this claim.
      grant()
      return true
    },
    /**
     * Why `claim` would wait for a slot right now, such as `3 of 3 busy: t3code-452 test-server, ...`, or
     * null when it would get one at once.
     */
    waitsFor,
  }
}

export type Slots = ReturnType<typeof make>
