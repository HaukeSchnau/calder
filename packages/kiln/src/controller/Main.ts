import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster"
import { FetchHttpClient } from "effect/http"
import * as Config from "./Config.ts"
import * as Db from "./Db.ts"
import * as Fleet from "./Fleet.ts"
import * as Gitea from "./Gitea.ts"
import * as Http from "./Http.ts"
import * as Jobs from "./Jobs.ts"
import * as Leases from "./Leases.ts"
import * as Live from "./Live.ts"
import * as Mirror from "./Mirror.ts"
import * as Runs from "./Runs.ts"
import * as Scheduler from "./Scheduler.ts"
import * as Telemetry from "./Telemetry.ts"
import * as WorkerServer from "./WorkerServer.ts"
import * as Workflow from "./Workflow.ts"

/** The controller: every service, the workflow engine on SQLite, the worker socket and the HTTP server. */
export const layer = (configPath: string) => {
  const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, BunCrypto.layer)
  const config = Config.fromFile(configPath)
  const base = Layer.mergeAll(Db.layer, Telemetry.layer, Gitea.layer, Mirror.layer, Live.layer, Jobs.layer).pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  )
  const fleet = Layer.mergeAll(Fleet.layer, Leases.layer).pipe(Layer.provideMerge(base))
  const core = Runs.layerCore.pipe(Layer.provideMerge(fleet))
  const engine = ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" })),
    Layer.provideMerge(core),
  )
  const workflows = Layer.mergeAll(Workflow.layerWorkflow, Workflow.layerRuns).pipe(Layer.provideMerge(engine))
  return Layer.mergeAll(WorkerServer.layer, Scheduler.layer, Http.layer).pipe(Layer.provide(workflows))
}
