import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Agents from "./Agents.ts"
import * as Cache from "./Cache.ts"
import * as Catchup from "./Catchup.ts"
import * as Comments from "./Comments.ts"
import * as Config from "./Config.ts"
import * as Db from "./Db.ts"
import * as Delivery from "./Delivery.ts"
import * as Egress from "./Egress.ts"
import * as Fleet from "./Fleet.ts"
import * as Gitea from "./Gitea.ts"
import * as Health from "./Health.ts"
import * as Http from "./Http.ts"
import * as Jobs from "./Jobs.ts"
import * as Leases from "./Leases.ts"
import * as Live from "./Live.ts"
import * as Merges from "./Merges.ts"
import * as Mirror from "./Mirror.ts"
import * as Projects from "./Projects.ts"
import * as Runs from "./Runs.ts"
import * as Scheduler from "./Scheduler.ts"
import { named, reportWhileStopping } from "./Stopping.ts"
import * as Telemetry from "./Telemetry.ts"
import * as Web from "./Web.ts"
import * as WorkerServer from "./WorkerServer.ts"
import * as Workflow from "./Workflow.ts"

/** The controller: every service, the run driver, the worker socket, the HTTP server and the UI for the web. */
export const layer = (configPath: string) => {
  const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, BunCrypto.layer)
  const config = Config.fromFile(configPath)
  const db = named("Db", Db.layer)
  const jobs = named("Jobs", Jobs.layer).pipe(Layer.provideMerge(named("Agents", Agents.layer)), Layer.provide(db))
  const base = Layer.mergeAll(db, named("Telemetry", Telemetry.layer), named("Gitea", Gitea.layer), named("Live", Live.layer), jobs).pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  )
  const projects = named("Projects", Projects.layer).pipe(Layer.provideMerge(base))
  const fleet = Layer.mergeAll(
    named("Cache", Cache.layer),
    named("Comments", Comments.layer),
    named("Fleet", Fleet.layer),
    named("Leases", Leases.layer),
    named("Mirror", Mirror.layer),
  ).pipe(Layer.provideMerge(projects))
  const core = named("Runs", Runs.layerCore).pipe(Layer.provideMerge(fleet))
  const runs = named("Workflow", Workflow.layer).pipe(Layer.provideMerge(core))
  const merging = named("Merges", Merges.layer).pipe(Layer.provideMerge(runs))
  const delivery = named("Delivery", Delivery.layer).pipe(Layer.provideMerge(merging))
  return Layer.mergeAll(
    reportWhileStopping,
    named("WorkerServer", WorkerServer.layer),
    named("Egress", Egress.layer),
    named("Scheduler", Scheduler.layer),
    named("Catchup", Catchup.layer),
    named("Http", Http.layer),
    named("Web", Web.layer),
    named("Health", Health.layer),
  ).pipe(Layer.provide(delivery))
}
