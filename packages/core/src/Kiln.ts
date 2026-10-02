import { Schema, type Cause, type Layer } from "effect"
import type { Files } from "./Files.ts"
import type { Rule } from "./On.ts"
import type { Base, PrBase } from "./Services.ts"

export const StorePath = Schema.String.pipe(Schema.brand("@kiln/core/StorePath"))
export type StorePath = typeof StorePath.Type

export const Sha = Schema.String.pipe(Schema.brand("@kiln/core/Sha"))
export type Sha = typeof Sha.Type

declare const ResultBrandId: unique symbol
declare const FailureBrandId: unique symbol

export declare namespace Result {
  interface Brand {
    readonly [ResultBrandId]: true
  }
}
export declare namespace Failure {
  interface Brand {
    readonly [FailureBrandId]: true
  }
}

/** The typed failures of a step: errors that are `Kiln.Failure` instances. Everything else is a defect. */
export type FailureOf<E> = Extract<E, Failure.Brand>

/** How the UI shows a result. */
export interface Render {
  readonly render: "link" | "text"
  readonly label?: string
}

export interface Registered {
  readonly schema: Schema.Top
  readonly render: Render | undefined
}

/** Result and failure classes by `namespace/tag`, so stored values can be decoded and shown anywhere. */
export const registry = new Map<string, Registered>()

const register = <C>(id: string, schema: C, render?: Render): C => {
  registry.set(id, { schema: schema as Schema.Top, render })
  return schema
}

/** A Schema class for values an action returns, registered under `namespace/tag`. */
export const Result = <Self = never>(namespace: string) =>
<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
  render?: Render,
): Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Result.Brand> =>
  register(`${namespace}/${tag}`, Schema.TaggedClass<Self, Result.Brand>(`${namespace}/${tag}`)(tag, fields) as any, render)

/** A Schema error class for the typed failures of a step, registered under `namespace/tag`. */
export const Failure = <Self = never>(namespace: string) =>
<const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
): Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError & Failure.Brand> =>
  register(`${namespace}/${tag}`, Schema.TaggedError<Self, Failure.Brand>(`${namespace}/${tag}`)(tag, fields) as any)

export class TimedOut extends Failure<TimedOut>("@kiln/core")("TimedOut", { after: Schema.String }) {
  override get message() {
    return `timed out after ${this.after}`
  }
}

export const TestFailure = Schema.Struct({
  _tag: Schema.Literals(["TestFailed", "TestTimeout"]),
  suite: Schema.String,
  name: Schema.String,
  file: Schema.optional(Schema.String),
  message: Schema.String,
})
export type TestFailure = typeof TestFailure.Type

export class TaskFailed extends Failure<TaskFailed>("@kiln/core")("TaskFailed", {
  exitCode: Schema.Number,
  failures: Schema.Array(TestFailure),
}) {
  override get message() {
    return this.failures.length > 0
      ? `${this.failures.length} failing test${this.failures.length === 1 ? "" : "s"}`
      : `exited with ${this.exitCode}`
  }
}

export class BuildFailed extends Failure<BuildFailed>("@kiln/core")("BuildFailed", {
  attr: Schema.String,
  drv: Schema.optional(Schema.String),
}) {
  override get message() {
    return `nix build ${this.attr} failed`
  }
}

export const ProjectTypeId = "~@kiln/core/Project" as const

export interface Project {
  readonly [ProjectTypeId]: typeof ProjectTypeId
  readonly shared: Files | undefined
  readonly layer: Layer.Layer<never, unknown, Base> | undefined
  readonly rules: ReadonlyArray<Rule<"pr" | "trusted", any>>
}

export const isProject = (u: unknown): u is Project => typeof u === "object" && u !== null && ProjectTypeId in u

/**
 * A project's pipeline. Pull-request rules get `PrBase`, trusted rules get `Base`, and both get what
 * `layer` provides. `NoInfer` keeps the rules from inventing services the layer doesn't provide.
 */
export const project = <ROut = never, E = never>(options: {
  readonly shared?: Files
  readonly layer?: Layer.Layer<ROut, E, Base>
  readonly rules: ReadonlyArray<Rule<"pr", PrBase | NoInfer<ROut>> | Rule<"trusted", Base | NoInfer<ROut>>>
}): Project => ({
  [ProjectTypeId]: ProjectTypeId,
  shared: options.shared,
  layer: options.layer,
  rules: options.rules,
})

export { plan, PlanError, type Plan, type PlannedStep, universe } from "./Plan.ts"
