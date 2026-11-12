import { describe, expect, it } from "@effect/vitest"
import { Cache, CurrentRun, Event, Fleet, Git, type Lease, Rejected, Sha, StorePath } from "@calder-ci/core"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Release from "../src/Release.ts"

const revision = Sha.make("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
const release = StorePath.make("/nix/store/0000000000000000000000000000000a-release")

const promoting = (
  lease: Lease,
  head: () => Sha = () => revision,
  releases: StorePath | Release.Releases = release,
  published: Array<string> = [],
) =>
  Effect.provide(
    Release.promote(releases),
    Layer.mergeAll(
      Layer.succeed(CurrentRun, {
        id: "calder-1",
        project: "calder",
        revision,
        branch: "main",
        trust: "trusted",
        event: Event.push("main"),
        system: "x86_64-linux",
        descriptor: Effect.succeed({}),
      }),
      Layer.succeed(Fleet, { deploying: () => Effect.succeed(lease) }),
      Layer.succeed(Git, { head: () => Effect.sync(head) }),
      Layer.succeed(Cache, { publish: (path, options) => Effect.sync(() => published.push(`${options?.system ?? "own"} ${path}`)) }),
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
      const hostA = {
        host: "host-a",
        system: "x86_64-linux",
        preflight: () => Effect.sync(() => touched.push("preflight")),
        deploy: () => Effect.sync(() => touched.push("deploy")),
      }
      const error = yield* Effect.flip(promoting({ _tag: "Held", fence: 1, targets: [hostA], unreachable: ["host-b"] }))
      expect(error).toEqual(new Release.Unreachable({ project: "calder", hosts: ["host-b"] }))
      expect(touched).toEqual([])
    }))

  const topology = new Rejected({ target: "host-a", status: 409, reason: "Release topology differs from the host-compatible contract" })
  /** A host that refuses the first `refusals` preflights with `refused`. */
  const host = (refusals: number, refused: Rejected, touched: Array<string>) => ({
    host: "host-a",
    system: "x86_64-linux",
    preflight: () =>
      Effect.suspend(() => {
        touched.push("preflight")
        return touched.length <= refusals ? Effect.fail(refused) : Effect.void
      }),
    deploy: () => Effect.sync(() => touched.push("deploy")),
  })

  it.effect("waits for the switch that gives a host the release's topology, then deploys", () =>
    Effect.gen(function*() {
      const touched: Array<string> = []
      const promotion = yield* Effect.forkChild(promoting({ _tag: "Held", fence: 1, targets: [host(2, topology, touched)], unreachable: [] }))
      yield* TestClock.adjust("1 minute")
      const result = yield* Fiber.join(promotion)
      expect(result._tag).toBe("Live")
      expect(touched).toEqual(["preflight", "preflight", "preflight", "deploy"])
    }))

  it.effect("stops waiting when a newer push supersedes the revision", () =>
    Effect.gen(function*() {
      const touched: Array<string> = []
      let head = revision
      const promotion = yield* Effect.forkChild(
        promoting({ _tag: "Held", fence: 1, targets: [host(Infinity, topology, touched)], unreachable: [] }, () => head),
      )
      yield* TestClock.adjust("30 seconds")
      head = Sha.make("0000000000000000000000000000000000000001")
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(promotion)).toEqual(new Release.Skipped({ reason: "Superseded" }))
      expect(touched).not.toContain("deploy")
    }))

  it.effect("fails at once when a host refuses for anything but the topology", () =>
    Effect.gen(function*() {
      const touched: Array<string> = []
      const secret = new Rejected({ target: "host-a", status: 409, reason: "missing required Secret binding: token" })
      const error = yield* Effect.flip(promoting({ _tag: "Held", fence: 1, targets: [host(1, secret, touched)], unreachable: [] }))
      expect(error).toEqual(secret)
      expect(touched).toEqual(["preflight"])
    }))

  const linux = StorePath.make("/nix/store/0000000000000000000000000000000b-release")
  const darwin = StorePath.make("/nix/store/0000000000000000000000000000000c-release")
  /** A host of `system` that records what it is asked to deploy. */
  const of = (host: string, system: string, deployed: Array<string>) => ({
    host,
    system,
    preflight: () => Effect.void,
    deploy: (r: { readonly storePath: StorePath }) => Effect.sync(() => deployed.push(`${host} ${r.storePath}`)),
  })

  it.effect("gives each host the release of its system and publishes each one a host needs", () =>
    Effect.gen(function*() {
      const deployed: Array<string> = []
      const published: Array<string> = []
      const unused = StorePath.make("/nix/store/0000000000000000000000000000000d-release")
      const targets = [of("m1", "aarch64-darwin", deployed), of("tower", "x86_64-linux", deployed), of("dev", "x86_64-linux", deployed)]
      const releases = { "x86_64-linux": linux, "aarch64-darwin": darwin, "aarch64-linux": unused }
      const result = yield* promoting({ _tag: "Held", fence: 1, targets, unreachable: [] }, undefined, releases, published)
      expect(result).toEqual(new Release.Live({ revision, hosts: ["m1", "tower", "dev"] }))
      expect(deployed).toEqual([`m1 ${darwin}`, `tower ${linux}`, `dev ${linux}`])
      expect(published.sort()).toEqual([`aarch64-darwin ${darwin}`, `own ${linux}`])
    }))

  it.effect("deploys nowhere when a host's system has no release", () =>
    Effect.gen(function*() {
      const deployed: Array<string> = []
      const published: Array<string> = []
      const targets = [of("tower", "x86_64-linux", deployed), of("m1", "aarch64-darwin", deployed)]
      const error = yield* Effect.flip(promoting({ _tag: "Held", fence: 1, targets, unreachable: [] }, undefined, release, published))
      expect(error).toEqual(new Release.NoRelease({ project: "calder", host: "m1", system: "aarch64-darwin", built: ["x86_64-linux"] }))
      expect([...deployed, ...published]).toEqual([])
    }))
})
