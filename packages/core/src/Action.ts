import type { Effect, Scope } from "effect"
import type { FailureOf, Result } from "./Calder.ts"
import type { Granted } from "./Services.ts"
import { make as makeStep, type Grants, type Step } from "./Step.ts"

/** What an action may return: plain data, `void`, or `Calder.Result` instances. */
export type Storable<A> = A extends void | undefined | null | boolean | number | string ? A
  : A extends Result.Brand ? A
  : A extends Function | Date | Map<any, any> | Set<any> | Effect.Effect<any, any, any> ? never
  : A extends ReadonlyArray<infer X> ? ReadonlyArray<Storable<X>>
  : A extends object ? { readonly [K in keyof A]: Storable<A[K]> }
  : never

/**
 * Effect code with side effects. `needs` are the steps whose values the body reads, `after` the steps
 * that must pass first, and `grants` the powers it asks for. Fleet and secrets only exist through grants.
 */
export const make = <
  const N extends Step.Needs = {},
  const After extends ReadonlyArray<Step.Any> = [],
  const G extends Grants = {},
  Eff extends Effect.Effect<any, any, any> = never,
  A = void,
>(
  name: string,
  options: { readonly needs?: N; readonly after?: After; readonly grants?: G },
  body: (inputs: Step.Inputs<N>) => Generator<Eff, A, never>,
): Step<
  Storable<A>,
  FailureOf<Effect.Error<Eff>>,
  | Exclude<Effect.Services<Eff>, Scope.Scope | Granted<G>>
  | Step.NeedServices<N>
  | Step.Services<After[number]>,
  {},
  keyof G extends never ? never : G
> =>
  makeStep("action", name, {
    _tag: "Action",
    needs: options.needs ?? {},
    after: options.after ?? [],
    grants: options.grants ?? {},
    body: body as (inputs: any) => Generator<any, any, any>,
  }) as any
