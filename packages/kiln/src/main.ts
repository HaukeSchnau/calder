#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Domain, NotFound, Refused } from "@kiln/api"
import { Event, Kiln } from "@kiln/core"
import { Console, Effect, Layer, Option, Schema, Stream } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import * as Agent from "./Agent.ts"
import * as Check from "./Check.ts"
import * as Cli from "./Cli.ts"
import * as Controller from "./controller/Main.ts"
import * as Gen from "./Gen.ts"
import * as Remote from "./Remote.ts"
import * as Watch from "./Watch.ts"
import * as Load from "./worker/Load.ts"
import * as Worker from "./worker/Main.ts"

const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "darwin" : "linux"}`

const repository = Argument.String("dir").pipe(Argument.withDescription("The repository, by default the current directory"), Argument.withDefault("."))
const runId = Argument.String("run").pipe(Argument.withDescription("The run id, such as kiln-12"))
const url = Flag.String("url").pipe(
  Flag.withDescription("The controller (default $KILN_URL, then https://kiln.schnau.dev)"),
  Flag.withDefault(process.env.KILN_URL ?? "https://kiln.schnau.dev"),
)

const controller = Command.make("controller", {
  config: Flag.String("config").pipe(
    Flag.withDescription("The controller's JSON config (default $KILN_CONFIG, then /etc/kiln/config.json)"),
    Flag.withDefault(process.env.KILN_CONFIG ?? "/etc/kiln/config.json"),
  ),
}, ({ config }) => Layer.launch(Controller.layer(config))).pipe(Command.withDescription("Run the controller service"))

const worker = Command.make("worker", { job: Argument.String("job").pipe(Argument.withDescription("The job id")) }, ({ job }) =>
  Worker.run(
    job,
    process.env.KILN_URL !== undefined && process.env.KILN_TOKEN !== undefined && process.env.KILN_WORKSPACES !== undefined
      ? { remote: { url: process.env.KILN_URL, workspaces: process.env.KILN_WORKSPACES }, token: process.env.KILN_TOKEN }
      : {
        socket: process.env.KILN_SOCKET ?? "/run/kiln/worker.sock",
        tokenFile: process.env.KILN_TOKEN_FILE ?? `/run/kiln/jobs/${job}.token`,
      },
  )).pipe(Command.withDescription("Run one job; the controller or an agent starts it"))

const agent = Command.make("agent", {
  url: Flag.String("url").pipe(Flag.withDescription("The controller's URL")),
  tokenFile: Flag.String("token-file").pipe(Flag.withDescription("A file with the agent's token")),
  name: Flag.String("name").pipe(Flag.withDescription("The name the agent registers under")),
  slots: Flag.Int("slots").pipe(Flag.withDescription("How many jobs to run at once (default 1)"), Flag.withDefault(1)),
  slotsFile: Flag.String("slots-file").pipe(
    Flag.withDescription("A file with the number of jobs to take right now, which the host rewrites; replaces --slots"),
    Flag.optional,
  ),
  workspaces: Flag.String("workspaces").pipe(Flag.withDescription("Where workers keep task slots and extracted .kiln/ directories")),
  admission: Flag.String("admission").pipe(
    Flag.withDescription("A command whose lease subcommand prints ready once the host admits a job"),
    Flag.optional,
  ),
}, (flags) =>
  Agent.run({
    ...flags,
    platform: system,
    kiln: [process.argv[0]!, process.argv[1]!],
    slotsFile: Option.getOrNull(flags.slotsFile),
    admission: Option.getOrNull(flags.admission),
  })).pipe(Command.withDescription("Run the controller's jobs for this host's platform"))

const gen = Command.make("gen", { dir: repository }, ({ dir }) =>
  Effect.gen(function*() {
    const outputs = yield* Gen.gen(dir, system)
    yield* Console.log(
      `wrote .kiln/flake.ts (${outputs.packages.length} packages, ${outputs.checks.length} checks, ${outputs.devShells.length} dev shells)`,
    )
    if (outputs.created) yield* Console.log("wrote .kiln/ci.ts with the standard pipeline")
  })).pipe(Command.withDescription("Write .kiln/flake.ts and .kiln/tsconfig.json, and the standard .kiln/ci.ts if there is none"))

const plan = Command.make("plan", {
  dir: repository,
  event: Flag.String("event").pipe(
    Flag.withDescription(
      "push[:<branch>], pr[:<number>], closed[:<number>], check[:<ref>], schedule:<cron> or manual[:<json object>] (default push:main)",
    ),
    Flag.withDefault("push:main"),
  ),
  required: Flag.String("required").pipe(
    Flag.withDescription("Checks branch protection requires, comma-separated, such as kiln/qa"),
    Flag.optional,
  ),
}, ({ dir, event, required }) =>
  Effect.gen(function*() {
    const parsed = yield* Cli.parseEvent(event)
    const kilnDir = resolve(dir, ".kiln")
    // A link from an older `kiln gen` may point at a Kiln that is gone; planning repairs it.
    if (existsSync(kilnDir)) Gen.linkCheckout(kilnDir)
    const project = yield* Load.project(kilnDir)
    const requiredChecks = Option.match(required, { onNone: () => [], onSome: (r) => r.split(",") })
    const planned = yield* Kiln.plan(project, parsed, { requiredChecks })
    yield* Console.log(`${Event.describe(planned.event)}: ${planned.trust}, reuse ${planned.reuse}`)
    for (const step of planned.steps) {
      const deps = [
        ...step.needs.map((n) => `needs ${n}`),
        ...step.exits.map((n) => `exit ${n}`),
        ...step.after.map((n) => (step.required.includes(n) ? `after ${n} (required)` : `after ${n}`)),
      ]
      yield* Console.log(`  ${step.kind.padEnd(6)} ${step.name}${step.target ? "" : " (pulled in)"}${deps.length > 0 ? `  ← ${deps.join(", ")}` : ""}`)
    }
    yield* Check.checkFiles(dir, project)
  })).pipe(Command.withDescription("Show the steps an event would run, without running them; fails when a path or pattern matches no file"))

/** `kiln trigger`: a branch head like a push, or with `--inputs` a manual run of the rules taking them. */
const trigger = Command.make("trigger", {
  project: Argument.String("project").pipe(Argument.withDescription("The project, as kiln projects lists it")),
  branch: Flag.String("branch").pipe(Flag.withDescription("The branch whose head to run (default the default branch)"), Flag.optional),
  schedule: Flag.String("schedule").pipe(
    Flag.withDescription("Run what this cron schedule of the project runs, on the default branch"),
    Flag.optional,
  ),
  inputs: Flag.String("inputs").pipe(
    Flag.withDescription("A JSON object, such as {\"release\":\"ios\"}; runs the On.manual rules it matches instead"),
    Flag.withSchema(Schema.fromJsonString(Event.Manual.fields.inputs)),
    Flag.optional,
  ),
  url,
}, ({ project, branch, schedule, inputs, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const run = yield* client.trigger({
      project,
      ...Option.match(branch, { onNone: () => ({}), onSome: (b) => ({ branch: b }) }),
      ...Option.match(schedule, { onNone: () => ({}), onSome: (cron) => ({ schedule: cron }) }),
      ...Option.match(inputs, { onNone: () => ({}), onSome: (i) => ({ inputs: i }) }),
    })
    const ended = yield* Cli.follow(client, run)
    if (ended.status !== "passed") return yield* Effect.fail(new Error(`${ended.id} ${ended.status}`))
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Run a branch head, a schedule or manual inputs on the controller and follow it until it ends"),
  )

/**
 * `kiln check`: runs the working copy the way a pull request would, before anything is pushed for
 * review. Later runs of the same inputs reuse its results.
 */
const check = Command.make("check", {
  dir: repository,
  key: Flag.String("key").pipe(
    Flag.withDescription("Names the check, so a newer one under the same key replaces it (default the commit)"),
    Flag.optional,
  ),
  background: Flag.Boolean("background").pipe(
    Flag.withDescription("Start the check and return; it only takes slots nothing else wants"),
    Flag.withDefault(false),
  ),
  url,
}, ({ dir, key, background, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const submitted = yield* Check.submit(client, resolve(dir), {
      ...Option.match(key, { onNone: () => ({}), onSome: (k) => ({ key: k }) }),
      background,
    })
    // A background check runs on its own; its ref stays until the next check under the same key.
    if (background) return yield* Console.log(`${submitted.run.id} checks ${submitted.copy.sha.slice(0, 12)} in the background`)
    const ended = yield* Cli.follow(client, submitted.run).pipe(Effect.ensuring(Check.drop(submitted.copy, submitted.remote, submitted.ref)))
    if (ended.status !== "passed") return yield* Effect.fail(new Error(`the check ${ended.status}`))
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Run the working copy (jj or git) like a pull request, before pushing it"),
  )

/** `kiln watch <root>...`: background checks of the jj workspaces under the roots as their snapshots settle. */
const watch = Command.make("watch", {
  roots: Argument.String("root").pipe(Argument.withDescription("Directories with jj workspaces below them"), Argument.variadic()),
  settle: Flag.Int("settle").pipe(
    Flag.withDescription("Seconds a snapshot has to stay the same before it is checked (default 120)"),
    Flag.withDefault(120),
  ),
  url,
}, ({ roots, settle, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    yield* Watch.watch(client, roots.map((r) => resolve(r)), { every: 30_000, settle: settle * 1000 })
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Check jj workspaces in the background once their snapshots settle"),
  )

/** `kiln runs [project]`: recent runs, newest first. */
const runs = Command.make("runs", {
  project: Argument.String("project").pipe(Argument.withDescription("Only this project's runs"), Argument.optional),
  limit: Flag.Int("limit").pipe(Flag.withDescription("How many runs to list (default 20, at most 200)"), Flag.withDefault(20)),
  url,
}, ({ project, limit, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const listed = yield* client.runs({ limit, ...Option.match(project, { onNone: () => ({}), onSome: (p) => ({ project: p }) }) })
    if (listed.runs.length === 0) {
      return yield* Console.log(Option.match(project, { onNone: () => "no runs yet", onSome: (p) => `no runs of ${p}; kiln projects lists the projects` }))
    }
    const now = Date.now()
    for (
      const line of Cli.table(
        listed.runs.map((r) => [r.id, r.status, Event.describe(r.event), r.commit.sha.slice(0, 12), Cli.ago(now - r.createdAt), r.title ?? r.commit.title]),
      )
    ) yield* Console.log(line)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("List recent runs with their status, event, commit and age, newest first"),
  )

/** `kiln projects`: the projects and how their default branch fares. */
const projects = Command.make("projects", { url }, ({ url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const overview = yield* client.overview()
    const now = Date.now()
    for (
      const line of Cli.table(overview.projects.map((p) => [
        p.name,
        p.repo,
        p.defaultBranch,
        ...(p.main === null ? ["no runs yet"] : [p.main.status, p.main.id, Cli.ago(now - p.main.createdAt)]),
      ]))
    ) yield* Console.log(line)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("List the projects with the latest run of each default branch"),
  )

const rerun = Command.make("rerun", { run: runId, url }, ({ run, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const created = yield* client.rerun({ runId: run })
    yield* Console.log(`${created.id}: ${created.commit.sha.slice(0, 12)} ${created.commit.title}`)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(Command.withDescription("Run a run's revision and event again"))

/** `kiln merge <project> <pr>`: Kiln merges the pull request once it is green and up to date with its base. */
const merge = Command.make("merge", {
  project: Argument.String("project").pipe(Argument.withDescription("The project, as kiln projects lists it")),
  pr: Argument.Int("pr").pipe(Argument.withDescription("The pull request number")),
  url,
}, ({ project, pr, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const request = yield* client.merge({ project, pr })
    yield* Console.log(`${project} #${request.pr}: ${request.status}; Kiln merges it once it is green and up to date`)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Merge a pull request once it is green and up to date with its base"),
  )

/** `kiln status <run>`: the run and each step's status, with why it failed. */
const status = Command.make("status", { run: runId, url }, ({ run, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const detail = yield* client.run({ id: run })
    const r = detail.run
    yield* Console.log(`${r.project} #${r.number} ${r.status}${r.error ? `: ${r.error}` : ""}  ${r.commit.sha.slice(0, 12)} ${r.commit.title}`)
    for (const step of detail.steps) {
      if (step.kind === "output") continue
      yield* Console.log(Cli.stepLine(step))
      for (const o of step.outputs) yield* Console.log(`    ${o.name}: ${url.replace(/\/$/, "")}${Domain.outputPath(r.id, step.name, o.name)}`)
    }
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Show a run's steps, why the failed ones failed, and links to their outputs"),
  )

/** `kiln logs <run> [step]`: the output of a step, or of every step with its name in front. */
const logs = Command.make("logs", {
  run: runId,
  step: Argument.String("step").pipe(Argument.withDescription("Only this step's output"), Argument.optional),
  follow: Flag.Boolean("follow").pipe(
    Flag.withDescription("Keep printing new lines until the step ends, or the run without a step"),
    Flag.withAlias("f"),
    Flag.withDefault(false),
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("How many of the last lines so far to print (default 5000)"), Flag.optional),
  url,
}, ({ run, step, follow, limit, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    const one = Option.getOrUndefined(step)
    yield* client.logs({
      runId: run,
      follow,
      ...(one === undefined ? {} : { step: one }),
      ...Option.match(limit, { onNone: () => ({}), onSome: (n) => ({ limit: n }) }),
    }).pipe(Stream.runForEach((line) => {
      const where = [one === undefined ? line.step : null, line.shard === null ? null : `#${line.shard}`].filter((x) => x !== null).join(" ")
      return Console.log(`${where === "" ? "" : `${where} | `}${line.stream === "kiln" ? "[kiln] " : ""}${line.text}`)
    }))
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(
    Command.withDescription("Print a step's output, or every step's with its name in front"),
  )

const cancel = Command.make("cancel", { run: runId, url }, ({ run, url }) =>
  Effect.gen(function*() {
    const client = yield* Remote.client
    yield* client.cancel({ runId: run })
    yield* Console.log(`cancelled ${run}`)
  }).pipe(Effect.scoped, Effect.provide(Remote.layer(url)))).pipe(Command.withDescription("Cancel a run that hasn't ended"))

const subcommands = [controller, worker, agent, gen, plan, check, watch, trigger, runs, projects, status, logs, rerun, cancel, merge]

const kiln = Command.make("kiln").pipe(
  Command.withDescription("Kiln plans and runs the pipelines in .kiln/ci.ts, here or on its controller"),
  Command.withSubcommands(subcommands),
)

/** The parser would answer a mistyped subcommand with the whole help; a list of the subcommands says enough. */
const unknownSubcommand = Effect.suspend(() => {
  const typed = process.argv[2]
  const names: ReadonlyArray<string> = subcommands.map((c) => c.name)
  return typed === undefined || typed.startsWith("-") || names.includes(typed)
    ? Effect.void
    : Effect.fail(new Error(`${typed} is not a subcommand; try ${Cli.closest(typed, names).join(", ")}`))
})

// What the controller refuses, runs it doesn't know and failed checks are for people to read: one line, exit code 1.
const told = (e: unknown): e is NotFound | Refused | Error => e instanceof NotFound || e instanceof Refused || e instanceof Error

unknownSubcommand.pipe(
  Effect.andThen(Command.run(kiln, { version: "0.1.0" })),
  // The parser has printed the help and what was wrong with the arguments.
  Effect.catchIf(CliError.isCliError, () => Effect.sync(() => (process.exitCode = 1))),
  Effect.catchIf(told, (e) => Console.error(`kiln: ${e.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
