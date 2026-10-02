/**
 * What the controller and its workers say to each other. Workers run user code (planning, tasks,
 * actions) as unprivileged users in systemd units; they call the controller over a unix socket and
 * authenticate every call with their job's token.
 */
import { Domain } from "@kiln/api"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const Reuse = Schema.Literals(["all", "builds", "none"])

export const PlannedStep = Schema.Struct({
  name: Schema.String,
  kind: Domain.StepKind,
  needs: Schema.Array(Schema.String),
  exits: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
  required: Schema.Array(Schema.String),
  target: Schema.Boolean,
  neverReuse: Schema.Boolean,
  /** What it runs, for people: the attribute, the command or the action. */
  detail: Schema.String,
  build: Schema.NullOr(Schema.Struct({ attr: Schema.String })),
  task: Schema.NullOr(Schema.Struct({
    /** The dev shell's attribute path, or null for the host's PATH. */
    shell: Schema.NullOr(Schema.String),
    /** Hash of everything but the values the command interpolates. */
    keyBase: Schema.String,
    inputs: Schema.Array(Schema.String),
    interpolates: Schema.Array(Schema.String),
    shards: Schema.NullOr(Schema.Number),
    outputs: Schema.Array(Schema.String),
    secrets: Schema.Array(Schema.String),
    platform: Schema.NullOr(Schema.String),
  })),
  action: Schema.NullOr(Schema.Struct({ deploy: Schema.Boolean, secrets: Schema.Array(Schema.String) })),
  output: Schema.NullOr(Schema.Struct({ task: Schema.String, output: Schema.String })),
})
export type PlannedStep = typeof PlannedStep.Type

export const PlanSpec = Schema.Struct({
  version: Schema.Literal(1),
  trust: Domain.Trust,
  reuse: Reuse,
  schedules: Schema.Array(Schema.String),
  steps: Schema.Array(PlannedStep),
})
export type PlanSpec = typeof PlanSpec.Type

export const RunInfo = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  number: Schema.Number,
  revision: Schema.String,
  branch: Schema.NullOr(Schema.String),
  trust: Domain.Trust,
  event: Domain.Event,
  /** `git+file:` URL of the revision in the controller's mirror. */
  flake: Schema.String,
  /** The bare mirror, for tree ids and file listings. */
  mirror: Schema.String,
  /** The revision's `.kiln/` directory, extracted, with `node_modules` linked to Kiln's SDK. */
  kilnDir: Schema.String,
  system: Schema.String,
})
export type RunInfo = typeof RunInfo.Type

/** An earlier step's outcome as JSON. Values of `Kiln.Result` classes carry their class id in `$kiln`. */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Passed", { value: Schema.Unknown }),
  Schema.TaggedStruct("Failed", { error: Schema.Unknown }),
  Schema.TaggedStruct("Died", { message: Schema.String }),
  Schema.TaggedStruct("Blocked", {}),
])
export type Outcome = typeof Outcome.Type

export const PlanJob = Schema.TaggedStruct("Plan", {
  run: RunInfo,
  requiredChecks: Schema.Array(Schema.String),
})

export const StepJob = Schema.TaggedStruct("Step", {
  run: RunInfo,
  step: Schema.String,
  shard: Schema.NullOr(Schema.Struct({ index: Schema.Number, count: Schema.Number })),
  attempt: Schema.Number,
  /** Persistent checkout for tasks. */
  workspace: Schema.NullOr(Schema.String),
  /** Outcomes of the steps the step depends on, by name. */
  inputs: Schema.Record(Schema.String, Outcome),
  /** Granted secrets: name to value. Only trusted runs get any. */
  secrets: Schema.Record(Schema.String, Schema.String),
})

export const Job = Schema.Union([PlanJob, StepJob])
export type Job = typeof Job.Type

export const NixActivity = Schema.Struct({
  id: Schema.Number,
  parent: Schema.Number,
  /** build, substitute, copy, download, eval, other. */
  type: Schema.String,
  text: Schema.String,
  drv: Schema.NullOr(Schema.String),
  start: Schema.Number,
  end: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
})
export type NixActivity = typeof NixActivity.Type

export const TestResult = Schema.Struct({
  suite: Schema.String,
  name: Schema.String,
  file: Schema.NullOr(Schema.String),
  status: Schema.Literals(["passed", "failed", "skipped", "timeout"]),
  durationMs: Schema.Number,
  message: Schema.NullOr(Schema.String),
})

export const JobEvent = Schema.Union([
  Schema.TaggedStruct("Log", {
    stream: Schema.Literals(["stdout", "stderr", "kiln"]),
    text: Schema.String,
    timestamp: Schema.Number,
  }),
  Schema.TaggedStruct("Activity", { activity: NixActivity }),
  Schema.TaggedStruct("Tests", { results: Schema.Array(TestResult) }),
  /** The task's final key, once interpolated values are known. */
  Schema.TaggedStruct("Key", { key: Schema.String }),
  Schema.TaggedStruct("Attempt", { attempt: Schema.Number, reason: Schema.String }),
])
export type JobEvent = typeof JobEvent.Type

export const JobResult = Schema.Union([
  Schema.TaggedStruct("Planned", { plan: PlanSpec }),
  Schema.TaggedStruct("PlanFailed", { message: Schema.String }),
  Schema.TaggedStruct("Passed", {
    value: Schema.Unknown,
    /** For tasks with outputs: output name to store path. */
    outputs: Schema.Record(Schema.String, Schema.String),
    /** Builds: the derivation, the step's key. */
    key: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Failed", {
    error: Schema.Unknown,
    tag: Schema.String,
    message: Schema.String,
    key: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Died", { message: Schema.String }),
])
export type JobResult = typeof JobResult.Type

export class Unauthorized extends Schema.TaggedError<Unauthorized>("kiln/Unauthorized")("Unauthorized", {
  reason: Schema.String,
}) {}

export class FleetBusy extends Schema.TaggedError<FleetBusy>("kiln/FleetBusy")("FleetBusy", { target: Schema.String }) {}

export class FleetRejected extends Schema.TaggedError<FleetRejected>("kiln/FleetRejected")("FleetRejected", {
  target: Schema.String,
  status: Schema.Number,
  reason: Schema.String,
}) {}

const auth = { job: Schema.String, token: Schema.String }

export class WorkerRpcs extends RpcGroup.make(
  Rpc.make("job", { payload: auth, success: Job, error: Unauthorized }),
  Rpc.make("events", { payload: { ...auth, events: Schema.Array(JobEvent) }, error: Unauthorized }),
  Rpc.make("finish", { payload: { ...auth, result: JobResult }, error: Unauthorized }),
  Rpc.make("gitHead", { payload: { ...auth, branch: Schema.String }, success: Schema.String, error: Unauthorized }),
  Rpc.make("giteaDispatch", {
    payload: {
      ...auth,
      workflow: Schema.String,
      ref: Schema.NullOr(Schema.String),
      inputs: Schema.Record(Schema.String, Schema.String),
    },
    error: Unauthorized,
  }),
  Rpc.make("atticPush", { payload: { ...auth, path: Schema.String }, error: Unauthorized }),
  Rpc.make("pullRequestComment", { payload: { ...auth, markdown: Schema.String }, error: Unauthorized }),
  Rpc.make("fleetAcquire", {
    payload: { ...auth, project: Schema.String },
    success: Schema.Union([
      Schema.TaggedStruct("Held", { fence: Schema.Number, targets: Schema.Array(Schema.String) }),
      Schema.TaggedStruct("Replaced", {}),
    ]),
    error: Unauthorized,
  }),
  Rpc.make("fleetRelease", { payload: auth, error: Unauthorized }),
  Rpc.make("fleetPreflight", {
    payload: { ...auth, target: Schema.String, descriptor: Schema.Unknown },
    error: Schema.Union([Unauthorized, FleetRejected]),
  }),
  Rpc.make("fleetDeploy", {
    payload: { ...auth, target: Schema.String, revision: Schema.String, storePath: Schema.String },
    error: Schema.Union([Unauthorized, FleetBusy, FleetRejected]),
  }),
) {}
