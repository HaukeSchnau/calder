import { describe, expect, it } from "@effect/vitest"
import { Cache, CurrentRun, Event, Fleet, Git, type Lease, Sha, StorePath } from "@calder-ci/core"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as Release from "../src/Release.ts"

const revision = Sha.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
const release = StorePath.make("/nix/store/0000000000000000000000000000000a-release")

const promoting = (lease: Lease) =>
  Effect.provide(
    Release.promote(release),
    Layer.mergeAll(
      Layer.succeed(CurrentRun, {
        id: "calder-1",
        project: "calder",
        revision,
        branch: "main",
        trust: "trusted",
        event: Event.push("main"),
        descriptor: Effect.succeed({}),
      }),
      Layer.succeed(Fleet, { deploying: () => Effect.succeed(lease) }),
      Layer.succeed(Git, { head: () => Effect.succeed(revision) }),
      Layer.succeed(Cache, { publish: () => Effect.void }),
      Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die(new Error("no requests expected")))),
    ),
  )

describe("Release.promote", () => {
  it.effect("fails instead of going live when no host runs the app", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(promoting({ _tag: "Held", fence: 1, targets: [], unreachable: [] }))
      expect(error).toEqual(new Release.NoHosts({ project: "calder" }))
    }))

  it.effect("deploys nowhere while a host that might run the app can't be reached", () =>
    Effect.gen(function*() {
      const touched: Array<string> = []
      const srv2 = {
        host: "srv-2",
        preflight: () => Effect.sync(() => touched.push("preflight")),
        deploy: () => Effect.sync(() => touched.push("deploy")),
      }
      const error = yield* Effect.flip(promoting({ _tag: "Held", fence: 1, targets: [srv2], unreachable: ["srv-1"] }))
      expect(error).toEqual(new Release.Unreachable({ project: "calder", hosts: ["srv-1"] }))
      expect(touched).toEqual([])
    }))
})
