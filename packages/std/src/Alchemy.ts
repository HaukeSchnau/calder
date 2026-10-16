import { Action, Cmd, cmd, type Flake, PullRequest, Secret, type Setup, type Step, Task } from "@kiln/core"

/** How the repository's Alchemy stack deploys. */
export interface Stack {
  /** The dev shell with node and pnpm, and nix when the stack's build runs it. */
  readonly shell?: Flake.FlakeRef<"devShells">
  /** The installed dependencies the CLI runs from, as `pnpm exec alchemy`: usually `Pnpm.install`. */
  readonly setup: Setup.Setup
  /** The project's secret with a dotenv file of the providers' credentials, for `--env-file`. */
  readonly env: string
  /** The stack file, when it isn't `alchemy.run.ts`. */
  readonly config?: string
}

const shellOf = (stack: Stack) => (stack.shell === undefined ? {} : { shell: stack.shell })
const configOf = (stack: Stack) => (stack.config === undefined ? [] : ["--config", stack.config])

/**
 * `alchemy deploy --stage <stage>`, holding the project's deploy lease: one deploy at a time, and a
 * run that a newer one replaced doesn't deploy. It runs every time its rule does, since Alchemy only
 * changes what differs from its state.
 */
export const deploy = (stack: Stack, options: { readonly stage: string; readonly after?: ReadonlyArray<Step.Any> }) =>
  Task.make(`deploy-${options.stage}`, {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    lease: true,
    reuse: "never",
    run: cmd`pnpm exec alchemy deploy ${configOf(stack)} --stage ${options.stage} --yes --env-file ${Secret.file(stack.env)}`,
  })

/**
 * A pull request's own stage, `pr-<number>`, for `On.preview`: deployed on every update, then linked
 * from a comment on the pull request.
 */
export const preview = (
  stack: Stack,
  options: { readonly url: (pr: number) => string; readonly after?: ReadonlyArray<Step.Any> },
) => {
  const upload = Task.make("preview", {
    ...shellOf(stack),
    setup: stack.setup,
    after: options.after ?? [],
    reuse: "never",
    run: cmd`pnpm exec alchemy deploy ${configOf(stack)} --stage pr-${Cmd.pullRequest} --yes --env-file ${Secret.file(stack.env)}`,
  })
  const link = Action.make("preview-url", { after: [upload] }, function*() {
    const pr = yield* PullRequest
    yield* pr.comment(`Preview: ${options.url(pr.number)}`)
  })
  return [upload, link] as const
}

/** Removes a closed pull request's stage, for `On.pullRequestClosed`. */
export const destroy = (stack: Stack) =>
  Task.make("destroy-preview", {
    ...shellOf(stack),
    setup: stack.setup,
    reuse: "never",
    run: cmd`pnpm exec alchemy destroy ${configOf(stack)} --stage pr-${Cmd.pullRequest} --yes --env-file ${Secret.file(stack.env)}`,
  })
