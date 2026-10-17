import { Effect, Option } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * The directories a repository keeps its pipeline in, `.calder/` first. `.kiln/` is its name from
 * before Calder; drop it once no default branch or open pull request carries `.kiln/ci.ts`.
 */
export const dirs = [".calder", ".kiln"] as const

export type Dir = (typeof dirs)[number]

/** The pipeline directory under `root` that holds a ci.ts. */
export const find = (root: string): string | undefined =>
  dirs.map((dir) => join(root, dir)).find((dir) => existsSync(join(dir, "ci.ts")))

/** The pipeline directory of a revision, given a check whether the revision has a file. */
export const at = <E, R>(has: (path: string) => Effect.Effect<boolean, E, R>): Effect.Effect<Dir | undefined, E, R> =>
  Effect.findFirst(dirs, (dir) => has(`${dir}/ci.ts`)).pipe(Effect.map(Option.getOrUndefined))
