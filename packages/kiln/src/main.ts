#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import type { Domain } from "@kiln/api"
import { Event, Kiln } from "@kiln/core"
import { Console, Effect, Layer, Option, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { resolve } from "node:path"
import * as Agent from "./Agent.ts"
import * as Check from "./Check.ts"
import * as Controller from "./controller/Main.ts"
import * as Gen from "./Gen.ts"
import * as Remote from "./Remote.ts"
import * as Load from "./worker/Load.ts"
import * as Worker from "./worker/Main.ts"

const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "darwin" : "linux"}`

const controller = Command.make("controller", {
  config: Flag.String("config").pipe(Flag.withDefault(process.env.KILN_CONFIG ?? "/etc/kiln/config.json")),
}, ({ config }) => Layer.launch(Controller.layer(config)))

const worker = Command.make("worker", { job: Argument.String("job") }, ({ job }) =>
  Worker.run(
    job,
    process.env.KILN_URL !== undefined && process.env.KILN_TOKEN !== undefined && process.env.KILN_WORKSPACES !== undefined
      ? { remote: { url: process.env.KILN_URL, workspaces: process.env.KILN_WORKSPACES }, token: process.env.KILN_TOKEN }
      : {
        socket: process.env.KILN_SOCKET ?? "/run/kiln/worker.sock",
        tokenFile: process.env.KILN_TOKEN_FILE ?? `/run/kiln/jobs/${job}.token`,
      },
  ))

const agent = Command.make("agent", {
  url: Flag.String("url"),
  tokenFile: Flag.String("token-file"),
  name: Flag.String("name"),
  slots: Flag.Int("slots").pipe(Flag.withDefault(1)),
  workspaces: Flag.String("workspaces"),
  admission: Flag.String("admission").pipe(Flag.optional),
}, (flags) =>
  Agent.run({
    ...flags,
    platform: system,
    kiln: [process.argv[0]!, process.argv[1]!],
    admission: Option.getOrNull(flags.admission),
  }))

const gen = Command.make("gen", { dir: Argument.String("dir").pipe(Argument.withDefault(".")) }, ({ dir }) =>
  Effect.gen(function*() {
    const outputs = yield* Gen.gen(dir, system)
    yield* Console.log(
      `wrote .kiln/flake.ts (${outputs.packages.length} packages, ${outputs.checks.length} checks, ${outputs.devShells.length} dev shells)`,
    )
    if (outputs.created) yield* Console.log("wrote .kiln/ci.ts with the standard pipeline")
  }))

const parseEvent = (text: string): Event.Event => {
  const [kind, arg] = text.split(":", 2) as [string, string | undefined]
  switch (kind) {
    case "push":
      return Event.push(arg ?? "main")
    case "pr":
      return Event.pullRequest({ number: Number(arg ?? 1) })
    case "schedule":
      return Event.schedule(arg ?? "")
    case "check":
      return Event.check({ ref: arg ?? "kiln/check/local" })
    default:
      return Event.manual(arg === undefined ? {} : JSON.parse(arg) as Record<string, unknown>)
  }
}

const plan = Command.make("plan", {
  dir: Argument.String("dir").pipe(Argument.withDefault(".")),
  event: Flag.String("event").pipe(Flag.withDefault("push:main")),
  required: Flag.String("required").pipe(Flag.optional),
}, ({ dir, event, required }) =>
  Effect.gen(function*() {
    const project = yield* Load.project(resolve(dir, ".kiln"))
    const requiredChecks = Option.match(required, { onNone: () => [], onSome: (r) => r.split(",") })
    const planned = yield* Kiln.plan(project, parseEvent(event), { requiredChecks })
    yield* Console.log(`${Event.describe(planned.event)}: ${planned.trust}, reuse ${planned.reuse}`)
    for (const step of planned.steps) {
      const deps = [
        ...step.needs.map((n) => `needs ${n}`),
        ...step.exits.map((n) => `exit ${n}`),
        ...step.after.map((n) => (step.required.includes(n) ? `after ${n} (required)` : `after ${n}`)),
      ]
      yield* Console.log(`  ${step.kind.padEnd(6)} ${step.name}${step.target ? "" : " (pulled in)"}${deps.length > 0 ? `  ← ${deps.join(", ")}` : ""}`)
    }
  }))

const url = Flag.String("url").pipe(Flag.withDefault(process.env.KILN_URL ?? "https://kiln.schnau.dev"))

/** Prints a run's steps as they change until it ends; returns its final status. */
const follow = (client: Effect.Success<typeof Remote.client>, run: Domain.Run) =>
  Effect.gen(function*() {
    yield* Console.log(`${run.project} #${run.number} ${run.commit.sha.slice(0, 12)} ${run.commit.title}`)
    let status: string = run.status
    yield* client.changes().pipe(
      Stream.filter((c) => (c._tag === "StepChanged" ? c.step.runId === run.id : c._tag === "RunChanged" && c.run.id === run.id)),
      Stream.tap((c) =>
        c._tag === "StepChanged"
          ? Console.log(`  ${c.step.status.padEnd(9)} ${c.step.name}${c.step.error ? `: ${c.step.error.message.split("\n")[0]}` : ""}`)
          : Console.log(`${c._tag === "RunChanged" ? c.run.status : ""}${c._tag === "RunChanged" && c.run.error ? `: ${c.run.error}` : ""}`)
      ),
      Stream.tap((c) => Effect.sync(() => {
        if (c._tag === "RunChanged") status = c.run.status
      })),
      Stream.takeUntil((c) => c._tag === "RunChanged" && ["passed", "failed", "cancelled", "errored"].includes(c.run.status)),
      Stream.runDrain,
    )
    return status
  })

const trigger = Command.make("trigger", {
  project: Argument.String("project"),
  branch: Flag.String("branch").pipe(Flag.optional),
  url,
}, ({ project, branch, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const run = yield* client.trigger({ project, ...Option.match(branch, { onNone: () => ({}), onSome: (b) => ({ branch: b }) }) })
    yield* follow(client, run)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url))))

/**
 * `kiln check`: runs the working copy the way a pull request would, before anything is pushed for
 * review. Later runs of the same inputs reuse its results.
 */
const check = Command.make("check", { dir: Argument.String("dir").pipe(Argument.withDefault(".")), url }, ({ dir, url }) =>
  Effect.gen(function*() {
    const copy = yield* Check.workingCopy(resolve(dir))
    const ref = `kiln/check/${copy.sha.slice(0, 12)}`
    yield* Check.push(copy, ref)
    const client = yield* Remote.client
    const status = yield* Effect.gen(function*() {
      const run = yield* client.check({ repo: copy.repo, ref, sha: copy.sha })
      return yield* follow(client, run)
    }).pipe(Effect.ensuring(Check.drop(copy, ref)))
    if (status !== "passed") return yield* Effect.fail(new Error(`the check ${status}`))
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url))))

const rerun = Command.make("rerun", { run: Argument.String("run"), url }, ({ run, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const created = yield* client.rerun({ runId: run })
    yield* Console.log(`${created.id}: ${created.commit.sha.slice(0, 12)} ${created.commit.title}`)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url))))

const cancel = Command.make("cancel", { run: Argument.String("run"), url }, ({ run, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    yield* client.cancel({ runId: run })
    yield* Console.log(`cancelled ${run}`)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url))))

const kiln = Command.make("kiln").pipe(Command.withSubcommands([controller, worker, agent, gen, plan, check, trigger, rerun, cancel]))

Command.run(kiln, { version: "0.1.0" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
