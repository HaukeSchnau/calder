import { Effect, Layer } from "effect"

/** When each layer that is stopping right now began to. */
const stopping = new Map<string, number>()

/** The layers stopping right now, longest first, as "Runs for 95 s". */
export const report = (now: number) =>
  [...stopping].sort(([, a], [, b]) => a - b).map(([name, since]) => `${name} for ${Math.round((now - since) / 1000)} s`)

/**
 * `layer`, counted as stopping from when its finalizers begin until they end. From 2026-11-11 on, every stop of
 * srv-2's controller ran until systemd's SIGKILL two minutes later, and no line said what it waited for.
 */
export const named = <A, E, R>(name: string, layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> => {
  const begins = Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => stopping.set(name, Date.now()))))
  const ends = Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => stopping.delete(name))))
  // Finalizers run in reverse: `begins`, built last, before the layer's own, and `ends` after them.
  return begins.pipe(Layer.provideMerge(layer), Layer.provideMerge(ends))
}

/**
 * Logs every 15 s of a stop which layers it still waits for. The timer doesn't keep the process alive, and
 * no line at all means something blocks the event loop.
 */
export const reportWhileStopping = Layer.effectDiscard(Effect.sync(() => {
  process.once("SIGTERM", () => {
    const signalled = Date.now()
    setInterval(() => {
      const now = Date.now()
      const layers = report(now)
      console.error(
        `still stopping after ${Math.round((now - signalled) / 1000)} s: ${layers.length === 0 ? "no layer has begun to stop" : layers.join(", ")}`,
      )
    }, 15_000).unref()
  })
}))
