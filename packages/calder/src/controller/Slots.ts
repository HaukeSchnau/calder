import { Deferred, Effect } from "effect"

/** What a step asks the pool for. */
export interface Claim {
  readonly project: string
  /** Expected run time in ms: shorter goes first, and waiting earns the same amount back. */
  readonly expected: number
  /** When the step's run was created: within a project, older runs go first. */
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
}

interface Waiter extends Claim {
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
 * A pool of slots. A project's waiting steps go in run order, the shortest of a run first, so runs
 * reach a verdict instead of all advancing slowly. Across projects the step expected to finish soonest
 * goes first, minus the time it has waited, so short checks report quickly and long ones still start.
 * `perProject` keeps one project from holding every slot while another project waits; while nobody
 * else waits, it may use them all. Critical claims go before all others and have `lane` slots beyond
 * `capacity` to themselves.
 */
export const make = (options: {
  readonly capacity: number
  readonly perProject?: number
  /** Slots beyond capacity that only critical claims take. */
  readonly lane?: number
  readonly now?: () => number
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

  const take = (claim: { readonly project: string; readonly label?: string | undefined; readonly critical?: boolean | undefined }) => {
    const holder: Holder = { project: claim.project, label: claim.label ?? claim.project, critical: claim.critical === true }
    holders.push(holder)
    byProject.set(claim.project, (byProject.get(claim.project) ?? 0) + 1)
    return holder
  }

  const inRunOrder = (a: Waiter, b: Waiter) => a.run - b.run || a.expected - b.expected || a.seq - b.seq

  /**
   * Whether a claim may have a slot now: background work leaves one free and yields to the rest, critical
   * work has the lane. Critical work fills the lane first, so the lane never counts against other work.
   */
  const eligible = (w: Claim) => {
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
      // Each project's front is its critical work first, then its oldest run's shortest step.
      const fronts = new Map<string, Waiter>()
      for (const waiter of ready) {
        const front = fronts.get(waiter.project)
        const before = front === undefined ||
          (waiter.critical === true) !== (front.critical === true) ? waiter.critical === true : inRunOrder(waiter, front) < 0
        if (front === undefined || before) fronts.set(waiter.project, waiter)
      }
      // A project over its share goes only when no other project's front fits; critical work goes first among those that do.
      const fitting = [...fronts.values()].filter((w) => fits(w.project))
      const pool = fitting.length > 0 ? fitting : [...fronts.values()]
      const critical = pool.filter((w) => w.critical === true)
      const candidates = critical.length > 0 ? critical : pool
      const at = now()
      const score = (w: Waiter) => w.expected - (at - w.since)
      const next = candidates.reduce((best, w) => (score(w) < score(best) || (score(w) === score(best) && w.seq < best.seq) ? w : best))
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
      if (eligible(claim) && fits(claim.project) && waiters.length === 0) return Effect.succeed(take(claim))
      const waiter: Waiter = { ...claim, seq: seq++, since: now(), granted: Deferred.makeUnsafe<void>() }
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
              return Effect.void
            }
            // Granted just as we were interrupted: hand the slot on.
            const holder = holding.get(waiter.granted)
            holding.delete(waiter.granted)
            return holder === undefined ? Effect.void : release(holder)
          })
        ),
      )
    })

  return {
    /** Runs `effect` in a slot. Interrupting it while it waits gives up its place in the queue. */
    with: <A, E, R>(claim: Claim, effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        restore(acquire(claim)).pipe(Effect.flatMap((holder) => restore(effect).pipe(Effect.ensuring(release(holder)))))
      ),
    /**
     * Counts a job that already runs, such as one adopted after a restart, at once and even past
     * capacity. Returns what gives the slot back.
     */
    reserve: (project: string, label?: string) => release(take({ project, label: label ?? `${project} (adopted)` })),
    usage: () => ({ running: holders.length, waiting: waiters.length, capacity: options.capacity }),
    /**
     * Why `claim` would wait for a slot right now, such as `3 of 3 busy: t3code-452 test-server, ...`, or
     * null when it would get one at once.
     */
    waitsFor: (claim: Claim): string | null => {
      if (eligible(claim) && fits(claim.project) && waiters.length === 0) return null
      const ahead = waiters.filter((w) => claim.critical === true ? w.critical === true : true).length
      const busy = `${holders.length} of ${options.capacity}${claim.critical === true && lane > 0 ? ` (+${lane} for deploys)` : ""} busy`
      // Reasons reach pull requests' comments, so other projects' steps stay nameless.
      const others = holders.filter((h) => h.project !== claim.project).length
      const own = holders.filter((h) => h.project === claim.project).map((h) => h.label)
      const who = [...own.slice(0, 4), ...(own.length > 4 ? ["..."] : []), ...(others === 0 ? [] : [`${others} of other projects`])].join(", ")
      return `${busy}${who === "" ? "" : `: ${who}`}${ahead > 0 ? `; ${ahead} ahead` : ""}`
    },
  }
}

export type Slots = ReturnType<typeof make>
