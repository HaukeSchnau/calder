import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { ChildProcessSpawner } from "effect/process"
import * as Exec from "../src/Exec.ts"
import * as Fleet from "../src/controller/Fleet.ts"
import * as Telemetry from "../src/controller/Telemetry.ts"
import { config } from "./config.ts"

describe("Fleet", () => {
  it.effect("counts a host that never answered as unknown, and asks it again", () =>
    Effect.gen(function*() {
      const answers: Array<Effect.Effect<Fleet.Health, string>> = [Effect.fail("connection refused"), Effect.succeed({ apps: ["calder"] })]
      const healthOf = Fleet.remembered(() => answers.shift()!).cached
      expect(yield* healthOf("http://host-b:18100")).toBeNull()
      expect(yield* healthOf("http://host-b:18100")).toEqual({ apps: ["calder"] })
    }))

  it.effect("deploys to each host with the system its /health reports, the controller's when it reports none", () =>
    Effect.gen(function*() {
      const health: Record<string, unknown> = {
        "m1": { ok: true, apps: ["calder"], system: "aarch64-darwin" },
        "tower": { ok: true, apps: ["calder"] },
        "srv-1": { ok: true, apps: ["other"], system: "aarch64-linux" },
      }
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(health[new URL(request.url).hostname]))))
      )
      const fleet = yield* Effect.provide(
        Effect.gen(function*() {
          return yield* Fleet.Fleet
        }),
        Fleet.layer.pipe(Layer.provide(Layer.mergeAll(
          config({ fleet: ["http://m1:18100", { url: "http://tower:18100", wake: ["true"] }, "http://srv-1:18100"] }),
          Layer.succeed(Telemetry.Telemetry)({} as Telemetry.Telemetry["Service"]),
          Layer.succeed(HttpClient.HttpClient)(client),
          Layer.succeed(Exec.SpawnerTag)(ChildProcessSpawner.make(() => Effect.die("unused"))),
        ))),
      )
      const project = { name: "calder", repo: "schnau/calder", defaultBranch: "main", targets: null, secrets: {} }
      expect(yield* fleet.deployTargets(project, "calder")).toEqual({
        targets: [{ url: "http://m1:18100", system: "aarch64-darwin" }, { url: "http://tower:18100", system: "x86_64-linux" }],
        unreachable: [],
      })
    }))

  const asleep = (answersAfter: number) => {
    let asked = 0
    return () => Effect.sync(() => (++asked > answersAfter ? { apps: ["calder"] } : null))
  }

  it.effect("wakes a sleeping host at most once per two minutes and waits five minutes for it", () =>
    Effect.gen(function*() {
      const woken: Array<string> = []
      const wake = (command: ReadonlyArray<string>) => Effect.sync(() => woken.push(command.join(" ")))
      // Asked every 5 seconds, the host first answers after three minutes, past the minute others get.
      const ask = Fleet.patiently(asleep(36), wake)
      const tower = { url: "http://tower:18100", wake: ["systemctl", "start", "calder-wake@tower.service"] }
      const probing = yield* Effect.forkChild(ask(tower))
      yield* TestClock.adjust("3 minutes")
      expect(yield* Fiber.join(probing)).toEqual({ apps: ["calder"] })
      expect(woken).toEqual(["systemctl start calder-wake@tower.service", "systemctl start calder-wake@tower.service"])
    }))

  it.effect("wakes a host that answered before and fell asleep, rather than trusting its last answer", () =>
    Effect.gen(function*() {
      let awake = true
      const healthOf = Fleet.remembered(() => (awake ? Effect.succeed({ apps: ["calder"] }) : Effect.fail("connection refused")))
      expect(yield* healthOf.cached("http://tower:18100")).toEqual({ apps: ["calder"] })
      awake = false
      const woken: Array<string> = []
      const ask = Fleet.patiently(healthOf.fresh, (command) => Effect.sync(() => woken.push(command.join(" "))))
      const probing = yield* Effect.forkChild(ask({ url: "http://tower:18100", wake: ["wake-tower"] }))
      yield* TestClock.adjust("10 seconds")
      expect(woken).toEqual(["wake-tower"])
      expect(probing.pollUnsafe()).toBeUndefined()
      awake = true
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(probing)).toEqual({ apps: ["calder"] })
    }))

  it.effect("gives up on a host without a wake command after a minute, and on one with it after five", () =>
    Effect.gen(function*() {
      const woken: Array<string> = []
      const ask = Fleet.patiently(asleep(Infinity), (command) => Effect.sync(() => woken.push(command.join(" "))))
      const plain = yield* Effect.forkChild(ask({ url: "http://host-b:18100", wake: undefined }))
      const sleeper = yield* Effect.forkChild(ask({ url: "http://tower:18100", wake: ["wake-tower"] }))
      yield* TestClock.adjust("70 seconds")
      expect(yield* Fiber.join(plain)).toBeNull()
      expect(sleeper.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("4 minutes")
      expect(yield* Fiber.join(sleeper)).toBeNull()
      expect(woken).toEqual(["wake-tower", "wake-tower", "wake-tower"])
    }))
})
