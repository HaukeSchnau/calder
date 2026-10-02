import { Context, Effect, Layer, Schema } from "effect"
import { readFileSync } from "node:fs"

export const ProjectConfig = Schema.Struct({
  /** Gitea `owner/name`. */
  repo: Schema.String,
  defaultBranch: Schema.String,
  /** Promotion endpoints of the hosts that run the project's release, in deploy order. */
  targets: Schema.Array(Schema.String),
  /** Secrets steps of this project may be granted: name to a file the controller can read. */
  secrets: Schema.Record(Schema.String, Schema.String),
})
export type ProjectConfig = typeof ProjectConfig.Type

export const ConfigSchema = Schema.Struct({
  listen: Schema.Struct({ host: Schema.String, port: Schema.Number }),
  /** Where people open the UI; used in commit status links. */
  publicUrl: Schema.String,
  stateDir: Schema.String,
  runtimeDir: Schema.String,
  /** The `node_modules` that each revision's `.kiln/node_modules` links to. */
  sdk: Schema.String,
  /** The built web UI, served at `/`. */
  ui: Schema.NullOr(Schema.String),
  /** argv that starts a worker in process mode, before the job id. */
  workerCommand: Schema.Array(Schema.String),
  system: Schema.String,
  gitea: Schema.Struct({ url: Schema.String, tokenFile: Schema.String, webhookSecretFile: Schema.String }),
  promotion: Schema.Struct({ tokenFile: Schema.String }),
  cacheUrl: Schema.String,
  telemetry: Schema.Struct({
    otlp: Schema.NullOr(Schema.String),
    victoriaLogs: Schema.NullOr(Schema.String),
    tempo: Schema.NullOr(Schema.String),
  }),
  jobs: Schema.Struct({
    /** systemd: template units per pool with their own users. process: child processes, for development. */
    mode: Schema.Literals(["systemd", "process"]),
    slots: Schema.Struct({ plans: Schema.Number, builds: Schema.Number, tasks: Schema.Number, actions: Schema.Number }),
  }),
  projects: Schema.Record(Schema.String, ProjectConfig),
})
export type ConfigShape = typeof ConfigSchema.Type

export class Config extends Context.Service<Config, ConfigShape & {
  readonly giteaToken: string
  readonly webhookSecret: string
  readonly promotionToken: string
  readonly projectByRepo: (repo: string) => readonly [string, ProjectConfig] | undefined
}>()("kiln/controller/Config") {}

const readSecret = (path: string) => readFileSync(path, "utf8").trim()

export const fromFile = (path: string) =>
  Layer.effect(Config)(Effect.gen(function*() {
    const config = yield* Schema.decodeUnknownEffect(ConfigSchema)(JSON.parse(readFileSync(path, "utf8")))
    const byRepo = new Map(Object.entries(config.projects).map(([name, p]) => [p.repo.toLowerCase(), [name, p] as const]))
    return {
      ...config,
      giteaToken: readSecret(config.gitea.tokenFile),
      webhookSecret: readSecret(config.gitea.webhookSecretFile),
      promotionToken: readSecret(config.promotion.tokenFile),
      projectByRepo: (repo: string) => byRepo.get(repo.toLowerCase()),
    }
  }))
