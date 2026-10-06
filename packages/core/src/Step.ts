import { Duration, Pipeable, type Effect } from "effect"
import type { Cmd } from "./Cmd.ts"
import type { Files } from "./Files.ts"
import type { FlakeRef } from "./Flake.ts"
import type { StorePath, TimedOut } from "./Kiln.ts"
import type { ReportSpec } from "./Report.ts"
import type { SecretRef } from "./Secret.ts"

export const TypeId = "~@kiln/core/Step" as const

export type Kind = "build" | "setup" | "task" | "action" | "output"
export type Platform = "aarch64-linux" | "x86_64-linux" | "aarch64-darwin"

/**
 * A step of a pipeline. `A` is its value, `E` its typed failure, `R` the services it needs,
 * `O` its named outputs and `G` the grants it declares.
 */
export interface Step<out A, out E = never, out R = never, out O = {}, out G = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: (_: never) => A
    readonly _E: (_: never) => E
    readonly _R: (_: never) => R
    readonly _G: (_: never) => G
  }
  readonly kind: Kind
  readonly name: string
  readonly outputs: { readonly [K in keyof O]: Step<StorePath, never, R> }
  readonly def: Def
  readonly policies: ReadonlyArray<Policy>
}

export declare namespace Step {
  type Any = Step<any, any, any, any, any>
  type Success<S> = S extends Step<infer A, any, any, any, any> ? A : never
  type Error<S> = S extends Step<any, infer E, any, any, any> ? E : never
  type Services<S> = S extends Step<any, any, infer R, any, any> ? R : never
  type Grants<S> = S extends Step<any, any, any, any, infer G> ? G : never

  interface Exit<A, E, R> {
    readonly _tag: "Exit"
    readonly step: Step<A, E, R, any, any>
  }
  interface Exits<T extends ReadonlyArray<Any>> {
    readonly _tag: "Exits"
    readonly steps: T
  }

  type Need = Any | Exit<any, any, any> | Exits<ReadonlyArray<Any>>
  type Needs = { readonly [key: string]: Need }

  type InputOf<N> = N extends Exit<infer A, infer E, any> ? Outcome<A, E>
    : N extends Exits<infer T> ? { readonly [K in keyof T]: Outcome<Success<T[K]>, Error<T[K]>> }
    : Success<N>
  type Inputs<N extends Needs> = { readonly [K in keyof N]: InputOf<N[K]> }

  type NeedServices<N extends Needs> = {
    [K in keyof N]: N[K] extends Exit<any, any, infer R> ? R
      : N[K] extends Exits<infer T> ? Services<T[number]>
      : Services<N[K]>
  }[keyof N]
}

export interface Passed<A> {
  readonly _tag: "Passed"
  readonly step: string
  readonly value: A
}
export interface Failed<E> {
  readonly _tag: "Failed"
  readonly step: string
  readonly error: E
}
/** The step threw something that isn't a `Kiln.Failure`, or its process died. */
export interface Died {
  readonly _tag: "Died"
  readonly step: string
  readonly message: string
}
/** A step this one depends on did not pass, so it never ran. */
export interface Blocked {
  readonly _tag: "Blocked"
  readonly step: string
}
export type Outcome<A, E> = Passed<A> | Failed<E> | Died | Blocked

export type Grants = {
  readonly deploy?: true
  readonly secrets?: ReadonlyArray<string>
}

export type Policy =
  | { readonly _tag: "Retry"; readonly options: Effect.Retry.Options<any> }
  | { readonly _tag: "Timeout"; readonly duration: Duration.Duration }

export interface Shard {
  readonly index: number
  readonly count: number
  readonly files: ReadonlyArray<string>
}

export type Def =
  | { readonly _tag: "Build"; readonly ref: FlakeRef }
  | {
    readonly _tag: "Setup"
    readonly shell: FlakeRef | undefined
    readonly run: Cmd<never>
    readonly inputs: Files
    readonly keep: ReadonlyArray<string>
    readonly path: ReadonlyArray<string>
    readonly env: { readonly [env: string]: string }
    readonly platform: Platform | undefined
  }
  | {
    readonly _tag: "Task"
    readonly shell: FlakeRef | undefined
    readonly setup: Step.Any | undefined
    readonly run: Cmd<any> | ((shard: Shard) => Cmd<any>)
    readonly inputs: Files
    readonly each: Files | undefined
    readonly after: ReadonlyArray<Step.Any>
    readonly report: ReportSpec | undefined
    readonly shards: { readonly count: number; readonly split: Files | undefined } | undefined
    readonly outputs: { readonly [name: string]: string }
    readonly secrets: { readonly [env: string]: SecretRef }
    readonly env: { readonly [env: string]: string }
    readonly platform: Platform | undefined
  }
  | {
    readonly _tag: "Action"
    readonly needs: Step.Needs
    readonly after: ReadonlyArray<Step.Any>
    readonly grants: Grants
    readonly body: (inputs: any) => Generator<any, any, any>
  }
  | { readonly _tag: "Output"; readonly task: Step.Any; readonly output: string }

const variance = { _A: (_: never) => _, _E: (_: never) => _, _R: (_: never) => _, _G: (_: never) => _ }

class StepImpl implements Step<any, any, any, any, any> {
  readonly [TypeId] = variance
  readonly outputs: { readonly [name: string]: Step<StorePath, never, any> }
  constructor(
    readonly kind: Kind,
    readonly name: string,
    readonly def: Def,
    readonly policies: ReadonlyArray<Policy>,
  ) {
    this.outputs = def._tag === "Task"
      ? Object.fromEntries(
        Object.keys(def.outputs).map((output) => [output, make("output", `${name}.${output}`, { _tag: "Output", task: this as Step.Any, output }) as Step<StorePath, never, any>]),
      )
      : {}
  }
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }
  toJSON() {
    return { _id: "Step", kind: this.kind, name: this.name }
  }
}

/** @internal */
export const make = (kind: Kind, name: string, def: Def, policies: ReadonlyArray<Policy> = []): Step.Any =>
  new StepImpl(kind, name, def, policies)

export const isStep = (u: unknown): u is Step.Any => typeof u === "object" && u !== null && TypeId in u

/** Hands the body the step's outcome instead of blocking when it fails. */
export const exit = <A, E, R>(step: Step<A, E, R, any, any>): Step.Exit<A, E, R> => ({ _tag: "Exit", step })

/** `exit` for a list of steps. */
export const exits = <const T extends ReadonlyArray<Step.Any>>(steps: T): Step.Exits<T> => ({ _tag: "Exits", steps })

const withPolicy = (self: Step.Any, policy: Policy): Step.Any => make(self.kind, self.name, self.def, [...self.policies, policy])

/** Retries the step with `Effect.retry`'s options. Policies apply in pipe order. */
export const retry =
  <E>(options: Effect.Retry.Options<E>) => <A, R, O, G>(self: Step<A, E, R, O, G>): Step<A, E, R, O, G> =>
    withPolicy(self, { _tag: "Retry", options }) as Step<A, E, R, O, G>

/** Fails the step with `Kiln.TimedOut` after `duration`. Policies apply in pipe order. */
export const timeout =
  (duration: Duration.Input) => <A, E, R, O, G>(self: Step<A, E, R, O, G>): Step<A, E | TimedOut, R, O, G> =>
    withPolicy(self, { _tag: "Timeout", duration: Duration.fromInputUnsafe(duration) }) as Step<A, E | TimedOut, R, O, G>

/** Every step an edge leads to: needs, after, interpolated values and the task behind an output. */
export interface Dependency {
  readonly step: Step.Any
  readonly via: "needs" | "after" | "exit"
}

export const dependencies = (step: Step.Any): ReadonlyArray<Dependency> => {
  const def = step.def
  switch (def._tag) {
    case "Build":
    case "Setup":
      return []
    case "Output":
      return [{ step: def.task, via: "needs" }]
    case "Task": {
      const run = typeof def.run === "function" ? def.run({ index: 1, count: def.shards?.count ?? 1, files: [] }) : def.run
      return [
        ...(def.setup === undefined ? [] : [{ step: def.setup, via: "needs" } satisfies Dependency]),
        ...run.steps.map((s): Dependency => ({ step: s, via: "needs" })),
        ...def.after.map((s): Dependency => ({ step: s, via: "after" })),
      ]
    }
    case "Action":
      return [
        ...Object.values(def.needs).flatMap((need): ReadonlyArray<Dependency> =>
          isStep(need)
            ? [{ step: need, via: "needs" }]
            : need._tag === "Exit"
            ? [{ step: need.step, via: "exit" }]
            : need.steps.map((s): Dependency => ({ step: s, via: "exit" }))
        ),
        ...def.after.map((s): Dependency => ({ step: s, via: "after" })),
      ]
  }
}

export type Any = Step.Any
export type Success<S> = Step.Success<S>
export type Error<S> = Step.Error<S>
export type Services<S> = Step.Services<S>
export type Needs = Step.Needs
export type Inputs<N extends Step.Needs> = Step.Inputs<N>
