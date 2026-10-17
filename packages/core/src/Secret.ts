import { Context, Effect, type Redacted } from "effect"

declare const SecretTypeId: unique symbol

/** The service an action gets for each name in `grants: { secrets: [...] }`. */
export interface Secret<S extends string> {
  readonly [SecretTypeId]: S
}

export interface SecretValue {
  readonly value: Redacted.Redacted<string>
  /** A file holding the value, readable only by the step. */
  readonly path: string
}

const tags = new Map<string, Context.Service<any, SecretValue>>()

export const tag = <S extends string>(name: S): Context.Service<Secret<S>, SecretValue> => {
  let t = tags.get(name)
  if (t === undefined) {
    t = Context.Service<Secret<S>, SecretValue>(`@calder-ci/core/Secret/${name}`)
    tags.set(name, t)
  }
  return t
}

/** Reads a granted secret. */
export const value = <S extends string>(name: S): Effect.Effect<Redacted.Redacted<string>, never, Secret<S>> =>
  tag(name).use((s) => Effect.succeed(s.value))

/**
 * For tasks: the path of a file with the secret, in an environment variable (`secrets`) or as a
 * `cmd` argument. Trusted runs and previews only.
 */
export interface SecretRef {
  readonly _tag: "SecretRef"
  readonly name: string
}

export const file = (name: string): SecretRef => ({ _tag: "SecretRef", name })
