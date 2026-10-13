import { Effect } from "effect"
import { createHash } from "node:crypto"
import type { Repo } from "../src/worker/Repo.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

/** A revision held in memory: paths and their contents. Object ids follow contents, as git's do. */
export const memoryRepo = (tree: Record<string, string>): Repo => {
  const entries = Object.entries(tree).map(([path, text]) => ({ path, oid: hash(text) }))
  const id = (path: string) => {
    const below = entries.filter((e) => path === "." || e.path === path || e.path.startsWith(`${path}/`))
    return below.length === 0 ? [] : [[path, hash(JSON.stringify(below))] as const]
  }
  return {
    files: Effect.succeed(Object.keys(tree)),
    entries: Effect.succeed(entries),
    show: (path) => Effect.succeed(tree[path]),
    objectIds: (paths) => Effect.succeed(new Map(paths.flatMap(id))),
    read: (paths) => Effect.succeed(new Map(paths.flatMap((p) => (tree[p] === undefined ? [] : [[p, tree[p]] as const])))),
  }
}
