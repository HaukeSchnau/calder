import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as Pipeline from "../Pipeline.ts"
import { Config } from "./Config.ts"
import { Gitea } from "./Gitea.ts"

export interface Project {
  readonly name: string
  /** Gitea `owner/name`. */
  readonly repo: string
  readonly defaultBranch: string
  /** Promotion endpoints, when configured; otherwise Calder asks the fleet which hosts run the app. */
  readonly targets: ReadonlyArray<string> | null
  /** Secrets steps may be granted: name to a file the controller can read. */
  readonly secrets: { readonly [name: string]: string }
}

/**
 * Every repository of an allowed owner that carries `.calder/ci.ts` is a project; configuration only adds
 * overrides (another name, fixed targets, secrets). Enrolled projects that ran are kept, so their
 * history stays.
 */
export class Projects extends Context.Service<Projects, {
  readonly get: (name: string) => Project | undefined
  readonly all: () => ReadonlyArray<Project>
  /**
   * The project of a repository. One of an allowed owner is enrolled when the revision `sha` or its
   * default branch carries `.calder/ci.ts`.
   */
  readonly byRepo: (repo: string, at?: { readonly sha?: string | undefined; readonly defaultBranch?: string | undefined }) => Effect.Effect<Project | undefined>
}>()("calder/controller/Projects") {}


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

  const hasPipeline = (repo: string, ref: string) =>
    Pipeline.at((file) => gitea.hasFile(repo, ref, file)).pipe(Effect.map((dir) => dir !== undefined))

  const find = (repo: string) => [...projects.values()].find((p) => p.repo.toLowerCase() === repo.toLowerCase())

  const byRepo: Projects["Service"]["byRepo"] = (repo, at = {}) =>
    Effect.gen(function*() {
      const known = find(repo)
      if (known !== undefined) return known
      const [owner, name] = repo.split("/")
      if (owner === undefined || name === undefined || !config.owners.includes(owner)) return undefined
      const project: Project = { name: name.toLowerCase(), repo, defaultBranch: at.defaultBranch ?? "main", targets: null, secrets: {} }
      const carries = (at.sha !== undefined && (yield* hasPipeline(repo, at.sha))) ||
        (yield* hasPipeline(repo, project.defaultBranch))
      if (!carries) return undefined
      // Another event of the repository may have enrolled it meanwhile, or another repository has the name.
      if (projects.has(project.name)) return find(repo)
      yield* sql`insert into projects (name, repo, default_branch, created_at)
        values (${project.name}, ${repo}, ${project.defaultBranch}, ${Date.now()}) on conflict do nothing`.pipe(Effect.orDie)
      add(project)
      yield* Effect.logInfo(`enrolled ${repo} as ${project.name}`)
      return project
    })

  /** Drops an enrolled project that never ran and whose default branch carries no ci.ts. */
  const forget = (project: Project) =>
    Effect.gen(function*() {
      if (yield* hasPipeline(project.repo, project.defaultBranch)) return
      const ran = yield* sql`select 1 from runs where project = ${project.name} limit 1`
      if (ran.length > 0) return
      yield* sql`delete from projects where name = ${project.name}`
      projects.delete(project.name)
      yield* Effect.logInfo(`forgot ${project.repo}: it never ran and ${project.defaultBranch} has no .calder/ci.ts`)
    })

  // Webhooks enroll a repository on its next push; this finds the ones that carry ci.ts already.
  const scan = Effect.forEach(config.owners, (owner) =>
    gitea.repos(owner).pipe(
      Effect.flatMap(Effect.forEach(({ repo, defaultBranch }) => {
        const known = find(repo)
        if (known === undefined) return byRepo(repo, { defaultBranch })
        if (branchFromRepo.has(known.name)) add({ ...known, defaultBranch })
        return Effect.void
      }, { concurrency: 4, discard: true })),
    ), { discard: true })
  const enrolled = stored.flatMap((row) => (config.projects[row.name] === undefined ? [projects.get(row.name)!] : []))
  yield* Effect.forEach(enrolled, forget, { concurrency: 4, discard: true }).pipe(
    Effect.andThen(scan),
    Effect.catchCause((cause) => Effect.logWarning("scanning for projects failed", cause)),
    Effect.forkScoped,
  )

  return {
    get: (name) => projects.get(name),
    all: () => [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byRepo,
  }
}))
