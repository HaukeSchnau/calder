import { describe, expect, it } from "@effect/vitest"
import { cmd, Flake, Nix } from "@calder-ci/core"
import { Effect } from "effect"
import type { Job as JobSpec } from "../src/Protocol.ts"
import type { Job } from "../src/worker/Client.ts"
import { deploying } from "../src/worker/Steps.ts"

const bundle = Nix.build(Flake.make({ packages: ["bundle"], checks: [], devShells: [] }).packages.bundle, { name: "bundle" })
const command = cmd`alchemy deploy --stage beta ${bundle}`
const path = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-bundle"

/** A job of a push of `revision` to main, whose controller answers with `lease` and the branch's `head`. */
const harness = (options: {
  readonly head: string
  readonly lease: { _tag: "Held"; fence: number } | { _tag: "Replaced"; by: number }
  readonly publish?: Effect.Effect<void>
}) => {
  const calls: Array<string> = []
  const logs: Array<string> = []
  const client = {
    fleetAcquire: () => Effect.sync(() => calls.push("acquire")).pipe(Effect.as({ ...options.lease, targets: [], unreachable: [] })),
    fleetRelease: () => Effect.sync(() => void calls.push("release")),
    gitHead: ({ branch }: { readonly branch: string }) => Effect.sync(() => calls.push(`head ${branch}`)).pipe(Effect.as(options.head)),
    cachePublish: ({ path }: { readonly path: string }) => Effect.sync(() => void calls.push(`publish ${path}`)).pipe(Effect.andThen(options.publish ?? Effect.void)),
  }
  const self = {
    id: "job",
    token: "token",
    remote: null,
    client,
    emit: () => Effect.void,
    log: (_stream: string, text: string) => Effect.sync(() => void logs.push(text)),
    flush: Effect.void,
  } as unknown as Job["Service"]
  const job = { run: { project: "app", revision: "a".repeat(40), event: { _tag: "Push", branch: "main" } } } as unknown as Extract<JobSpec, { _tag: "Step" }>
  return { calls, logs, run: Effect.scoped(deploying(self, job, "deploy-beta", command, { bundle: path, other: "/nix/store/x" })) }
}

describe("a task that holds the deploy lease", () => {
  it.effect("publishes the artifacts it interpolates and hands the command the lease's fence", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ head: "a".repeat(40), lease: { _tag: "Held", fence: 7 } })
      expect(yield* run).toEqual({ _tag: "Held", fence: 7 })
      expect(calls).toEqual(["acquire", "head main", `publish ${path}`, "release"])
    }))

  it.effect("doesn't deploy once the branch moved past its revision", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ head: "b".repeat(40), lease: { _tag: "Held", fence: 7 } })
      expect(yield* run).toEqual({ _tag: "Ended", result: { _tag: "Skipped", reason: "main moved on to bbbbbbbbbbbb, so this run doesn't deploy" } })
      expect(calls).toEqual(["acquire", "head main", "release"])
    }))

  it.effect("doesn't deploy when a newer run's same step took the lease", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ head: "a".repeat(40), lease: { _tag: "Replaced", by: 12 } })
      expect(yield* run).toMatchObject({ _tag: "Ended", result: { reason: "#12 took deploy-beta's deploy lease, so this older run doesn't deploy" } })
      expect(calls).toEqual(["acquire", "release"])
    }))

  it.effect("dies saying why when an artifact can't reach the binary cache", () =>
    Effect.gen(function*() {
      const { run } = harness({ head: "a".repeat(40), lease: { _tag: "Held", fence: 7 }, publish: Effect.die(new Error(`${path} is not in the binary cache after publishing`)) })
      expect(yield* run).toEqual({ _tag: "Ended", result: { _tag: "Died", message: `${path} is not in the binary cache after publishing` } })
    }))
})
