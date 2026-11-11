import type { Domain } from "@calder-ci/api"
import { useAtomSet } from "@effect/atom-react"
import { Cause, type Exit } from "effect"
import { Calder } from "./client.ts"
import { go } from "./route.ts"
import { toast } from "./toast.ts"
import { errorText } from "./ui.tsx"

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => (exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined)

/** Whether a run has a step that failed or died, which a rerun runs again in the same run. */
export const hasFailed = (run: Domain.Run) => (run.counts.failed ?? 0) + (run.counts.died ?? 0) > 0

/** Trigger, cancel and rerun, reporting the outcome in the status bar and opening a new run. */
export function useRunCommands() {
  const cancelRpc = useAtomSet(Calder.mutation("cancel"), { mode: "promiseExit" })
  const rerunRpc = useAtomSet(Calder.mutation("rerun"), { mode: "promiseExit" })
  const triggerRpc = useAtomSet(Calder.mutation("trigger"), { mode: "promiseExit" })
  const started = (exit: Exit.Exit<Domain.Run, unknown>) => {
    if (exit._tag === "Success") {
      toast(`Started ${exit.value.project} #${exit.value.number}`)
      go({ page: "run", id: exit.value.id, step: null })
    } else {
      toast(errorText(failureOf(exit)), "bad")
    }
  }
  return {
    cancel: async (run: Domain.Run) => {
      const exit = await cancelRpc({ payload: { runId: run.id } })
      if (exit._tag === "Success") toast(`Cancelled ${run.project} #${run.number}`)
      else toast(errorText(failureOf(exit)), "bad")
    },
    /** Runs what failed in the run again, in the same run; or, with `force`, every step in a new run. */
    rerun: async (run: Domain.Run, force = false) => {
      const exit = await rerunRpc({ payload: { runId: run.id, ...(force ? { force } : {}) } })
      if (exit._tag === "Success" && exit.value.id === run.id) toast(`Running the failed steps of ${run.project} #${run.number} again`)
      else started(exit)
    },
    trigger: async (project: string) => started(await triggerRpc({ payload: { project } })),
  }
}
