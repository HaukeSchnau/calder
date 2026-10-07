import { Console, Effect, Schedule } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import * as Check from "./Check.ts"
import * as Exec from "./Exec.ts"

/** jj workspaces: each root that is one, and the directories right inside it that are. */
const workspaces = (roots: ReadonlyArray<string>) =>
  roots.flatMap((root) =>
    existsSync(join(root, ".jj"))
      ? [root]
      : existsSync(root)
      ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, d.name, ".jj"))).map((d) =>
        join(root, d.name)
      )
      : []
  )

/** The workspace's last snapshot, if it holds changes its trunk doesn't. Reading it doesn't take a snapshot. */
const snapshot = (dir: string) =>
  Effect.gen(function*() {
    const jj = (args: ReadonlyArray<string>) => Exec.run(["jj", "--ignore-working-copy", "--repository", dir, ...args])
    const changed = (yield* jj(["log", "--no-graph", "-r", "trunk()..@ ~ empty()", "-T", `commit_id ++ "\\n"`])).trim()
    if (changed === "") return null
    return (yield* jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])).trim()
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * jj rewrites this file whenever the workspace's working copy moves to a new operation, so while it
 * stays the same the snapshot does too, and reading it is far cheaper than running jj.
 */
const stamp = (dir: string) => {
  try {
    return readFileSync(join(dir, ".jj", "working_copy", "checkout"), "latin1")
  } catch {
    return null
  }
}

/**
 * `kiln watch`: checks the jj workspaces under `roots` in the background once a snapshot has stayed
 * the same for `settle`, one check per workspace (a newer one replaces it). Snapshots that existed when
 * the watcher started aren't checked.
 */
export const watch = (client: Check.Client, roots: ReadonlyArray<string>, options: { readonly every: number; readonly settle: number }) =>
  Effect.gen(function*() {
    const seen = new Map<string, { stamp: string | null; readonly sha: string | null; readonly since: number; checked: boolean }>()
    let first = true
    const tick = Effect.gen(function*() {
      for (const dir of workspaces(roots)) {
        const known = seen.get(dir)
        const current = stamp(dir)
        const sha = current !== null && known?.stamp === current ? known.sha : yield* snapshot(dir)
        if (known === undefined || known.sha !== sha) {
          seen.set(dir, { stamp: current, sha, since: Date.now(), checked: first })
          continue
        }
        known.stamp = current
        if (sha === null || known.checked || Date.now() - known.since < options.settle) continue
        known.checked = true
        yield* Check.submit(client, dir, { key: basename(dir), background: true, snapshot: false }).pipe(
          Effect.tap(({ run }) => Console.log(`${basename(dir)}: ${run.project} #${run.number} checks ${sha.slice(0, 12)}`)),
          Effect.catchCause((cause) => Effect.logWarning(`checking ${dir} failed`, cause)),
        )
      }
      first = false
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("watch tick failed", cause)))
    yield* Console.log(`watching ${workspaces(roots).length} workspaces`)
    return yield* tick.pipe(Effect.repeat(Schedule.spaced(options.every)), Effect.asVoid)
  })
