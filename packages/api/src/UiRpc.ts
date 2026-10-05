import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Change, DeploymentRecord, LogEntry, Metrics, Overview, Run, RunDetail, Span, StepStats, TestResult } from "./Domain.ts"

export class NotFound extends Schema.TaggedError<NotFound>("@kiln/api/NotFound")("NotFound", {
  what: Schema.String,
}) {}

export class Refused extends Schema.TaggedError<Refused>("@kiln/api/Refused")("Refused", {
  reason: Schema.String,
}) {}

/** What the web UI asks the controller. Served over a WebSocket at `/rpc`. */
export class UiRpcs extends RpcGroup.make(
  Rpc.make("overview", { success: Overview }),
  /** Every change as it happens. The UI applies them to what it loaded. */
  Rpc.make("changes", { success: Change, stream: true }),
  Rpc.make("runs", {
    payload: {
      project: Schema.optional(Schema.String),
      /** Only runs of this pull request. */
      pullRequest: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
      /** Runs created before this time, for paging. */
      before: Schema.optional(Schema.Number),
    },
    /** `seq` is the last change included; apply only changes with a higher one. */
    success: Schema.Struct({ seq: Schema.Number, runs: Schema.Array(Run) }),
  }),
  Rpc.make("run", { payload: { id: Schema.String }, success: RunDetail, error: NotFound }),
  /**
   * History from VictoriaLogs, then live lines while the step runs. `limit` keeps the last lines of the
   * history (default 5000); `before` pages back from a line's `index`.
   */
  Rpc.make("logs", {
    payload: {
      runId: Schema.String,
      step: Schema.optional(Schema.String),
      follow: Schema.optional(Schema.Boolean),
      limit: Schema.optional(Schema.Number),
      before: Schema.optional(Schema.Number),
    },
    success: LogEntry,
    error: NotFound,
    stream: true,
  }),
  /** The run's trace from Tempo: steps, Nix builds, HTTP calls of deploys. */
  Rpc.make("trace", { payload: { runId: Schema.String }, success: Schema.Array(Span), error: NotFound }),
  Rpc.make("stepStats", { payload: { project: Schema.String, step: Schema.String }, success: StepStats }),
  /** Deploys Kiln made, newest first. */
  Rpc.make("deployments", {
    payload: { project: Schema.String, host: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) },
    success: Schema.Array(DeploymentRecord),
  }),
  Rpc.make("stepMetrics", { payload: { runId: Schema.String, step: Schema.String }, success: Metrics, error: NotFound }),
  Rpc.make("testHistory", {
    payload: { project: Schema.String, suite: Schema.String, name: Schema.String },
    success: Schema.Array(TestResult),
  }),
  /** Starts a run of the default branch head, or of a branch, with manual inputs. */
  Rpc.make("trigger", {
    payload: {
      project: Schema.String,
      branch: Schema.optional(Schema.String),
      inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    },
    success: Run,
    error: Schema.Union([NotFound, Refused]),
  }),
  /** Runs a working copy that `kiln check` pushed as `ref` (under `kiln/check/`) the way a pull request would. */
  Rpc.make("check", {
    payload: { repo: Schema.String, ref: Schema.String, sha: Schema.String },
    success: Run,
    error: Schema.Union([NotFound, Refused]),
  }),
  Rpc.make("cancel", { payload: { runId: Schema.String }, error: Schema.Union([NotFound, Refused]) }),
  /** Runs the same revision and event again. */
  Rpc.make("rerun", { payload: { runId: Schema.String }, success: Run, error: Schema.Union([NotFound, Refused]) }),
) {}
