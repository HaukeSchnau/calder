import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { RunInfo } from "../src/Protocol.ts"
import * as Footprint from "../src/worker/Footprint.ts"
import { type Derivation, derivations, fromEarlier, jobMemory, type Memory } from "../src/worker/Resolve.ts"

const run = (flake: string) => ({ flake }) as RunInfo
const drv = (name: string) => ({ drv: `/nix/store/${name}.drv`, out: `/nix/store/${name}`, system: "x86_64-linux" })
const GiB = 2 ** 30

/** What `nix eval` makes of an attribute: a derivation or null, an error Nix can't catch, and how much memory it takes. */
interface Attr {
  readonly value?: Derivation | null | "missing" | "unreachable"
  readonly bytes?: number
}

/**
 * Answers `nix eval` like Nix does Calder's expression: reports the flake, then each attribute's
 * derivation in order, holding `bytes` more for each, until an attribute is missing. One that takes more
 * than `hang` bytes never finishes. `nix-store --check-validity` answers with `valid` and
 * `nix-store --query --requisites` with `closure`.
 */
const nix = (
  valid: () => boolean,
  options: {
    readonly evaluating?: Effect.Effect<void>
    readonly closure?: () => ReadonlyArray<string>
    readonly attrs?: Readonly<Record<string, Attr>>
    readonly hang?: number
    /** Loading the flake itself takes this much and never ends. */
    readonly heavyFlake?: number
    /** The flake itself fails to load, such as an input that can't be fetched. */
    readonly broken?: boolean
    /** Nix succeeds without reporting any attribute, as a Nix whose trace output changed would. */
    readonly silent?: boolean
  } = {},
) => {
  const calls: Array<string> = []
  const evaluated: Array<ReadonlyArray<string>> = []
  const held = new Map<number, number>()
  const line = (text: string) => new TextEncoder().encode(`${text}\n`)
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      calls.push(argv.slice(0, 2).join(" "))
      const evaluates = argv[1] === "eval"
      const pid = calls.length
      held.set(pid, GiB / 4)
      let stderr: Stream.Stream<Uint8Array> = Stream.empty
      let exit: Effect.Effect<number> = Effect.succeed(evaluates || valid() ? 0 : 1)
      if (evaluates) {
        yield* options.evaluating ?? Effect.void
        const asked = [...argv.at(-1)!.matchAll(/\(report \d+ f\.(\S+)\)/g)].map((m) => m[1]!)
        evaluated.push(asked)
        const reports: Array<Stream.Stream<Uint8Array>> = options.heavyFlake === undefined
          ? [Stream.make(line(options.broken ? "error: cannot fetch input 'nixpkgs'" : "trace: calder-flake"))]
          : [Stream.fromEffect(Effect.sync(() => held.set(pid, options.heavyFlake!))).pipe(Stream.drain), Stream.never]
        if (options.heavyFlake !== undefined) exit = Effect.never
        if (options.broken) exit = Effect.succeed(1)
        for (const [i, name] of options.broken || options.silent ? [] : asked.entries()) {
          const attr = options.attrs?.[name] ?? {}
          const value = attr.value === undefined ? (name === "b" ? null : drv(name)) : attr.value
          const grow = Stream.fromEffect(Effect.sync(() => held.set(pid, held.get(pid)! + (attr.bytes ?? 0)))).pipe(Stream.drain)
          if (value === "missing" || value === "unreachable") {
            const error = value === "missing" ? `attribute '${name}' missing` : "unable to download 'https://example.org/x': HTTP error 502"
            reports.push(Stream.make(line("error:"), line("       … while calling the 'seq' builtin"), line(`       error: ${error}`)))
            exit = Effect.succeed(1)
            break
          }
          if ((attr.bytes ?? 0) > (options.hang ?? Number.POSITIVE_INFINITY)) {
            reports.push(grow, Stream.never)
            exit = Effect.never
            break
          }
          reports.push(grow, Stream.make(line(`trace: calder-derivation ${JSON.stringify([i, value])}`)))
        }
        stderr = Stream.flatten(Stream.fromIterable(reports))
      }
      // `--print-invalid` lists the invalid paths and succeeds; without it, any invalid path fails.
      const listing = argv.includes("--print-invalid")
      if (listing) exit = Effect.succeed(0)
      const stdout = argv[1] === "--query" ? (options.closure?.() ?? []).join("\n")
        : listing && !valid() ? argv.filter((a) => a.startsWith("/nix/store/")).join("\n") : ""
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.map(exit, ChildProcessSpawner.ExitCode),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  )
  const memory = (budget: number | null): Memory => ({ budget, resident: (pid) => held.get(pid) ?? 0, every: "10 millis" })
  return { calls, evaluated, spawner, memory }
}

const unlimited: Memory = { budget: null, resident: () => 0, every: "1 second" }

describe("derivations", () => {
  it.effect("evaluates a locked revision once while its derivations are in the store", () =>
    Effect.gen(function*() {
      let valid = true
      const { calls, spawner } = nix(() => valid)
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = (flake: string) => derivations(run(flake), ["a", "b"], dir, undefined, unlimited).pipe(Effect.map((e) => e.derivations), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

      const first = yield* plan("git+file:///mirror?rev=1")
      expect(yield* plan("git+file:///mirror?rev=1")).toEqual(first)
      expect(first).toEqual(new Map([["a", drv("a")], ["b", null]]))
      expect(calls).toEqual(["nix eval", "nix-store --check-validity"])

      // Another revision replaces the repository's entry; a subset of it is a hit.
      yield* plan("git+file:///mirror?rev=2")
      const subset = yield* derivations(run("git+file:///mirror?rev=2"), ["a"], dir, undefined, unlimited).pipe(Effect.map((e) => e.derivations), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      expect(subset).toEqual(new Map([["a", drv("a")]]))
      expect(yield* plan("git+file:///mirror?rev=1")).toEqual(first)
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(3)

      valid = false
      yield* plan("git+file:///mirror?rev=1")
      yield* plan("git+file:///mirror")
      yield* plan("git+file:///mirror")
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(6)
    }))

  it.live("evaluates a revision once when two plans of it start together", () =>
    Effect.gen(function*() {
      const { calls, spawner } = nix(() => true, { evaluating: Effect.sleep("50 millis") })
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = derivations(run("git+file:///mirror?rev=1"), ["a", "b"], dir, undefined, unlimited).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const [push, schedule] = yield* Effect.all([plan, plan], { concurrency: 2 })
      expect(schedule).toEqual(push)
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(1)
    }))

  it.effect("takes over the lock of a worker that died holding it", () =>
    Effect.gen(function*() {
      const { calls, spawner } = nix(() => true)
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = derivations(run("git+file:///mirror?rev=1"), ["a"], dir, undefined, unlimited).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      yield* plan
      // No process has this id: Linux caps them at 2^22.
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        writeFileSync(join(dir, `${name}.lock`), String(2 ** 23))
      }
      yield* plan
      expect(calls).toEqual(["nix eval", "nix-store --check-validity"])
    }))

  it.effect("takes an earlier plan's derivations of the same tree, unless they mention its commit", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      // The closure of the earlier derivation: one .drv file, which may mention the commit.
      const closure = join(dir, "x-bundle.drv")
      const { calls, spawner } = nix(() => true, { closure: () => [closure] })
      const pr = "1".repeat(40)
      const committed = 1_761_609_600
      const earlier = { revision: pr, derivations: { a: drv("a"), b: null }, app: "app" }
      const flake = new Map([["flake.nix", "{ outputs = { self, nixpkgs }: { packages.x86_64-linux.bundle = 1; }; }"]])
      const take = (attrs: ReadonlyArray<string>, revision: Partial<Parameters<typeof fromEarlier>[2]> = {}) =>
        fromEarlier(earlier, attrs, { committed: Option.some(committed), nix: flake, ...revision })
          .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

      writeFileSync(closure, `Derive([("out","/nix/store/x-bundle","","")],[],[],"x86_64-linux","/bin/sh",[],[("version","0.1")])`)
      expect(yield* take(["a", "b"])).toEqual(new Map([["a", drv("a")], ["b", null]]))
      // A derivation that embeds the commit, such as a version from `self.shortRev` or `self.lastModified`, doesn't carry over.
      for (const mark of [pr.slice(0, 7), String(committed), "20251028000000", "20251028"]) {
        writeFileSync(closure, `Derive([("out","/nix/store/x-bundle","","")],[],[],"x86_64-linux","/bin/sh",[],[("version","0.1-${mark}")])`)
        expect(yield* take(["a", "b"])).toBeUndefined()
      }
      // Nor does a plan that didn't evaluate every attribute this one needs, nor one of a flake that reads
      // revCount, nor one whose commit can't be read.
      writeFileSync(closure, `Derive([("out","/nix/store/x-bundle","","")],[],[],"x86_64-linux","/bin/sh",[],[("version","0.1")])`)
      expect(yield* take(["a", "c"])).toBeUndefined()
      expect(yield* take(["a", "b"], { nix: new Map([["nix/version.nix", "self: \"0.${toString self.revCount}\""]]) })).toBeUndefined()
      expect(yield* take(["a", "b"], { committed: Option.none() })).toBeUndefined()
      expect(yield* take(["a", "b"])).toBeDefined()
      expect(calls.filter((c) => c === "nix eval")).toHaveLength(0)
    }))
})

describe("evaluating within the job's memory", () => {
  const evaluate = (fake: ReturnType<typeof nix>, attrs: ReadonlyArray<string>, budget: number | null) =>
    Effect.gen(function*() {
      const logged: Array<string> = []
      const log = (text: string) => Effect.sync(() => void logged.push(text))
      const { derivations: result, errors } = yield* derivations(run("git+file:///mirror"), attrs, undefined, log, fake.memory(budget))
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner))
      return { result, errors, logged }
    })

  it.live("shares one evaluator while the attributes fit", () =>
    Effect.gen(function*() {
      const fake = nix(() => true, { attrs: { a: { bytes: GiB / 2 }, c: { bytes: GiB / 2 } } })
      const { result } = yield* evaluate(fake, ["a", "b", "c"], 3 * GiB)
      expect(result).toEqual(new Map([["a", drv("a")], ["b", null], ["c", drv("c")]]))
      expect(fake.evaluated).toEqual([["a", "b", "c"]])
    }))

  it.live("goes on in a new evaluator once the next attribute might not fit", () =>
    Effect.gen(function*() {
      // Each host takes 1 GiB on top of the flake's quarter: after two, a third might reach 3.25.
      const host = { bytes: GiB }
      const fake = nix(() => true, { attrs: { h1: host, h2: host, h3: host, h4: host } })
      const { result } = yield* evaluate(fake, ["h1", "h2", "h3", "h4"], 3 * GiB)
      expect(result).toEqual(new Map(["h1", "h2", "h3", "h4"].map((h) => [h, drv(h)])))
      expect(fake.evaluated).toEqual([["h1", "h2", "h3", "h4"], ["h3", "h4"]])
    }))

  it.live("stops at once, saying which attribute, when one outgrows the budget even on its own", () =>
    Effect.gen(function*() {
      const fake = nix(() => true, { attrs: { a: { bytes: GiB / 2 }, huge: { bytes: 4 * GiB } }, hang: 3 * GiB })
      const error = yield* Effect.flip(evaluate(fake, ["a", "huge", "c"], 3 * GiB))
      expect(error).toMatchObject({ _tag: "TooLarge", attr: "huge", budget: 3 * GiB })
      expect(error.message).toContain("took more than 3.0 GiB")
      // It gets another try in an evaluator of its own before it counts as too large; nothing swaps or waits.
      expect(fake.evaluated).toEqual([["a", "huge", "c"], ["huge", "c"]])
    }))

  it.live("tries an attribute Nix can't evaluate once more, then leaves it out with Nix's reason, uncached", () =>
    Effect.gen(function*() {
      const fake = nix(() => true, { attrs: { gone: { value: "missing" } } })
      const { result, errors, logged } = yield* evaluate(fake, ["a", "gone", "c"], null)
      expect(result).toEqual(new Map([["a", drv("a")], ["c", drv("c")]]))
      expect(errors).toEqual(new Map([["gone", "attribute 'gone' missing"]]))
      expect(fake.evaluated).toEqual([["a", "gone", "c"], ["gone", "c"], ["c"]])
      expect(logged).toContain("gone did not evaluate: attribute 'gone' missing")
    }))

  it.live("retries an error many attributes share only until two failed with it", () =>
    Effect.gen(function*() {
      const down = { value: "unreachable" as const }
      const fake = nix(() => true, { attrs: { x: down, y: down, z: down } })
      const { errors } = yield* evaluate(fake, ["x", "y", "z"], null)
      expect([...errors.keys()]).toEqual(["x", "y", "z"])
      expect(fake.evaluated).toEqual([["x", "y", "z"], ["x", "y", "z"], ["y", "z"], ["y", "z"], ["z"]])
    }))

  it.live("says it was loading the flake that outgrew the budget", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(evaluate(nix(() => true, { heavyFlake: 4 * GiB }), ["a"], 3 * GiB))
      expect(error.message).toMatch(/^Loading the flake took more than 3.0 GiB/)
    }))

  it.live("doesn't cache an attribute whose evaluation failed, so the next plan tries it again", () =>
    Effect.gen(function*() {
      let flaky = true
      const fake = nix(() => true, { attrs: { get shell() { return flaky ? { value: "missing" as const } : {} } } })
      const dir = mkdtempSync(join(tmpdir(), "calder-derivations-"))
      const plan = derivations(run("git+file:///mirror?rev=1"), ["shell"], dir, undefined, unlimited)
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner))
      const twice = derivations(run("git+file:///mirror?rev=1"), ["a", "shell"], dir, undefined, unlimited)
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner))
      expect((yield* twice).derivations).toEqual(new Map([["a", drv("a")]]))
      flaky = false
      // The next plan of the commit evaluates only what the cache lacks.
      expect((yield* twice).derivations).toEqual(new Map([["a", drv("a")], ["shell", drv("shell")]]))
      expect(fake.evaluated.at(-1)).toEqual(["shell"])
      expect((yield* plan).derivations).toEqual(new Map([["shell", drv("shell")]]))
    }))

  it.live("evaluates as before, recording nothing, when recording what Nix read fails", () =>
    Effect.gen(function*() {
      const fake = nix(() => true)
      const recorder = {
        source: "/nix/store/x-source",
        url: "path:/nix/store/x-source?rev=1",
        revision: "1",
        at: Footprint.tree([]),
        marks: [],
        read: () => Effect.succeed(new Map<string, string>()),
      }
      const logged: Array<string> = []
      const log = (text: string) => Effect.sync(() => void logged.push(text))
      const result = yield* derivations(run("git+file:///mirror"), ["a"], undefined, log, unlimited, { recorder })
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner))
      expect(result.derivations).toEqual(new Map([["a", drv("a")]]))
      expect(result.recorded).toBeUndefined()
      // strace ran nothing that reported (as without ptrace), then nix ran alone.
      expect(fake.calls.filter((c) => c === "strace -f" || c === "nix eval")).toEqual(["strace -f", "nix eval"])
      expect(logged.some((l) => l.startsWith("recording what Nix read failed"))).toBe(true)
    }))

  it.live("fails without caching when Nix's reports don't match the expression", () =>
    Effect.gen(function*() {
      const fake = nix(() => true, { silent: true })
      const error = yield* Effect.flip(evaluate(fake, ["a", "b"], null))
      expect(error._tag === "CommandFailed" && error.stderr).toContain("2 attributes went unreported")
    }))

  it.live("fails when the flake itself doesn't load", () =>
    Effect.gen(function*() {
      const fake = nix(() => true, { broken: true })
      const error = yield* Effect.flip(evaluate(fake, ["a", "b"], null))
      expect(error._tag === "CommandFailed" && error.stderr).toContain("cannot fetch input 'nixpkgs'")
      expect(fake.evaluated).toHaveLength(1)
    }))

  it("reads the budget from the job's cgroup and its ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "calder-cgroup-"))
    const unit = join(root, "calder.slice", "calder-jobs.slice", "calder-job-pr@1.service")
    mkdirSync(unit, { recursive: true })
    writeFileSync(join(root, "calder.slice", "calder-jobs.slice", "memory.high"), String(8 * GiB))
    writeFileSync(join(root, "calder.slice", "calder-jobs.slice", "memory.max"), "max\n")
    writeFileSync(join(unit, "memory.high"), String(3.5 * GiB))
    writeFileSync(join(unit, "memory.max"), String(4 * GiB))
    const self = join(root, "self")
    writeFileSync(self, "0::/calder.slice/calder-jobs.slice/calder-job-pr@1.service\n")
    const { budget } = jobMemory(root, self)
    // 80% of 3.5 GiB, less what this process holds.
    expect(budget).toBeLessThan(0.8 * 3.5 * GiB)
    expect(budget).toBeGreaterThan(0.8 * (3.5 * GiB - process.memoryUsage().rss - GiB / 4))

    writeFileSync(self, "0::/\n")
    expect(jobMemory(root, self).budget).toBeNull()
    expect(jobMemory(root, join(root, "missing")).budget).toBeNull()
  })
})
