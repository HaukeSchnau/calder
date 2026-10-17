import { Domain } from "@calder-ci/api"
import { type Cause, Context, Effect, Layer, PubSub, Queue, Stream } from "effect"

const keep = 20_000
const excerptLines = 40

interface Buffer {
  readonly lines: Array<Domain.LogLine>
  done: boolean
}

interface Follower {
  readonly runId: string
  /** Undefined follows every step of the run. */
  readonly step: string | undefined
  readonly offer: (line: Domain.LogLine) => void
  readonly end: () => void
}

/**
 * What only exists while it happens: output of running steps and the change feed. Finished output
 * lives in VictoriaLogs; this keeps it a while after a step ends so the UI doesn't wait for ingestion.
 */
type Unsequenced<C> = C extends unknown ? Omit<C, "seq"> : never

export class Live extends Context.Service<Live, {
  /** Numbers the change and sends it to every subscriber. */
  readonly publish: (change: Unsequenced<Domain.Change>) => Effect.Effect<void>
  /** The seq of the last published change, for snapshots. */
  readonly seq: () => number
  readonly changes: Stream.Stream<Domain.Change>
  readonly append: (runId: string, line: Domain.LogLine) => void
  readonly finish: (runId: string, step: string) => void
  readonly lines: (runId: string, step?: string) => ReadonlyArray<Domain.LogLine>
  /**
   * Lines of a step, or of every step of the run including those that start later, as they arrive,
   * starting after those `lines` returned. Ends when the step or the run does.
   */
  readonly follow: (runId: string, step?: string) => Stream.Stream<Domain.LogLine>
  readonly running: (runId: string, step?: string) => boolean
  readonly excerpt: (runId: string, step: string) => string
}>()("calder/controller/Live") {}

export const layer = Layer.effect(Live)(Effect.gen(function*() {
  const pubsub = yield* PubSub.unbounded<Domain.Change>()
  const buffers = new Map<string, Buffer>()
  const followers = new Set<Follower>()
  /** Runs whose end was published lately, so following one that just ended stops at once. */
  const ended = new Set<string>()
  let seq = 0
  const id = (runId: string, step: string) => `${runId}/${step}`
  const buffer = (runId: string, step: string) => {
    let b = buffers.get(id(runId, step))
    if (b === undefined) {
      b = { lines: [], done: false }
      buffers.set(id(runId, step), b)
    }
    return b
  }
  const matching = (runId: string, step?: string) =>
    [...buffers.entries()].filter(([key]) => (step === undefined ? key.startsWith(`${runId}/`) : key === id(runId, step))).map(([, b]) => b)

  return {
    publish: (change) =>
      Effect.suspend(() => {
        if (change._tag === "RunChanged" && Domain.ended.has(change.run.status)) {
          const runId = change.run.id
          ended.add(runId)
          setTimeout(() => ended.delete(runId), 15 * 60_000)
          for (const f of followers) if (f.runId === runId) f.end()
        }
        return PubSub.publish(pubsub, { ...change, seq: ++seq } as Domain.Change)
      }).pipe(Effect.asVoid),
    seq: () => seq,
    changes: Stream.fromPubSub(pubsub),
    append: (runId, line) => {
      const b = buffer(runId, line.step)
      b.done = false
      b.lines.push(line)
      if (b.lines.length > keep) b.lines.splice(0, b.lines.length - keep)
      for (const f of followers) if (f.runId === runId && (f.step === undefined || f.step === line.step)) f.offer(line)
    },
    finish: (runId, step) => {
      for (const f of followers) if (f.runId === runId && f.step === step) f.end()
      const b = buffers.get(id(runId, step))
      if (b === undefined) return
      b.done = true
      setTimeout(() => {
        if (buffers.get(id(runId, step)) === b && b.done) buffers.delete(id(runId, step))
      }, 15 * 60_000)
    },
    lines: (runId, step) => matching(runId, step).flatMap((b) => b.lines).sort((a, b) => a.timestamp - b.timestamp),
    follow: (runId, step) =>
      Stream.unwrap(Effect.gen(function*() {
        const queue = yield* Queue.unbounded<Domain.LogLine, Cause.Done>()
        const follower: Follower = { runId, step, offer: (line) => Queue.offerUnsafe(queue, line), end: () => Queue.endUnsafe(queue) }
        followers.add(follower)
        yield* Effect.addFinalizer(() => Effect.sync(() => followers.delete(follower)))
        if (ended.has(runId) || (step !== undefined && buffers.get(id(runId, step))?.done === true)) follower.end()
        return Stream.fromQueue(queue)
      })),
    running: (runId, step) => matching(runId, step).some((b) => !b.done),
    excerpt: (runId, step) =>
      (buffers.get(id(runId, step))?.lines ?? [])
        .filter((l) => l.stream !== "calder" || l.level !== "debug")
        .slice(-excerptLines)
        .map((l) => l.text)
        .join("\n"),
  }
}))
