import { Domain } from "@kiln/api"
import { Event } from "@kiln/core"
import { Console, Effect, Option, Schema, Stream } from "effect"

/** Manual inputs as a JSON object, such as `{"release":"testflight"}`. */
const manualInputs = Schema.decodeUnknownOption(Schema.fromJsonString(Event.Manual.fields.inputs))

const readEvent = (kind: string, arg: string | undefined): Event.Event | undefined => {
  switch (kind) {
    case "push":
      return arg === "" ? undefined : Event.push(arg ?? "main")
    case "pr": {
      const number = Number(arg ?? 1)
      return Number.isSafeInteger(number) && number > 0 ? Event.pullRequest({ number }) : undefined
    }
    case "check":
      return arg === "" ? undefined : Event.check({ ref: arg ?? "kiln/check/local" })
    case "schedule":
      return arg === undefined || arg === "" ? undefined : Event.schedule(arg)
    case "manual":
      return arg === undefined ? Event.manual() : Option.getOrUndefined(Option.map(manualInputs(arg), Event.manual))
  }
}

/** Reads `kiln plan --event`. */
export const parseEvent = (text: string): Effect.Effect<Event.Event, Error> => {
  const colon = text.indexOf(":")
  const event = colon === -1 ? readEvent(text, undefined) : readEvent(text.slice(0, colon), text.slice(colon + 1))
  return event === undefined
    ? Effect.fail(new Error(`--event ${text} is not an event; use push[:<branch>], pr[:<number>], check[:<ref>], schedule:<cron> or manual[:<json object>]`))
    : Effect.succeed(event)
}

const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    previous = row
  }
  return previous[b.length]!
}

/** `names` ordered by how close they are to what was typed, closest first. */
export const closest = (typed: string, names: ReadonlyArray<string>) =>
  names.map((name) => ({ name, d: distance(typed, name) })).sort((x, y) => x.d - y.d).map((x) => x.name)

export const stepLine = (step: Domain.StepRun) => `  ${step.status.padEnd(9)} ${step.name}${step.error ? `: ${step.error.message.split("\n")[0]}` : ""}`

/** Prints a run's status and steps as they change until it ends; returns the run as it ended. */
export const follow = <E>(
  client: {
    readonly changes: () => Stream.Stream<Domain.Change, E>
    readonly run: (input: { readonly id: string }) => Effect.Effect<Domain.RunDetail, E>
  },
  run: Domain.Run,
) =>
  Effect.gen(function*() {
    let last = run
    const report = (r: Domain.Run) =>
      Effect.sync(() => (last = r)).pipe(Effect.andThen(Console.log(`${r.status}${r.error ? `: ${r.error}` : ""}`)))
    yield* Console.log(`${run.project} #${run.number} ${run.commit.sha.slice(0, 12)} ${run.commit.title}`)
    yield* report(run)
    // The run may end before the change feed starts, so its current state joins the feed.
    const current = Stream.fromEffect(client.run({ id: run.id })).pipe(
      Stream.map((detail): Domain.Change => ({ _tag: "RunChanged", seq: detail.seq, run: detail.run })),
    )
    yield* client.changes().pipe(
      Stream.merge(current),
      Stream.filter((c) => (c._tag === "StepChanged" ? c.step.runId === run.id : c._tag === "RunChanged" && c.run.id === run.id)),
      Stream.tap((c) =>
        c._tag === "StepChanged" ? Console.log(stepLine(c.step)) : c._tag === "RunChanged" && c.run.status !== last.status ? report(c.run) : Effect.void
      ),
      Stream.takeUntil((c) => c._tag === "RunChanged" && Domain.ended.has(c.run.status)),
      Stream.runDrain,
    )
    return last
  })
