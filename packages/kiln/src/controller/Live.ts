import type { Domain } from "@kiln/api"
import { Context, Effect, Layer, PubSub, Queue, Stream } from "effect"

const keep = 20_000
const excerptLines = 40

interface Buffer {
  readonly lines: Array<Domain.LogLine>
  readonly subscribers: Set<(line: Domain.LogLine) => void>
  done: boolean
}

/**
 * What only exists while it happens: output of running steps and the change feed. Finished output
 * lives in VictoriaLogs; this keeps it a while after a step ends so the UI doesn't wait for ingestion.
 */
export class Live extends Context.Service<Live, {
  readonly publish: (change: Domain.Change) => Effect.Effect<void>
  readonly changes: Stream.Stream<Domain.Change>
  readonly append: (runId: string, line: Domain.LogLine) => void
  readonly finish: (runId: string, step: string) => void
  readonly lines: (runId: string, step?: string) => ReadonlyArray<Domain.LogLine>
  /** Lines of a step as they arrive, starting after those `lines` returned. Ends when the step does. */
  readonly follow: (runId: string, step?: string) => Stream.Stream<Domain.LogLine>
  readonly running: (runId: string, step?: string) => boolean
  readonly excerpt: (runId: string, step: string) => string
}>()("kiln/controller/Live") {}

export const layer = Layer.effect(Live)(Effect.gen(function*() {
  const pubsub = yield* PubSub.unbounded<Domain.Change>()
  const buffers = new Map<string, Buffer>()
  const id = (runId: string, step: string) => `${runId}/${step}`
  const buffer = (runId: string, step: string) => {
    let b = buffers.get(id(runId, step))
    if (b === undefined) {
      b = { lines: [], subscribers: new Set(), done: false }
      buffers.set(id(runId, step), b)
    }
    return b
  }
  const matching = (runId: string, step?: string) =>
    [...buffers.entries()].filter(([key]) => (step === undefined ? key.startsWith(`${runId}/`) : key === id(runId, step))).map(([, b]) => b)

  return {
    publish: (change) => PubSub.publish(pubsub, change).pipe(Effect.asVoid),
    changes: Stream.fromPubSub(pubsub),
    append: (runId, line) => {
      const b = buffer(runId, line.step)
      b.done = false
      b.lines.push(line)
      if (b.lines.length > keep) b.lines.splice(0, b.lines.length - keep)
      for (const s of b.subscribers) s(line)
    },
    finish: (runId, step) => {
      const b = buffers.get(id(runId, step))
      if (b === undefined) return
      b.done = true
      for (const s of b.subscribers) s({ step, shard: null, stream: "kiln", level: "debug", timestamp: Date.now(), text: "\u0000end" })
      setTimeout(() => {
        if (buffers.get(id(runId, step)) === b && b.done) buffers.delete(id(runId, step))
      }, 15 * 60_000)
    },
    lines: (runId, step) => matching(runId, step).flatMap((b) => b.lines).sort((a, b) => a.timestamp - b.timestamp),
    follow: (runId, step) =>
      Stream.callback<Domain.LogLine>((queue) =>
        Effect.gen(function*() {
          const targets = step === undefined ? undefined : buffer(runId, step)
          const subscriber = (line: Domain.LogLine) => {
            if (line.text === "\u0000end") {
              if (targets !== undefined) Queue.endUnsafe(queue)
              return
            }
            Queue.offerUnsafe(queue, line)
          }
          const attach = () => {
            for (const b of step === undefined ? matching(runId) : [targets!]) b.subscribers.add(subscriber)
          }
          attach()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const b of buffers.values()) b.subscribers.delete(subscriber)
            })
          )
          if (targets?.done === true) Queue.endUnsafe(queue)
        })
      ),
    running: (runId, step) => matching(runId, step).some((b) => !b.done),
    excerpt: (runId, step) =>
      (buffers.get(id(runId, step))?.lines ?? [])
        .filter((l) => l.stream !== "kiln" || l.level !== "debug")
        .slice(-excerptLines)
        .map((l) => l.text)
        .join("\n"),
  }
}))
