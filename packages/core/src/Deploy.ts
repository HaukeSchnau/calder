import { Duration, Schema } from "effect";
import { Failure, Result } from "./Calder.ts";
import { make as makeStep, type Step } from "./Step.ts";

/** What a host deploy did: the system the host ran before and the one it runs now, which its probes passed on. */
export class Deployed extends Result<Deployed>("@calder-ci/core")(
  "Deployed",
  {
    host: Schema.String,
    previous: Schema.String,
    current: Schema.String,
    healthy: Schema.Boolean,
    /** Units the switch left failed that no probe names, which don't fail the deploy. */
    failedUnits: Schema.Array(Schema.String),
  },
  { render: "text", label: "deployed" },
) {}

/**
 * A host deploy that didn't leave the host on its system: the switch failed or a probe did, and the host
 * went back to `previous`. `current` is what it runs now, `previous` again unless going back failed too.
 */
export class DeployFailed extends Failure<DeployFailed>("@calder-ci/core")("DeployFailed", {
  host: Schema.String,
  previous: Schema.String,
  current: Schema.String,
  reason: Schema.String,
  /** Whether the host went back to `previous`; false when it never left it or going back failed. */
  rolledBack: Schema.Boolean,
}) {
  override get message() {
    return this.rolledBack
      ? `${this.reason}; ${this.host} went back to ${this.previous}`
      : `${this.reason}; ${this.host} runs ${this.current}`;
  }
}

export interface Options {
  /** The host, by the name its agent deploys it under (`calder agent --deploys <host>`). */
  readonly host: string;
  /** The build of the host's system, such as a NixOS toplevel: its output is what the host switches to. */
  readonly system: Step<string, any, any, any>;
  /**
   * What the host must show after its switch, or it goes back to the system it ran: units that are
   * active (systemd hosts) and URLs that answer 2xx, all within `within` (3 minutes by default). A unit
   * the switch left failed that isn't a probe is reported in the value and fails nothing.
   */
  readonly probes?: {
    readonly units?: ReadonlyArray<string>;
    readonly urls?: ReadonlyArray<string>;
    readonly within?: Duration.Input;
  };
  /** Steps that must pass first, such as the checks. */
  readonly after?: ReadonlyArray<Step.Any>;
  /** Steps that must end first, whatever their outcome. */
  readonly afterEnded?: ReadonlyArray<Step.Any>;
  /** `deploy-<host>` by default. */
  readonly name?: string;
}

/**
 * Deploys a host from the default branch: the controller hands the step to the agent that deploys `host`,
 * and waits while that agent is away, such as on a host that sleeps, without waking it. The agent takes
 * the host's deploy lease, which every project's deploys of the host share (latest wins per step), puts the
 * system in the binary cache unless the host is the controller's, realises it with a garbage collector root,
 * switches through the host's switch command, runs the probes, and goes back to the system it ran when the
 * switch or a probe fails. A host that already runs the system only runs the probes. Trusted runs only.
 */
export const host = (options: Options): Step<Deployed, DeployFailed> =>
  makeStep("deploy", options.name ?? `deploy-${options.host}`, {
    _tag: "Deploy",
    host: options.host,
    system: options.system,
    probes: {
      units: options.probes?.units ?? [],
      urls: options.probes?.urls ?? [],
      within: Duration.fromInputUnsafe(options.probes?.within ?? "3 minutes"),
    },
    after: options.after ?? [],
    afterEnded: options.afterEnded ?? [],
  }) as Step<Deployed, DeployFailed>;
