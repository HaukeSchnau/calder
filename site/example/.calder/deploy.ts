import { Secret, type StorePath } from "@calder-ci/core"
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/** Hands the built site to the hosting provider's deploy hook. */
export const publish = (site: StorePath) =>
  Effect.gen(function*() {
    const token = yield* Secret.value("deploy-token")
    const client = yield* HttpClient.HttpClient
    yield* client.execute(
      HttpClientRequest.post("https://deploy.example.com/hooks/site").pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.bodyJsonUnsafe({ path: site }),
      ),
    )
  })
