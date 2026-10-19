import { Action, Cmd, cmd, type Flake, PullRequest, Secret, type Setup, type Step, Task } from "@calder-ci/core"
import type { Schema } from "effect"

/** How the repository's Alchemy stack deploys. */
export interface Stack<A = void> {
  /** The dev shell with node and pnpm, or bun for `runner: "bun"`, and nix when the stack's build runs it. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The installed dependencies the CLI runs from: `Pnpm.install`, or `Bun.install` with `runner: "bun"`. */
  readonly setup: Setup.Setup
  /** What starts the CLI: `pnpm exec alchemy` by default, `bun alchemy` with `"bun"`. */
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
   * What the stack returns, as the value of its deploys: `name` is the stack's (`Alchemy.Stack(name, ...)`),
   * `schema` decodes its outputs. Outputs the schema leaves out, such as secrets, never reach Calder.
   */
  readonly outputs?: { readonly name: string; readonly schema: Schema.Decoder<A> }
}

/** Where a deploy writes the stack's outputs for the task's value; `git clean` removes it before the next task. */
const outputsFile = ".calder-alchemy-outputs.json"

const shellOf = (stack: Stack<unknown>) => (stack.shell === undefined ? {} : { shell: stack.shell })
const configOf = (stack: Stack<unknown>) => (stack.config === undefined ? [] : ["--config", stack.config])
const cliOf = (stack: Stack<unknown>) => {
  const at = stack.dir === undefined ? [] : stack.runner === "bun" ? ["--cwd", stack.dir] : ["--dir", stack.dir]
  return stack.runner === "bun" ? ["bun", ...at, "alchemy"] : ["pnpm", ...at, "exec", "alchemy"]
}

const quote = (words: ReadonlyArray<string>) => words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ")

/**
 * `alchemy deploy`, then `alchemy state read <name>/<stage>/output`, which prints what the stack returned
 * as JSON, into the file the task's value comes from. The stage and the env file are the script's `$1`
 * and `$2`, since they are only known when the task runs.
 */
const withOutputs = <A>(stack: Stack<A>, outputs: NonNullable<Stack<A>["outputs"]>) => {
  const cli = quote(cliOf(stack))
  const config = quote(configOf(stack))
  // pnpm and Alchemy both log to stdout, which has to hold the JSON alone.
  const quiet = quote(stack.runner === "bun" ? cliOf(stack) : ["pnpm", "--silent", ...cliOf(stack).slice(1)])
  return `${cli} deploy ${config} --stage "$1" --yes --env-file "$2" && ` +
    `${quiet} state read ${quote([`${outputs.name}/`])}"$1"/output ${config} --env-file "$2" --log-level error > ${quote([outputsFile])}`
}

const valueOf = <A>(stack: Stack<A>) =>
  stack.outputs === undefined ? {} : { value: { path: outputsFile, schema: stack.outputs.schema } }

/**
 * `alchemy deploy --stage <stage>`, holding the project's deploy lease: one deploy at a time, and a
 * run that a newer one replaced doesn't deploy. It runs every time its rule does, since Alchemy only
 * changes what differs from its state. Its value is the stack's `outputs`.
 */
export const deploy = <A = void>(
  stack: Stack<A>,
  options: {
    readonly stage: string
    /** The step's name, `deploy-<stage>` by default. */
    readonly name?: string
    readonly after?: ReadonlyArray<Step.Any>
  },
) =>
  Task.make(options.name ?? `deploy-${options.stage}`, {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    lease: true,
    reuse: "never",
    run: stack.outputs === undefined
      ? cmd`${cliOf(stack)} deploy ${configOf(stack)} --stage ${options.stage} --yes --env-file ${Secret.file(stack.env)}`
      : cmd`bash -c ${withOutputs(stack, stack.outputs)} calder-alchemy ${options.stage} ${Secret.file(stack.env)}`,
    ...valueOf(stack),
  })

/**
 * A pull request's own stage, `pr-<number>`, for `On.preview`: deployed on every update, then linked
 * from a comment on the pull request. `url` gets the stack's `outputs` too, such as a preview's URL.
 */
export const preview = <A = void>(
  stack: Stack<A>,
  options: { readonly url: (pr: number, outputs: A) => string; readonly after?: ReadonlyArray<Step.Any> },
) => {
  const upload = Task.make("preview", {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    reuse: "never",
    run: stack.outputs === undefined
      ? cmd`${cliOf(stack)} deploy ${configOf(stack)} --stage pr-${Cmd.pullRequest} --yes --env-file ${Secret.file(stack.env)}`
      : cmd`bash -c ${withOutputs(stack, stack.outputs)} calder-alchemy pr-${Cmd.pullRequest} ${Secret.file(stack.env)}`,
    ...valueOf(stack),
  })
  const link = Action.make("preview-url", { needs: { outputs: upload } }, function*({ outputs }) {
    const pr = yield* PullRequest
    yield* pr.comment(`Preview: ${options.url(pr.number, outputs)}`)
  })
  return [upload, link] as const
}

/** Removes a closed pull request's stage, for `On.pullRequestClosed`. */
export const destroy = <A>(stack: Stack<A>) =>
  Task.make("destroy-preview", {
    ...shellOf(stack),
    setup: stack.setup,
    reuse: "never",
    run: cmd`${cliOf(stack)} destroy ${configOf(stack)} --stage pr-${Cmd.pullRequest} --yes --env-file ${Secret.file(stack.env)}`,
  })
