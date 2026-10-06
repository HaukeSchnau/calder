import { Deferred, Effect } from "effect"

/** What a step asks the pool for. */
export interface Claim {
  readonly project: string
  /** Expected run time in ms: shorter goes first, and waiting earns the same amount back. */
  readonly expected: number
  /** When the step's run was created: within a project, older runs go first. */
  readonly run: number
}

interface Waiter extends Claim {
  readonly seq: number
  readonly since: number
  readonly granted: Deferred.Deferred<void>
}

/**
 * A pool of slots. A project's waiting steps go in run order, the shortest of a run first, so runs
 * reach a verdict instead of all advancing slowly. Across projects the step expected to finish soonest
 * goes first, minus the time it has waited, so short checks report quickly and long ones still start.
 * `perProject` keeps one project from holding every slot while another project waits; while nobody
 * else waits, it may use them all.
 */
export const make = (options: { readonly capacity: number; readonly perProject?: number; readonly now?: () => number }) => {
  const now = options.now ?? Date.now
  const waiters: Array<Waiter> = []
  const byProject = new Map<string, number>()
  let running = 0
  let seq = 0

  const fits = (project: string) => options.perProject === undefined || (byProject.get(project) ?? 0) < options.perProject

  const take = (project: string) => {
    running++
    byProject.set(project, (byProject.get(project) ?? 0) + 1)
  }

  const inRunOrder = (a: Waiter, b: Waiter) => a.run - b.run || a.expected - b.expected || a.seq - b.seq

  const grant = () => {
    while (running < options.capacity && waiters.length > 0) {
      const fronts = new Map<string, Waiter>()
      for (const waiter of waiters) {
        const front = fronts.get(waiter.project)
        if (front === undefined || inRunOrder(waiter, front) < 0) fronts.set(waiter.project, waiter)
      }
      const fitting = [...fronts.values()].filter((w) => fits(w.project))
      const candidates = fitting.length > 0 ? fitting : [...fronts.values()]
      const at = now()
      const score = (w: Waiter) => w.expected - (at - w.since)
      const next = candidates.reduce((best, w) => (score(w) < score(best) || (score(w) === score(best) && w.seq < best.seq) ? w : best))
      waiters.splice(waiters.indexOf(next), 1)
      take(next.project)
      Deferred.doneUnsafe(next.granted, Effect.void)
    }
  }

  const release = (project: string) =>
    Effect.sync(() => {
      running--
      byProject.set(project, (byProject.get(project) ?? 1) - 1)
      grant()
    })

  const acquire = (claim: Claim) =>
    Effect.suspend(() => {
      if (running < options.capacity && fits(claim.project) && waiters.length === 0) {
        take(claim.project)
        return Effect.void
      }
      const waiter: Waiter = { ...claim, seq: seq++, since: now(), granted: Deferred.makeUnsafe<void>() }
      waiters.push(waiter)
      grant()
      return Deferred.await(waiter.granted).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) {
              waiters.splice(index, 1)
              return Effect.void
            }
            // Granted just as we were interrupted: hand the slot on.
            return release(claim.project)
          })
        ),
      )
    })

  return {
    /** Runs `effect` in a slot. Interrupting it while it waits gives up its place in the queue. */
    with: <A, E, R>(claim: Claim, effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        restore(acquire(claim)).pipe(Effect.andThen(restore(effect).pipe(Effect.ensuring(release(claim.project)))))
      ),
    /** Counts a job that already runs, such as one adopted after a restart, even past capacity. */
    hold: <A, E, R>(project: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(Effect.sync(() => take(project)), () => effect, () => release(project)),
    usage: () => ({ running, waiting: waiters.length, capacity: options.capacity }),
  }
}

export type Slots = ReturnType<typeof make>
