import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Agents from "./Agents.ts"
import * as Catchup from "./Catchup.ts"
import * as Config from "./Config.ts"
import * as Db from "./Db.ts"
import * as Egress from "./Egress.ts"
import * as Fleet from "./Fleet.ts"
import * as Gitea from "./Gitea.ts"
import * as Http from "./Http.ts"
import * as Jobs from "./Jobs.ts"
import * as Leases from "./Leases.ts"
import * as Live from "./Live.ts"
import * as Mirror from "./Mirror.ts"
import * as Projects from "./Projects.ts"
import * as Runs from "./Runs.ts"
import * as Scheduler from "./Scheduler.ts"
import * as Telemetry from "./Telemetry.ts"
import * as WorkerServer from "./WorkerServer.ts"
import * as Workflow from "./Workflow.ts"

/** The controller: every service, the run driver, the worker socket and the HTTP server. */
export const layer = (configPath: string) => {
  const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, BunCrypto.layer)
  const config = Config.fromFile(configPath)
  const base = Layer.mergeAll(Db.layer, Telemetry.layer, Gitea.layer, Live.layer, Jobs.layer.pipe(Layer.provideMerge(Agents.layer), Layer.provide(Db.layer))).pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  )
  const projects = Projects.layer.pipe(Layer.provideMerge(base))
  const fleet = Layer.mergeAll(Fleet.layer, Leases.layer, Mirror.layer).pipe(Layer.provideMerge(projects))
  const core = Runs.layerCore.pipe(Layer.provideMerge(fleet))
  const runs = Workflow.layer.pipe(Layer.provideMerge(core))
  return Layer.mergeAll(WorkerServer.layer, Egress.layer, Scheduler.layer, Catchup.layer, Http.layer).pipe(Layer.provide(runs))
}
