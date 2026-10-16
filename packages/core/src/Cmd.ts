import type { SecretRef } from "./Secret.ts"
import { isStep, type Step } from "./Step.ts"

export const TypeId = "~@kiln/core/Cmd" as const

/** The run's pull-request number, such as `--stage pr-${Cmd.pullRequest}`. A run without one can't render it. */
export const pullRequest = { _tag: "PullRequestNumber" } as const
export type PullRequestNumber = typeof pullRequest

/**
 * A value a command can interpolate: plain strings and numbers, lists of them, steps whose value is
 * one, the path of a secret's file (`Secret.file(name)`, trusted runs and previews only) or the run's
 * pull-request number.
 */
export type Interpolation =
  | string
  | number
  | ReadonlyArray<string>
  | Step<string | number, any, any, any, any>
  | SecretRef
  | PullRequestNumber

/**
 * One argument of a command: literal text and interpolated values, concatenated.
 * A list interpolated on its own spreads into several arguments.
 */
export type Arg = ReadonlyArray<
  | string
  | { readonly step: string }
  | { readonly list: ReadonlyArray<string> }
  | { readonly secret: string }
  | { readonly pullRequest: true }
>

export interface Cmd<out R = never> {
  readonly [TypeId]: { readonly _R: (_: never) => R }
  readonly args: ReadonlyArray<Arg>
  /** Steps whose values the command reads. */
  readonly steps: ReadonlyArray<Step.Any>
  /** Secrets whose file paths the command reads. */
  readonly secrets: ReadonlyArray<string>
  /** Whether the command reads the run's pull-request number. */
  readonly pullRequest: boolean
}

/** What a command reads besides step values. */
export interface Context {
  /** Secret name to the path of its file. */
  readonly secrets?: { readonly [name: string]: string }
  readonly pullRequest?: number
}

const variance = { _R: (_: never) => _ }

/**
 * Builds an argv from a template. Literal text splits on whitespace and honours single and
 * double quotes; interpolated values never split. Commands run without a shell.
 */
export const cmd = <const V extends ReadonlyArray<Interpolation>>(
  strings: TemplateStringsArray,
  ...values: V
): Cmd<Step.Services<Extract<V[number], Step.Any>>> => {
  const args: Array<Array<Arg[number]>> = []
  const steps: Array<Step.Any> = []
  const secrets: Array<string> = []
  let readsPullRequest = false
  let current: Array<Arg[number]> | undefined
  let quote: "'" | '"' | undefined

  const push = (part: Arg[number]) => {
    current ??= []
    current.push(part)
  }
  const end = () => {
    if (current !== undefined) args.push(current)
    current = undefined
  }

  strings.forEach((literal, i) => {
    let text = ""
    for (const ch of literal) {
      if (quote !== undefined) {
        if (ch === quote) quote = undefined
        else text += ch
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        current ??= []
        continue
      }
      if (/\s/.test(ch)) {
        if (text !== "") push(text)
        text = ""
        end()
        continue
      }
      text += ch
    }
    if (text !== "") push(text)
    if (i >= values.length) return
    const value = values[i]!
    if (isStep(value)) {
      steps.push(value)
      push({ step: value.name })
    } else if (Array.isArray(value)) {
      push({ list: value })
    } else if (typeof value === "object" && "_tag" in value && value._tag === "SecretRef") {
      if (!secrets.includes(value.name)) secrets.push(value.name)
      push({ secret: value.name })
    } else if (typeof value === "object" && "_tag" in value && value._tag === "PullRequestNumber") {
      readsPullRequest = true
      push({ pullRequest: true })
    } else {
      push(String(value))
    }
  })
  if (quote !== undefined) throw new Error(`cmd: unclosed ${quote} in \`${strings.join("${…}")}\``)
  end()
  return { [TypeId]: variance, args, steps, secrets, pullRequest: readsPullRequest }
}

export const isCmd = (u: unknown): u is Cmd<unknown> => typeof u === "object" && u !== null && TypeId in u

/** Resolves a command to argv, given the values of the steps it interpolates and what else it reads. */
export const render = (
  self: Cmd<unknown>,
  values: { readonly [step: string]: unknown },
  context: Context = {},
): ReadonlyArray<string> =>
  self.args.flatMap((arg) => {
    if (arg.length === 1 && typeof arg[0] === "object" && "list" in arg[0]) return [...arg[0].list]
    return [
      arg
        .map((part) => {
          if (typeof part === "string") return part
          if ("list" in part) return part.list.join(" ")
          if ("secret" in part) {
            const path = context.secrets?.[part.secret]
            if (path === undefined) throw new Error(`cmd: the secret ${part.secret} was not granted`)
            return path
          }
          if ("pullRequest" in part) {
            if (context.pullRequest === undefined) throw new Error("cmd: the run has no pull request")
            return String(context.pullRequest)
          }
          const value = values[part.step]
          if (typeof value !== "string" && typeof value !== "number") {
            throw new Error(`cmd: step ${part.step} has no string or number value`)
          }
          return String(value)
        })
        .join(""),
    ]
  })

const showPart = (part: Arg[number]) =>
  typeof part === "string" ? part
  : "step" in part ? `\${${part.step}}`
  : "list" in part ? part.list.join(" ")
  : "secret" in part ? `\${secret:${part.secret}}`
  : "${pull-request}"

/** The command as text, with interpolated steps shown as `${name}`, secrets as `${secret:name}`. */
export const show = (self: Cmd<unknown>): string =>
  self.args
    .flatMap((arg) =>
      arg.length === 1 && typeof arg[0] === "object" && "list" in arg[0]
        ? arg[0].list
        : [arg.map(showPart).join("")]
    )
    .map((text) => (/[\s'"]/.test(text) ? JSON.stringify(text) : text))
    .join(" ")
