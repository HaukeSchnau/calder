import type { Domain } from "@kiln/api"
import { useAtomSet } from "@effect/atom-react"
import { Cause, type Exit } from "effect"
import { Kiln } from "./client.ts"
import { go } from "./route.ts"
import { toast } from "./toast.ts"
import { errorText } from "./ui.tsx"

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => (exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined)

/** Trigger, cancel and rerun, reporting the outcome in the status bar and opening a new run. */
export function useRunCommands() {
  const cancelRpc = useAtomSet(Kiln.mutation("cancel"), { mode: "promiseExit" })
  const rerunRpc = useAtomSet(Kiln.mutation("rerun"), { mode: "promiseExit" })
  const triggerRpc = useAtomSet(Kiln.mutation("trigger"), { mode: "promiseExit" })
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
    rerun: async (run: Domain.Run) => started(await rerunRpc({ payload: { runId: run.id } })),
    trigger: async (project: string) => started(await triggerRpc({ payload: { project } })),
  }
}
