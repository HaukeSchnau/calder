import { Schema } from "effect"

export const Trust = Schema.Literals(["pr", "trusted"])
export type Trust = typeof Trust.Type

export const RunStatus = Schema.Literals(["queued", "planning", "running", "passed", "failed", "cancelled", "errored"])
export type RunStatus = typeof RunStatus.Type

export const StepStatus = Schema.Literals([
  /** Waiting for the steps it depends on. */
  "pending",
  /** Ready, waiting for a slot. */
  "queued",
  "running",
  "passed",
  /** Passed earlier with the same key; this run reused the result. */
  "reused",
  "failed",
  /** Crashed or threw something that isn't a Kiln.Failure. */
  "died",
  /** A step it depends on didn't pass. */
  "blocked",
  "cancelled",
])
export type StepStatus = typeof StepStatus.Type

export const StepKind = Schema.Literals(["build", "task", "action", "output"])
export type StepKind = typeof StepKind.Type

export const Event = Schema.Union([
  Schema.TaggedStruct("PullRequest", { number: Schema.Number, base: Schema.String, head: Schema.String }),
  Schema.TaggedStruct("Push", { branch: Schema.String }),
  Schema.TaggedStruct("Schedule", { cron: Schema.String }),
  Schema.TaggedStruct("Manual", { inputs: Schema.Record(Schema.String, Schema.Unknown) }),
])
export type Event = typeof Event.Type

export const Commit = Schema.Struct({
  sha: Schema.String,
  /** jj change id from the commit's `change-id` header, when jj wrote it. */
  changeId: Schema.NullOr(Schema.String),
  title: Schema.String,
  author: Schema.String,
  timestamp: Schema.Number,
})
export type Commit = typeof Commit.Type

export const Run = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  /** Increments per project, for humans: "studienbuch #412". */
  number: Schema.Number,
  event: Event,
  commit: Commit,
  /** Pull request title, when the run is for one. */
  title: Schema.NullOr(Schema.String),
  trust: Trust,
  status: RunStatus,
  createdAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  /** Why the run errored before its steps could run, such as a plan error. */
  error: Schema.NullOr(Schema.String),
  traceId: Schema.NullOr(Schema.String),
  /** Counts by status, for lists. */
  counts: Schema.Record(Schema.String, Schema.Number),
})
export type Run = typeof Run.Type

/** A value a step produced, ready to show. */
export const Value = Schema.Struct({
  /** `Kiln.Result` class id such as `@kiln/std/Release/Live`, or null for plain data. */
  type: Schema.NullOr(Schema.String),
  render: Schema.NullOr(Schema.Literals(["link", "text"])),
  label: Schema.NullOr(Schema.String),
  /** Short text for the UI: a store path, a URL, a tag and its fields. */
  text: Schema.String,
  json: Schema.Unknown,
})
export type Value = typeof Value.Type

export const StepError = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  /** The last lines of output before the failure. */
  excerpt: Schema.String,
})
export type StepError = typeof StepError.Type

export const StepRun = Schema.Struct({
  runId: Schema.String,
  name: Schema.String,
  kind: StepKind,
  status: StepStatus,
  /** Content key: same key means same inputs, so same color in the UI. Builds use the derivation. */
  key: Schema.NullOr(Schema.String),
  /** The run whose result was reused. */
  reusedFrom: Schema.NullOr(Schema.String),
  needs: Schema.Array(Schema.String),
  exits: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
  /** Required checks that `after` gained from branch protection. */
  required: Schema.Array(Schema.String),
  target: Schema.Boolean,
  /** An action with `grants: { deploy: true }`: the step behind a rollout. */
  deploys: Schema.Boolean,
  /** What it runs: the flake attribute, the command, or the action name. */
  detail: Schema.String,
  queuedAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  attempts: Schema.Number,
  shards: Schema.NullOr(Schema.Number),
  value: Schema.NullOr(Value),
  error: Schema.NullOr(StepError),
  cpuSeconds: Schema.NullOr(Schema.Number),
  memoryPeakBytes: Schema.NullOr(Schema.Number),
  spanId: Schema.NullOr(Schema.String),
  tests: Schema.NullOr(Schema.Struct({ passed: Schema.Number, failed: Schema.Number, skipped: Schema.Number })),
})
export type StepRun = typeof StepRun.Type

export const TestResult = Schema.Struct({
  runId: Schema.String,
  step: Schema.String,
  suite: Schema.String,
  name: Schema.String,
  file: Schema.NullOr(Schema.String),
  status: Schema.Literals(["passed", "failed", "skipped", "timeout"]),
  durationMs: Schema.Number,
  message: Schema.NullOr(Schema.String),
  /** Passed and failed on the same key in recent runs. */
  flaky: Schema.Boolean,
})
export type TestResult = typeof TestResult.Type

export const RunDetail = Schema.Struct({
  run: Run,
  steps: Schema.Array(StepRun),
  /** Failing tests of this run, with flakiness from history. */
  failingTests: Schema.Array(TestResult),
  /** Other runs of the same change or pull request, newest first. */
  siblings: Schema.Array(Run),
})
export type RunDetail = typeof RunDetail.Type

export const LogLine = Schema.Struct({
  step: Schema.String,
  /** Shard number for sharded tasks. */
  shard: Schema.NullOr(Schema.Number),
  stream: Schema.Literals(["stdout", "stderr", "kiln"]),
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  timestamp: Schema.Number,
  text: Schema.String,
})
export type LogLine = typeof LogLine.Type

export const Span = Schema.Struct({
  spanId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  /** Unix ms. */
  start: Schema.Number,
  end: Schema.Number,
  status: Schema.Literals(["ok", "error", "unset"]),
  attributes: Schema.Record(Schema.String, Schema.String),
})
export type Span = typeof Span.Type

export const Deployment = Schema.Struct({
  project: Schema.String,
  host: Schema.String,
  revision: Schema.NullOr(Schema.String),
  storePath: Schema.NullOr(Schema.String),
  /** The revision the host was asked for but hasn't activated, such as an incompatible release. */
  pending: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.Number),
  healthy: Schema.NullOr(Schema.Boolean),
  url: Schema.NullOr(Schema.String),
  /** The run deploying here right now. */
  deployingRun: Schema.NullOr(Schema.String),
})
export type Deployment = typeof Deployment.Type

export const Project = Schema.Struct({
  name: Schema.String,
  repo: Schema.String,
  defaultBranch: Schema.String,
  /** Latest run on the default branch. */
  main: Schema.NullOr(Run),
  deployments: Schema.Array(Deployment),
  /** The last 20 runs on the default branch, oldest first, for sparklines. */
  history: Schema.Array(Schema.Struct({ id: Schema.String, status: RunStatus, durationMs: Schema.NullOr(Schema.Number) })),
})
export type Project = typeof Project.Type

export const Overview = Schema.Struct({
  projects: Schema.Array(Project),
  /** Runs that are queued, planning or running. */
  active: Schema.Array(Run),
  /** Recent runs across projects, newest first. */
  recent: Schema.Array(Run),
  /** Slot use right now. */
  slots: Schema.Struct({ tasks: Schema.Number, tasksMax: Schema.Number, builds: Schema.Number, buildsMax: Schema.Number }),
})
export type Overview = typeof Overview.Type

export const StepStats = Schema.Struct({
  project: Schema.String,
  step: Schema.String,
  /** Recent executions, oldest first. */
  samples: Schema.Array(Schema.Struct({
    runId: Schema.String,
    status: StepStatus,
    durationMs: Schema.NullOr(Schema.Number),
    queueMs: Schema.NullOr(Schema.Number),
    reused: Schema.Boolean,
    finishedAt: Schema.Number,
  })),
})
export type StepStats = typeof StepStats.Type

export const Metrics = Schema.Struct({
  /** Samples of a running step's cgroup, oldest first. */
  samples: Schema.Array(Schema.Struct({
    timestamp: Schema.Number,
    cpuPercent: Schema.Number,
    memoryBytes: Schema.Number,
  })),
})
export type Metrics = typeof Metrics.Type

/** Pushed to UI subscribers whenever something changes. */
export const Change = Schema.Union([
  Schema.TaggedStruct("RunChanged", { run: Run }),
  Schema.TaggedStruct("StepChanged", { step: StepRun }),
  Schema.TaggedStruct("DeploymentChanged", { deployment: Deployment }),
])
export type Change = typeof Change.Type
