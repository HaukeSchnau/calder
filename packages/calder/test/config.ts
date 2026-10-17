import { Layer } from "effect"
import { Config } from "../src/controller/Config.ts"

/** A controller configuration in which nothing a test doesn't set is reachable. */
export const config = (overrides: Partial<Config["Service"]> = {}) =>
  Layer.succeed(Config)({
    listen: { host: "127.0.0.1", port: 0 },
    publicUrl: "http://calder.test",
    stateDir: "/nonexistent/state",
    runtimeDir: "/nonexistent/run",
    sdk: "/nonexistent/sdk",
    ui: null,
    workerCommand: [],
    system: "x86_64-linux",
    gitea: { url: "http://gitea.test", tokenFile: "", webhookSecretFile: "" },
    promotion: { tokenFile: "" },
    cache: { url: "http://cache.test", publish: null },
    host: "test",
    telemetry: { otlp: null, victoriaLogs: null, tempo: null },
    jobs: { mode: "process", slots: { plans: 1, builds: 1, tasks: 1, actions: 1 } },
    owners: [],
    fleet: [],
    egress: null,
    agents: null,
    projects: {},
    retention: { days: 30 },
    giteaToken: "",
    webhookSecret: "",
    promotionToken: "",
    ...overrides,
  })
