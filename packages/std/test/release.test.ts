import { describe, expect, it } from "@effect/vitest"
import { Cache, CurrentRun, Event, Fleet, Git, Sha, StorePath } from "@kiln/core"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as Release from "../src/Release.ts"

const revision = Sha.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904")

const services = Layer.mergeAll(
  Layer.succeed(CurrentRun, {
    id: "kiln-1",
    project: "kiln",
    revision,
    branch: "main",
    trust: "trusted",
    event: Event.push("main"),
    descriptor: Effect.succeed({}),
  }),
  Layer.succeed(Fleet, { deploying: () => Effect.succeed({ _tag: "Held", fence: 1, targets: [] }) }),
  Layer.succeed(Git, { head: () => Effect.succeed(revision) }),
  Layer.succeed(Cache, { publish: () => Effect.void }),
  Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die(new Error("no requests expected")))),
)

describe("Release.promote", () => {
  it.effect("fails instead of going live when no host runs the app", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Release.promote(StorePath.make("/nix/store/0000000000000000000000000000000a-release")))
      expect(error).toEqual(new Release.NoHosts({ project: "kiln" }))
    }).pipe(Effect.provide(services)))
})
