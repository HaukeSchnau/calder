import { Context, Effect, Layer, Schema } from "effect"
import { readFileSync } from "node:fs"

/** Overrides for a project; every repository of an allowed owner is a project without any. */
export const ProjectConfig = Schema.Struct({
  /** Gitea `owner/name`. */
  repo: Schema.String,
  defaultBranch: Schema.optional(Schema.String),
  /** Promotion endpoints in deploy order, instead of asking the fleet which hosts run the app. */
  targets: Schema.optional(Schema.Array(Schema.String)),
  /** Secrets steps of this project may be granted: name to a file the controller can read. */
  secrets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
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
  /** The fleet's binary cache, which the hosts substitute from. */
  cache: Schema.Struct({
    /** Its substituter URL. A narinfo there means the path was built before. */
    url: Schema.String,
    /**
     * argv that copies store paths, appended, into the cache. `--pin <name>` before the path also keeps it as
     * that name's release. Null when this controller only reads the cache.
     */
    publish: Schema.NullOr(Schema.Array(Schema.String)),
  }),
  /** This controller's host, as the fleet's promotion endpoints name it. */
  host: Schema.String,
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
  /** Gitea owners whose repositories are enrolled when they carry `.kiln/ci.ts`. */
  owners: Schema.Array(Schema.String),
  /** The hosts' promotion endpoints, in deploy order. Kiln asks each which apps it runs. */
  fleet: Schema.Array(Schema.String),
  /**
   * Sandboxed workers reach the network only through the controller's egress proxy: hosts in `allow`
   * (`*.example.org` for subdomains) on public addresses, plus `allowPrivate` hosts on private ones.
   */
  egress: Schema.NullOr(Schema.Struct({ allow: Schema.Array(Schema.String), allowPrivate: Schema.Array(Schema.String) })),
  /** Agents on other hosts authenticate with the secret in this file. Without it none may connect. */
  agents: Schema.NullOr(Schema.Struct({ tokenFile: Schema.String })),
  projects: Schema.Record(Schema.String, ProjectConfig),
})
export type ConfigShape = typeof ConfigSchema.Type

export class Config extends Context.Service<Config, ConfigShape & {
  readonly giteaToken: string
  readonly webhookSecret: string
  readonly promotionToken: string
}>()("kiln/controller/Config") {}

const readSecret = (path: string) => readFileSync(path, "utf8").trim()

export const fromFile = (path: string) =>
  Layer.effect(Config)(Effect.gen(function*() {
    const config = yield* Schema.decodeUnknownEffect(ConfigSchema)(JSON.parse(readFileSync(path, "utf8")))
    return {
      ...config,
      giteaToken: readSecret(config.gitea.tokenFile),
      webhookSecret: readSecret(config.gitea.webhookSecretFile),
      promotionToken: readSecret(config.promotion.tokenFile),
    }
  }))
