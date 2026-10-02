// A stand-in controller for UI work: implements `UiRpcs` over the same WebSocket transport the
// real controller uses, on deterministic fake data from ./scenario.ts.
//
//   bun mock/server.ts            listens on 127.0.0.1:8791 (KILN_MOCK_PORT overrides)

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { type Domain, NotFound, Refused, UiRpcs } from "@kiln/api"
import { Effect, Layer, PubSub, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import {
  PROJECTS, World, deployments, logLines, metrics, runStatus, stepState, testResults, toRun, toStep, trace,
  type SimRun, type SimStep,
} from "./scenario.ts"

const port = Number(process.env["KILN_MOCK_PORT"] ?? 8791)

const terminal = new Set<Domain.StepStatus>(["passed", "reused", "failed", "died", "blocked", "cancelled"])
const isActive = (status: Domain.RunStatus) => status === "queued" || status === "planning" || status === "running"

function overview(world: World, now: number): Domain.Overview {
  const visible = world.runs.filter((r) => r.createdAt <= now)
  const deps = deployments(world, now)
  const running = visible.flatMap((r) => r.steps.filter((s) => stepState(r, s, now).status === "running"))
  return {
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
      tasks: running.filter((s) => s.plan.kind === "task").length,
      tasksMax: 6,
      builds: running.filter((s) => s.plan.kind === "build").length,
      buildsMax: 3,
    },
  }
}

function detail(world: World, run: SimRun, now: number): Domain.RunDetail {
  const failingTests = run.steps
    .filter((s) => { const st = stepState(run, s, now).status; return st === "failed" || st === "died" })
    .flatMap((s) => testResults(run, s))
    .filter((t) => t.status === "failed" || t.status === "timeout")
  const pr = run.event._tag === "PullRequest" ? run.event.number : null
  const siblings = world.runs
    .filter((r) => r !== run && r.project === run.project && r.createdAt <= now)
    .filter((r) => (pr !== null && r.event._tag === "PullRequest" && r.event.number === pr) || (run.commit.changeId !== null && r.commit.changeId === run.commit.changeId))
    .reverse()
    .map((r) => toRun(r, now))
  return { run: toRun(run, now), steps: run.steps.map((s) => toStep(world, run, s, now)), failingTests, siblings }
}

/** Lines only ever get appended, so a follower remembers how many it has sent. */
function follow(run: SimRun, steps: ReadonlyArray<SimStep>, sent: number): Stream.Stream<Domain.LogLine> {
  const lines = (now: number) => steps.flatMap((s) => logLines(run, s, now)).sort((a, b) => a.timestamp - b.timestamp)
  const done = (now: number) => steps.every((s) => terminal.has(stepState(run, s, now).status))
  return Stream.suspend(() => {
    let n = sent
    return Stream.tick("400 millis").pipe(
      Stream.map(() => {
        const now = Date.now()
        const all = lines(now)
        const fresh = all.slice(n)
        n = all.length
        return { fresh, finished: done(now) }
      }),
      Stream.takeUntil((batch) => batch.finished),
      Stream.flatMap((batch) => Stream.fromIterable(batch.fresh)),
    )
  })
}

const Handlers = UiRpcs.toLayer(Effect.gen(function*() {
  const world = new World(Date.now())
  const changes = yield* PubSub.unbounded<Domain.Change>()
  const seen = new Map<string, string>()

  const diff = (now: number): Array<Domain.Change> => {
    const out: Array<Domain.Change> = []
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
        if (changed(`step:${r.id}:${s.plan.name}`, step)) out.push({ _tag: "StepChanged", step })
      }
      const run = toRun(r, now)
      if (changed(`run:${r.id}`, run)) out.push({ _tag: "RunChanged", run })
    }
    for (const deployment of deployments(world, now)) {
      if (changed(`dep:${deployment.project}:${deployment.host}`, deployment)) out.push({ _tag: "DeploymentChanged", deployment })
    }
    return out
  }

  diff(Date.now())
  yield* Effect.sleep("500 millis").pipe(
    Effect.andThen(Effect.suspend(() => PubSub.publishAll(changes, diff(Date.now())))),
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
    overview: () => Effect.sync(() => overview(world, Date.now())),
    changes: () => Stream.fromPubSub(changes),
    runs: ({ project, pullRequest, limit, before }) =>
      Effect.sync(() => {
        const now = Date.now()
        return world.runs
          .filter((r) => r.createdAt <= now && (project === undefined || r.project === project))
          .filter((r) => pullRequest === undefined || (r.event._tag === "PullRequest" && r.event.number === pullRequest))
          .filter((r) => before === undefined || r.createdAt < before)
          .reverse()
          .slice(0, limit ?? 50)
          .map((r) => toRun(r, now))
      }),
    run: ({ id }) => findRun(id).pipe(Effect.map((run) => detail(world, run, Date.now()))),
    logs: ({ runId, step, follow: live }) =>
      Stream.unwrap(Effect.gen(function*() {
        const run = yield* findRun(runId)
        const steps = step === undefined ? run.steps : [yield* findStep(run, step)]
        const now = Date.now()
        const history = steps.flatMap((s) => logLines(run, s, now)).sort((a, b) => a.timestamp - b.timestamp)
        const finished = steps.every((s) => terminal.has(stepState(run, s, now).status))
        const head = Stream.fromIterable(history)
        return live && !finished ? Stream.concat(head, follow(run, steps, history.length)) : head
      })),
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
