import { Kiln, type Step } from "@kiln/core"
import { Effect, Schema } from "effect"
import { join } from "node:path"

export class LoadFailed extends Schema.TaggedError<LoadFailed>("kiln/LoadFailed")("LoadFailed", {
  message: Schema.String,
}) {}

/** Imports the revision's `.kiln/ci.ts` and returns its default export. */
export const project = (kilnDir: string) =>
  Effect.tryPromise({
    try: () => import(join(kilnDir, "ci.ts")) as Promise<{ readonly default?: unknown }>,
    catch: (error) => new LoadFailed({ message: `.kiln/ci.ts failed to load: ${error instanceof Error ? error.stack ?? error.message : String(error)}` }),
  }).pipe(
    Effect.flatMap((module) =>
      Kiln.isProject(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(new LoadFailed({ message: ".kiln/ci.ts must `export default Kiln.project({ ... })`" }))
    ),
  )

export const step = (project: Kiln.Project, name: string) =>
  Kiln.universe(project).pipe(
    Effect.mapError((e) => new LoadFailed({ message: e.message })),
    Effect.flatMap((all): Effect.Effect<Step.Any, LoadFailed> => {
      const found = all.get(name)
      return found === undefined
        ? Effect.fail(new LoadFailed({ message: `no step named "${name}" in .kiln/ci.ts` }))
        : Effect.succeed(found)
    }),
  )
