import { Deferred, Effect } from "effect"

/**
 * Result keys whose jobs run right now, in any run: a run that needs one waits for it instead of
 * repeating the work, then looks for its result.
 */
export const make = () => {
  const keys = new Map<string, Deferred.Deferred<void>>()
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
    /** Waits until none of `wanted` is in flight any more. */
    landing: (wanted: ReadonlyArray<string>) =>
      Effect.forEach([...new Set(wanted.flatMap((k) => keys.get(k) ?? []))], Deferred.await, { discard: true }),
  }
}
