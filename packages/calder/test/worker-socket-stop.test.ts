import { BunSocketServer } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { mkdtempSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { named, report } from "../src/controller/Stopping.ts"
import { protocol } from "../src/controller/WorkerServer.ts"

class Rpcs extends RpcGroup.make(Rpc.make("job", { success: Schema.String })) {}

describe("the worker socket", () => {
  it.live("stops its RPC server while a worker leaves an answer untaken", () =>
    Effect.gen(function*() {
      const path = join(mkdtempSync(join(tmpdir(), "calder-worker-socket-")), "worker.sock")
      const server = named("RPC server", RpcServer.layer(Rpcs)).pipe(
        Layer.provide(Rpcs.toLayer({ job: () => Effect.succeed("x".repeat(1_000_000)) })),
        Layer.provide(protocol),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(named("socket", BunSocketServer.layer({ path }))),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(server, scope)
      // A worker that asks and doesn't read: the answer doesn't fit the socket's buffers.
      const worker = connect(path, () => worker.write(`${JSON.stringify({ _tag: "Request", id: "1", tag: "job", payload: null, headers: [] })}\n`))
      worker.pause()
      yield* Effect.sleep("500 millis")

      const stopping = yield* Effect.forkChild(Scope.close(scope, Exit.void), { startImmediately: true })
      yield* Effect.sleep("1 second")
      // Closing the socket server waits for the worker's connection; the RPC server no longer waits for the answer.
      expect(report(Date.now()).map((line) => line.split(" for ")[0])).toEqual(["socket"])
      worker.destroy()
      yield* Fiber.join(stopping)
    }))
})
