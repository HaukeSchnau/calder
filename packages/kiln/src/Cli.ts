import { Event } from "@kiln/core"
import { Effect, Option, Schema } from "effect"

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
