import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Cmd, Event, Files, Flake, Calder, Step } from "@calder-ci/core"
import { type Duration, Effect, Option, Schedule, Schema } from "effect"
import { randomBytes } from "node:crypto"
import * as Exec from "../Exec.ts"
import { sha256 } from "../Keys.ts"
import type { Mismatch, PlannedStep, PlanSpec, Records, RunInfo } from "../Protocol.ts"
import { Job } from "./Client.ts"
import * as Footprint from "./Footprint.ts"
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
  /** The footprints its evaluators recorded, when it had a recorder. */
  readonly recorded?: Records
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
  options: {
    /** Records footprints of what it evaluates. */
    readonly recorder?: Recorder | undefined
    /** Evaluates even what the cache holds, as an audit does. */
    readonly fresh?: boolean
  } = {},
) =>
  attrs.length === 0 ? Effect.succeed<Evaluated>({ derivations: new Map(), errors: new Map() }) : cached(run, cacheDir, (entry) =>
    Effect.gen(function*() {
      const known = entry?.derivations ?? {}
      // What the cache holds and the store still has; entries cached before derivations carried their
      // system don't count. Only the rest is evaluated, so an attribute that keeps failing costs its own
      // evaluation, not every attribute's. An audit (`fresh`) evaluates everything.
      const cachedHere = options.fresh === true
        ? []
        : attrs.filter((attr) => attr in known && (known[attr] === null || known[attr]?.system !== undefined))
      const drvs = cachedHere.flatMap((attr) => (known[attr] ? [known[attr].drv] : []))
      const invalid = drvs.length === 0 ? new Set<string>() : new Set(
        (yield* Exec.exec(["nix-store", "--check-validity", "--print-invalid", ...drvs])).stdout.split("\n").filter(Boolean),
      )
      const hits = new Map(cachedHere.filter((attr) => !known[attr] || !invalid.has(known[attr].drv)).map((attr) => [attr, known[attr] ?? null]))
      const missing = attrs.filter((attr) => !hits.has(attr))
      if (missing.length === 0) return { result: { derivations: hits, errors: new Map<string, string>() } as Evaluated, entry: {} }
      // Recording that fails, such as strace without ptrace, leaves the plan to evaluate as before.
      const evaluated = yield* evaluate(run.flake, missing, memory, log, options.recorder).pipe(
        Effect.catchTag("CommandFailed", (e) =>
          options.recorder === undefined
            ? Effect.fail(e)
            : log(`recording what Nix read failed, so this plan records nothing: ${e.stderr.trim().split("\n").slice(-3).join(" ")}`).pipe(
              Effect.andThen(evaluate(run.flake, missing, memory, log)),
            )
        ),
      )
      const result: Evaluated = {
        derivations: new Map([...hits, ...evaluated.derivations]),
        errors: evaluated.errors,
        ...(evaluated.recorded === undefined ? {} : { recorded: evaluated.recorded }),
      }
      return { result, entry: { derivations: { ...known, ...Object.fromEntries(evaluated.derivations) } } }
    }))

/** Where the plan says what it reused or evaluated: the plan job's log. */
type Log = (text: string) => Effect.Effect<void>

/** The app the flake's `lib.project` declares, or null; cached like the derivations. */
export const appOf = (run: RunInfo, cacheDir = defaultCacheDir, recorder?: Recorder, fresh = false) =>
  cached(run, cacheDir, (entry) =>
    Effect.gen(function*() {
      if (entry?.app !== undefined && !fresh) return { result: { app: entry.app, recorded: undefined }, entry: {} }
      if (recorder === undefined) {
        const app = yield* Exec.run(["nix", "eval", "--raw", `${run.flake}#lib.project.project`]).pipe(
          Effect.map((name) => name.trim() || null),
          Effect.orElseSucceed(() => null),
        )
        return { result: { app, recorded: undefined }, entry: { app } }
      }
      // Recorded like an attribute, so a plan whose footprint of it holds needs no Nix for it either.
      const scratch = mkdtempSync(join(tmpdir(), "calder-footprint-"))
      const expr = `let p = (builtins.getFlake ${JSON.stringify(recorder.url)}).lib.project.project or null; in if builtins.isString p then p else null`
      const out = yield* Exec.exec([...straced(join(scratch, "trace")), "nix", "eval", "--json", "--expr", expr], {
        env: { ...process.env, NIX_CACHE_HOME: join(scratch, "cache"), XDG_CACHE_HOME: join(scratch, "cache") },
      }).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })))
      const trace = yield* Effect.sync(() => {
        try {
          return Footprint.parseTrace(readFileSync(join(scratch, "trace"), "utf8"), recorder.source, recorder.nonce)
        } catch {
          return undefined
        } finally {
          rmSync(scratch, { recursive: true, force: true })
        }
      })
      const app = out.exitCode === 0 ? (JSON.parse(out.stdout) as string | null) || null : null
      const pass = out.exitCode === 0 && trace !== undefined
        ? Footprint.footprints({ ...trace, marks: [trace.touches.length] }, recorder.at)
        : undefined
      const count = pass?.counts[0]
      const kept = pass === undefined || count === undefined || count === null ? [] : yield* vetted(recorder, [
        { attr: appAttr, index: 0, count, entries: pass.entries, derivation: null, outside: trace!.outside.map(([p]) => p) },
      ])
      const recorded: Records | undefined = pass === undefined || count === undefined || count === null || kept.length === 0 ? undefined : {
        footprints: [{ id: "app", revision: recorder.revision, entries: pass.entries }],
        evaluations: [{ attr: appAttr, footprint: "app", count, digest: Footprint.digest(recorder.at, pass.entries, count, recorder.context), derivation: null, app }],
      }
      return { result: { app, recorded }, entry: { app } }
    }))

/** The attribute a plan reads the app's name from, recorded like the derivations. */
const appAttr = "lib.project.project"

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
    // The process and its children: under the recorder, nix runs below strace.
    resident: (pid) => {
      const tree = (id: number): ReadonlyArray<number> => {
        try {
          const children = readFileSync(`/proc/${id}/task/${id}/children`, "utf8").trim().split(/\s+/).filter(Boolean)
          return [id, ...children.flatMap((child) => tree(Number(child)))]
        } catch {
          return [id]
        }
      }
      return tree(pid).reduce((sum, id) => {
        try {
          const kb = /^RssAnon:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${id}/status`, "utf8"))?.[1]
          return sum + (kb === undefined ? 0 : Number(kb) * 1024)
        } catch {
          return sum
        }
      }, 0)
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
const evaluator = (flake: string, attrs: ReadonlyArray<string>, memory: Memory, largest: number, recorder?: Recorder) =>
  Effect.gen(function*() {
    const unexpected = (what: string) => new Exec.CommandFailed({ command: `nix eval of ${flake}`, exitCode: 0, stderr: `nix eval gave ${what}` })
    const reports = attrs.map((attr, i) => `(report ${i} f.${attr})`).join(" ")
    // Under the recorder, a lookup of a marker that doesn't exist follows each attribute, after its value.
    const mark = recorder === undefined ? "" : `builtins.seq (builtins.pathExists "\${f.outPath}/.calder-derivation-${recorder.nonce}-\${toString i}")`
    const expr = `let f = builtins.getFlake ${JSON.stringify(recorder?.url ?? flake)};
      one = x: let t = builtins.tryEval (builtins.seq x.drvPath x); in
        if t.success then { drv = t.value.drvPath; out = t.value.outPath; system = t.value.system; } else null;
      report = i: x: let v = builtins.toJSON [i (one x)]; in builtins.seq v (${mark} (builtins.trace "calder-derivation \${v}" null));
      in builtins.seq (builtins.seq f (builtins.trace "calder-flake" null)) (builtins.foldl' (_: x: x) null [ ${reports} ])`
    const scratch = recorder === undefined ? undefined : mkdtempSync(join(tmpdir(), "calder-footprint-"))
    const nix = ["nix", "eval", "--json", "--expr", expr]
    const argv = scratch === undefined ? nix : [...straced(join(scratch, "trace")), ...nix]
    // An empty fetcher cache, so no cached hash of a copied path hides that the evaluation read its files.
    // Nix 2.34 reads NIX_CACHE_HOME before XDG_CACHE_HOME.
    const env = scratch === undefined ? {} : { env: { ...process.env, NIX_CACHE_HOME: join(scratch, "cache"), XDG_CACHE_HOME: join(scratch, "cache") } }
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
    const exit = yield* Exec.stream(argv, env, (stream, line) =>
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
      Effect.ensuring(Effect.sync(() => scratch === undefined ? undefined : rmSync(join(scratch, "cache"), { recursive: true, force: true }))),
    )
    const trace = scratch === undefined ? undefined : yield* Effect.sync(() => {
      try {
        return Footprint.parseTrace(readFileSync(join(scratch, "trace"), "utf8"), recorder!.source, recorder!.nonce)
      } catch {
        return undefined
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
    // Killed before the flake loaded under the recorder, such as strace by a signal: the recording failed,
    // and the plan evaluates without it. Without the recorder, loading the flake outgrew the memory.
    if (exit !== 0 && exit !== "full" && exit !== "over" && !loaded && (exit !== "killed" || recorder !== undefined)) {
      return yield* new Exec.CommandFailed({ command: `nix eval of ${flake}`, exitCode: exit === "killed" ? -1 : exit, stderr: stderr.join("\n") })
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
    return { got, stop, error, peak, largest, loaded, trace }
  })

/** Runs a command under strace, writing the source accesses Footprint.parseTrace reads to `file`. */
const straced = (file: string) => [
  "strace", "-f", "-qq", "--seccomp-bpf", "-s", "4096", "-e", "signal=none", "-o", file,
  "-e", "trace=?open,openat,?openat2,?stat,?lstat,?newfstatat,?statx,?access,?faccessat,?faccessat2,?readlinkat,?readlink",
]

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

const evaluate = (flake: string, attrs: ReadonlyArray<string>, memory: Memory, log: Log, recorder?: Recorder) =>
  Effect.gen(function*() {
    const started = Date.now()
    const passes: Array<{ readonly attrs: ReadonlyArray<string>; readonly trace: Footprint.Trace | undefined }> = []
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
      const pass = yield* evaluator(flake, rest, memory, largest, recorder)
      if (recorder !== undefined) passes.push({ attrs: rest.slice(0, pass.got.length), trace: pass.trace })
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
    if (recorder === undefined) return { derivations, errors } as Evaluated
    const recorded = yield* records(recorder, passes, derivations)
    yield* log(`recorded footprints of ${recorded.evaluations.length} of ${attrs.length} attributes`)
    return { derivations, errors, recorded } as Evaluated
  })

/** What a plan records footprints with: the source in the store, the `path:` URL that reads it there, and its git tree. */
export interface Recorder {
  readonly source: string
  readonly url: string
  readonly revision: string
  readonly at: Footprint.Tree
  /** What a derivation that depends on this commit or on the whole source contains (see `marksOf`). */
  readonly marks: ReadonlyArray<string>
  /** The source's NAR hash: a store path with it is the source under another name. */
  readonly narHash: string
  /** Store paths a read of which `flake.lock` pins or that are Nix's own: the inputs and Nix's closure. */
  readonly pinned: ReadonlySet<string>
  /** What else decides an evaluation's result (`evaluationContext`), which every digest covers. */
  readonly context: string
  /** In each marker's name, so flake code can't forge one. */
  readonly nonce: string
  readonly read: (paths: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>, Error>
}

/**
 * What besides the files it read decides an evaluation's result: Nix's version, the system it evaluates
 * for, and the settings that change what evaluates (import from derivation, and whatever `NIX_CONFIG`
 * sets). A record made under another counts nowhere.
 */
export const evaluationContext = (system: string) =>
  Effect.gen(function*() {
    const version = (yield* Exec.run(["nix", "--version"])).trim()
    const ifd = (yield* Exec.run(["nix", "config", "show", "allow-import-from-derivation"]).pipe(Effect.orElseSucceed(() => "?"))).trim()
    return sha256({ version, system, ifd, config: process.env.NIX_CONFIG ?? "" })
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * A recorder for the run's revision, or none where Calder can't record: not Linux, no strace, or a flake
 * Nix won't describe. Without one, a plan evaluates as before and records nothing. `path:<source>` with the
 * commit's `rev`, `revCount`, `lastModified` and `narHash` evaluates to the same derivations as the mirror's
 * `git+file:` URL, but Nix reads its files from the store, where strace sees them.
 */
export const recorder = (run: RunInfo, repo: RepoAt) =>
  Effect.gen(function*() {
    if (process.platform !== "linux" || !/[?&]rev=/.test(run.flake)) return undefined
    if ((yield* Exec.exec(["strace", "-V"])).exitCode !== 0) return undefined
    const { path, locked } = JSON.parse(yield* Exec.run(["nix", "flake", "metadata", "--json", run.flake])) as {
      readonly path?: string
      readonly locked?: { readonly rev?: string; readonly revCount?: number; readonly lastModified?: number; readonly narHash?: string }
    }
    if (path === undefined || locked?.rev === undefined || locked.lastModified === undefined || locked.narHash === undefined) return undefined
    const context = yield* evaluationContext(run.system)
    if (context === undefined) return undefined
    // The inputs flake.lock pins, and Nix's own closure (its libraries and data).
    const archive = JSON.parse(yield* Exec.run(["nix", "flake", "archive", "--json", "--dry-run", run.flake])) as unknown
    const inputs = (node: unknown): ReadonlyArray<string> => {
      const n = node as { readonly path?: string; readonly inputs?: Record<string, unknown> } | null
      return n === null || typeof n !== "object" ? [] : [...(n.path === undefined ? [] : [n.path]), ...Object.values(n.inputs ?? {}).flatMap(inputs)]
    }
    const own = (yield* Exec.run(["sh", "-c", "nix-store --query --requisites \"$(readlink -f \"$(command -v nix)\")\""])).split("\n").filter(Boolean)
    const query = [
      `rev=${locked.rev}`,
      ...(locked.revCount === undefined ? [] : [`revCount=${locked.revCount}`]),
      `lastModified=${locked.lastModified}`,
      `narHash=${encodeURIComponent(locked.narHash)}`,
    ].join("&")
    return {
      source: path,
      url: `path:${path}?${query}`,
      revision: locked.rev,
      at: Footprint.tree(yield* repo.entries),
      marks: [...marksOf(locked.rev, locked.lastModified), locked.narHash, path],
      narHash: locked.narHash,
      pinned: new Set([...inputs(archive).filter((p) => p !== path), ...own]),
      context,
      nonce: randomBytes(8).toString("hex"),
      read: repo.read,
    } satisfies Recorder
  }).pipe(Effect.orElseSucceed(() => undefined))

/** A footprint that might become a record: an attribute of an evaluator, with what it read of the store. */
export interface Candidate {
  readonly attr: string
  readonly index: number
  readonly count: number
  readonly entries: ReadonlyArray<readonly [string, Footprint.Access]>
  readonly outside: ReadonlyArray<string>
  readonly derivation: Derivation | null
}

/**
 * The candidates one may trust. Not one whose derivation's closure mentions the commit or the whole
 * source (`self.rev`, `src = self`), nor one that read a store path whose deriver does (import from a
 * derivation built from `self`), nor one that read a store path whose deriver Nix doesn't know, nor one
 * whose footprint read a file mentioning `revCount`: another commit with the same footprint evaluates to
 * something else then.
 */
export const vetted = (recorder: Recorder, candidates: ReadonlyArray<Candidate>) =>
  Effect.gen(function*() {
    const nix = [...new Set(candidates.flatMap((c) => c.entries.slice(0, c.count).filter(([p, a]) => a === "read" && p.endsWith(".nix")).map(([p]) => p)))]
    const sources = yield* recorder.read(nix).pipe(Effect.orElseSucceed(() => undefined))
    const counting = sources === undefined ? new Set(nix) : new Set([...sources].filter(([, text]) => text.includes("revCount")).map(([p]) => p))
    const foreign = [...new Set(candidates.flatMap((c) => c.outside))].filter((p) => !recorder.pinned.has(p))
    const derivers = yield* derivers_(foreign)
    // Without a deriver, a path the evaluation itself wrote by content (`builtins.toFile`, a fixed-output
    // fetch) is a function of what it read, unless it refers to the source or mentions the commit.
    const unknown = foreign.filter((p) => derivers.get(p) === null)
    const byContent = yield* contentAddressed(unknown, recorder)
    const roots = (c: Candidate) => [
      ...(c.derivation === null ? [] : [c.derivation.drv]),
      ...c.outside.filter((p) => !recorder.pinned.has(p) && !byContent.has(p)).map((p) => derivers.get(p) ?? null),
    ]
    const all = [...new Set(candidates.flatMap(roots).filter((d): d is string => d !== null))]
    const marked = yield* commitBound(all, recorder)
    return candidates.filter((c) =>
      roots(c).every((root) => root !== null && !marked.has(root)) &&
      !c.entries.slice(0, c.count).some(([p, a]) => a === "read" && counting.has(p))
    )
  })

/**
 * Of `paths`, those that are content-addressed (`ca` text or fixed), aren't a copy of the source (its NAR
 * hash), refer to nothing but other store paths than the source, and whose text doesn't mention the commit.
 */
const contentAddressed = (paths: ReadonlyArray<string>, recorder: Recorder) =>
  Effect.gen(function*() {
    const infos = yield* pathInfo(paths)
    return new Set([...infos].filter(([path, info]) => {
      if (!info.ca?.startsWith("text:") && !info.ca?.startsWith("fixed:")) return false
      // A copy of the whole source under another name is the source.
      if (info.narHash === recorder.narHash || (info.references ?? []).includes(recorder.source)) return false
      if (!info.ca.startsWith("text:")) return true
      try {
        const text = readFileSync(path, "utf8")
        return !recorder.marks.some((mark) => text.includes(mark))
      } catch {
        return false
      }
    }).map(([path]) => path))
  })

/** The derivation each store path came from: itself for a derivation, null where Nix doesn't know one. */
const derivers_ = (paths: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const out = new Map<string, string | null>(paths.filter((p) => p.endsWith(".drv")).map((p) => [p, p]))
    const rest = paths.filter((p) => !out.has(p))
    if (rest.length === 0) return out
    const lines = (yield* Exec.run(["nix-store", "--query", "--deriver", ...rest]).pipe(Effect.orElseSucceed(() => ""))).split("\n")
    rest.forEach((p, i) => out.set(p, lines[i]?.endsWith(".drv") ? lines[i]! : null))
    return out
  })

/**
 * The records an evaluation leaves: a footprint per evaluator, and for each attribute it got that one
 * may trust (`vetted`), how much of it is the attribute's and its identities' digest.
 */
const records = (
  recorder: Recorder,
  passes: ReadonlyArray<{ readonly attrs: ReadonlyArray<string>; readonly trace: Footprint.Trace | undefined }>,
  derivations: ReadonlyMap<string, Derivation | null>,
) =>
  Effect.gen(function*() {
    const candidates = passes.flatMap((pass, index): ReadonlyArray<Candidate> => {
      if (pass.trace === undefined) return []
      const trace = pass.trace
      const { entries, counts } = Footprint.footprints(trace, recorder.at)
      return pass.attrs.flatMap((attr, i) => {
        const count = counts[i]
        const derivation = derivations.get(attr)
        if (count === undefined || count === null || derivation === undefined) return []
        return [{ attr, index, count, entries, derivation, outside: trace.outside.filter(([, before]) => before <= i).map(([p]) => p) }]
      })
    })
    const kept = yield* vetted(recorder, candidates)
    const used = [...new Set(kept.map((c) => c.index))]
    return {
      footprints: used.map((index) => ({ id: String(index), revision: recorder.revision, entries: kept.find((c) => c.index === index)!.entries })),
      evaluations: kept.map((c) => ({
        attr: c.attr,
        footprint: String(c.index),
        count: c.count,
        digest: Footprint.digest(recorder.at, c.entries, c.count, recorder.context),
        derivation: c.derivation,
      })),
    } satisfies Records
  })

/**
 * Of `drvs`, those whose closure depends on the commit or the whole source: a derivation in it mentions one
 * of `recorder.marks`, a text file in it does (`builtins.toFile "rev" self.rev`), or a source in it is a copy
 * of the whole source under another name (`builtins.path { path = self; name = "src"; }`, whose NAR hash is
 * the source's). A closure that can't be read counts as bound, which only costs an evaluation later.
 */
const commitBound = (drvs: ReadonlyArray<string>, recorder: Pick<Recorder, "marks" | "narHash">) =>
  Effect.gen(function*() {
    const closures = yield* Effect.forEach(drvs, (drv) =>
      Exec.run(["nix-store", "--query", "--requisites", drv]).pipe(
        Effect.map((out) => [drv, out.split("\n").filter(Boolean)] as const),
        Effect.orElseSucceed(() => [drv, null] as const),
      ), { concurrency: 4 })
    const mentions = (path: string) => {
      try {
        const text = readFileSync(path, "utf8")
        return recorder.marks.some((mark) => text.includes(mark))
      } catch {
        return true
      }
    }
    const sources = [...new Set(closures.flatMap(([, closure]) => (closure ?? []).filter((p) => !p.endsWith(".drv"))))]
    const infos = yield* pathInfo(sources)
    const bound = new Map<string, boolean>()
    const check = (path: string) => {
      let known = bound.get(path)
      if (known === undefined) {
        if (path.endsWith(".drv")) known = mentions(path)
        else {
          const info = infos.get(path)
          known = info === undefined || info.narHash === recorder.narHash || (info.ca?.startsWith("text:") === true && mentions(path))
        }
        bound.set(path, known)
      }
      return known
    }
    return new Set(closures.filter(([, closure]) => closure === null || closure.some(check)).map(([drv]) => drv))
  })

/** `nix path-info` of store paths: how each is addressed, its NAR hash and references. */
const pathInfo = (paths: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const infos = new Map<string, { readonly ca?: string | null; readonly narHash?: string; readonly references?: ReadonlyArray<string> }>()
    for (let i = 0; i < paths.length; i += 500) {
      const out = yield* Exec.run(["nix", "path-info", "--json", ...paths.slice(i, i + 500)]).pipe(Effect.orElseSucceed(() => "{}"))
      const parsed = JSON.parse(out) as Record<string, { readonly ca?: string | null; readonly narHash?: string; readonly references?: ReadonlyArray<string> } | null> |
        ReadonlyArray<{ readonly path: string; readonly ca?: string | null; readonly narHash?: string; readonly references?: ReadonlyArray<string> }>
      for (const info of Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([path, info]) => ({ path, ...info }))) {
        if (info !== null) infos.set(info.path, info)
      }
    }
    return infos
  })

/**
 * Attributes whose recorded footprint holds at the revision `at` describes, under the evaluation context
 * `context`, with the derivation they evaluated to and the record's id. Records come newest first; the
 * first that holds counts.
 */
export const fromRecords = (records: Records, attrs: ReadonlyArray<string>, at: Footprint.Tree, context: string) => {
  const footprints = new Map(records.footprints.map((f) => [f.id, f]))
  const held = new Map<string, { readonly derivation: Derivation | null; readonly id: number | undefined }>()
  for (const evaluation of records.evaluations) {
    const footprint = footprints.get(evaluation.footprint)
    if (held.has(evaluation.attr) || !attrs.includes(evaluation.attr) || footprint === undefined) continue
    if (Footprint.digest(at, footprint.entries, evaluation.count, context) === evaluation.digest) {
      held.set(evaluation.attr, { derivation: evaluation.derivation, id: evaluation.id })
    }
  }
  return held
}

/**
 * Orders attributes so that each comes after those its last derivation depends on (`closures`, by
 * attribute): an attribute's footprint is a prefix of its evaluator's, so a lockfile's dependencies
 * evaluated after the app build that uses them would carry all the app's files, although they read only
 * the lockfile. Dependencies first, each footprint holds what it adds. Ties keep their order, dev shells
 * first; attributes without a last derivation go last.
 */
export const byDependencies = (
  attrs: ReadonlyArray<string>,
  closures: ReadonlyMap<string, { readonly drv: string; readonly closure: ReadonlySet<string> }>,
  own: ReadonlyMap<string, number> = new Map(),
) => {
  const placed: Array<string> = []
  const remaining = attrs.filter((attr) => closures.has(attr))
  while (remaining.length > 0) {
    // Of those whose closure contains no other remaining attribute's derivation, the one that read least itself.
    const ready = remaining.filter((attr) =>
      !remaining.some((other) => other !== attr && closures.get(attr)!.closure.has(closures.get(other)!.drv))
    )
    const next = (ready.length > 0 ? ready : remaining).reduce((a, b) => ((own.get(b) ?? 0) < (own.get(a) ?? 0) ? b : a))
    placed.push(...remaining.splice(remaining.indexOf(next), 1))
  }
  return [...placed, ...attrs.filter((attr) => !closures.has(attr))]
}

/**
 * How much each attribute's last evaluation read beyond the attributes before it in its evaluator: its own
 * part of the footprint.
 */
export const ownReads = (records: Records | undefined) => {
  const own = new Map<string, number>()
  const byFootprint = new Map<string, Array<Records["evaluations"][number]>>()
  for (const e of records?.evaluations ?? []) byFootprint.set(e.footprint, [...(byFootprint.get(e.footprint) ?? []), e])
  for (const evaluations of byFootprint.values()) {
    let before = 0
    for (const e of [...evaluations].sort((a, b) => a.count - b.count)) {
      own.set(e.attr, e.count - before)
      before = e.count
    }
  }
  return own
}


/** The closures of the derivations `records` say `attrs` evaluated to last, for `byDependencies`. */
const lastClosures = (attrs: ReadonlyArray<string>, records: Records | undefined) =>
  Effect.gen(function*() {
    const last = new Map<string, string>()
    for (const e of records?.evaluations ?? []) {
      if (e.derivation !== null && attrs.includes(e.attr) && !last.has(e.attr)) last.set(e.attr, e.derivation.drv)
    }
    const closures = yield* Effect.forEach([...last], ([attr, drv]) =>
      Exec.run(["nix-store", "--query", "--requisites", drv]).pipe(
        Effect.map((out) => [[attr, { drv, closure: new Set(out.split("\n").filter(Boolean)) }] as const]),
        Effect.orElseSucceed(() => []),
      ), { concurrency: 4 })
    return new Map(closures.flat())
  })

/** The app's name from a record whose footprint holds, if one does. */
const appFromRecords = (records: Records, at: Footprint.Tree, context: string) => {
  const footprints = new Map(records.footprints.map((f) => [f.id, f]))
  const evaluation = records.evaluations.find((e) => {
    const footprint = footprints.get(e.footprint)
    return e.attr === appAttr && e.app !== undefined && footprint !== undefined && Footprint.digest(at, footprint.entries, e.count, context) === e.digest
  })
  return evaluation === undefined ? undefined : { app: evaluation.app ?? null, id: evaluation.id }
}

/** Of the held derivations, those still in the store: a collected one has to be instantiated again. */
const inStore = <A extends { readonly derivation: Derivation | null }>(held: ReadonlyMap<string, A>) =>
  Effect.gen(function*() {
    const drvs = [...held.values()].flatMap((h) => (h.derivation === null ? [] : [h.derivation.drv]))
    if (drvs.length === 0) return held
    const out = yield* Exec.exec(["nix-store", "--check-validity", "--print-invalid", ...drvs])
    if (out.exitCode !== 0) return new Map<string, A>()
    const invalid = new Set(out.stdout.split("\n").filter(Boolean))
    return new Map([...held].filter(([, h]) => h.derivation === null || !invalid.has(h.derivation.drv)))
  })

const sameDerivation = (a: Derivation | null, b: Derivation | null) => a?.drv === b?.drv && a?.out === b?.out

/** Two sets of records as one, with footprint ids kept apart. */
const merge = (a: Records | undefined, b: Records | undefined): Records | undefined =>
  a === undefined ? b : b === undefined ? a : { footprints: [...a.footprints, ...b.footprints], evaluations: [...a.evaluations, ...b.evaluations] }

/** What the fresh evaluation of `attr` read that its record's footprint didn't, for the audit's log. */
const missedBy = (records: Records, fresh: Records | undefined, attr: string) => {
  const entries = (set: Records | undefined) => {
    const evaluation = set?.evaluations.find((e) => e.attr === attr)
    const footprint = set?.footprints.find((f) => f.id === evaluation?.footprint)
    return evaluation === undefined || footprint === undefined ? [] : footprint.entries.slice(0, evaluation.count)
  }
  return fresh === undefined ? ["(the fresh evaluation recorded no footprint)"] : Footprint.missed(entries(records), entries(fresh)).slice(0, 50)
}

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
export const resolve = (
  plan: Calder.Plan,
  project: Calder.Project,
  run: RunInfo,
  repo: RepoAt,
  earlier?: Earlier,
  options: {
    /** Footprint records this run may trust. */
    readonly records?: Records | undefined
    /** Evaluates everything afresh and reports the records it contradicts. */
    readonly audit?: boolean | undefined
  } = {},
) =>
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
    // Dev shells first: an evaluator's later attributes' footprints include what earlier ones read, and a
    // shell, which reads little more than the flake's Nix files, then keeps its record when sources change.
    const attrs = [...new Set([...shells, ...builds])]
    const audit = options.audit === true
    const reused = earlier === undefined || audit ? undefined : yield* fromEarlier(earlier, attrs, {
      committed: yield* Repo.make(run.mirror, earlier.revision).pipe(Effect.flatMap((at) => at.committed), Effect.option),
      nix: yield* Effect.flatMap(repo.files, (files) => repo.read(files.filter((f) => f.endsWith(".nix")))),
    }, log)
    // Attributes whose recorded footprint holds here need no evaluation, nor does the app's name.
    const at = Footprint.tree(yield* repo.entries)
    const context = options.records === undefined ? undefined : yield* evaluationContext(run.system)
    const records = context === undefined ? undefined : options.records
    const taken = records === undefined || reused !== undefined
      ? new Map<string, { readonly derivation: Derivation | null; readonly id: number | undefined }>()
      : yield* inStore(fromRecords(records, attrs, at, context!))
    const held = new Map([...taken].map(([attr, h]) => [attr, h.derivation]))
    const heldApp = records === undefined ? undefined : appFromRecords(records, at, context!)
    const known = audit ? new Map<string, Derivation | null>() : held
    const unknown = attrs.filter((attr) => !known.has(attr))
    const rest = byDependencies(unknown, yield* lastClosures(unknown, records), ownReads(records))
    const needsApp = !(reused !== undefined && earlier !== undefined) && (audit || heldApp === undefined)
    // An audit evaluates exactly as plans did before footprints, through the mirror and without the
    // recorder, so a record and its check never share a way of evaluating.
    const recording = reused === undefined && !audit && (rest.length > 0 || needsApp) ? yield* recorder(run, repo) : undefined
    if (held.size > 0 && !audit) yield* log(`took ${held.size} of ${attrs.length} attributes from footprints that hold at this commit`)
    // When the flake fails to load, builds evaluate on their own when they run, but keys need the dev
    // shells now. An attribute too large to evaluate would swap as much in its build.
    const result = reused !== undefined
      ? { derivations: reused, errors: new Map<string, string>(), recorded: undefined }
      : yield* derivations(run, rest, undefined, log, undefined, { recorder: recording, fresh: audit }).pipe(
      Effect.catchIf(
        (e) => e._tag !== "TooLarge",
        (e) =>
          log(`the flake did not load, so only the dev shells are evaluated: ${
            e._tag === "CommandFailed" ? e.stderr.trim().split("\n").slice(-3).join(" ") : e.message
          }`).pipe(Effect.andThen(derivations(run, shells.filter((shell) => rest.includes(shell)), undefined, log))).pipe(
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
    const evaluated = new Map([...known, ...result.derivations])
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

    const named = reused !== undefined && earlier !== undefined
      ? { app: earlier.app, recorded: undefined }
      : heldApp !== undefined && !audit
      ? { app: heldApp.app, recorded: undefined }
      : yield* appOf(run, undefined, recording, audit)
    const recorded = merge(result.recorded, named.recorded)
    const wrong = !audit ? [] : [...taken].flatMap(([attr, { derivation, id }]) => {
      const fresh = result.derivations.get(attr)
      return fresh === undefined || sameDerivation(fresh, derivation) ? [] : [{ attr, recorded: derivation, evaluated: fresh, id }]
    })
    const appWrong = audit && heldApp !== undefined && heldApp.app !== named.app
    // What the fresh evaluation read that the wrong records didn't: recorded again, for the log only.
    const again = wrong.length === 0 && !appWrong ? undefined : yield* Effect.gen(function*() {
      const r = yield* recorder(run, repo)
      if (r === undefined) return undefined
      const out = yield* derivations(run, wrong.map((w) => w.attr), undefined, log, undefined, { recorder: r, fresh: true }).pipe(Effect.option)
      return Option.getOrUndefined(out)?.recorded
    })
    const mismatches: Array<Mismatch> = [
      ...wrong.map((w) => ({ attr: w.attr, recorded: w.recorded, evaluated: w.evaluated, missed: missedBy(records!, again, w.attr), ...(w.id === undefined ? {} : { record: w.id }) })),
      ...(appWrong ? [{ attr: appAttr, recorded: null, evaluated: null, missed: [], ...(heldApp.id === undefined ? {} : { record: heldApp.id }) }] : []),
    ]
    const spec: PlanSpec = {
      version: 1,
      app: named.app,
      trust: plan.trust,
      reuse: plan.reuse,
      schedules: plan.schedules,
      steps,
      derivations: Object.fromEntries(evaluated),
      ...(recorded === undefined ? {} : { recorded }),
      ...(audit ? { mismatches } : {}),
      // Which record gave each attribute this plan took, so a wrong record's deploys can be listed.
      ...(taken.size === 0 || audit ? {} : {
        fromRecords: Object.fromEntries([...taken].flatMap(([attr, h]) => (h.id === undefined ? [] : [[attr, h.id]]))),
      }),
    }
    return spec
  })
