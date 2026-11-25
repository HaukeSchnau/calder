import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Gitea, layer } from "../src/controller/Gitea.ts";
import { config } from "./config.ts";

/** A Gitea that answers edits with `status` and posts with a new comment, recording each request. */
const answering = (status: number) =>
  Effect.gen(function* () {
    const requests: Array<string> = [];

    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${request.url.replace("http://gitea.test/api/v1", "")}`);

        return request.method === "PATCH"
          ? HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ message: "no" }), { status }),
            )
          : HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ id: 43 }), { status: 201 }),
            );
      }),
    );

    const gitea = yield* Effect.provide(
      Effect.service(Gitea),
      layer.pipe(
        Layer.provide(Layer.mergeAll(config(), Layer.succeed(HttpClient.HttpClient)(client))),
      ),
    );

    return { gitea, requests };
  });

describe("Gitea", () => {
  it.effect("posts a new comment in place of one someone deleted", () =>
    Effect.gen(function* () {
      const { gitea, requests } = yield* answering(404);
      expect(yield* gitea.comment("o/app", 5, "body", 42)).toBe(43);
      expect(requests).toEqual([
        "PATCH /repos/o/app/issues/comments/42",
        "POST /repos/o/app/issues/5/comments",
      ]);
    }),
  );

  it.effect(
    "keeps a comment it can't edit for another reason, rather than posting a second one",
    () =>
      Effect.gen(function* () {
        const { gitea, requests } = yield* answering(500);
        expect(yield* Effect.exit(gitea.comment("o/app", 5, "body", 42))).toMatchObject({
          _tag: "Failure",
        });
        expect(requests).toEqual(["PATCH /repos/o/app/issues/comments/42"]);
      }),
  );
});

describe("Gitea's open pull requests", () => {
  // As Gitea v28.3.0's list endpoint answers (services/convert/pull.go `ToAPIPullRequests`).
  const pull = (number: number, head: object) => ({
    number,
    head: { sha: `sha-${number}`, repo: { full_name: "o/app" }, ...head },
    base: { ref: "main", repo: { full_name: "o/app" } },
  });

  it.effect(
    "name an AGit pull request's head by its ref, also when a branch has its topic's name",
    () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify([
                  pull(7, { ref: "feature", label: "" }),
                  pull(8, { ref: "refs/pull/8/head", label: "" }),
                  pull(9, { ref: "feature", label: "feature" }),
                ]),
              ),
            ),
          ),
        );

        const gitea = yield* Effect.provide(
          Effect.service(Gitea),
          layer.pipe(
            Layer.provide(Layer.mergeAll(config(), Layer.succeed(HttpClient.HttpClient)(client))),
          ),
        );

        expect((yield* gitea.openPulls("o/app")).map((p) => [p.number, p.head])).toEqual([
          [7, "refs/pull/7/head"],
          [8, "refs/pull/8/head"],
          [9, "feature"],
        ]);
      }),
  );
});
