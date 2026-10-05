import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Config } from "./Config.ts"
import { Gitea } from "./Gitea.ts"

export interface Project {
  readonly name: string
  /** Gitea `owner/name`. */
  readonly repo: string
  readonly defaultBranch: string
  /** Promotion endpoints, when configured; otherwise Kiln asks the fleet which hosts run the app. */
  readonly targets: ReadonlyArray<string> | null
  /** Secrets steps may be granted: name to a file the controller can read. */
  readonly secrets: { readonly [name: string]: string }
}

/**
 * Every repository of an allowed owner that carries `.kiln/ci.ts` is a project; configuration only adds
 * overrides (another name, fixed targets, secrets). Enrolled projects are kept, so their history stays.
 */
export class Projects extends Context.Service<Projects, {
  readonly get: (name: string) => Project | undefined
  readonly all: () => ReadonlyArray<Project>
  /** The project of a repository, enrolling it if its owner is allowed. */
  readonly byRepo: (repo: string, defaultBranch?: string) => Effect.Effect<Project | undefined>
}>()("kiln/controller/Projects") {}

export const layer = Layer.effect(Projects)(Effect.gen(function*() {
  const config = yield* Config
  const gitea = yield* Gitea
  const sql = yield* SqlClient.SqlClient
  const projects = new Map<string, Project>()
  const add = (project: Project) => projects.set(project.name, project)

  const stored = yield* sql<{ name: string; repo: string; default_branch: string }>`select * from projects`.pipe(Effect.orDie)
  for (const row of stored) add({ name: row.name, repo: row.repo, defaultBranch: row.default_branch, targets: null, secrets: {} })
  const branchFromRepo = new Set<string>()
  for (const [name, p] of Object.entries(config.projects)) {
    if (p.defaultBranch === undefined) branchFromRepo.add(name)
    add({ name, repo: p.repo, defaultBranch: p.defaultBranch ?? "main", targets: p.targets ?? null, secrets: p.secrets ?? {} })
  }

  const find = (repo: string) => [...projects.values()].find((p) => p.repo.toLowerCase() === repo.toLowerCase())

  const byRepo = (repo: string, defaultBranch?: string) =>
    Effect.gen(function*() {
      const known = find(repo)
      if (known !== undefined) return known
      const [owner, name] = repo.split("/")
      if (owner === undefined || name === undefined || !config.owners.includes(owner)) return undefined
      const project: Project = { name: name.toLowerCase(), repo, defaultBranch: defaultBranch ?? "main", targets: null, secrets: {} }
      if (projects.has(project.name)) return undefined
      yield* sql`insert into projects (name, repo, default_branch, created_at)
        values (${project.name}, ${repo}, ${project.defaultBranch}, ${Date.now()}) on conflict do nothing`.pipe(Effect.orDie)
      add(project)
      yield* Effect.logInfo(`enrolled ${repo} as ${project.name}`)
      return project
    })

  // Webhooks enroll a repository on its next push; this finds the ones that carry ci.ts already.
  yield* Effect.forEach(config.owners, (owner) =>
    gitea.repos(owner).pipe(
      Effect.flatMap(Effect.forEach(({ repo, defaultBranch }) => {
        const known = find(repo)
        if (known !== undefined) {
          if (branchFromRepo.has(known.name)) add({ ...known, defaultBranch })
          return Effect.void
        }
        return gitea.hasFile(repo, defaultBranch, ".kiln/ci.ts").pipe(
          Effect.flatMap((has) => (has ? byRepo(repo, defaultBranch) : Effect.void)),
        )
      }, { concurrency: 4, discard: true })),
    ), { discard: true }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("scanning for projects failed", cause)),
    Effect.forkScoped,
  )

  return {
    get: (name) => projects.get(name),
    all: () => [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byRepo,
  }
}))
