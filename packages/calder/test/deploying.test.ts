import { describe, expect, it } from "@effect/vitest"
import { cmd, Flake, Nix, Task } from "@calder-ci/core"
import { Effect } from "effect"
import type { Job as JobSpec } from "../src/Protocol.ts"
import type { Job } from "../src/worker/Client.ts"
import { deploying } from "../src/worker/Steps.ts"

const flake = Flake.make({ packages: ["bundle", "tool"], checks: [], devShells: [] })
const bundle = Nix.build(flake.packages.bundle, { name: "bundle" })
const tool = Nix.build(flake.packages.tool, { name: "tool" })
// `tool` is interpolated, not declared: it never goes to the cache, as a NixOS host's closure wouldn't.
const deploy = Task.make("deploy-beta", { run: cmd`${tool}/bin/deploy beta`, artifacts: { CALDER_BUNDLE: bundle }, lease: true })
const def = deploy.def._tag === "Task" ? deploy.def : undefined!
const path = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-bundle"
const revision = "a".repeat(40)

type Lease = { _tag: "Held"; fence: number } | { _tag: "Replaced"; by: number } | { _tag: "Stale"; head: string }

/** A job of a push of `revision` to main, whose controller answers with `lease` and then the branch's `heads`, in turn. */
const harness = (options: { readonly heads?: ReadonlyArray<string>; readonly lease: Lease; readonly publish?: Effect.Effect<void> }) => {
  const calls: Array<string> = []
  const heads = [...(options.heads ?? [revision])]
  const client = {
    fleetAcquire: () => Effect.sync(() => calls.push("acquire")).pipe(Effect.as({ ...options.lease, targets: [], unreachable: [] })),
    fleetRelease: () => Effect.sync(() => void calls.push("release")),
    gitHead: ({ branch }: { readonly branch: string }) => Effect.sync(() => (calls.push(`head ${branch}`), heads.shift() ?? revision)),
    cachePublish: ({ path, artifact }: { readonly path: string; readonly artifact?: string }) =>
      Effect.sync(() => void calls.push(`publish ${artifact} ${path}`)).pipe(Effect.andThen(options.publish ?? Effect.void)),
  }
  const self = { id: "job", token: "token", remote: null, client, emit: () => Effect.void, log: () => Effect.void, flush: Effect.void } as unknown as Job["Service"]
  const job = { run: { project: "app", revision, branch: "main", event: { _tag: "Push", branch: "main" } } } as unknown as Extract<JobSpec, { _tag: "Step" }>
  return { calls, run: Effect.scoped(deploying(self, job, "deploy-beta", def, { bundle: path, tool: "/nix/store/1123456789abcdfghijklmnpqrsvwxyz-nixos-system" })) }
}

describe("a task that holds the deploy lease", () => {
  it.effect("publishes only the artifacts it declares, by name, and hands the command the lease's fence", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ lease: { _tag: "Held", fence: 7 } })
      expect(yield* run).toEqual({ _tag: "Held", fence: 7 })
      expect(calls).toEqual(["acquire", `publish CALDER_BUNDLE ${path}`, "head main", "release"])
    }))

  it.effect("doesn't deploy when the controller finds its revision is no longer the branch's head", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ lease: { _tag: "Stale", head: "b".repeat(40) } })
      expect(yield* run).toEqual({ _tag: "Ended", result: { _tag: "Skipped", reason: "main moved on to bbbbbbbbbbbb, so this run doesn't deploy" } })
      expect(calls).toEqual(["acquire", "release"])
    }))

  it.effect("doesn't deploy when the branch moved on while its artifacts were published", () =>
    Effect.gen(function*() {
      const { run } = harness({ heads: ["c".repeat(40)], lease: { _tag: "Held", fence: 7 } })
      expect(yield* run).toMatchObject({ _tag: "Ended", result: { _tag: "Skipped", reason: "main moved on to cccccccccccc, so this run doesn't deploy" } })
    }))

  it.effect("doesn't deploy when a newer run's same step took the lease", () =>
    Effect.gen(function*() {
      const { calls, run } = harness({ lease: { _tag: "Replaced", by: 12 } })
      expect(yield* run).toMatchObject({ _tag: "Ended", result: { reason: "#12 took deploy-beta's deploy lease, so this older run doesn't deploy" } })
      expect(calls).toEqual(["acquire", "release"])
    }))

  it.effect("dies saying why when an artifact can't reach the binary cache", () =>
    Effect.gen(function*() {
      const { run } = harness({ lease: { _tag: "Held", fence: 7 }, publish: Effect.die(new Error(`${path} is not in the binary cache after publishing`)) })
      expect(yield* run).toEqual({ _tag: "Ended", result: { _tag: "Died", message: `${path} is not in the binary cache after publishing` } })
    }))
})
