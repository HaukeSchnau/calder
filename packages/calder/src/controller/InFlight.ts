import { Deferred, Effect } from "effect";

/** A job that holds keys: `landed` completes when it ends, `raised` raises its claim (Slots `raised`). */
interface Flight {
  readonly landed: Deferred.Deferred<void>;
  readonly raised?: Deferred.Deferred<void> | undefined;
}

/**
 * Result keys whose jobs run right now, in any run: a run that needs one waits for it instead of
 * repeating the work, then looks for its result.
 */
export const make = () => {
  const keys = new Map<string, Flight>();
  /** How many jobs hold each key `mark` marked. */
  const holders = new Map<string, number>();
  return {
    has: (key: string) => keys.has(key),
    /**
     * Runs `effect` with `wanted` marked as in flight, unless another job already holds them. `raised` is
     * the background claim of `effect`'s job, which a run that waits for these keys raises (`landing`).
     */
    flying: <A, E, R>(
      wanted: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
      raised?: Deferred.Deferred<void>,
    ) =>
      Effect.suspend(() => {
        const mine = wanted.filter((k) => !keys.has(k));
        const flight: Flight = { landed: Deferred.makeUnsafe<void>(), raised };
        for (const k of mine) keys.set(k, flight);
        return effect.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              for (const k of mine) if (keys.get(k) === flight) keys.delete(k);
              return Deferred.succeed(flight.landed, undefined);
            }),
          ),
        );
      }),
    /**
     * Marks `wanted` as in flight from now on, such as once a job started rather than while it waits for a
     * slot, also beside other jobs that hold them: each stays in flight until the last of its jobs lands.
     * Returns what lands them for this job.
     */
    mark: (wanted: ReadonlyArray<string>) =>
      Effect.sync(() => {
        for (const k of wanted) {
          if (!keys.has(k)) keys.set(k, { landed: Deferred.makeUnsafe<void>() });
          holders.set(k, (holders.get(k) ?? 0) + 1);
        }
        return Effect.sync(() => {
          for (const k of wanted) {
            const left = (holders.get(k) ?? 1) - 1;
            if (left > 0) {
              holders.set(k, left);
              continue;
            }
            holders.delete(k);
            const flight = keys.get(k);
            keys.delete(k);
            if (flight !== undefined) Deferred.doneUnsafe(flight.landed, Effect.void);
          }
        });
      }),
    /**
     * Waits until none of `wanted` is in flight any more. With `raise`, for work that isn't background work,
     * the jobs it waits for no longer yield to other work while they wait for a slot.
     */
    landing: (wanted: ReadonlyArray<string>, options: { readonly raise?: boolean } = {}) =>
      Effect.suspend(() => {
        const flights = [...new Set(wanted.flatMap((k) => keys.get(k) ?? []))];
        if (options.raise === true)
          for (const f of flights)
            if (f.raised !== undefined) Deferred.doneUnsafe(f.raised, Effect.void);
        return Effect.forEach(flights, (f) => Deferred.await(f.landed), { discard: true });
      }),
  };
};
