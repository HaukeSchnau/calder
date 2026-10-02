import { Effect } from "effect"
import * as Exec from "../Exec.ts"

/** Git environment that reads the controller's mirror, which another user owns. */
export const gitEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
  GIT_TERMINAL_PROMPT: "0",
}

export const make = (mirror: string, revision: string) =>
  Effect.gen(function*() {
    const git = (args: ReadonlyArray<string>) => Exec.run(["git", "--git-dir", mirror, ...args], { env: gitEnv })
    const files = yield* Effect.cached(
      git(["ls-tree", "-r", "-z", "--name-only", revision]).pipe(Effect.map((out) => out.split("\0").filter(Boolean))),
    )
    const show = (path: string) =>
      git(["show", `${revision}:${path}`]).pipe(Effect.orElseSucceed(() => undefined))
    /** Object ids of paths at the revision: trees for directories, blobs for files. Missing paths are left out. */
    const objectIds = (paths: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const ids = new Map<string, string>()
        if (paths.includes(".")) ids.set(".", (yield* git(["rev-parse", `${revision}^{tree}`])).trim())
        const rest = [...new Set(paths.filter((p) => p !== "."))]
        for (let i = 0; i < rest.length; i += 500) {
          const out = yield* git(["ls-tree", "-z", revision, "--", ...rest.slice(i, i + 500)])
          for (const entry of out.split("\0").filter(Boolean)) {
            const [meta, path] = entry.split("\t")
            ids.set(path!, meta!.split(" ")[2]!)
          }
        }
        return ids as ReadonlyMap<string, string>
      })
    return { files, show, objectIds }
  })

export type Repo = Effect.Success<ReturnType<typeof make>>
