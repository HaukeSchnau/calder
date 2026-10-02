import { Deferred, Effect } from "effect"

interface Waiter {
  readonly project: string
  readonly priority: number
  readonly seq: number
  readonly granted: Deferred.Deferred<void>
}

/**
 * A pool of slots that hands the next free one to the waiting step expected to finish soonest, so short
 * checks report before long ones start. With `perProject`, one project can't hold every slot.
 */
export const make = (options: { readonly capacity: number; readonly perProject?: number }) => {
  const waiters: Array<Waiter> = []
  const byProject = new Map<string, number>()
  let running = 0
  let seq = 0

  const fits = (project: string) => options.perProject === undefined || (byProject.get(project) ?? 0) < options.perProject

  const take = (project: string) => {
    running++
    byProject.set(project, (byProject.get(project) ?? 0) + 1)
  }

  const grant = () => {
    waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    for (let i = 0; i < waiters.length && running < options.capacity;) {
      const waiter = waiters[i]!
      if (!fits(waiter.project)) {
        i++
        continue
      }
      waiters.splice(i, 1)
      take(waiter.project)
      Deferred.doneUnsafe(waiter.granted, Effect.void)
    }
  }

  const release = (project: string) =>
    Effect.sync(() => {
      running--
      byProject.set(project, (byProject.get(project) ?? 1) - 1)
      grant()
    })

  const acquire = (project: string, priority: number) =>
    Effect.suspend(() => {
      if (running < options.capacity && fits(project) && waiters.length === 0) {
        take(project)
        return Effect.void
      }
      const waiter: Waiter = { project, priority, seq: seq++, granted: Deferred.makeUnsafe<void>() }
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
            return release(project)
          })
        ),
      )
    })

  return {
    /** Runs `effect` in a slot. Lower `priority` goes first; use the expected duration in ms. */
    with: <A, E, R>(project: string, priority: number, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(acquire(project, priority), () => effect, () => release(project)),
    usage: () => ({ running, waiting: waiters.length, capacity: options.capacity }),
  }
}

export type Slots = ReturnType<typeof make>
