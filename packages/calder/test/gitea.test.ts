import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Gitea, layer } from "../src/controller/Gitea.ts"
import { config } from "./config.ts"

describe("Gitea", () => {
  it.effect("posts a new comment in place of one someone deleted", () =>
    Effect.gen(function*() {
      const requests: Array<string> = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(`${request.method} ${request.url.replace("http://gitea.test/api/v1", "")}`)
          return request.method === "PATCH"
            ? HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ message: "not found" }), { status: 404 }))
            : HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ id: 43 }), { status: 201 }))
        })
      )
      const gitea = yield* Effect.provide(
        Effect.gen(function*() { return yield* Gitea }),
        layer.pipe(Layer.provide(Layer.mergeAll(config(), Layer.succeed(HttpClient.HttpClient)(client)))),
      )
      expect(yield* gitea.comment("o/app", 5, "body", 42)).toBe(43)
      expect(requests).toEqual(["PATCH /repos/o/app/issues/comments/42", "POST /repos/o/app/issues/5/comments"])
    }))
})
