import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { cgi } from "../src/controller/Remote.ts"

const bytes = (...parts: ReadonlyArray<string>) => Stream.fromArray(parts.map((p) => new TextEncoder().encode(p)))

describe("cgi", () => {
  it.effect("reads the headers, even split across chunks, and streams the body on", () =>
    Effect.gen(function*() {
      const response = yield* cgi(bytes("Status: 404 Not Found\r\nContent-Type: text/plain\r", "\n\r\nnot ", "here"))
      expect(response).toMatchObject({ status: 404, headers: { "Content-Type": "text/plain" } })
      expect(yield* Stream.mkString(Stream.decodeText(response!.body))).toBe("not here")
      expect(yield* cgi(bytes("Content-Type: text/plain\r\n"))).toBeUndefined()
    }).pipe(Effect.scoped))
})
