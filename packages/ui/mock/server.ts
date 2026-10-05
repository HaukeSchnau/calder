// A stand-in controller for UI work: implements `UiRpcs` over the same WebSocket transport the
// real controller uses, on deterministic fake data from ./scenario.ts.
//
//   bun mock/server.ts                       listens on 127.0.0.1:8791 (KILN_MOCK_PORT overrides)
//   KILN_MOCK_M1=offline bun mock/server.ts  the m1 agent is gone and t3code's testflight waits for it

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { type Domain, NotFound, Refused, UiRpcs } from "@kiln/api"
import { Effect, Layer, PubSub, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import {
  DARWIN, PROJECTS, World, deployRecords, deployments, logLines, metrics, runStatus, stepState, testResults, toRun, toStep, trace,
  type SimRun, type SimStep,
} from "./scenario.ts"

const port = Number(process.env["KILN_MOCK_PORT"] ?? 8791)
const m1 = process.env["KILN_MOCK_M1"] === "offline" ? "offline" : "online"

const terminal = new Set<Domain.StepStatus>(["passed", "reused", "failed", "died", "blocked", "cancelled"])
const isActive = (status: Domain.RunStatus) => status === "queued" || status === "planning" || status === "running"

function overview(world: World, now: number, seq: number): Domain.Overview {
  const visible = world.runs.filter((r) => r.createdAt <= now)
  const deps = deployments(world, now)
  const running = visible.flatMap((r) => r.steps.filter((s) => stepState(r, s, now).status === "running"))
  return {
    seq,
    projects: PROJECTS.map((name) => {
      const mains = visible.filter((r) => r.project === name && r.event._tag === "Push")
      const main = mains.at(-1)
      return {
        name,
        repo: `schnau/${name}`,
        defaultBranch: "main",
        main: main ? toRun(main, now) : null,
        deployments: deps.filter((d) => d.project === name),
        history: mains.slice(-20).map((r) => {
          const run = toRun(r, now)
          return { id: r.id, status: run.status, durationMs: run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : null }
        }),
      }
    }),
    active: visible.filter((r) => isActive(runStatus(r, now))).reverse().map((r) => toRun(r, now)),
    recent: visible.slice(-40).reverse().map((r) => toRun(r, now)),
    slots: {
      tasks: running.filter((s) => s.plan.kind === "task" && s.plan.platform === undefined).length,
      tasksMax: 6,
      builds: running.filter((s) => s.plan.kind === "build").length,
      buildsMax: 3,
    },
    agents: [{ name: "m1", platform: DARWIN, slots: 2, running: running.filter((s) => s.plan.platform === DARWIN).length, connected: world.agentGoneAt === null }],
  }
}

const failing = (run: SimRun, s: SimStep, now: number) => {
  const st = stepState(run, s, now).status
  return st === "failed" || st === "died" ? testResults(run, s).filter((t) => t.status === "failed" || t.status === "timeout") : []
}

function detail(world: World, run: SimRun, now: number, seq: number): Domain.RunDetail {
  const failingTests = run.steps.flatMap((s) => failing(run, s, now))
  const pr = run.event._tag === "PullRequest" ? run.event.number : null
  const siblings = world.runs
    .filter((r) => r !== run && r.project === run.project && r.createdAt <= now)
    .filter((r) => (pr !== null && r.event._tag === "PullRequest" && r.event.number === pr) || (run.commit.changeId !== null && r.commit.changeId === run.commit.changeId))
    .reverse()
    .map((r) => toRun(r, now))
  return { seq, run: toRun(run, now), steps: run.steps.map((s) => toStep(world, run, s, now)), failingTests, siblings }
}

const entries = (lines: ReadonlyArray<Domain.LogLine>, from: number): Array<Domain.LogEntry> => lines.map((l, i) => ({ ...l, index: from + i }))

/** Lines only ever get appended, so a follower remembers how many it has sent and keeps numbering from there. */
function follow(run: SimRun, steps: ReadonlyArray<SimStep>, sent: number): Stream.Stream<Domain.LogEntry> {
  const lines = (now: number) => steps.flatMap((s) => logLines(run, s, now)).sort((a, b) => a.timestamp - b.timestamp)
  const done = (now: number) => steps.every((s) => terminal.has(stepState(run, s, now).status))
  return Stream.suspend(() => {
    let n = sent
    return Stream.tick("400 millis").pipe(
      Stream.map(() => {
        const now = Date.now()
        const all = lines(now)
        const fresh = entries(all.slice(n), n)
        n = all.length
        return { fresh, finished: done(now) }
      }),
      Stream.takeUntil((batch) => batch.finished),
      Stream.flatMap((batch) => Stream.fromIterable(batch.fresh)),
    )
  })
}

const Handlers = UiRpcs.toLayer(Effect.gen(function*() {
  const world = new World(Date.now(), m1)
  const changes = yield* PubSub.unbounded<Domain.Change>()
  const seen = new Map<string, string>()
  const recorded = new Set<string>()
  let seq = 0

  /**
   * Publishes what changed since the last call, each change with the next seq, and returns the seq a
   * snapshot taken at `now` includes. Publishing is synchronous, so changes go out in seq order.
   */
  const sync = (now: number): number => {
    const publish = (change: Domain.Change) => PubSub.publishUnsafe(changes, change)
    const changed = (key: string, value: unknown) => {
      const json = JSON.stringify(value)
      if (seen.get(key) === json) return false
      seen.set(key, json)
      return true
    }
    for (const r of world.runs) {
      if (r.createdAt > now) continue
      const settledAt = Math.max(r.finishedAt, r.cancelledAt ?? 0)
      if (now - settledAt > 5000 && seen.has(`run:${r.id}`)) continue
      for (const s of r.steps) {
        const step = toStep(world, r, s, now)
        if (changed(`step:${r.id}:${s.plan.name}`, step)) publish({ _tag: "StepChanged", seq: ++seq, step, failingTests: failing(r, s, now) })
      }
      const run = toRun(r, now)
      if (changed(`run:${r.id}`, run)) publish({ _tag: "RunChanged", seq: ++seq, run })
    }
    for (const deployment of deployments(world, now)) {
      if (changed(`dep:${deployment.project}:${deployment.host}`, deployment)) publish({ _tag: "DeploymentChanged", seq: ++seq, deployment })
    }
    for (const record of deployRecords(world, now).reverse()) {
      const key = `${record.runId}:${record.host}:${record.at}`
      if (recorded.has(key)) continue
      recorded.add(key)
      publish({ _tag: "DeploymentRecorded", seq: ++seq, record })
    }
    return seq
  }

  sync(Date.now())
  yield* Effect.sleep("500 millis").pipe(
    Effect.andThen(Effect.sync(() => sync(Date.now()))),
    Effect.forever,
    Effect.forkScoped,
  )

  const findRun = (id: string): Effect.Effect<SimRun, NotFound> => {
    const run = world.run(id)
    return run && run.createdAt <= Date.now() ? Effect.succeed(run) : Effect.fail(new NotFound({ what: `run ${id}` }))
  }
  const findStep = (run: SimRun, name: string): Effect.Effect<SimStep, NotFound> => {
    const step = run.steps.find((s) => s.plan.name === name)
    return step ? Effect.succeed(step) : Effect.fail(new NotFound({ what: `step ${name} in run ${run.id}` }))
  }

  return UiRpcs.of({
    overview: () => Effect.sync(() => {
      const now = Date.now()
      return overview(world, now, sync(now))
    }),
    changes: () => Stream.fromPubSub(changes),
    runs: ({ project, pullRequest, limit, before }) =>
      Effect.sync(() => {
        const now = Date.now()
        const runs = world.runs
          .filter((r) => r.createdAt <= now && (project === undefined || r.project === project))
          .filter((r) => pullRequest === undefined || (r.event._tag === "PullRequest" && r.event.number === pullRequest))
          .filter((r) => before === undefined || r.createdAt < before)
          .reverse()
          .slice(0, limit ?? 50)
          .map((r) => toRun(r, now))
        return { seq: sync(now), runs }
      }),
    run: ({ id }) =>
      findRun(id).pipe(Effect.map((run) => {
        const now = Date.now()
        return detail(world, run, now, sync(now))
      })),
    logs: ({ runId, step, follow: live, limit, before }) =>
      Stream.unwrap(Effect.gen(function*() {
        const run = yield* findRun(runId)
        const steps = step === undefined ? run.steps : [yield* findStep(run, step)]
        const now = Date.now()
        const all = steps.flatMap((s) => logLines(run, s, now)).sort((a, b) => a.timestamp - b.timestamp)
        const end = before ?? all.length
        const from = Math.max(0, end - (limit ?? 5000))
        const finished = steps.every((s) => terminal.has(stepState(run, s, now).status))
        const head = Stream.fromIterable(entries(all.slice(from, end), from))
        return live && before === undefined && !finished ? Stream.concat(head, follow(run, steps, all.length)) : head
      })),
    deployments: ({ project, host, limit }) =>
      Effect.sync(() => deployRecords(world, Date.now()).filter((d) => d.project === project && (host === undefined || d.host === host)).slice(0, limit ?? 50)),
    trace: ({ runId }) => findRun(runId).pipe(Effect.map((run) => trace(run, Date.now()))),
    stepStats: ({ project, step }) =>
      Effect.sync(() => {
        const now = Date.now()
        const samples = world.runs
          .filter((r) => r.project === project && r.createdAt <= now)
          .flatMap((r) => r.steps.filter((s) => s.plan.name === step).map((s) => ({ r, s, st: stepState(r, s, now) })))
          .filter(({ st }) => st.status === "passed" || st.status === "failed" || st.status === "died" || st.status === "reused")
          .map(({ r, s, st }) => ({
            runId: r.id,
            status: st.status,
            durationMs: st.status === "reused" || st.startedAt === null || st.finishedAt === null ? null : st.finishedAt - st.startedAt,
            queueMs: st.queuedAt !== null && st.startedAt !== null ? st.startedAt - st.queuedAt : null,
            reused: st.status === "reused",
            finishedAt: st.finishedAt ?? s.finishedAt,
          }))
          .sort((a, b) => a.finishedAt - b.finishedAt)
          .slice(-30)
        return { project, step, samples }
      }),
    stepMetrics: ({ runId, step }) =>
      Effect.gen(function*() {
        const run = yield* findRun(runId)
        return metrics(run, yield* findStep(run, step), Date.now())
      }),
    testHistory: ({ project, suite, name }) =>
      Effect.sync(() => {
        const now = Date.now()
        return world.runs
          .filter((r) => r.project === project && r.createdAt <= now)
          .flatMap((r) => r.steps.filter((s) => terminal.has(stepState(r, s, now).status)).flatMap((s) => testResults(r, s)))
          .filter((t) => t.suite === suite && t.name === name)
          .slice(-20)
      }),
    trigger: ({ project, inputs }) =>
      PROJECTS.some((p) => p === project)
        ? Effect.sync(() => { const now = Date.now(); return toRun(world.trigger(project, now, inputs), now) })
        : Effect.fail(new NotFound({ what: `project ${project}` })),
    cancel: ({ runId }) =>
      findRun(runId).pipe(Effect.flatMap((run) => {
        const now = Date.now()
        const status = runStatus(run, now)
        if (!isActive(status)) return Effect.fail(new Refused({ reason: `#${run.number} already ${status}` }))
        run.cancelledAt = now
        return Effect.void
      })),
    rerun: ({ runId }) =>
      findRun(runId).pipe(Effect.flatMap((run) => {
        const now = Date.now()
        if (isActive(runStatus(run, now))) return Effect.fail(new Refused({ reason: `#${run.number} is still running` }))
        return Effect.succeed(toRun(world.rerun(run, now), now))
      })),
  })
}))

const Rpc = RpcServer.layer(UiRpcs).pipe(
  Layer.provide(Handlers),
  Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
)

const Main = HttpRouter.serve(Rpc).pipe(
  Layer.provide(BunHttpServer.layer({ port, hostname: "127.0.0.1" })),
  Layer.provide(RpcSerialization.layerJson),
)

BunRuntime.runMain(Layer.launch(Main))
