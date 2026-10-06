import { Effect } from "effect"
import { spawn } from "node:child_process"
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
    /** Every file of the revision with its blob id. */
    const entries = yield* Effect.cached(
      git(["ls-tree", "-r", "-z", revision]).pipe(
        Effect.map((out) =>
          out.split("\0").filter(Boolean).map((entry) => {
            const [meta, path] = entry.split("\t")
            return { path: path!, oid: meta!.split(" ")[2]! }
          })
        ),
      ),
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
    /** Contents of many files at the revision in one `git cat-file --batch`. Missing ones are left out. */
    const read = (paths: ReadonlyArray<string>) =>
      Effect.callback<ReadonlyMap<string, string>, Error>((resume) => {
        const out = new Map<string, string>()
        if (paths.length === 0) return resume(Effect.succeed(out))
        const child = spawn("git", ["--git-dir", mirror, "cat-file", "--batch"], { env: { ...process.env, ...gitEnv }, stdio: ["pipe", "pipe", "ignore"] })
        const chunks: Array<Buffer> = []
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
        child.on("error", (error) => resume(Effect.fail(error)))
        child.on("close", () => {
          const bytes = Buffer.concat(chunks)
          let at = 0
          for (const path of paths) {
            const end = bytes.indexOf(10, at)
            if (end < 0) break
            const header = bytes.toString("utf8", at, end)
            at = end + 1
            if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue
            const size = Number(header.split(" ")[2])
            out.set(path, bytes.toString("utf8", at, at + size))
            at += size + 1
          }
          resume(Effect.succeed(out))
        })
        child.stdin.end(paths.map((p) => `${revision}:${p}\n`).join(""))
      }).pipe(Effect.orDie)
    return { files, entries, show, objectIds, read }
  })

export type Repo = Effect.Success<ReturnType<typeof make>>
