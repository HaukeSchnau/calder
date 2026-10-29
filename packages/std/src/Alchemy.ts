import { Action, Cmd, cmd, CurrentRun, type Flake, PullRequest, Secret, type Setup, type Step, Task } from "@calder-ci/core"
import type { Schema } from "effect"
import * as Release from "./Release.ts"

/** How the repository's Alchemy stack deploys. */
export interface Stack<A = void> {
  /** The dev shell with node and pnpm, or bun for `runner: "bun"`, and nix when the stack's build runs it. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The installed dependencies the CLI runs from: `Pnpm.install`, or `Bun.install` with `runner: "bun"`. */
  readonly setup: Setup.Setup
  /**
   * What starts the CLI: the installed `node_modules/.bin/alchemy` by default, `bun alchemy` with `"bun"`.
   * Not `pnpm exec`, which checks the install again before every command: 8 s of a deploy on srv-2.
   */
  readonly runner?: "pnpm" | "bun"
  /** The project's secret with a dotenv file of the providers' credentials, for `--env-file`. */
  readonly env: string
  /**
   * The directory the CLI runs in, relative to the repository root, when the stack and its package
   * aren't at the root. The setup installs that package (`dir` of `Pnpm.install`), and `config` is
   * relative to it.
   */
  readonly dir?: string
  /** The stack file, when it isn't `alchemy.run.ts`. */
  readonly config?: string
  /**
   * More of the project's secrets the stack reads, by the environment variable that gets its file's
   * path, such as `{ FLEET_TOKEN_FILE: "placement-token" }` for a `Fleet.Placement`.
   */
  readonly secrets?: { readonly [env: string]: string }
  /**
   * What the stack returns, as the value of its deploys: `name` is the stack's (`Alchemy.Stack(name, ...)`),
   * `schema` decodes its outputs. Outputs the schema leaves out, such as secrets, never reach Calder.
   */
  readonly outputs?: { readonly name: string; readonly schema: Schema.Decoder<A> }
}

/**
 * Store paths a deploy hands the stack, by the environment variable that gets each path, such as
 * `{ CALDER_BUNDLE: bundle }` (`Task`'s `artifacts`). They are the deploy's only inputs from the run, so
 * a deploy waits for them and nothing else unless told to, and it publishes them to the binary cache
 * first, for a host that substitutes them.
 */
export type Artifacts = { readonly [env: string]: Step.Step<string, any, any, any, never> }

/**
 * A stage name: one word, since the CLI gets it as an argument, and not `pr-<number>`, the stages of
 * pull requests' previews. A pipeline with another name fails to load, like a `cmd` it can't parse.
 */
export const stageName = (stage: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stage)) {
    throw new Error(`Alchemy stage "${stage}": use letters, digits, ".", "_" and "-", starting with a letter or digit`)
  }
  if (/^pr-\d+$/.test(stage)) throw new Error(`Alchemy stage "${stage}" is a pull request's preview stage; pick another name`)
  return stage
}

/** Where a deploy writes the stack's outputs for the task's value; `git clean` removes it before the next task. */
const outputsFile = ".calder-alchemy-outputs.json"

const shellOf = (stack: Stack<unknown>) => ({
  ...(stack.shell === undefined ? {} : { shell: stack.shell }),
  ...(stack.secrets === undefined
    ? {}
    : { secrets: Object.fromEntries(Object.entries(stack.secrets).map(([env, name]) => [env, Secret.file(name)])) }),
})

const quote = (words: ReadonlyArray<string>) => words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ")

/**
 * The script every command runs: in the stack's directory, `alchemy <verb>` of stage `$1` with the env
 * file `$2`, and with `outputs` then `alchemy state read <name>/<stage>/output` into the file the task's
 * value comes from. The CLI prints status lines before the outputs, an object, so the file keeps what
 * starts at the line `{`.
 */
const script = <A>(stack: Stack<A>, verb: "deploy" | "destroy") => {
  const config = stack.config === undefined ? "" : ` --config ${quote([stack.config])}`
  const outputs = verb === "deploy" ? stack.outputs : undefined
  return [
    "set -euo pipefail",
    "root=$PWD",
    ...(stack.dir === undefined ? [] : [`cd ${quote([stack.dir])}`]),
    // Alchemy keeps its daily npm version check in .alchemy, which git clean removes before every task,
    // so each command waited up to 3 s for npm. Remove this once Alchemy keeps that cache elsewhere.
    `if [ -n "\${CI_CACHE_ROOT:-}" ]; then mkdir -p .alchemy && ln -sfn "$CI_CACHE_ROOT/alchemy-version-check.json" .alchemy/version-check.json; fi`,
    stack.runner === "bun" ? `alchemy() { bun alchemy "$@"; }` : `alchemy() { node_modules/.bin/alchemy "$@"; }`,
    `alchemy ${verb}${config} --stage "$1" --yes --env-file "$2"`,
    ...(outputs === undefined
      ? []
      : [`alchemy state read ${quote([`${outputs.name}/`])}"$1"/output${config} --env-file "$2" | sed -n '/^{/,$p' > "$root"/${outputsFile}`]),
  ].join("\n")
}

/** Literal command text, which splits on whitespace like a template's, or a value interpolated whole. */
type Part = { readonly text: string } | Cmd.Interpolation

/** A command from literal text and interpolations in order, for commands whose interpolations vary. */
const command = (parts: ReadonlyArray<Part>) => {
  const strings: Array<string> = [""]
  const values: Array<Cmd.Interpolation> = []
  for (const part of parts) {
    if (typeof part === "object" && "text" in part) strings[strings.length - 1] += part.text
    else {
      values.push(part)
      strings.push("")
    }
  }
  return cmd(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...values)
}

const run = <A>(stack: Stack<A>, verb: "deploy" | "destroy", stage: ReadonlyArray<Part>) =>
  command([
    { text: "bash -c " },
    script(stack, verb),
    { text: " calder-alchemy " },
    ...stage,
    { text: " " },
    Secret.file(stack.env),
  ])

const valueOf = <A>(stack: Stack<A>) =>
  stack.outputs === undefined ? {} : { value: { path: outputsFile, schema: stack.outputs.schema } }

/**
 * `alchemy deploy --stage <stage>`, holding the project's deploy lease: one deploy at a time, and a
 * run that a newer one replaced doesn't deploy. On a push, it doesn't deploy once the branch moved
 * past its revision. The stack gets the lease's fencing token as `FLEET_FENCE` and the revision as
 * `CALDER_REVISION`. It runs every time its rule does, since Alchemy only changes what differs from its
 * state. Its value is the stack's `outputs`.
 */
export const deploy = <A = void>(
  stack: Stack<A>,
  options: {
    readonly stage: string
    /** The step's name, `deploy-<stage>` by default. */
    readonly name?: string
    readonly after?: ReadonlyArray<Step.Any>
    readonly artifacts?: Artifacts
  },
) =>
  Task.make(options.name ?? `deploy-${options.stage}`, {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    lease: true,
    reuse: "never",
    run: run(stack, "deploy", [{ text: stageName(options.stage) }]),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...valueOf(stack),
  })

/**
 * Waits until the URL `readiness` reads from the deploy's outputs reports the run's revision as its
 * JSON `revision`. Its value is the deploy's outputs, so steps after it can read them.
 */
export const ready = <A>(
  deployed: Step.Step<A, any, any, any, any>,
  options: { readonly name: string; readonly readiness: (outputs: A) => string },
) =>
  Action.make(options.name, { needs: { outputs: deployed } }, function*({ outputs }) {
    const current = yield* CurrentRun
    yield* Release.awaitReadiness(options.readiness(outputs), current.revision)
    return outputs
  })

/**
 * A pull request's own stage, `pr-<number>`, for `On.preview`: deployed on every update, holding the
 * pull request's lease so its deploys take turns, then linked from Calder's comment on the pull request. `url` gets the stack's `outputs` too, such as a preview's
 * URL. With `readiness`, the link waits until the preview reports the pull request's revision.
 */
export const preview = <A = void>(
  stack: Stack<A>,
  options: {
    readonly url: (pr: number, outputs: A) => string
    readonly after?: ReadonlyArray<Step.Any>
    /** Steps the deploy waits for on its critical path, such as a smoke test of what it deploys (`Task.make`'s `gate`). */
    readonly gate?: ReadonlyArray<Step.Any>
    readonly artifacts?: Artifacts
    readonly readiness?: (outputs: A) => string
  },
) => {
  const upload = Task.make("preview", {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    gate: options.gate ?? [],
    lease: true,
    reuse: "never",
    run: run(stack, "deploy", [{ text: "pr-" }, Cmd.pullRequest]),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...valueOf(stack),
  })
  const link = Action.make("preview-url", { needs: { outputs: upload } }, function*({ outputs }) {
    const pr = yield* PullRequest
    const current = yield* CurrentRun
    if (options.readiness !== undefined) yield* Release.awaitReadiness(options.readiness(outputs), current.revision)
    yield* pr.comment(`Preview: ${options.url(pr.number, outputs)}`)
    return outputs
  })
  return [upload, link] as const
}

/** Removes a closed pull request's stage, for `On.pullRequestClosed`, holding the pull request's lease like its previews. */
export const destroy = <A>(stack: Stack<A>) =>
  Task.make("destroy-preview", {
    ...shellOf(stack),
    setup: stack.setup,
    lease: true,
    reuse: "never",
    run: run(stack, "destroy", [{ text: "pr-" }, Cmd.pullRequest]),
  })
