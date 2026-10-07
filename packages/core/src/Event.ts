import { Schema } from "effect"

export const PullRequest = Schema.TaggedStruct("PullRequest", {
  number: Schema.Number,
  base: Schema.String,
  head: Schema.String,
})
export const Push = Schema.TaggedStruct("Push", { branch: Schema.String })
export const Scheduled = Schema.TaggedStruct("Schedule", { cron: Schema.String })
export const Manual = Schema.TaggedStruct("Manual", { inputs: Schema.Record(Schema.String, Schema.Unknown) })
/** A working copy checked before it is pushed (`kiln check`), pushed as `ref`. It runs what a pull request would. */
/** A working copy `kiln check` pushed as `ref`; `background` checks only take slots nothing else wants. */
export const Check = Schema.TaggedStruct("Check", { ref: Schema.String, base: Schema.String, background: Schema.optional(Schema.Boolean) })

export const Event = Schema.Union([PullRequest, Push, Scheduled, Manual, Check])
export type Event = typeof Event.Type

export const pullRequest = (options: { readonly number: number; readonly base?: string; readonly head?: string }): Event =>
  PullRequest.make({ number: options.number, base: options.base ?? "main", head: options.head ?? `pr-${options.number}` })

export const push = (branch: string): Event => Push.make({ branch })

export const schedule = (cron: string): Event => Scheduled.make({ cron })

export const manual = (inputs: { readonly [name: string]: unknown } = {}): Event => Manual.make({ inputs })

export const check = (options: { readonly ref: string; readonly base?: string }): Event =>
  Check.make({ ref: options.ref, base: options.base ?? "main" })

export const describe = (event: Event): string => {
  switch (event._tag) {
    case "PullRequest":
      return `pull request #${event.number}`
    case "Push":
      return `push to ${event.branch}`
    case "Schedule":
      return `schedule ${event.cron}`
    case "Manual":
      return "manual"
    case "Check":
      return `check of ${event.ref}`
  }
}
