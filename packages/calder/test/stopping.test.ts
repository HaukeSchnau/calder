import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { named, report } from "../src/controller/Stopping.ts"

describe("a stopping controller's report", () => {
  it.effect("names the layer whose finalizers still run, and only until they end", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const waiting = Layer.effectDiscard(Effect.addFinalizer(() => Deferred.await(gate)))
      const inner = named("Inner", Layer.empty)
      const outer = named("Outer", waiting).pipe(Layer.provide(inner))
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(outer, scope)
      expect(report(Date.now())).toEqual([])

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), { startImmediately: true })
      yield* Effect.yieldNow
      expect(report(Date.now()).map((line) => line.split(" ")[0])).toEqual(["Outer"])

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(closing)
      expect(report(Date.now())).toEqual([])
    }))
})
