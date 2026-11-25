import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { realpathSync } from "node:fs";
import { Job } from "../src/worker/Client.ts";
import * as Steps from "../src/worker/Steps.ts";

const bundle = "/nix/store/0pnbk1rns4wk6azih0kcz7136aid5x6f-studienbuch-bundle";
// The runtime running this test lives in the store, so this store holds it.
const held = realpathSync(process.execPath).split("/").slice(0, 4).join("/");

/**
 * A task on the controller's host whose artifacts are `paths`, such as Studienbuch's `plan-beta` reading
 * CALDER_BUNDLE, where `nix-store --realise` gets a path back from the binary cache, fails as Nix does when
 * no substituter has it, or never ends. Returns the commands it ran and what its log said.
 */
const fetched = (paths: ReadonlyArray<string>, fetch: "substitutes" | "fails" | "stalls") =>
  Effect.gen(function* () {
    const ran: Array<ReadonlyArray<string>> = [];
    const logged: Array<string> = [];
    const nix = ChildProcessSpawner.make((command) => {
      ran.push(ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            fetch === "stalls"
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(fetch === "substitutes" ? 0 : 1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(
            new TextEncoder().encode(
              fetch === "fails"
                ? `error: path '${bundle}' is required, but there is no substituter that can build it\n`
                : "",
            ),
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    });
    const self = {
      remote: null,
      log: (_stream: string, text: string) => Effect.sync(() => void logged.push(text)),
    } as unknown as Job["Service"];
    const fiber = yield* Effect.forkChild(
      Steps.fetchArtifacts(self, paths).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, nix),
      ),
    );
    yield* TestClock.adjust("5 minutes");
    yield* Fiber.join(fiber);
    return { ran, logged };
  });

describe("a task's artifacts on the controller's host", () => {
  it.effect(
    "come back from the binary cache before the command reads them, when this store lost them",
    () =>
      Effect.gen(function* () {
        const { ran, logged } = yield* fetched([bundle, held], "substitutes");
        // Only the path this store lacks is fetched.
        expect(ran).toEqual([["nix-store", "--realise", bundle]]);
        expect(logged).toEqual([`fetched ${bundle} from the binary cache`]);
      }),
  );

  it.effect("leave the command to fail on its own when the cache has none, saying why", () =>
    Effect.gen(function* () {
      const { logged } = yield* fetched([bundle], "fails");
      expect(logged).toEqual([
        `${bundle} isn't in this store, and fetching it from the binary cache failed: error: path '${bundle}' is required, but there is no substituter that can build it`,
      ]);
    }),
  );

  it.effect("give up fetching after 5 minutes", () =>
    Effect.gen(function* () {
      const { logged } = yield* fetched([bundle], "stalls");
      expect(logged).toEqual([
        `${bundle} isn't in this store, and fetching it from the binary cache failed: timed out after 5 minutes`,
      ]);
    }),
  );
});
