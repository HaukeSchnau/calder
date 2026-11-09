import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { vi } from "vitest"
import { tick } from "../src/controller/Delivery.ts"
import { Gitea } from "../src/controller/Gitea.ts"
import { Mirror } from "../src/controller/Mirror.ts"
import { Projects } from "../src/controller/Projects.ts"
import { config } from "./config.ts"
import { insertRun, insertStep, layer } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const project = { name: "p", repo: "o/p", defaultBranch: "main", targets: null, secrets: {} }

/** Gitea where merge `m1` is pull request 7, and a mirror whose history is m1 <- m2. */
const fakes = (options: { readonly giteaDown?: { count: number } } = {}) => {
  const comments: Array<{ pr: number; body: string; existing: number | null }> = []
  const history = ["m1", "m2"]
  const services = Layer.mergeAll(
    config(),
    Layer.succeed(Projects)({ get: () => project, all: () => [project], byRepo: () => Effect.succeed(undefined) }),
    Layer.succeed(Gitea)({
      mergedPull: (_repo: string, sha: string) =>
        options.giteaDown !== undefined && options.giteaDown.count-- > 0 ? Effect.fail(new Error("502")) : Effect.succeed(sha === "m1" ? 7 : null),
      comment: (_repo: string, pr: number, body: string, existing: number | null) =>
        Effect.sync(() => {
          comments.push({ pr, body, existing })
          return existing ?? 100
        }),
    } as unknown as Gitea["Service"]),
    Layer.succeed(Mirror)({
      contains: (_project: string, revision: string, commit: string) =>
        Effect.succeed(history.indexOf(commit) !== -1 && history.indexOf(commit) <= history.indexOf(revision)),
    } as unknown as Mirror["Service"]),
  )
  return { comments, services }
}

describe("delivery", () => {
  it.effect("tells a merge's pull request that its run failed, once, and that it shipped once a run including it passed", () => {
    const { comments, services } = fakes()
    return Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1, branch: "main", sha: "m1", status: "failed", planned: true })
      yield* insertStep("p-1", "placement", { status: "failed", error: "exited with 1: state store unreachable\nat cli.deploy" })
      yield* insertRun("p-2", { at: 2, branch: "main", sha: "direct", status: "failed", planned: true })
      // The closed pull request's run at the merge only cleans up; it passing ships nothing.
      yield* insertRun("p-4", { at: 3, branch: "main", sha: "m1", planned: true, event: '{"_tag":"PullRequestClosed","number":7,"base":"main","head":"f"}' })
      // Nor does a nightly that only runs checks.
      yield* insertRun("p-5", { at: 4, branch: "main", sha: "m2", planned: true, event: '{"_tag":"Schedule","cron":"0 3 * * *"}' })
      yield* tick(10)
      yield* tick(20)
      expect(comments).toEqual([{
        pr: 7,
        existing: null,
        body: "**Merged, not shipped yet.** [run 1](http://calder.test/#/run/p-1) of this merge on `main` failed at `placement`: " +
          "exited with 1: state store unreachable.\n\nCalder edits this comment once a run that includes this merge passes.",
      }])

      yield* insertRun("p-3", { at: 3_600_001, branch: "main", sha: "m2", status: "passed", planned: true })
      yield* tick(3_600_010)
      yield* tick(3_600_020)
      expect(comments.slice(1)).toEqual([{
        pr: 7,
        existing: 100,
        body: "**Shipped.** [run 3](http://calder.test/#/run/p-3) passed with this merge, 1h after [run 1](http://calder.test/#/run/p-1) failed.",
      }])
    }).pipe(Effect.provide(Layer.merge(layer, services)))
  })

  it.effect("leaves a failed merge alone when a run including it passed already", () => {
    const { comments, services } = fakes()
    return Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1, branch: "main", sha: "m1", status: "failed", planned: true })
      yield* insertRun("p-2", { at: 2, branch: "main", sha: "m2", status: "passed", planned: true })
      yield* tick(10)
      expect(comments).toEqual([])
    }).pipe(Effect.provide(Layer.merge(layer, services)))
  })

  it.effect("asks again after Gitea failed to answer which pull request a merge was", () => {
    const { comments, services } = fakes({ giteaDown: { count: 1 } })
    return Effect.gen(function*() {
      yield* insertRun("p-1", { at: 1, branch: "main", sha: "m1", status: "failed", planned: true })
      const looked = new Set<string>()
      yield* tick(10, looked)
      expect(comments).toEqual([])
      yield* tick(20, looked)
      expect(comments.map((c) => c.pr)).toEqual([7])
    }).pipe(Effect.provide(Layer.merge(layer, services)))
  })
})
