import { Context, Effect, Layer, Semaphore } from "effect"
import { HttpClient } from "effect/http"
import * as Exec from "../Exec.ts"
import { Config } from "./Config.ts"
import { hostOf } from "./Fleet.ts"

/** The hash a store path's narinfo is named after. */
export const hashOf = (path: string) => /^\/nix\/store\/([a-z0-9]{32})-[^/]+$/.exec(path)?.[1]

/** Whether a release for these promotion endpoints goes to a host other than `host`. */
export const leavesHost = (targets: ReadonlyArray<string>, host: string) => targets.some((t) => hostOf(t) !== host)

/** The fleet's binary cache, which the hosts substitute from. */
export class Cache extends Context.Service<Cache, {
  /** Whether the cache serves the path. False when it can't be asked. */
  readonly has: (path: string) => Effect.Effect<boolean>
  /**
   * Copies the path's closure into the cache, which keeps it for its retention. With `pin`, the cache also keeps
   * it as that name's release until the next pin. One publish runs at a time. Without a publish command, nothing
   * happens.
   */
  readonly publish: (path: string, options?: { readonly pin?: string }) => Effect.Effect<void, Exec.ExecError>
}>()("kiln/controller/Cache") {}

export const layer = Layer.effect(Cache)(Effect.gen(function*() {
  const config = yield* Config
  const http = yield* HttpClient.HttpClient
  const spawner = yield* Exec.SpawnerTag
  const url = config.cache.url.replace(/\/$/, "")
  const command = config.cache.publish
  // Builds finish in bursts; copying their closures one after another keeps the disks and the link calm.
  const one = Semaphore.makeUnsafe(1)

  return {
    has: (path) => {
      const hash = hashOf(path)
      if (hash === undefined) return Effect.succeed(false)
      return http.head(`${url}/${hash}.narinfo`).pipe(
        Effect.map((r) => r.status === 200),
        Effect.timeout("20 seconds"),
        Effect.orElseSucceed(() => false),
      )
    },
    publish: (path, options = {}) => {
      if (command === null) return Effect.void
      const argv = [...command, ...(options.pin === undefined ? [] : ["--pin", options.pin]), path]
      return one.withPermits(1)(
        Exec.run(argv).pipe(
          Effect.provideService(Exec.SpawnerTag, spawner),
          Effect.timeoutOrElse({
            duration: "30 minutes",
            orElse: () => Effect.fail(new Exec.CommandFailed({ command: argv.join(" "), exitCode: -1, stderr: "timed out after 30 minutes" })),
          }),
          Effect.asVoid,
        ),
      )
    },
  }
}))
