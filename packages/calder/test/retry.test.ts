import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { vi } from "vitest"
import { retryable, RunsCore } from "../src/controller/Runs.ts"
import * as Workflow from "../src/controller/Workflow.ts"
import type { JobResult, PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const task = (name: string, needs: ReadonlyArray<string> = []): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [...needs],
  detail: name,
  task: {
    shell: null,
    keyBase: name,
    inputs: [],
    interpolates: [],
    shards: null,
    each: null,
    deps: "deps",
    outputs: [],
    secrets: [],
    platform: null,
  },
})

/** An action, which takes an action slot, so it runs beside the tests' one task slot. */
const action = (name: string): PlannedStep => ({ ...step, name, kind: "action", needs: [], detail: name, action: { deploy: false, secrets: [] } })

const failed: JobResult = { _tag: "Failed", tag: "BuildFailed", message: "failed to start SSH connection", error: null, key: null }

/** Fails `name`'s first job, as a builder that dropped its connection would. */
const failingOnce = (name: string) => {
  let calls = 0
  return (s: string) => (s === name && calls++ === 0 ? failed : undefined)
}

const statusOf = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ status: string }>`select status from steps where run_id = 'app-2' and name = ${name}`
    return row?.status
  }).pipe(Effect.orDie)

const runOf = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ status: string; retries: number }>`select status, retries from runs where id = 'app-2'`
  return row!
}).pipe(Effect.orDie)

const until = <A>(effect: Effect.Effect<A, never, SqlClient.SqlClient>, done: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }), Effect.timeout("5 seconds"), Effect.orDie)

const rerun = Effect.gen(function*() {
  const runs = yield* Workflow.Runs
  return yield* runs.rerun("app-2").pipe(Effect.orDie)
})

describe("a rerun in place", () => {
  it("runs the failed steps and what they blocked again, downstream of each, and leaves what passed", () => {
    const steps = [
      { name: "a", status: "passed", spec: task("a") },
      { name: "b", status: "failed", spec: task("b") },
      { name: "c", status: "blocked", spec: task("c", ["b"]) },
      { name: "d", status: "blocked", spec: task("d", ["c"]) },
      { name: "e", status: "pending", spec: task("e", ["b", "a"]) },
      { name: "f", status: "skipped", spec: task("f", ["a"]) },
    ] as const
    expect(retryable(steps)).toEqual(["b", "c", "d"])
  })

  it.live("of a run that ended runs its failed step and the step it blocked in the same run, which then passes", () =>
    Effect.gen(function*() {
      let retried: { readonly id: string } | undefined
      let after: { readonly status: string; readonly retries: number } | undefined
      const { status, jobs, steps } = yield* drive({
        steps: [task("a"), task("b"), task("c", ["b"]), task("d", ["a"])],
        result: failingOnce("b"),
        meanwhile: Effect.gen(function*() {
          yield* until(runOf, (r) => r.status === "failed")
          retried = yield* rerun
          after = yield* until(runOf, (r) => r.status === "passed")
        }),
      })
      expect(status).toBe("passed")
      expect(retried?.id).toBe("app-2")
      expect(after?.retries).toBe(1)
      expect(jobs.filter((j) => j === "b")).toHaveLength(2)
      expect(jobs.filter((j) => j === "a" || j === "d").toSorted()).toEqual(["a", "d"])
      expect(jobs.at(-1)).toBe("c")
      expect(steps.get("c")?.status).toBe("passed")
    }))

  it.live("while the run goes on starts the failed step at once, and a dependent that hadn't started waits for it", () =>
    Effect.gen(function*() {
      let slowEnded = false
      let againBeforeSlowEnded: boolean | undefined
      let bJobs = 0
      let retries: number | undefined
      const { status, jobs, steps } = yield* drive({
        steps: [action("slow"), task("b"), task("c", ["b", "slow"])],
        result: (s) => (s === "b" && bJobs === 1 ? failed : undefined),
        work: (s) =>
          s === "slow"
            ? Effect.sleep("600 millis").pipe(Effect.andThen(Effect.sync(() => void (slowEnded = true))))
            : s === "b"
            ? Effect.suspend(() => {
              bJobs++
              if (bJobs === 1) return Effect.void
              againBeforeSlowEnded = !slowEnded
              // b's second job outlasts slow, so c is ready to run while b still runs again.
              return Effect.sleep("1200 millis")
            })
            : Effect.void,
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("b"), (s) => s === "failed")
          yield* rerun
          retries = (yield* until(runOf, (r) => r.status === "passed")).retries
        }),
      })
      expect(status).toBe("passed")
      expect(againBeforeSlowEnded).toBe(true)
      expect(jobs.filter((j) => j === "c")).toHaveLength(1)
      expect(steps.get("c")?.status).toBe("passed")
      // Waiting, c never settled blocked, which the driver would have had to run again.
      expect(retries).toBe(1)
    }))

  it.live("refuses a run that still goes on with nothing failed yet", () =>
    Effect.gen(function*() {
      let refused: string | undefined
      yield* drive({
        steps: [task("slow")],
        work: () => Effect.sleep("300 millis"),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("slow"), (s) => s === "running")
          const runs = yield* Workflow.Runs
          refused = yield* runs.rerun("app-2").pipe(Effect.flip, Effect.map((e) => e.message), Effect.orElseSucceed(() => "it reran"))
        }),
      })
      expect(refused).toContain("nothing of app-2 failed so far")
    }))

  it.live("of a step whose row ended while its attempt still reports it waits for that attempt, so its failure lands before the retry", () =>
    Effect.gen(function*() {
      const { status, history } = yield* drive({
        steps: [task("b"), task("c", ["b"])],
        result: failingOnce("b"),
        // Gitea takes a while to take b's failure, which the step reports after its row ended.
        statusDelay: (context, state) => (context === "calder/b" && state === "failure" ? 300 : undefined),
        meanwhile: Effect.gen(function*() {
          yield* until(statusOf("b"), (s) => s === "failed")
          yield* rerun
          yield* until(runOf, (r) => r.status === "passed")
        }),
      })
      expect(status).toBe("passed")
      const ofB = history.filter((h) => h.startsWith("calder/b: "))
      expect(ofB.indexOf("calder/b: pending: runs again")).toBeGreaterThan(ofB.findIndex((h) => h.startsWith("calder/b: failure")))
      expect(ofB.at(-1)).toMatch(/^calder\/b: success/)
    }))

  it.live("that the driver makes itself neither counts as a retry nor tells Gitea", () =>
    Effect.gen(function*() {
      let retries: number | undefined
      const { statuses } = yield* drive({
        steps: [task("b")],
        result: () => failed,
        meanwhile: Effect.gen(function*() {
          yield* until(runOf, (r) => r.status === "failed")
          const core = yield* RunsCore
          yield* core.retry("app-2", "a test", { only: ["b"], quiet: true })
          retries = (yield* runOf).retries
          // No driver runs b again here; the run ends as it was.
          const sql = yield* SqlClient.SqlClient
          yield* sql`update runs set status = 'failed' where id = 'app-2'`.pipe(Effect.orDie)
        }),
      })
      expect(retries).toBe(0)
      expect(statuses.get("calder/b")).toMatch(/^failure/)
    }))

  it.live("runs the steps it reset again when whoever asked for it goes away while Gitea is slow to hear of it", () =>
    Effect.gen(function*() {
      const { status, jobs } = yield* drive({
        steps: [task("b")],
        result: failingOnce("b"),
        statusDelay: (_context, _state, description) => (description === "runs again" ? 300 : undefined),
        meanwhile: Effect.gen(function*() {
          yield* until(runOf, (r) => r.status === "failed")
          // The CLI's connection drops while the rerun waits for Gitea.
          const asked = yield* Effect.forkChild(rerun)
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(asked)
          yield* until(runOf, (r) => r.status === "passed")
        }),
      })
      expect(status).toBe("passed")
      expect(jobs).toEqual(["b", "b"])
    }))
})

describe("a rerun in place of a step that reads a build", () => {
  const out = "/nix/store/0pnbk1rns4wk6azih0kcz7136aid5x6f-studienbuch-bundle"
  const bundle: PlannedStep = {
    ...step,
    name: "bundle",
    kind: "build",
    needs: [],
    detail: "packages.bundle",
    build: { attr: "packages.bundle", drv: out.replace("bundle", "bundle.drv"), out, system: null },
  }
  // Publishing its artifact signs what this store holds.
  const preview = task("preview", ["bundle"])

  /**
   * Drives a run whose bundle was in the binary cache and whose preview failed, then `forget`s what held the
   * bundle and reruns the run. Returns how it ended, and whether the preview's last job found the bundle.
   */
  const rerunAfter = (forget: { readonly cache: boolean }) =>
    Effect.gen(function*() {
      const stateDir = mkdtempSync(join(tmpdir(), "calder-rerun-"))
      let cached = true
      let here = false
      let previews = 0
      let found: boolean | undefined
      const driven = yield* drive({
        steps: [bundle, preview],
        stateDir,
        cache: { has: (path) => Effect.succeed(path === out && cached), publish: () => Effect.void },
        // `nix-store --realise` substitutes what the cache has.
        valid: (path) => path === out && (here ||= cached),
        value: (s) => (s === "bundle" ? out : null),
        work: (s) => Effect.sync(() => void (s === "bundle" && (here = true))),
        result: (s) => {
          if (s !== "preview") return undefined
          previews++
          if (previews === 1) return { _tag: "Failed", tag: "Exit", message: "3 previews are running (pr-102, pr-103, pr-106)", error: null, key: null }
          found = here
          return found ? undefined : { _tag: "Died", message: `publishing ${out} failed: nix-cache-sign: not all paths are valid` }
        },
        meanwhile: Effect.gen(function*() {
          yield* until(runOf, (r) => r.status === "failed")
          // srv-2's nightly collection, and maybe the cache's, dropped the bundle between the run and its rerun.
          if (forget.cache) cached = false
          yield* rerun
          yield* until(runOf, (r) => r.status !== "running" && r.retries === 1)
        }),
      })
      return { ...driven, found, stateDir }
    })

  it.live("builds a kept build again whose output left this store and the binary cache, before the step that reads it", () =>
    Effect.gen(function*() {
      const { status, jobs, found, steps } = yield* rerunAfter({ cache: true })
      expect(found).toBe(true)
      expect(status).toBe("passed")
      expect(jobs).toEqual(["preview", "bundle", "preview"])
      expect(steps.get("bundle")?.status).toBe("passed")
    }))

  it.live("substitutes a kept build's output the binary cache still has, and keeps it for the reopened run", () =>
    Effect.gen(function*() {
      const { status, jobs, commands, stateDir, found } = yield* rerunAfter({ cache: false })
      expect(found).toBe(true)
      expect(status).toBe("passed")
      expect(jobs).toEqual(["preview", "preview"])
      expect(commands).toContainEqual(["nix-store", "--add-root", join(stateDir, "derivations", "app-2", basename(out)), "--realise", out])
    }))
})
