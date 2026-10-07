import { Context, Effect, Layer, Schema } from "effect"
import { Action, Cache, CurrentRun, Files, Fleet, Flake, Kiln, Nix, On, PullRequest, Report, Step, Task, cmd } from "../src/index.ts"

export const flake = Flake.make({
  packages: ["projectRelease"],
  checks: ["projectReleaseGate"],
  devShells: ["ci"],
})

export class Live extends Kiln.Result<Live>("@test/Release")("Live", { revision: Schema.String }) {}
export class Skipped extends Kiln.Result<Skipped>("@test/Release")("Skipped", { reason: Schema.Literals(["Superseded"]) }) {}

export const promoteRelease = Effect.fn("promote")(function*(release: string) {
  const run = yield* CurrentRun
  const lease = yield* Fleet.deploying(run.project, { queue: "latest-wins" })
  if (lease._tag === "Replaced") return new Skipped({ reason: "Superseded" })
  yield* Cache.publish(release as never)
  return new Live({ revision: `${run.revision}:${release}` })
}, Effect.scoped)

export class DevController extends Context.Service<DevController, { readonly ensure: (path: string) => Effect.Effect<string> }>()(
  "@test/DevController",
) {}
export const DevControllerLive = Layer.succeed(DevController, { ensure: (path: string) => Effect.succeed(`https://preview/${path}`) })

export const qa = Task.make("qa", {
  shell: flake.devShells.ci,
  run: cmd`just qa`,
  inputs: Files.workspace("."),
  report: Report.junit("reports/junit.xml"),
}).pipe(Step.timeout("20 minutes"))

export const gate = Nix.build(flake.checks.projectReleaseGate, { name: "gate" })
export const release = Nix.build(flake.packages.projectRelease, { name: "release" })

export const promote = Action.make(
  "promote",
  { needs: { release }, after: [qa, gate], grants: { deploy: true } },
  function*({ release }) {
    return yield* promoteRelease(release)
  },
)

export const preview = Action.make("preview", { needs: { release } }, function*({ release }) {
  return yield* DevController.use((d) => d.ensure(release))
})

export const comment = Action.make("comment", { needs: { url: preview, qa: Step.exit(qa) } }, function*({ url, qa }) {
  if (qa._tag !== "Passed") yield* PullRequest.comment(`qa did not pass, preview at ${url}`)
})

export const smoke = Task.make("smoke", { run: cmd`./smoke ${release} --url ${preview}`, inputs: Files.of("scripts/smoke") })

export const project = Kiln.project({
  shared: Files.of("justfile"),
  layer: DevControllerLive,
  rules: [
    On.pullRequest([qa, gate, preview, comment, smoke]),
    On.push("main", [promote]),
    On.schedule("0 3 * * *", { reuse: "none" }, [qa]),
    On.manual({ inputs: { reason: Schema.String } }, [promote]),
  ],
})
