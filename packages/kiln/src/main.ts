#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Event, Kiln } from "@kiln/core"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { resolve } from "node:path"
import * as Controller from "./controller/Main.ts"
import * as Gen from "./Gen.ts"
import * as Load from "./worker/Load.ts"
import * as Worker from "./worker/Main.ts"

const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "darwin" : "linux"}`

const controller = Command.make("controller", {
  config: Flag.String("config").pipe(Flag.withDefault(process.env.KILN_CONFIG ?? "/etc/kiln/config.json")),
}, ({ config }) => Layer.launch(Controller.layer(config)))

const worker = Command.make("worker", { job: Argument.String("job") }, ({ job }) =>
  Worker.run(job, {
    socket: process.env.KILN_SOCKET ?? "/run/kiln/worker.sock",
    tokenFile: process.env.KILN_TOKEN_FILE ?? `/run/kiln/jobs/${job}.token`,
  }))

const gen = Command.make("gen", { dir: Argument.String("dir").pipe(Argument.withDefault(".")) }, ({ dir }) =>
  Effect.gen(function*() {
    const outputs = yield* Gen.gen(dir, system)
    yield* Console.log(
      `wrote .kiln/flake.ts (${outputs.packages.length} packages, ${outputs.checks.length} checks, ${outputs.devShells.length} dev shells)`,
    )
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

const kiln = Command.make("kiln").pipe(Command.withSubcommands([controller, worker, gen, plan]))

Command.run(kiln, { version: "0.1.0" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
