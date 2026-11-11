import { Deferred, Effect } from "effect"

/**
 * Result keys whose jobs run right now, in any run: a run that needs one waits for it instead of
 * repeating the work, then looks for its result.
 */
export const make = () => {
  const keys = new Map<string, Deferred.Deferred<void>>()
  /** How many jobs hold each key `mark` marked. */
  const holders = new Map<string, number>()
  return {
    has: (key: string) => keys.has(key),
    /** Runs `effect` with `wanted` marked as in flight, unless another job already holds them. */
    flying: <A, E, R>(wanted: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const mine = wanted.filter((k) => !keys.has(k))
        const landed = Deferred.makeUnsafe<void>()
        for (const k of mine) keys.set(k, landed)
        return effect.pipe(Effect.ensuring(Effect.suspend(() => {
          for (const k of mine) if (keys.get(k) === landed) keys.delete(k)
          return Deferred.succeed(landed, undefined)
        })))
      }),
    /**
     * Marks `wanted` as in flight from now on, such as once a job started rather than while it waits for a
     * slot, also beside other jobs that hold them: each stays in flight until the last of its jobs lands.
     * Returns what lands them for this job.
     */
    mark: (wanted: ReadonlyArray<string>) =>
      Effect.sync(() => {
        for (const k of wanted) {
          if (!keys.has(k)) keys.set(k, Deferred.makeUnsafe<void>())
          holders.set(k, (holders.get(k) ?? 0) + 1)
        }
        return Effect.sync(() => {
          for (const k of wanted) {
            const left = (holders.get(k) ?? 1) - 1
            if (left > 0) {
              holders.set(k, left)
              continue
            }
            holders.delete(k)
            const landed = keys.get(k)
            keys.delete(k)
            if (landed !== undefined) Deferred.doneUnsafe(landed, Effect.void)
          }
        })
      }),
    /** Waits until none of `wanted` is in flight any more. */
    landing: (wanted: ReadonlyArray<string>) =>
      Effect.forEach([...new Set(wanted.flatMap((k) => keys.get(k) ?? []))], Deferred.await, { discard: true }),
  }
}
