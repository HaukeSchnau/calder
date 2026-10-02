import { Gitea } from "@kiln/core"
import { Effect } from "effect"

/**
 * Starts Gitea Actions workflows for this revision, for jobs that still run on act_runner (the Apple
 * builder). The workflows must accept `workflow_dispatch` with a `sha` input.
 */
export const dispatch = Effect.fn("Gitea.dispatch")(function*(workflows: ReadonlyArray<string>, revision: string) {
  for (const workflow of workflows) yield* Gitea.dispatch(workflow, { inputs: { sha: revision } })
})
