import { Calder, type Step } from "@calder-ci/core"
import { Effect, Schema } from "effect"
import { join } from "node:path"

export class LoadFailed extends Schema.TaggedError<LoadFailed>("calder/LoadFailed")("LoadFailed", {
  message: Schema.String,
}) {}

/** Imports the revision's `.calder/ci.ts` and returns its default export. */
export const project = (pipelineDir: string) =>
  Effect.tryPromise({
    try: () => import(join(pipelineDir, "ci.ts")) as Promise<{ readonly default?: unknown }>,
    catch: (error) => new LoadFailed({ message: `.calder/ci.ts failed to load: ${error instanceof Error ? error.stack ?? error.message : String(error)}` }),
  }).pipe(
    Effect.flatMap((module) =>
      Calder.isProject(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(new LoadFailed({ message: ".calder/ci.ts must `export default Calder.project({ ... })`" }))
    ),
  )

export const step = (project: Calder.Project, name: string) =>
  Calder.universe(project).pipe(
    Effect.mapError((e) => new LoadFailed({ message: e.message })),
    Effect.flatMap((all): Effect.Effect<Step.Any, LoadFailed> => {
      const found = all.get(name)
      return found === undefined
        ? Effect.fail(new LoadFailed({ message: `no step named "${name}" in .calder/ci.ts` }))
        : Effect.succeed(found)
    }),
  )
