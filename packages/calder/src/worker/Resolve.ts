import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Cmd, Event, Files, Flake, Calder, Step } from "@calder-ci/core"
import { type Duration, Effect, Option, Schedule, Schema } from "effect"
import * as Exec from "../Exec.ts"
import { sha256 } from "../Keys.ts"
import type { PlannedStep, PlanSpec, RunInfo } from "../Protocol.ts"
import { Job } from "./Client.ts"
import * as Imports from "./Imports.ts"
import * as Repo from "./Repo.ts"
import type { Repo as RepoAt } from "./Repo.ts"

/**
 * What every workspace package reads at the root: the files there except docs (manifests, lockfiles,
 * shared configs such as `tsconfig.base.json`) and the fleet's `.ci/` contract.
 */
const rootFiles = (repo: RepoAt) => Effect.map(repo.files, (all) => [...all.filter((f) => !f.includes("/") && !/\.mdx?$/i.test(f)), ".ci"])

interface Manifest {
  readonly dir: string
  readonly name: string
  readonly deps: ReadonlyArray<string>
}

const workspaceGlobs = (repo: RepoAt) =>
  Effect.gen(function*() {
    const yaml = yield* repo.show("pnpm-workspace.yaml")
    if (yaml !== undefined) {
      const globs: Array<string> = []
      let inPackages = false
      for (const line of yaml.split("\n")) {
        if (/^packages:\s*$/.test(line)) inPackages = true
        else if (inPackages && /^\s+-\s+/.test(line)) globs.push(line.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim())
        else if (inPackages && /^\S/.test(line)) inPackages = false
      }
      return globs
    }
    const pkg = yield* repo.show("package.json")
    if (pkg === undefined) return []
    const json = JSON.parse(pkg) as { workspaces?: ReadonlyArray<string> | { packages?: ReadonlyArray<string> } }
    const ws = json.workspaces
    return Array.isArray(ws) ? ws : (ws as { packages?: ReadonlyArray<string> } | undefined)?.packages ?? []
  })

const manifests = (repo: RepoAt) =>
  Effect.gen(function*() {
    const globs = (yield* workspaceGlobs(repo)).filter((g) => !g.startsWith("!"))
    const files = yield* repo.files
    const matchers = globs.map((g) => Files.globToRegExp(`${g.replace(/\/+$/, "")}/package.json`))
    const paths = files.filter((f) => f.endsWith("package.json") && matchers.some((m) => m.test(f)))
    const out: Array<Manifest> = []
    for (const path of paths) {
      const text = yield* repo.show(path)
      if (text === undefined) continue
      const json = JSON.parse(text) as Record<string, unknown>
      const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) =>
        Object.keys((json[k] ?? {}) as Record<string, string>)
      )
      out.push({ dir: path.slice(0, -"/package.json".length), name: String(json.name ?? path), deps })
    }
    return out
  })

const graphs = new WeakMap<RepoAt, Imports.Graph>()
/** One import graph per revision, however many tasks ask. */
const graphOf = (repo: RepoAt) =>
  Effect.suspend(() => {
    const known = graphs.get(repo)
    if (known !== undefined) return Effect.succeed(known)
    return manifests(repo).pipe(
      Effect.flatMap((ws) => Imports.make(repo, ws.map((m) => m.dir))),
      Effect.tap((graph) => Effect.sync(() => graphs.set(repo, graph))),
    )
  })

/** Concrete paths for a `Files` value at the revision. Directories stay directories. */
export const paths = (repo: RepoAt, files: Files.Files): Effect.Effect<ReadonlyArray<string>, Exec.ExecError, Exec.Spawner> =>
  Effect.gen(function*() {
    switch (files._tag) {
      case "All":
        return ["."]
      case "Of":
        return files.paths
      case "Glob": {
        const all = yield* repo.files
        const res = files.patterns.map(Files.globToRegExp)
        return all.filter((f) => res.some((r) => r.test(f)))
      }
      case "Imports": {
        const graph = yield* graphOf(repo)
        return [...(yield* graph.closure(graph.match(files.patterns), files))].sort()
      }
      case "Union":
        return (yield* Effect.forEach(files.members, (m) => paths(repo, m))).flat()
      case "Optional":
        return yield* paths(repo, files.files)
      case "Workspace": {
        if (files.dirs.includes(".")) return ["."]
        const all = yield* manifests(repo)
        const byName = new Map(all.map((m) => [m.name, m]))
        const byDir = new Map(all.map((m) => [m.dir, m]))
        const seen = new Set<string>()
        const visit = (m: Manifest) => {
          if (seen.has(m.dir)) return
          seen.add(m.dir)
          for (const dep of m.deps) {
            const target = byName.get(dep)
            if (target !== undefined) visit(target)
          }
        }
        for (const dir of files.dirs) {
          const m = byDir.get(dir)
          if (m !== undefined) visit(m)
          else seen.add(dir)
        }
        return [...(yield* rootFiles(repo)), ...[...seen].sort()]
      }
    }
  })

/** The paths and patterns of `files` that match nothing at the revision, except `optional` ones. */
const unmatched = (repo: RepoAt, files: Files.Files): Effect.Effect<ReadonlyArray<string>, Exec.ExecError, Exec.Spawner> =>
  Effect.gen(function*() {
    switch (files._tag) {
      case "All":
      case "Optional":
        return []
      case "Of":
      case "Workspace": {
        const all = yield* repo.files
        return (files._tag === "Of" ? files.paths : files.dirs).filter((path) =>
          path !== "." && !all.some((f) => f === path || f.startsWith(`${path}/`))
        )
      }
      case "Glob":
      case "Imports": {
        const all = yield* repo.files
        return files.patterns.filter((pattern) => {
          const re = Files.globToRegExp(pattern)
          return !all.some((f) => re.test(f))
        })
      }
      case "Union":
        return (yield* Effect.forEach(files.members, (m) => unmatched(repo, m))).flat()
    }
  })

/**
 * Fails the plan when a path or pattern the project wrote matches no file: its key would never change.
 * Every task's and setup's files count, also those of steps this event doesn't run.
 */
export const checkFiles = (project: Calder.Project, repo: RepoAt) =>
  Effect.gen(function*() {
    const universe = yield* Calder.universe(project)
    const written = [
      ...(project.shared === undefined ? [] : [["the project's shared files", project.shared] as const]),
      ...[...universe.values()].flatMap((step) => {
        const def = step.def
        if (def._tag === "Setup") return [[`${step.name}'s inputs`, def.inputs] as const]
        if (def._tag !== "Task") return []
        return [
          [`${step.name}'s inputs`, def.inputs] as const,
          ...(def.each === undefined ? [] : [[`${step.name}'s each`, def.each] as const]),
          ...(def.shards?.split === undefined ? [] : [[`${step.name}'s shards.split`, def.shards.split] as const]),
        ]
      }),
    ]
    const missing = (yield* Effect.forEach(written, ([where, files]) =>
      Effect.map(unmatched(repo, files), (patterns) => patterns.map((pattern) => `${JSON.stringify(pattern)} (${where})`))
    )).flat()
    if (missing.length > 0) {
      return yield* new Calder.PlanError({
        message: `No file matches ${missing.join(", ")}. Fix the path or pattern, or wrap files that may be missing in Files.optional(...).`,
      })
    }
  })

/**
 * A key for every file of a task's `each`: the task's own key base (with its setup's key), the file,
 * everything it imports and its package's data files.
 */
const eachKeys = (repo: RepoAt, each: Files.Files, keyBase: string) =>
  Effect.gen(function*() {
    const graph = yield* graphOf(repo)
    const entries = each._tag === "Imports" || each._tag === "Glob" ? graph.match(each.patterns) : [...new Set(yield* paths(repo, each))].sort()
    const byEntry = each._tag === "Imports" ? yield* graph.closures(entries, each) : new Map(entries.map((e) => [e, [e]] as const))
    const closures = entries.map((entry) => byEntry.get(entry) ?? [entry])
    const blobs = new Map((yield* repo.entries).map((e) => [e.path, e.oid]))
    const dirs = [...new Set(closures.flatMap((c) => c.filter((p) => !blobs.has(p))))]
    const trees = yield* repo.objectIds(dirs)
    const id = (path: string) => blobs.get(path) ?? trees.get(path) ?? null
    const data = new Map<string, string>()
    const dataKey = (dir: string) => {
      let key = data.get(dir)
      if (key === undefined) {
        key = sha256(graph.data(dir).map((p) => [p, id(p)]))
        data.set(dir, key)
      }
      return key
    }
    return entries.map((file, i) => ({
      file,
      key: sha256({ keyBase, file, closure: [...closures[i]!].sort().map((p) => [p, id(p)]), data: dataKey(graph.packageOf(file)) }),
      always: graph.always(file),
    }))
  })

/** Files whose change means dependencies must be set up again. */
const dependencyFiles = [
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock|\.npmrc|\.?pnpmfile\.cjs)$/,
  /(^|\/)(composer\.json|composer\.lock|Cargo\.lock|uv\.lock|go\.sum|Gemfile\.lock|pyproject\.toml|requirements[^/]*\.txt)$/,
  /^patches\//,
  /^\.ci\//,
  /^flake\.lock$/,
]

export interface Derivation {
  readonly drv: string
  readonly out: string
  readonly system: string
}

/**
 * How a flake reads a commit: `self.rev`, `self.shortRev`, `self.lastModified`, `self.lastModifiedDate`
 * and its day, the usual substring of it. `self.revCount` is a small number, found in any closure by
 * chance, so `fromEarlier` looks for its name in the flake's sources instead.
 */
export const marksOf = (revision: string, committed: number) => {
  const date = new Date(committed * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14)
  return [revision, revision.slice(0, 7), String(committed), date, date.slice(0, 8)]
}

/** The repository's cache file: the derivations of its last planned revision and the app its flake declares. */
interface Cached {
  readonly flake: string
  readonly derivations: Record<string, Derivation | null>
  /** `lib.project.project`, once a plan of this revision read it. */
  readonly app?: string | null
}

/**
 * Whether any derivation in the closure of `drvs` mentions one of `marks`, so the flake read the commit
 * and another commit of the same tree evaluates to other derivations. A mark that turns up by chance,
 * or a closure that can't be read, only costs an evaluation.
 */
const readsCommit = (drvs: ReadonlyArray<string>, marks: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (drvs.length === 0) return false
    const closure = (yield* Exec.run(["nix-store", "--query", "--requisites", ...drvs])).split("\n").filter((p) => p.endsWith(".drv"))
    return yield* Effect.try(() =>
      closure.some((drv) => {
        const text = readFileSync(drv, "utf8")
        return marks.some((mark) => text.includes(mark))
      })
    )
  }).pipe(Effect.orElseSucceed(() => true))

/**
 * The derivations an earlier commit with the same root tree evaluated to (`Earlier`, which the controller
 * hands a plan from runs this run may reuse), when they cover `attrs`, are still in the store, and don't
 * mention that commit. A merge of a pull request that was up to date then evaluates nothing: t3code
 * planned its merges in two minutes, mostly evaluating.
 */
export const fromEarlier = (
  earlier: Earlier,
  attrs: ReadonlyArray<string>,
  revision: {
    /** When the earlier commit was committed, or None when that couldn't be read. */
    readonly committed: Option.Option<number>
    /** The flake's Nix sources at this revision, by path. */
    readonly nix: ReadonlyMap<string, string>
  },
  log: Log = () => Effect.void,
) =>
  Effect.gen(function*() {
    if (!attrs.every((attr) => attr in earlier.derivations) || Option.isNone(revision.committed)) return undefined
    const counting = [...revision.nix].find(([, text]) => text.includes("revCount"))
    if (counting !== undefined) {
      yield* log(`${counting[0]} reads revCount, which differs for every commit, so the flake is evaluated again`)
      return undefined
    }
    const committed = revision.committed.value
    const drvs = attrs.flatMap((attr) => (earlier.derivations[attr] ? [earlier.derivations[attr].drv] : []))
    if (drvs.length > 0 && (yield* Exec.exec(["nix-store", "--check-validity", ...drvs])).exitCode !== 0) return undefined
    const short = earlier.revision.slice(0, 12)
    if (yield* readsCommit(drvs, marksOf(earlier.revision, committed))) {
      yield* log(`${short} has the same tree, but its derivations mention that commit, so the flake is evaluated again`)
      return undefined
    }
    yield* log(`${short} has the same tree, and its derivations don't mention that commit, so this plan reuses them`)
    return new Map(attrs.map((attr) => [attr, earlier.derivations[attr] ?? null]))
  })

/** What an earlier plan of the same tree evaluated, from a run this one may reuse. */
export interface Earlier {
  readonly revision: string
  readonly derivations: Readonly<Record<string, Derivation | null>>
  readonly app: string | null
}

/** What a plan evaluated: each attribute's derivation, null for one that throws, and Nix's reason for those that failed. */
export interface Evaluated {
  readonly derivations: ReadonlyMap<string, Derivation | null>
  readonly errors: ReadonlyMap<string, string>
}

/**
 * Evaluates every attribute's derivation, sharing one evaluator while it fits the job's memory (see
 * `evaluate`).
 *
 * A revision evaluates to the same derivations every time, and `--expr` bypasses Nix's eval cache:
 * a schedule that plans an unchanged head evaluated infra's hosts again each hour, 6.5 GB for four
 * minutes. `cacheDir` keeps one file per repository with the derivations of its last planned revision.
 * A plan of that revision whose attributes it holds, such as a schedule's subset of a push's, reuses
 * them while they are still in the store. Plans of one repository take turns: on srv-2 a push and a
 * schedule of the same head once evaluated infra side by side and swapped the host into a stall.
 */
export const derivations = (
  run: RunInfo,
  attrs: ReadonlyArray<string>,
  cacheDir = defaultCacheDir,
  log: Log = () => Effect.void,
  memory: Memory = jobMemory(),
) =>
  attrs.length === 0 ? Effect.succeed<Evaluated>({ derivations: new Map(), errors: new Map() }) : cached(run, cacheDir, (entry) =>
    Effect.gen(function*() {
      const known = entry?.derivations ?? {}
      // What the cache holds and the store still has; entries cached before derivations carried their
      // system don't count. Only the rest is evaluated, so an attribute that keeps failing costs its own
      // evaluation, not every attribute's.
      const cachedHere = attrs.filter((attr) => attr in known && (known[attr] === null || known[attr]?.system !== undefined))
      const drvs = cachedHere.flatMap((attr) => (known[attr] ? [known[attr].drv] : []))
      const invalid = drvs.length === 0 ? new Set<string>() : new Set(
        (yield* Exec.exec(["nix-store", "--check-validity", "--print-invalid", ...drvs])).stdout.split("\n").filter(Boolean),
      )
      const hits = new Map(cachedHere.filter((attr) => !known[attr] || !invalid.has(known[attr].drv)).map((attr) => [attr, known[attr] ?? null]))
      const missing = attrs.filter((attr) => !hits.has(attr))
      if (missing.length === 0) return { result: { derivations: hits, errors: new Map<string, string>() } as Evaluated, entry: {} }
      const evaluated = yield* evaluate(run.flake, missing, memory, log)
      const result: Evaluated = { derivations: new Map([...hits, ...evaluated.derivations]), errors: evaluated.errors }
      return { result, entry: { derivations: { ...known, ...Object.fromEntries(evaluated.derivations) } } }
    }))

/** Where the plan says what it reused or evaluated: the plan job's log. */
type Log = (text: string) => Effect.Effect<void>

/** The app the flake's `lib.project` declares, or null; cached like the derivations. */
export const appOf = (run: RunInfo, cacheDir = defaultCacheDir) =>
  cached(run, cacheDir, (entry) =>
    Effect.gen(function*() {
      if (entry?.app !== undefined) return { result: entry.app, entry: {} }
      const app = yield* Exec.run(["nix", "eval", "--raw", `${run.flake}#lib.project.project`]).pipe(
        Effect.map((name) => name.trim() || null),
        Effect.orElseSucceed(() => null),
      )
      return { result: app, entry: { app } }
    }))

const defaultCacheDir = join(homedir(), ".cache", "calder")

/** Hands `use` what the repository's cache file holds for this revision, under the repository's lock, and writes back what it adds. */
const cached = <A, E, R>(
  run: RunInfo,
  cacheDir: string,
  use: (entry: Cached | undefined) => Effect.Effect<{ readonly result: A; readonly entry: Partial<Cached> }, E, R>,
) =>
  Effect.gen(function*() {
    if (!/[?&]rev=/.test(run.flake)) return (yield* use(undefined)).result
    mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, `derivations-${sha256(run.flake.replace(/[?&]rev=[^&]*/, ""))}.json`)
    return yield* Effect.acquireUseRelease(
      lock(`${file}.lock`),
      () =>
        Effect.gen(function*() {
          const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Cached : undefined
          const entry = stored?.flake === run.flake ? stored : undefined
          const { result, entry: added } = yield* use(entry)
          if (Object.keys(added).length > 0) {
            const next: Cached = { ...(entry ?? { derivations: {} }), ...added, flake: run.flake }
            writeFileSync(`${file}.tmp`, JSON.stringify(next))
            renameSync(`${file}.tmp`, file)
          }
          return result
        }),
      (path) => Effect.sync(() => rmSync(path, { force: true })),
    )
  })

/** How much memory an evaluator may hold, and how to read what one holds. */
export interface Memory {
  /** Bytes, or null when nothing limits the job. */
  readonly budget: number | null
  /** The anonymous resident memory of a process, in bytes. */
  readonly resident: (pid: number) => number
  /** How often a running evaluator is checked against the budget. */
  readonly every: Duration.Input
}

/**
 * 80% of what the job's cgroup lets it use before systemd throttles it, less what this worker holds: the
 * smallest `memory.high`, else `memory.max`, of the cgroup and its ancestors. In a pull request's job
 * (MemoryHigh 3.5G) that is about 2.6 GiB.
 */
export const jobMemory = (root = "/sys/fs/cgroup", self = "/proc/self/cgroup"): Memory => {
  const read = (file: string) => {
    try {
      return Number(readFileSync(file, "utf8").trim())
    } catch {
      return Number.NaN
    }
  }
  let limit = Number.POSITIVE_INFINITY
  try {
    const path = /^0::(\/.*)$/m.exec(readFileSync(self, "utf8"))?.[1]
    for (let dir = join(root, path ?? ""); path !== undefined && dir.startsWith(root); dir = dirname(dir)) {
      // "max" reads as NaN.
      for (const value of [read(join(dir, "memory.high")), read(join(dir, "memory.max"))]) {
        if (Number.isFinite(value)) limit = Math.min(limit, value)
      }
      if (dir === root) break
    }
  } catch {
    // Not cgroup v2: nothing limits the job.
  }
  return {
    budget: Number.isFinite(limit) ? Math.floor((limit - process.memoryUsage().rss) * 0.8) : null,
    // Anonymous memory only: what the evaluator allocated, not the files it has mapped.
    resident: (pid) => {
      try {
        const kb = /^RssAnon:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]
        return kb === undefined ? 0 : Number(kb) * 1024
      } catch {
        return 0
      }
    },
    every: "1 second",
  }
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`

/** Stops an evaluator: between attributes when the next might not fit (`full`), or during one that outgrew the budget (`over`). */
class Stopped extends Schema.TaggedError<Stopped>("calder/Stopped")("Stopped", { reason: Schema.Literals(["full", "over"]) }) {}

/**
 * One `nix eval` that evaluates `attrs` in order and reports each derivation on stderr as it gets it, so
 * what it got counts even when it stops before the end. `largest` is the most an attribute added to an
 * evaluator so far, also in earlier ones. `error` is Nix's when it failed on the attribute after those it
 * got. Reports out of order, or missing although Nix succeeded, mean the expression no longer works with
 * this Nix: that fails like a flake that doesn't load, so nothing is cached.
 */
const evaluator = (flake: string, attrs: ReadonlyArray<string>, memory: Memory, largest: number) =>
  Effect.gen(function*() {
    const unexpected = (what: string) => new Exec.CommandFailed({ command: `nix eval of ${flake}`, exitCode: 0, stderr: `nix eval gave ${what}` })
    const reports = attrs.map((attr, i) => `(report ${i} f.${attr})`).join(" ")
    const expr = `let f = builtins.getFlake ${JSON.stringify(flake)};
      one = x: let t = builtins.tryEval (builtins.seq x.drvPath x); in
        if t.success then { drv = t.value.drvPath; out = t.value.outPath; system = t.value.system; } else null;
      report = i: x: builtins.trace "calder-derivation \${builtins.toJSON [i (one x)]}" null;
      in builtins.seq (builtins.seq f (builtins.trace "calder-flake" null)) (builtins.foldl' (_: x: x) null [ ${reports} ])`
    const got: Array<Derivation | null> = []
    const stderr: Array<string> = []
    let loaded = false
    let pid = 0
    let peak = 0
    let held = 0
    const resident = () => {
      const now = memory.resident(pid)
      peak = Math.max(peak, now)
      return now
    }
    const exit = yield* Exec.stream(["nix", "eval", "--json", "--expr", expr], {}, (stream, line) =>
      Effect.gen(function*() {
        const report = /^trace: calder-(flake|derivation)(?: (.*))?$/.exec(line)
        if (report === null) {
          if (stream === "stderr") stderr.push(line)
          if (stderr.length > 200) stderr.shift()
          return
        }
        if (report[1] === "flake") {
          loaded = true
          held = resident()
          return
        }
        const [index, derivation] = yield* Effect.try({
          try: () => JSON.parse(report[2]!) as [number, Derivation | null],
          catch: () => unexpected(`a report it can't read: ${line}`),
        })
        if (index !== got.length) return yield* unexpected(`attribute ${index} reported where ${got.length} belonged`)
        got.push(derivation)
        const now = resident()
        largest = Math.max(largest, now - held)
        held = now
        if (memory.budget !== null && got.length < attrs.length && now + largest > memory.budget) {
          return yield* new Stopped({ reason: "full" })
        }
      }), (id) => {
      pid = id
      return Effect.gen(function*() {
        while (memory.budget !== null) {
          yield* Effect.sleep(memory.every)
          if (resident() > memory.budget) return yield* new Stopped({ reason: "over" })
        }
      })
    }).pipe(
      Effect.catchTag("Stopped", (stopped) => Effect.succeed(stopped.reason)),
      // A signal, such as the kernel's OOM killer's SIGKILL, fails the exit code rather than giving one.
      Effect.catchTag("PlatformError", (e) => /receipt of signal/.test(String(e.cause ?? e.message)) ? Effect.succeed("killed" as const) : Effect.fail(e)),
    )
    if (exit !== 0 && exit !== "full" && exit !== "over" && exit !== "killed" && !loaded) {
      return yield* new Exec.CommandFailed({ command: `nix eval of ${flake}`, exitCode: exit, stderr: stderr.join("\n") })
    }
    if (exit === 0 && got.length < attrs.length) return yield* unexpected(`${attrs.length - got.length} attributes went unreported`)
    // Killed by a signal, such as the kernel's OOM killer (which takes the whole job instead unless its
    // unit sets OOMPolicy=continue): the attribute in flight counts as outgrowing the budget.
    const stop = exit === "full" || exit === "over" ? exit : exit === "killed" && got.length < attrs.length ? "over" as const
      : got.length === attrs.length ? "done" as const : "failed" as const
    // The attribute it stopped in had added at least this much.
    if (stop === "over" && memory.budget !== null) largest = Math.max(largest, memory.budget - held)
    // Nix's innermost error comes last.
    const error = stderr.map((line) => line.trim()).findLast((line) => line.startsWith("error:"))?.replace(/^error:\s*/, "") ?? ""
    return { got, stop, error, peak, largest, loaded }
  })

/** An attribute needs more memory to evaluate than the plan's job may use, even in an evaluator of its own. */
export class TooLarge extends Schema.TaggedError<TooLarge>("calder/TooLarge")("TooLarge", {
  attr: Schema.String,
  budget: Schema.Number,
}) {
  override get message() {
    const what = this.attr === loadingTheFlake ? "Loading the flake" : `Evaluating ${this.attr} alone`
    return `${what} took more than ${gib(this.budget)}, 80% of what the plan's job may use, ` +
      "so the plan stopped instead of swapping. Make the attribute cheaper to evaluate or give the pool's jobs more memory."
  }
}

/** What outgrew the budget when the evaluator hadn't loaded the flake yet. */
const loadingTheFlake = "loading the flake"

/**
 * Evaluates the attributes in order, sharing an evaluator between them, so what they have in common,
 * such as nixpkgs, is evaluated once: t3code's nine took 19 s of CPU in one evaluator and 66 s in one
 * each. An evaluator keeps every value it computed, though: infra's six hosts in one held 7 GB, more than
 * a pull request's job may use, which stalled its plans for an hour. So an evaluator stops between
 * attributes once the next, if it grows as much as the largest so far, might not fit the budget, and at
 * once when it outgrows it; a new one goes on where it stopped. An attribute that outgrows the budget in
 * an evaluator of its own fails the evaluation (`TooLarge`), since its build would swap as much. One that
 * fails in a way Nix can't catch, such as a missing attribute or an input that couldn't be fetched, gets one
 * more try in a fresh evaluator; failing again, it is left out of `derivations`, so nothing caches it, and
 * `errors` has Nix's reason. One that throws, which `tryEval` catches, is null.
 */
/** How long a failed attribute waits before its second try. */
const retryAfter = "2 seconds"

const evaluate = (flake: string, attrs: ReadonlyArray<string>, memory: Memory, log: Log) =>
  Effect.gen(function*() {
    const started = Date.now()
    const derivations = new Map<string, Derivation | null>()
    const errors = new Map<string, string>()
    const retried = new Set<string>()
    /** How many attributes failed for good with each error: one many share, such as an unreachable input, isn't retried. */
    const failedWith = new Map<string, number>()
    let done = 0
    let evaluators = 0
    let peak = 0
    let largest = 0
    while (done < attrs.length) {
      const rest = attrs.slice(done)
      const pass = yield* evaluator(flake, rest, memory, largest)
      evaluators++
      peak = Math.max(peak, pass.peak)
      largest = pass.largest
      pass.got.forEach((derivation, i) => derivations.set(rest[i]!, derivation))
      done += pass.got.length
      const next = rest[pass.got.length]
      if (next === undefined || pass.stop === "full" || (pass.stop === "over" && pass.got.length > 0)) continue
      if (pass.stop === "over") return yield* new TooLarge({ attr: pass.loaded ? next : loadingTheFlake, budget: memory.budget ?? 0 })
      if (!retried.has(next) && (failedWith.get(pass.error) ?? 0) < 2) {
        retried.add(next)
        // A fetch or the daemon may fail for a moment.
        yield* Effect.sleep(retryAfter)
        continue
      }
      errors.set(next, pass.error)
      failedWith.set(pass.error, (failedWith.get(pass.error) ?? 0) + 1)
      done++
      yield* log(`${next} did not evaluate: ${pass.error}`)
    }
    const budget = memory.budget === null ? "" : ` of ${gib(memory.budget)}`
    yield* log(`evaluated ${derivations.size} attributes of the flake in ${Date.now() - started} ms with ${evaluators} evaluators, holding at most ${gib(peak)}${budget}`)
    return { derivations, errors } as Evaluated
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Creates `path` holding this process's id, waiting while a live process holds it. A dead holder's lock is taken over. */
const lock = (path: string) =>
  Effect.gen(function*() {
    while (true) {
      try {
        writeFileSync(path, String(process.pid), { flag: "wx" })
        return path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      // The holder can release between our create and this read.
      const holder = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0
      if (holder > 0 && !alive(holder)) rmSync(path, { force: true })
      else if (holder > 0) yield* Effect.sleep("2 seconds")
    }
  })

const describeCmd = (run: Cmd.Cmd<unknown> | ((shard: Step.Shard) => Cmd.Cmd<unknown>), count: number) =>
  Cmd.show(typeof run === "function" ? run({ index: 1, count, files: ["<files>"] }) : run)

/**
 * Which planned builds each build uses: a build needs another when the other's derivation is in its
 * closure, keeping only direct links (`deps → release → gate`, not also `deps → gate`). Two steps of
 * the same derivation are one build to Nix and get no link.
 */
export const directUses = (
  builds: ReadonlyArray<{ readonly name: string; readonly drv: string }>,
  closures: ReadonlyMap<string, ReadonlySet<string>>,
) => {
  const uses = (a: (typeof builds)[number], b: (typeof builds)[number]) => a.drv !== b.drv && (closures.get(b.name)?.has(a.drv) ?? false)
  const edges = new Map<string, Array<string>>()
  for (const b of builds) {
    const direct = builds.filter((a) => uses(a, b) && !builds.some((c) => c !== a && uses(a, c) && uses(c, b)))
    if (direct.length > 0) edges.set(b.name, direct.map((a) => a.name))
  }
  return edges
}

const buildEdges = (builds: ReadonlyArray<{ readonly name: string; readonly drv: string }>) =>
  builds.length < 2
    ? Effect.succeed(new Map<string, Array<string>>())
    : Effect.forEach(builds, (b) =>
      Exec.run(["nix-store", "--query", "--requisites", b.drv]).pipe(
        Effect.map((out) => [b.name, new Set(out.split("\n").filter(Boolean))] as const),
        Effect.orElseSucceed(() => [b.name, new Set<string>()] as const),
      ), { concurrency: 4 }).pipe(Effect.map((closures) => directUses(builds, new Map(closures))))

/** Turns a plan into the wire format, resolving tree ids, dev shells and task keys at the revision. */
export const resolve = (plan: Calder.Plan, project: Calder.Project, run: RunInfo, repo: RepoAt, earlier?: Earlier) =>
  Effect.gen(function*() {
    yield* checkFiles(project, repo)
    const shared = project.shared === undefined ? [] : yield* paths(repo, project.shared)
    const builds = plan.steps.flatMap((p) => (p.step.def._tag === "Build" ? [Flake.attrPath(p.step.def.ref, run.system)] : []))
    const shells = [...new Set(plan.steps.flatMap((p) => {
      const def = p.step.def
      return (def._tag === "Task" || def._tag === "Setup") && def.shell !== undefined ? [Flake.attrPath(def.shell, run.system)] : []
    }))]
    const job = Option.getOrUndefined(yield* Effect.serviceOption(Job))
    const log: Log = (text) => job === undefined ? Effect.void : job.log("calder", text)
    const attrs = [...new Set([...builds, ...shells])]
    const reused = earlier === undefined ? undefined : yield* fromEarlier(earlier, attrs, {
      committed: yield* Repo.make(run.mirror, earlier.revision).pipe(Effect.flatMap((at) => at.committed), Effect.option),
      nix: yield* Effect.flatMap(repo.files, (files) => repo.read(files.filter((f) => f.endsWith(".nix")))),
    }, log)
    // When the flake fails to load, builds evaluate on their own when they run, but keys need the dev
    // shells now. An attribute too large to evaluate would swap as much in its build.
    const result = reused !== undefined ? { derivations: reused, errors: new Map<string, string>() } : yield* derivations(run, attrs, undefined, log).pipe(
      Effect.catchIf(
        (e) => e._tag !== "TooLarge",
        (e) =>
          log(`the flake did not load, so only the dev shells are evaluated: ${
            e._tag === "CommandFailed" ? e.stderr.trim().split("\n").slice(-3).join(" ") : e.message
          }`).pipe(Effect.andThen(derivations(run, shells, undefined, log))).pipe(
            Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds"), while: (e) => e._tag !== "TooLarge" }),
          ),
      ),
      Effect.mapError((e) =>
        new Calder.PlanError({
          message: e._tag === "TooLarge" ? e.message : `Nix could not evaluate the dev shells ${shells.join(", ")}, which task keys include: ${
            e._tag === "CommandFailed" ? e.stderr.trim().split("\n").slice(-10).join("\n") : e.message
          }`,
        })
      ),
    )
    const evaluated = result.derivations
    const broken = shells.filter((shell) => !evaluated.get(shell))
    if (broken.length > 0) {
      const why = broken.map((shell) => `${shell}: ${result.errors.get(shell) || "it threw"}`).join("; ")
      return yield* new Calder.PlanError({ message: `A dev shell did not evaluate, and task keys include it. ${why}` })
    }
    const toolchainOf = (shell: string | null) => (shell === null ? null : evaluated.get(shell)!.drv)
    const dependencies = (yield* repo.entries).filter((e) => dependencyFiles.some((re) => re.test(e.path)))
    const uses = yield* buildEdges(plan.steps.flatMap((p) => {
      const def = p.step.def
      const derivation = def._tag === "Build" ? evaluated.get(Flake.attrPath(def.ref, run.system)) : undefined
      return derivation ? [{ name: p.name, drv: derivation.drv }] : []
    }))

    // A setup's key covers what its prepared workspace depends on; its tasks start from it.
    const setupKeys = new Map(yield* Effect.forEach(plan.steps.filter((p) => p.step.def._tag === "Setup"), (p) =>
      Effect.gen(function*() {
        const def = p.step.def
        if (def._tag !== "Setup") return [p.name, ""] as const
        const inputs = (yield* paths(repo, def.inputs)).slice().sort()
        const ids = yield* repo.objectIds(inputs)
        const shell = def.shell === undefined ? null : Flake.attrPath(def.shell, run.system)
        return [p.name, sha256({
          kind: "setup",
          inputs: inputs.map((path) => [path, ids.get(path) ?? null]),
          toolchain: toolchainOf(shell),
          command: Cmd.show(def.run),
          keep: def.keep,
          path: def.path,
          env: Object.entries(def.env).sort(),
          platform: def.platform ?? null,
        })] as const
      })))

    const steps = yield* Effect.forEach(plan.steps, (p) =>
      Effect.gen(function*() {
        const def = p.step.def
        const base = {
          name: p.name,
          kind: p.kind,
          needs: [...p.needs, ...(uses.get(p.name) ?? []).filter((n) => !p.needs.includes(n))],
          exits: p.exits,
          after: p.after,
          required: p.required,
          target: p.target,
          neverReuse: p.neverReuse || (def._tag === "Task" && def.reuse === "never"),
          build: null,
          setup: null,
          task: null,
          action: null,
          output: null,
        } satisfies Partial<PlannedStep>
        switch (def._tag) {
          case "Build": {
            const attr = Flake.attrPath(def.ref, run.system)
            const derivation = evaluated.get(attr) ?? null
            return { ...base, detail: attr, build: { attr, drv: derivation?.drv ?? null, out: derivation?.out ?? null, system: derivation?.system ?? null } }
          }
          case "Setup":
            return {
              ...base,
              detail: Cmd.show(def.run),
              setup: { deps: setupKeys.get(p.name)!, platform: def.platform ?? null },
            }
          case "Output":
            return {
              ...base,
              detail: `${def.task.name}.outputs.${def.output}`,
              output: { task: def.task.name, output: def.output },
            }
          case "Action":
            return {
              ...base,
              detail: p.name,
              action: { deploy: def.grants.deploy === true, secrets: [...(def.grants.secrets ?? [])], preview: p.preview },
            }
          case "Task": {
            const inputs = [...new Set([...(yield* paths(repo, def.inputs)), ...shared])].sort()
            const ids = yield* repo.objectIds(inputs)
            const split = def.shards?.split === undefined ? [] : yield* paths(repo, def.shards.split)
            const splitIds = split.length === 0 ? new Map<string, string>() : yield* repo.objectIds(split)
            const shell = def.shell === undefined ? null : Flake.attrPath(def.shell, run.system)
            const toolchain = toolchainOf(shell)
            const count = def.shards?.count ?? 1
            const command = typeof def.run === "function" ? def.run({ index: 1, count, files: [] }) : def.run
            const setup = def.setup === undefined ? null : setupKeys.get(def.setup.name)!
            const keyBase = sha256({
              kind: "task",
              inputs: inputs.map((path) => [path, ids.get(path) ?? null]),
              split: split.map((path) => [path, splitIds.get(path) ?? null]),
              toolchain,
              setup,
              command: describeCmd(def.run, count),
              env: Object.entries(def.env).sort(),
              secrets: Object.entries(def.secrets).map(([env, ref]) => [env, ref.name]).sort(),
              // Two pull requests with the same trees must not share a preview's result. Absent otherwise,
              // so the keys of tasks that don't read it stay what they were.
              ...(command.pullRequest ? { pullRequest: Event.pullRequestNumber(run.event) ?? null } : {}),
              // Absent without artifacts, so the keys of tasks without them stay what they were.
              ...(Object.keys(def.artifacts).length === 0 ? {} : { artifacts: Object.entries(def.artifacts).map(([env, s]) => [env, s.name]).sort() }),
              report: def.report ?? null,
              outputs: Object.entries(def.outputs).sort(),
              shards: def.shards?.count ?? null,
              platform: def.platform ?? null,
            })
            return {
              ...base,
              detail: describeCmd(def.run, count),
              task: {
                shell,
                keyBase,
                inputs,
                interpolates: [...new Set([...command.steps, ...Object.values(def.artifacts)].map((s) => s.name))],
                shards: def.shards?.count ?? null,
                each: def.each === undefined ? null : yield* eachKeys(repo, def.each, keyBase),
                deps: setup ?? sha256({ dependencies: dependencies.map((e) => [e.path, e.oid]), toolchain }),
                outputs: Object.keys(def.outputs),
                secrets: [...Step.taskSecrets(def)],
                platform: def.platform ?? null,
                offload: def.offload !== false,
                preview: p.preview,
                lease: def.lease ?? false,
              },
            }
          }
        }
      }), { concurrency: 4 })

    const app = reused !== undefined && earlier !== undefined ? earlier.app : yield* appOf(run)
    const spec: PlanSpec = {
      version: 1,
      app,
      trust: plan.trust,
      reuse: plan.reuse,
      schedules: plan.schedules,
      steps,
      derivations: Object.fromEntries(evaluated),
    }
    return spec
  })
