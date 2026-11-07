import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { secretsDigest, taskKey } from "../src/Keys.ts"
import type { PlannedStep } from "../src/Protocol.ts"
import { drive, step } from "./drive.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

/** A release step: a deploy, which never takes another run's result. */
const deploy = (name: string, needs: ReadonlyArray<string> = [], secrets: ReadonlyArray<string> = []): PlannedStep => ({
  ...step,
  name,
  kind: "task",
  needs: [...needs],
  neverReuse: true,
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
    secrets: [...secrets],
    platform: null,
    lease: true,
  },
})

const action = (name: string, needs: ReadonlyArray<string>): PlannedStep => ({
  ...step,
  name,
  kind: "action",
  needs: [...needs],
  neverReuse: true,
  detail: name,
  action: { deploy: true, secrets: [] },
})

const key = (name: string) => taskKey(name, {}, null)

describe("a rerun", () => {
  it.live("runs only what didn't pass in the run it repeats, deploys included, and what depends on what it ran", () =>
    Effect.gen(function*() {
      // hopwatch-67: the OTA update and the server deployed, TestFlight failed.
      const { status, jobs, steps } = yield* drive({
        steps: [deploy("ota"), deploy("server"), deploy("testflight"), action("promote", ["server"]), action("announce", ["testflight"])],
        rerunOf: [
          { name: "ota", status: "passed", key: key("ota"), lease: 1 },
          { name: "server", status: "passed", key: key("server"), value: "v1", lease: 1 },
          { name: "testflight", status: "failed", key: key("testflight") },
          { name: "promote", status: "passed", lease: 1 },
          { name: "announce", status: "blocked" },
        ],
      })
      expect(status).toBe("passed")
      expect(jobs.toSorted()).toEqual(["announce", "testflight"])
      expect(steps.get("ota")).toMatchObject({ status: "reused", reusedFrom: { id: "app-1" } })
      // An action whose inputs are what they were takes its earlier result too.
      expect(steps.get("promote")).toMatchObject({ status: "reused", reusedFrom: { id: "app-1" } })
    }))

  it.live("runs a deploy again whose secrets changed since, or whose lease a newer run held since, and not one whose didn't", () =>
    Effect.gen(function*() {
      const token = join(mkdtempSync(join(tmpdir(), "calder-secret-")), "token")
      writeFileSync(token, "token-2")
      const digest = (value: string) => secretsDigest("placement key", { TOKEN: value })
      const { jobs } = yield* drive({
        steps: [deploy("server", [], ["TOKEN"]), deploy("ota"), deploy("tower", [], ["TOKEN"])],
        project: { secrets: { TOKEN: token } },
        placementKey: "placement key",
        rerunOf: [
          // A rerun to ship a rotated token has to run the step that reads it.
          { name: "server", status: "passed", key: key("server"), lease: 1, secrets: digest("token-1") },
          // app-3 deployed ota after app-1 did: what app-1 deployed no longer runs there.
          { name: "ota", status: "passed", key: key("ota"), lease: 3 },
          { name: "tower", status: "passed", key: key("tower"), lease: 1, secrets: digest("token-2") },
        ],
      })
      expect(jobs.toSorted()).toEqual(["ota", "server"])
    }))

  it.live("runs a step with secrets again on a controller without a key, which records no digest", () =>
    Effect.gen(function*() {
      const token = join(mkdtempSync(join(tmpdir(), "calder-secret-")), "token")
      writeFileSync(token, "1234")
      const { jobs, steps } = yield* drive({
        steps: [deploy("server", [], ["TOKEN"]), deploy("ota")],
        project: { secrets: { TOKEN: token } },
        // What a controller without a key recorded before: an unkeyed hash, which gave the secret away.
        rerunOf: [
          { name: "server", status: "passed", key: key("server"), lease: 1, secrets: secretsDigest("calder", { TOKEN: "1234" }) },
          { name: "ota", status: "passed", key: key("ota"), lease: 1 },
        ],
      })
      expect(jobs).toEqual(["server"])
      expect(steps.get("server")?.status).toBe("passed")
    }))

  it.live("runs a step again whose key changed, or an action whose inputs did", () =>
    Effect.gen(function*() {
      const { jobs } = yield* drive({
        steps: [deploy("server"), deploy("ota"), action("promote", ["ota"])],
        rerunOf: [
          { name: "server", status: "passed", key: "another revision's key", lease: 1 },
          { name: "ota", status: "passed", key: "another revision's key", value: "update-1", lease: 1 },
          { name: "promote", status: "passed", lease: 1 },
        ],
        value: (name) => (name === "ota" ? "update-2" : null),
      })
      expect(jobs.toSorted()).toEqual(["ota", "promote", "server"])
    }))
})
