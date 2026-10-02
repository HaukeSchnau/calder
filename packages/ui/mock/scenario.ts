// Deterministic fake data shaped like Hauke's fleet. Every run's step timeline is planned once
// when the run is created; the state of the fleet at any instant is then a pure function of the
// clock, so the server only has to diff snapshots to produce `changes`.

import type { Domain } from "@kiln/api"

type Outcome = "passed" | "failed" | "died"
type Kind = Domain.StepKind
type Event = Domain.Event

interface StepPlan {
  readonly name: string
  readonly kind: Kind
  readonly detail: string
  readonly duration: number
  readonly needs?: ReadonlyArray<string>
  readonly after?: ReadonlyArray<string>
  readonly exits?: ReadonlyArray<string>
  readonly required?: ReadonlyArray<string>
  readonly shards?: number
  readonly target?: boolean
  /** Inputs that rarely change, such as a lockfile: the key survives commits, so later runs reuse it. */
  readonly stable?: boolean
}

interface Spec {
  readonly key: string
  readonly project: string
  /** Seconds relative to the moment the server started. */
  readonly at: number
  readonly event: Event
  readonly title: string | null
  readonly commit: { readonly title: string; readonly author: string; readonly changeId: string | null; readonly sha?: string }
  readonly outcomes?: Readonly<Record<string, Outcome>>
  /** Step name to the spec key of the run whose result this one reuses. */
  readonly reused?: Readonly<Record<string, string>>
  readonly durations?: Readonly<Record<string, number>>
  readonly attempts?: Readonly<Record<string, number>>
  readonly error?: string
  readonly cancelAt?: number
}

export interface SimStep {
  readonly plan: StepPlan
  readonly outcome: Outcome | "reused" | "blocked"
  readonly key: string | null
  readonly reusedFrom: string | null
  /** Median of the step's last ten executions before this run was planned. */
  readonly expectedMs: number | null
  readonly queuedAt: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly attempts: number
}

export interface SimRun {
  readonly id: string
  readonly project: string
  readonly number: number
  readonly event: Event
  readonly commit: Domain.Commit
  readonly title: string | null
  readonly trust: Domain.Trust
  readonly createdAt: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly error: string | null
  readonly traceId: string
  readonly steps: ReadonlyArray<SimStep>
  cancelledAt: number | null
}

/* ------------------------------------------------------------------ */
/* Deterministic randomness and identifiers                            */

const fnv = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const fromAlphabet = (alphabet: string) => (seed: string, n: number): string => {
  let out = ""
  for (let i = 0; out.length < n; i++) {
    let h = fnv(`${seed}:${i}`)
    for (let j = 0; j < 6 && out.length < n; j++) {
      out += alphabet[h % alphabet.length]
      h = Math.floor(h / alphabet.length)
    }
  }
  return out
}

const hex = fromAlphabet("0123456789abcdef")
const nixHash = fromAlphabet("0123456789abcdfghijklmnpqrsvwxyz")
const jjId = fromAlphabet("klmnopqrstuvwxyz")

const rng = (seed: string) => {
  let s = fnv(seed)
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------------ */
/* Projects and pipelines                                              */

export const PROJECTS = [
  "t3code", "studienbuch", "portfolio", "hopwatch", "igs", "merkbeet", "anna-fotoalbum", "ralfs-audio-finder",
] as const

export const HOSTS_OF: Readonly<Record<string, ReadonlyArray<string>>> = {
  t3code: ["srv-2", "srv-1"],
}
export const hostsOf = (project: string) => HOSTS_OF[project] ?? ["srv-2"]

const URLS: Readonly<Record<string, string>> = {
  t3code: "https://t3code.schnau.dev",
  studienbuch: "https://beta.studienbuch.app",
  portfolio: "https://schnau.dev",
  igs: "https://igs-lilienthal.de",
}
export const urlOf = (project: string) => URLS[project] ?? `https://${project}.schnau.dev`

const NUMBER_BASE: Readonly<Record<string, number>> = {
  t3code: 590, studienbuch: 371, portfolio: 142, hopwatch: 88, igs: 61, merkbeet: 47, "anna-fotoalbum": 23, "ralfs-audio-finder": 35,
}

const release = (project: string): StepPlan => ({
  name: "projectRelease", kind: "build", detail: ".#packages.aarch64-linux.projectRelease", duration: project === "t3code" ? 380 : 96,
})

const promote = (after: ReadonlyArray<string>, required: ReadonlyArray<string>, duration: number): StepPlan => ({
  name: "promote", kind: "action", detail: "Release.promote", duration, needs: ["projectRelease"], after: [...after, ...required], required, target: true,
})

const T3_CHECKS = ["static", "typecheck clients", "typecheck rest", "test web", "test server"]

function pipeline(project: string, event: Event): ReadonlyArray<StepPlan> {
  const main = event._tag === "Push" || event._tag === "Manual"
  if (project === "t3code") {
    const steps: Array<StepPlan> = [
      { name: "pnpmDeps", kind: "build", detail: ".#packages.aarch64-linux.pnpmDeps", duration: 212, stable: true },
      { name: "static", kind: "task", detail: "just qa-static", duration: 75, needs: ["pnpmDeps"] },
      { name: "typecheck clients", kind: "task", detail: "just qa-typecheck-clients", duration: 150, needs: ["pnpmDeps"] },
      { name: "typecheck rest", kind: "task", detail: "just qa-typecheck-rest", duration: 120, needs: ["pnpmDeps"] },
      { name: "test web", kind: "task", detail: "just qa-test-non-server", duration: 420, needs: ["pnpmDeps"] },
      { name: "test server", kind: "task", detail: "just qa-test-server-shard $SHARD 3", duration: 330, needs: ["pnpmDeps"], shards: 3 },
      release(project),
      { name: "releaseGate", kind: "build", detail: ".#checks.aarch64-linux.projectReleaseGate", duration: 50, needs: ["projectRelease"] },
    ]
    if (main) {
      steps.push(promote(["releaseGate"], T3_CHECKS, 90))
      steps.push({ name: "desktop and mobile", kind: "action", detail: "Apple.dispatch desktop.yml, mobile.yml", duration: 18, after: ["promote"], target: true })
    } else {
      steps.push({ name: "report failures", kind: "action", detail: "Gitea.comment", duration: 2, exits: ["test web", "test server"], target: true })
    }
    return steps
  }
  if (project === "studienbuch") {
    const steps: Array<StepPlan> = [
      { name: "qa", kind: "task", detail: "just qa", duration: 540 },
      { name: "releaseGate", kind: "build", detail: ".#checks.aarch64-linux.projectReleaseGate", duration: 78 },
      release(project),
    ]
    if (event._tag !== "Schedule") steps.push(promote(["qa", "releaseGate"], [], 52))
    return steps
  }
  return [
    { name: "flake check", kind: "build", detail: ".#checks.aarch64-linux", duration: project === "hopwatch" ? 74 : 58 },
    release(project),
    promote(["flake check"], [], 41),
  ]
}

/* ------------------------------------------------------------------ */
/* What happened: generated history plus the scripted present           */

const TITLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  t3code: [
    "Group tool calls by turn in the sidebar", "Persist thread scroll position", "Show model and effort per turn",
    "Retry provider requests after a 529", "Render diffs with word highlights", "Keyboard shortcut for new thread",
    "Fix desktop notarization on m1", "Cache git status per worktree", "Collapse long tool output", "Upgrade to Effect 4",
  ],
  studienbuch: [
    "Validate module codes on import", "Show ECTS per semester", "Fix timezone of exam reminders", "Add Moodle sync status",
    "Paginate the grade table", "Rename study plans", "Store calendar tokens hashed",
  ],
  portfolio: ["Bump nixpkgs", "New post on Nix deploys", "Compress hero images", "Fix RSS dates"],
  hopwatch: ["Show brewery on check-ins", "Cache Untappd avatars", "Weekly digest mail", "Fix duplicate badges"],
  igs: ["Update Vertretungsplan import", "New school year dates", "Fix menu on Safari", "Add Elternbrief archive"],
  merkbeet: ["Watering reminders per bed", "Seed calendar for Northern Germany", "Fix photo upload on iOS"],
  "anna-fotoalbum": ["Guest upload limit", "Sort albums by date", "Slideshow mode"],
  "ralfs-audio-finder": ["Search by BPM range", "Index FLAC metadata", "Fix waveform rendering"],
}

const SPACING: Readonly<Record<string, number>> = {
  t3code: 3 * 3600, studienbuch: 8 * 3600, portfolio: 26 * 3600, hopwatch: 20 * 3600, igs: 30 * 3600,
  merkbeet: 40 * 3600, "anna-fotoalbum": 52 * 3600, "ralfs-audio-finder": 46 * 3600,
}

const push: Event = { _tag: "Push", branch: "main" }
const pr = (number: number, head: string): Event => ({ _tag: "PullRequest", number, base: "main", head })

function history(project: string): Array<Spec> {
  const r = rng(`history:${project}`)
  const titles = TITLES[project] ?? ["Update dependencies"]
  const spacing = SPACING[project] ?? 86400
  const out: Array<Spec> = []
  const count = 20
  for (let i = 0; i < count; i++) {
    const at = -(count - i) * spacing - Math.round(r() * spacing * 0.4) - 1800
    const plans = pipeline(project, push)
    const checks = plans.filter((p) => p.kind === "task" || p.name === "flake check" || p.name === "qa")
    const fails = r() < 0.09 && checks.length > 0 && i < count - 2
    const failing = fails ? checks[Math.floor(r() * checks.length)]?.name : undefined
    out.push({
      key: `${project}:h${i}`,
      project,
      at,
      event: push,
      title: null,
      commit: {
        title: titles[i % titles.length] ?? "Update dependencies",
        author: ["hauke", "codex", "claude"][Math.floor(r() * 3)] ?? "hauke",
        changeId: r() < 0.7 ? jjId(`${project}:h${i}`, 32) : null,
      },
      ...(failing ? { outcomes: { [failing]: "failed" as const } } : {}),
    })
  }
  if (project === "studienbuch") {
    for (let d = 1; d <= 6; d++) {
      out.push({
        key: `studienbuch:nightly${d}`,
        project,
        at: -d * 86400 + 3 * 3600 - 11 * 3600,
        event: { _tag: "Schedule", cron: "0 3 * * *" },
        title: null,
        commit: { title: "Nightly cold run", author: "kiln", changeId: null },
      })
    }
  }
  return out
}

const CHANGE_418 = jjId("t3code:pr418", 32)

/** The present: the runs every screen of the UI has something to say about. */
const SCRIPTED: ReadonlyArray<Spec> = [
  {
    key: "t3:pr415", project: "t3code", at: -52 * 60, event: pr(415, "codex/stream-tool-output"),
    title: "Stream tool output in the thread view", commit: { title: "Stream tool output in the thread view", author: "codex", changeId: jjId("t3code:pr415", 32) },
  },
  {
    key: "t3:pr417", project: "t3code", at: -83 * 60, event: pr(417, "claude/retry-push"),
    title: "Retry git push on a transient Gitea 502", commit: { title: "Retry git push on a transient Gitea 502", author: "claude", changeId: jjId("t3code:pr417", 32) },
    attempts: { "test server": 2 },
  },
  {
    key: "t3:pr418-1", project: "t3code", at: -131 * 60, event: pr(418, "codex/token-usage"),
    title: "Show token usage per turn", commit: { title: "Show token usage per turn", author: "codex", changeId: CHANGE_418 },
    outcomes: { "typecheck clients": "failed" },
  },
  {
    key: "t3:pr418-2", project: "t3code", at: -96 * 60, event: pr(418, "codex/token-usage"),
    title: "Show token usage per turn", commit: { title: "Show token usage per turn", author: "codex", changeId: CHANGE_418 },
    reused: { static: "t3:pr418-1", "typecheck rest": "t3:pr418-1" },
  },
  {
    key: "t3:pr418-3", project: "t3code", at: -7 * 60, event: pr(418, "codex/token-usage"),
    title: "Show token usage per turn", commit: { title: "Show token usage per turn", author: "codex", changeId: CHANGE_418 },
    outcomes: { "test web": "failed" },
    reused: { static: "t3:pr418-2", "typecheck rest": "t3:pr418-2", "test server": "t3:pr418-2" },
    durations: { "test web": 400 },
  },
  {
    key: "t3:main-merge", project: "t3code", at: -8 * 60, event: push, title: null,
    commit: { title: "Stream tool output in the thread view (#415)", author: "codex", changeId: jjId("t3code:pr415", 32) },
    reused: Object.fromEntries(T3_CHECKS.map((name) => [name, "t3:pr415"])),
    durations: { projectRelease: 168, releaseGate: 47, promote: 18 * 60, "desktop and mobile": 21 },
  },
  {
    key: "t3:pr418-4", project: "t3code", at: -75, event: pr(418, "codex/token-usage"),
    title: "Show token usage per turn", commit: { title: "Show token usage per turn", author: "codex", changeId: CHANGE_418 },
    reused: { static: "t3:pr418-3", "typecheck rest": "t3:pr418-3" },
    durations: { "typecheck clients": 170, "test web": 9 * 60, "test server": 400, projectRelease: 430 },
  },
  {
    key: "sb:main-calendar", project: "studienbuch", at: -88, event: push, title: null,
    commit: { title: "Export the calendar as ICS", author: "hauke", changeId: jjId("studienbuch:ics", 32) },
    durations: { qa: 11 * 60, releaseGate: 80, projectRelease: 190, promote: 64 },
  },
  {
    key: "sb:pr96", project: "studienbuch", at: -3 * 3600 - 600, event: pr(96, "claude/offline-cache"),
    title: "Cache the calendar for offline use", commit: { title: "Cache the calendar for offline use", author: "claude", changeId: jjId("studienbuch:pr96", 32) },
  },
  {
    key: "hw:main-batches", project: "hopwatch", at: -26 * 60, event: push, title: null,
    commit: { title: "Ingest Untappd check-ins in batches", author: "claude", changeId: jjId("hopwatch:batches", 32) },
    outcomes: { "flake check": "failed" },
  },
  {
    key: "pf:main-nixpkgs", project: "portfolio", at: -56 * 60, event: push, title: null,
    commit: { title: "Bump nixpkgs to 26.05", author: "hauke", changeId: null },
  },
  {
    key: "igs:manual", project: "igs", at: -5 * 3600, event: { _tag: "Manual", inputs: { reason: "redeploy after cert renewal" } }, title: null,
    commit: { title: "New school year dates", author: "hauke", changeId: null },
    error: "plan failed: .kiln/ci.ts: step \"promote\" needs \"projectRelease\", which On.manual doesn't target",
  },
  {
    key: "mb:pr12", project: "merkbeet", at: -4 * 3600, event: pr(12, "codex/frost-warnings"),
    title: "Frost warnings for open beds", commit: { title: "Frost warnings for open beds", author: "codex", changeId: jjId("merkbeet:pr12", 32) },
  },
]

/* ------------------------------------------------------------------ */
/* Planning a run                                                      */

const PLANNING = 2

interface Memory {
  readonly built: ReadonlyMap<string, SimRun>
  readonly stableKeys: Map<string, { key: string; run: string }>
  readonly durations: Map<string, Array<number>>
}

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function plan(spec: Spec, id: string, number: number, t0: number, { built, stableKeys, durations }: Memory): SimRun {
  const r = rng(`run:${spec.key}`)
  const createdAt = t0 + spec.at * 1000
  const sha = spec.commit.sha ?? hex(`sha:${spec.key}`, 40)
  const startedAt = createdAt + PLANNING * 1000
  const plans = spec.error ? [] : pipeline(spec.project, spec.event)
  const done = new Map<string, SimStep>()
  const order = topo(plans)
  for (const p of order) {
    const deps = [...(p.needs ?? []), ...(p.after ?? [])]
    const exits = p.exits ?? []
    const upstream = [...deps, ...exits].map((n) => done.get(n)).filter((s): s is SimStep => s !== undefined)
    const ready = Math.max(startedAt, ...upstream.map((s) => s.finishedAt))
    const blockedBy = deps.map((n) => done.get(n)).find((s) => s && s.outcome !== "passed" && s.outcome !== "reused")
    const reusedSpec = spec.reused?.[p.name]
    const reusedRun = reusedSpec ? built.get(reusedSpec) : undefined
    const reusedStep = reusedRun?.steps.find((s) => s.plan.name === p.name)
    const stable = p.stable ? stableKeys.get(`${spec.project}:${p.name}`) : undefined
    const history = durations.get(`${spec.project}:${p.name}`) ?? []
    const expectedMs = history.length ? (median(history.slice(-10)) ?? null) : null
    const ownKey = p.kind === "build"
      ? `/nix/store/${nixHash(`drv:${spec.project}:${p.name}:${sha}`, 32)}-${spec.project}-${p.name}.drv`
      : hex(`key:${spec.project}:${p.name}:${sha}`, 64)
    const duration = (spec.durations?.[p.name] ?? p.duration * (0.88 + r() * 0.24)) * 1000
    const queue = (p.kind === "action" ? 0.3 : 0.6 + r() * 2.4) * 1000
    let step: SimStep
    if (blockedBy) {
      step = { plan: p, outcome: "blocked", key: null, reusedFrom: null, expectedMs, queuedAt: blockedBy.finishedAt, startedAt: blockedBy.finishedAt, finishedAt: blockedBy.finishedAt, attempts: 0 }
    } else if (reusedStep && reusedRun) {
      step = { plan: p, outcome: "reused", key: reusedStep.key, reusedFrom: reusedStep.reusedFrom ?? reusedRun.id, expectedMs, queuedAt: ready, startedAt: ready, finishedAt: ready, attempts: 0 }
    } else if (stable && spec.event._tag !== "Schedule") {
      step = { plan: p, outcome: "reused", key: stable.key, reusedFrom: stable.run, expectedMs, queuedAt: ready, startedAt: ready, finishedAt: ready, attempts: 0 }
    } else {
      const key = p.stable ? `/nix/store/${nixHash(`drv:${spec.project}:${p.name}:lock`, 32)}-${spec.project}-${p.name}.drv` : ownKey
      step = {
        plan: p, outcome: spec.outcomes?.[p.name] ?? "passed", key, reusedFrom: null, expectedMs,
        queuedAt: ready, startedAt: ready + queue, finishedAt: ready + queue + duration, attempts: spec.attempts?.[p.name] ?? 1,
      }
      if (p.stable && step.outcome === "passed") stableKeys.set(`${spec.project}:${p.name}`, { key, run: id })
      durations.set(`${spec.project}:${p.name}`, [...history, step.finishedAt - step.startedAt])
    }
    done.set(p.name, step)
  }
  const steps = plans.map((p) => done.get(p.name)).filter((s): s is SimStep => s !== undefined)
  return {
    id,
    project: spec.project,
    number,
    event: spec.event,
    commit: { sha, changeId: spec.commit.changeId, title: spec.commit.title, author: spec.commit.author, timestamp: createdAt - 40_000 - Math.round(r() * 600_000) },
    title: spec.title,
    trust: spec.event._tag === "PullRequest" ? "pr" : "trusted",
    createdAt,
    startedAt: spec.error ? createdAt + 900 : startedAt,
    finishedAt: spec.error ? createdAt + 900 : Math.max(startedAt, ...steps.map((s) => s.finishedAt)),
    error: spec.error ?? null,
    traceId: hex(`trace:${spec.key}`, 32),
    steps,
    cancelledAt: spec.cancelAt === undefined ? null : t0 + spec.cancelAt * 1000,
  }
}

function topo(plans: ReadonlyArray<StepPlan>): Array<StepPlan> {
  const byName = new Map(plans.map((p) => [p.name, p]))
  const out: Array<StepPlan> = []
  const seen = new Set<string>()
  const visit = (p: StepPlan) => {
    if (seen.has(p.name)) return
    seen.add(p.name)
    for (const d of [...(p.needs ?? []), ...(p.after ?? []), ...(p.exits ?? [])]) {
      const dep = byName.get(d)
      if (dep) visit(dep)
    }
    out.push(p)
  }
  plans.forEach(visit)
  return out
}

const runId = (project: string, number: number) => `r${hex(`id:${project}:${number}`, 10)}`

/* ------------------------------------------------------------------ */
/* The world                                                           */

export class World {
  readonly runs: Array<SimRun> = []
  private readonly bySpec = new Map<string, SimRun>()
  private readonly memory = { built: this.bySpec, stableKeys: new Map<string, { key: string; run: string }>(), durations: new Map<string, Array<number>>() }
  private readonly numbers = new Map<string, number>()

  constructor(readonly t0: number) {
    const specs = [...PROJECTS.flatMap(history), ...SCRIPTED].sort((a, b) => a.at - b.at)
    for (const spec of specs) this.add(spec)
  }

  private add(spec: Spec): SimRun {
    const number = (this.numbers.get(spec.project) ?? NUMBER_BASE[spec.project] ?? 1) + 1
    this.numbers.set(spec.project, number)
    const run = plan(spec, runId(spec.project, number), number, this.t0, this.memory)
    this.bySpec.set(spec.key, run)
    this.runs.push(run)
    return run
  }

  run(id: string): SimRun | undefined {
    return this.runs.find((r) => r.id === id)
  }

  /** Starts a run of the default branch head with every result it can reuse. */
  trigger(project: string, now: number, inputs: Readonly<Record<string, unknown>> | undefined): SimRun {
    const head = this.latestMain(project)
    const key = `${project}:manual:${now}`
    const reused = head ? this.reusable(head) : {}
    if (head) this.bySpec.set(`${key}:head`, head)
    return this.add({
      key,
      project,
      at: (now - this.t0) / 1000,
      event: inputs ? { _tag: "Manual", inputs } : push,
      title: null,
      commit: head ? { title: head.commit.title, author: "hauke", changeId: head.commit.changeId, sha: head.commit.sha } : { title: "Manual run", author: "hauke", changeId: null },
      reused: Object.fromEntries(Object.keys(reused).map((name) => [name, `${key}:head`])),
      durations: { promote: 6 },
    })
  }

  /** Runs the same revision and event again, reusing what passed. */
  rerun(source: SimRun, now: number): SimRun {
    const key = `${source.project}:rerun:${source.id}:${now}`
    this.bySpec.set(`${key}:source`, source)
    const outcomes = Object.fromEntries(source.steps.flatMap((s) => (s.outcome === "failed" || s.outcome === "died" ? [[s.plan.name, s.outcome] as const] : [])))
    return this.add({
      key,
      project: source.project,
      at: (now - this.t0) / 1000,
      event: source.event,
      title: source.title,
      commit: { title: source.commit.title, author: source.commit.author, changeId: source.commit.changeId, sha: source.commit.sha },
      outcomes,
      reused: Object.fromEntries(Object.keys(this.reusable(source)).map((name) => [name, `${key}:source`])),
    })
  }

  private reusable(run: SimRun): Record<string, true> {
    return Object.fromEntries(run.steps.filter((s) => (s.outcome === "passed" || s.outcome === "reused") && s.plan.kind !== "action").map((s) => [s.plan.name, true as const]))
  }

  latestMain(project: string): SimRun | undefined {
    return this.runs.filter((r) => r.project === project && r.event._tag === "Push" && r.error === null).at(-1)
  }
}

/* ------------------------------------------------------------------ */
/* State at an instant                                                 */

type StepState = { status: Domain.StepStatus; queuedAt: number | null; startedAt: number | null; finishedAt: number | null }

export function stepState(run: SimRun, s: SimStep, now: number): StepState {
  const cut = run.cancelledAt !== null && run.cancelledAt <= now && s.finishedAt > run.cancelledAt ? run.cancelledAt : null
  if (cut !== null) {
    return { status: "cancelled", queuedAt: s.queuedAt <= cut ? s.queuedAt : null, startedAt: s.startedAt <= cut ? s.startedAt : null, finishedAt: cut }
  }
  if (s.outcome === "blocked") {
    return now >= s.finishedAt ? { status: "blocked", queuedAt: null, startedAt: null, finishedAt: s.finishedAt } : { status: "pending", queuedAt: null, startedAt: null, finishedAt: null }
  }
  if (now < s.queuedAt) return { status: "pending", queuedAt: null, startedAt: null, finishedAt: null }
  if (s.outcome === "reused") return { status: "reused", queuedAt: s.queuedAt, startedAt: null, finishedAt: s.finishedAt }
  if (now < s.startedAt) return { status: "queued", queuedAt: s.queuedAt, startedAt: null, finishedAt: null }
  if (now < s.finishedAt) return { status: "running", queuedAt: s.queuedAt, startedAt: s.startedAt, finishedAt: null }
  return { status: s.outcome, queuedAt: s.queuedAt, startedAt: s.startedAt, finishedAt: s.finishedAt }
}

export function runStatus(run: SimRun, now: number): Domain.RunStatus {
  if (run.error !== null) return now >= run.finishedAt ? "errored" : "planning"
  if (run.cancelledAt !== null && run.cancelledAt <= now && run.finishedAt > run.cancelledAt) return "cancelled"
  if (now < run.startedAt) return "planning"
  if (now < run.finishedAt) return "running"
  return run.steps.some((s) => s.outcome === "failed" || s.outcome === "died") ? "failed" : "passed"
}

const isActive = (status: Domain.RunStatus) => status === "queued" || status === "planning" || status === "running"

export function toRun(run: SimRun, now: number): Domain.Run {
  const status = runStatus(run, now)
  const counts: Record<string, number> = {}
  for (const s of run.steps) {
    const st = stepState(run, s, now).status
    counts[st] = (counts[st] ?? 0) + 1
  }
  const end = status === "cancelled" ? run.cancelledAt : isActive(status) ? null : run.finishedAt
  return {
    id: run.id,
    project: run.project,
    number: run.number,
    event: run.event,
    commit: run.commit,
    title: run.title,
    trust: run.trust,
    status,
    createdAt: run.createdAt,
    startedAt: now >= run.startedAt ? run.startedAt : null,
    finishedAt: end,
    error: status === "errored" ? run.error : null,
    traceId: run.error === null ? run.traceId : null,
    counts,
  }
}

export function toStep(world: World, run: SimRun, s: SimStep, now: number): Domain.StepRun {
  const st = stepState(run, s, now)
  const finished = st.status === "passed" || st.status === "failed" || st.status === "died"
  const ran = st.startedAt !== null
  const seconds = ran ? ((st.finishedAt ?? now) - (st.startedAt ?? now)) / 1000 : 0
  const cores = s.plan.kind === "build" ? 3.1 : s.plan.kind === "task" ? 1.8 : 0.05
  return {
    runId: run.id,
    name: s.plan.name,
    kind: s.plan.kind,
    status: st.status,
    key: s.key,
    // A reused build is one whose output already existed; reused tasks point at the run that ran them.
    reusedFrom: st.status === "reused" && s.plan.kind !== "build" && s.reusedFrom !== null ? { id: s.reusedFrom, number: world.run(s.reusedFrom)?.number ?? 0 } : null,
    needs: s.plan.needs ?? [],
    exits: s.plan.exits ?? [],
    after: s.plan.after ?? [],
    required: s.plan.required ?? [],
    target: s.plan.target ?? false,
    deploys: s.plan.detail === "Release.promote",
    detail: s.plan.detail,
    queuedAt: st.queuedAt,
    startedAt: st.startedAt,
    finishedAt: st.finishedAt,
    expectedMs: s.expectedMs === null ? null : Math.round(s.expectedMs),
    attempts: ran ? s.attempts : 0,
    shards: s.plan.shards ?? null,
    value: st.status === "passed" || st.status === "reused" ? valueOf(world, run, s) : null,
    error: st.status === "failed" || st.status === "died" ? errorOf(run, s) : null,
    cpuSeconds: finished ? Math.round(seconds * cores * 10) / 10 : null,
    memoryPeakBytes: finished ? Math.round((s.plan.kind === "build" ? 2.4 : s.plan.kind === "task" ? 1.3 : 0.08) * 2 ** 30 * (0.8 + (fnv(s.plan.name) % 40) / 100)) : null,
    spanId: ran || st.status === "reused" ? spanIdOf(run, s.plan.name) : null,
    tests: finished || st.status === "reused" ? testCounts(run, s) : null,
  }
}

const spanIdOf = (run: SimRun, name: string) => hex(`span:${run.id}:${name}`, 16)
const short = (sha: string) => sha.slice(0, 7)
export const storePathOf = (run: SimRun) => `/nix/store/${nixHash(`out:${run.project}:${run.commit.sha}`, 32)}-${run.project}-release`

function valueOf(world: World, run: SimRun, s: SimStep): Domain.Value | null {
  const source = s.reusedFrom ? world.run(s.reusedFrom) ?? run : run
  switch (s.plan.kind) {
    case "build": {
      const path = s.plan.name === "projectRelease" ? storePathOf(source) : `/nix/store/${nixHash(`out:${run.project}:${s.plan.name}:${s.key}`, 32)}-${run.project}-${s.plan.name}`
      return { type: null, render: "text", label: "store path", text: path, json: { path } }
    }
    case "task": {
      const counts = testCounts(run, s)
      return counts
        ? { type: null, render: "text", label: "report", text: `${counts.passed} passed${counts.skipped ? `, ${counts.skipped} skipped` : ""}`, json: counts }
        : { type: null, render: null, label: null, text: "exit 0", json: { exitCode: 0 } }
    }
    case "action": {
      if (s.plan.name === "promote") {
        const hosts = hostsOf(run.project)
        return { type: "@kiln/std/Release/Live", render: "text", label: "Live", text: `${short(run.commit.sha)} on ${hosts.join(", ")}`, json: { _tag: "Live", revision: run.commit.sha, hosts } }
      }
      if (s.plan.name === "desktop and mobile") {
        return { type: "@kiln/std/Apple/Dispatched", render: "link", label: "workflow runs", text: "https://git.schnau.dev/schnau/t3code/actions", json: { workflows: ["desktop.yml", "mobile.yml"] } }
      }
      return { type: null, render: "text", label: null, text: "comment posted", json: null }
    }
    case "output":
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */

const TOKEN_TEST = { suite: "TokenUsage", name: "formats large counts with a thin space", file: "apps/web/src/components/TokenUsage.test.tsx" }
const FLAKY_TEST = { suite: "ThreadView", name: "replays tool output after reconnect", file: "apps/web/src/thread/ThreadView.test.tsx" }
const HOP_TEST = { suite: "ingest", name: "rejects a duplicate check-in within a batch", file: "src/ingest/batch.test.ts" }
const SERVER_TEST = { suite: "GitService", name: "retries push after a 502 from Gitea", file: "apps/server/src/git/GitService.test.ts" }

function flakyTimesOut(run: SimRun) {
  return fnv(`flaky:${run.id}`) % 7 === 0
}

/** Per-run results of the few tests the scenario follows; everything else passes. */
export function testResults(run: SimRun, step: SimStep): Array<Domain.TestResult> {
  const out: Array<Domain.TestResult> = []
  const base = { runId: run.id, step: step.plan.name, flaky: false }
  if (run.project === "t3code" && step.plan.name === "test web" && (step.outcome === "passed" || step.outcome === "failed")) {
    const tokenFails = step.outcome === "failed"
    out.push({ ...base, ...TOKEN_TEST, status: tokenFails ? "failed" : "passed", durationMs: 41, message: tokenFails ? "AssertionError: expected '12,400 tokens' to be '12 400 tokens'" : null })
    const timeout = tokenFails || flakyTimesOut(run)
    out.push({ ...base, ...FLAKY_TEST, status: timeout ? "timeout" : "passed", durationMs: timeout ? 5000 : 812, message: timeout ? "Test timed out in 5000ms." : null, flaky: true })
  }
  if (run.project === "t3code" && step.plan.name === "test server" && step.outcome === "passed") {
    out.push({ ...base, ...SERVER_TEST, status: "passed", durationMs: 230, message: null, flaky: run.commit.title.includes("Retry git push") })
  }
  if (run.project === "hopwatch" && step.plan.name === "flake check" && (step.outcome === "passed" || step.outcome === "failed")) {
    const fails = step.outcome === "failed"
    out.push({ ...base, ...HOP_TEST, status: fails ? "failed" : "passed", durationMs: 18, message: fails ? "expected 1 check-in, received 2\n  at batch.test.ts:48:31" : null })
  }
  return out
}

function testCounts(run: SimRun, s: SimStep): Domain.StepRun["tests"] {
  const totals: Readonly<Record<string, number>> = { "test web": 403, "test server": 114, qa: 412 }
  const total = run.project === "hopwatch" && s.plan.name === "flake check" ? 96 : totals[s.plan.name]
  if (total === undefined) return null
  const failed = testResults(run, s).filter((t) => t.status === "failed" || t.status === "timeout").length
  return { passed: total - failed - (s.plan.name === "test server" ? 2 : 0), failed, skipped: s.plan.name === "test server" ? 2 : 0 }
}

/* ------------------------------------------------------------------ */
/* Errors and logs                                                     */

type Line = readonly [at: number, level: Domain.LogLine["level"], stream: Domain.LogLine["stream"], text: string, shard?: number | undefined]

function errorOf(run: SimRun, s: SimStep): Domain.StepError {
  const lines = scriptOf(run, s)
  const excerpt = lines.filter((l) => l[2] !== "kiln").slice(-7).map((l) => l[3]).join("\n")
  if (run.project === "t3code" && s.plan.name === "test web") {
    return { tag: "TestFailed", message: "2 tests failed: TokenUsage › formats large counts with a thin space, ThreadView › replays tool output after reconnect (timeout)", excerpt }
  }
  if (s.plan.name === "typecheck clients") {
    return { tag: "CommandFailed", message: "just qa-typecheck-clients exited with code 2", excerpt }
  }
  if (s.plan.kind === "build") {
    return { tag: "BuildFailed", message: `builder for '/nix/store/${nixHash(`fail:${run.id}`, 32)}-${run.project}-vitest.drv' failed with exit code 1`, excerpt }
  }
  return { tag: "CommandFailed", message: `${s.plan.detail} exited with code 1`, excerpt }
}

const files = (list: ReadonlyArray<string>, from: number, to: number, shard?: number): Array<Line> =>
  list.map((f, i) => [from + ((to - from) * i) / Math.max(1, list.length - 1), "info", "stdout", f, shard] as const)

const WEB_FILES = [
  "src/thread/Timeline.test.tsx (18 tests) 1.94s", "src/components/Sidebar.test.tsx (22 tests) 1.31s", "src/state/threads.test.ts (44 tests) 1.12s",
  "src/components/DiffView.test.tsx (31 tests) 3.07s", "src/settings/Providers.test.tsx (12 tests) 4.88s", "src/thread/ToolOutput.test.tsx (17 tests) 2.64s",
  "src/state/settings.test.ts (29 tests) 0.97s", "src/components/Composer.test.tsx (26 tests) 2.21s", "src/thread/Markdown.test.tsx (35 tests) 1.48s",
  "src/hooks/useKeybindings.test.ts (14 tests) 0.41s", "src/components/ModelPicker.test.tsx (9 tests) 0.88s", "src/state/worktrees.test.ts (21 tests) 0.63s",
  "src/thread/Scroll.test.tsx (11 tests) 1.02s", "src/components/CommandMenu.test.tsx (16 tests) 1.37s", "src/lib/format.test.ts (38 tests) 0.22s",
  "src/thread/Approvals.test.tsx (13 tests) 1.76s", "src/components/Terminal.test.tsx (8 tests) 2.95s", "src/state/notifications.test.ts (10 tests) 0.35s",
].map((f) => ` ✓ ${f}`)

function scriptOf(run: SimRun, s: SimStep): Array<Line> {
  const sha = short(run.commit.sha)
  const where = run.event._tag === "PullRequest" ? `pr/${run.project}/1` : `trusted/${run.project}/1`
  const failed = s.outcome === "failed"
  const cmd: Line = [0, "info", "kiln", s.plan.kind === "build" ? `nix build .#${s.plan.detail.replace(/^\.#/, "")}` : `$ ${s.plan.detail}`]
  const ws: Line = [0.004, "debug", "kiln", `workspace ${where} at ${sha}`]
  const p = `${run.project}:${s.plan.name}`
  if (s.plan.kind === "build") {
    const drv = `/nix/store/${nixHash(`drv:${p}:${sha}`, 32)}-${run.project}-${s.plan.name}.drv`
    const lines: Array<Line> = [
      cmd,
      [0.01, "debug", "kiln", `evaluating ${s.plan.detail} at ${sha}`],
      [0.04, "info", "stderr", `copying ${12 + (fnv(p) % 300)} paths from https://attic.schnau.dev/fleet`],
      [0.12, "info", "stderr", `building '${drv}' on srv-2`],
    ]
    if (s.plan.name === "flake check") {
      lines.push([0.3, "info", "stderr", "checking derivation checks.aarch64-linux.lint"], [0.45, "info", "stderr", "checking derivation checks.aarch64-linux.vitest"])
      lines.push(...files([" ✓ src/api/checkins.test.ts (14 tests) 0.41s", " ✓ src/badges/award.test.ts (22 tests) 0.18s", " ✓ src/digest/weekly.test.ts (9 tests) 0.77s"], 0.5, 0.8))
      if (failed) {
        lines.push(
          [0.84, "error", "stdout", " ✗ src/ingest/batch.test.ts (12 tests | 1 failed) 0.52s"],
          [0.85, "error", "stdout", "   × ingest > rejects a duplicate check-in within a batch"],
          [0.86, "error", "stdout", "     AssertionError: expected 1 check-in, received 2"],
          [0.87, "error", "stdout", "      ❯ src/ingest/batch.test.ts:48:31"],
          [0.92, "info", "stdout", " Test Files  1 failed | 11 passed (12)"],
          [0.93, "info", "stdout", "      Tests  1 failed | 95 passed (96)"],
          [0.97, "error", "stderr", `error: builder for '/nix/store/${nixHash(`fail:${run.id}`, 32)}-${run.project}-vitest.drv' failed with exit code 1`],
          [0.99, "error", "kiln", "step failed: BuildFailed"],
        )
        return lines
      }
      lines.push([0.92, "info", "stdout", " Test Files  12 passed (12)"], [0.93, "info", "stdout", "      Tests  96 passed (96)"])
    }
    if (s.plan.name === "projectRelease") lines.push([0.55, "info", "stdout", "vite v8.3.2 building for production..."], [0.7, "info", "stdout", `${900 + (fnv(p) % 1500)} modules transformed.`], [0.8, "warn", "stderr", "(!) Some chunks are larger than 500 kB after minification."])
    if (s.plan.name === "releaseGate") lines.push([0.5, "info", "stdout", "migrations reversible, 0 pending"], [0.8, "info", "stdout", "bindings compatible with srv-2"])
    if (s.plan.name === "pnpmDeps") lines.push([0.5, "info", "stderr", "pnpm install --offline --frozen-lockfile"], [0.8, "info", "stderr", "Packages: +1412"])
    lines.push([0.99, "info", "stdout", s.plan.name === "projectRelease" ? storePathOf(run) : drv.replace(/\.drv$/, "")])
    return lines
  }
  if (s.plan.kind === "task") {
    switch (s.plan.name) {
      case "static":
        return [cmd, ws, [0.4, "info", "stdout", "oxlint 1.14: 0 problems in 1,204 files"], [0.8, "info", "stdout", "prettier --check: 1,204 files formatted"], [0.99, "info", "kiln", "exit 0"]]
      case "typecheck clients":
        return failed
          ? [cmd, ws, [0.3, "info", "stdout", "tsc -b apps/web apps/desktop apps/mobile"], [0.93, "error", "stdout", "apps/web/src/components/TokenUsage.tsx:12:27 - error TS2339: Property 'usage' does not exist on type 'TurnSummary'."], [0.94, "error", "stdout", "Found 1 error in apps/web/src/components/TokenUsage.tsx:12"], [0.99, "error", "kiln", "exit 2"]]
          : [cmd, ws, [0.3, "info", "stdout", "tsc -b apps/web apps/desktop apps/mobile"], [0.72, "info", "stdout", "apps/web: 0 errors"], [0.9, "info", "stdout", "apps/desktop, apps/mobile: 0 errors"], [0.99, "info", "kiln", "exit 0"]]
      case "typecheck rest":
        return [cmd, ws, [0.3, "info", "stdout", "tsc -b apps/server packages/*"], [0.99, "info", "stdout", "0 errors in 7 projects"]]
      case "test web": {
        const lines: Array<Line> = [cmd, ws, [0.01, "info", "stdout", " RUN  v4.1.2 /work/t3code/apps/web"], [0.08, "warn", "stderr", "[vite] warning: Sourcemap for \"shiki/dist/langs.mjs\" points to missing source files"]]
        lines.push(...files(WEB_FILES, 0.1, 0.86))
        if (failed) {
          lines.push(
            [0.88, "error", "stdout", " ✗ src/components/TokenUsage.test.tsx (6 tests | 1 failed) 0.86s"],
            [0.881, "error", "stdout", "   × TokenUsage > formats large counts with a thin space"],
            [0.882, "error", "stdout", "     AssertionError: expected '12,400 tokens' to be '12 400 tokens'"],
            [0.883, "error", "stdout", "      ❯ src/components/TokenUsage.test.tsx:31:40"],
            [0.9, "error", "stdout", " ✗ src/thread/ThreadView.test.tsx (19 tests | 1 failed) 5.81s"],
            [0.901, "error", "stdout", "   × ThreadView > replays tool output after reconnect"],
            [0.902, "error", "stdout", "     Error: Test timed out in 5000ms."],
            [0.96, "info", "stdout", " Test Files  2 failed | 40 passed (42)"],
            [0.961, "info", "stdout", "      Tests  2 failed | 401 passed (403)"],
            [0.98, "info", "kiln", "report: reports/vitest.json decoded, 2 failing"],
            [0.99, "error", "kiln", "exit 1"],
          )
          return lines
        }
        lines.push([0.9, "info", "stdout", " ✓ src/components/TokenUsage.test.tsx (6 tests) 0.81s"], [0.96, "info", "stdout", " Test Files  42 passed (42)"], [0.961, "info", "stdout", "      Tests  403 passed (403)"], [0.98, "info", "kiln", "report: reports/vitest.json decoded, 403 passed"], [0.99, "info", "kiln", "exit 0"])
        return lines
      }
      case "test server": {
        const lines: Array<Line> = [cmd, [0.01, "debug", "kiln", "3 shards: 38, 38 and 38 files"]]
        for (const shard of [1, 2, 3]) {
          lines.push([0.02, "info", "kiln", `$ just qa-test-server-shard ${shard} 3`, shard])
          lines.push(...files(["src/git/GitService.test.ts (31 tests)", "src/provider/Codex.test.ts (18 tests)", "src/ws/Protocol.test.ts (40 tests)", "src/db/Threads.test.ts (25 tests)"].map((f) => ` ✓ ${f}`), 0.1 + shard * 0.05, 0.8 + shard * 0.05, shard))
          lines.push([0.92 + shard * 0.02, "info", "stdout", `shard ${shard} of 3: 38 passed`, shard])
        }
        if (s.attempts > 1) lines.splice(6, 0, [0.4, "warn", "kiln", "shard 2 of 3: TestTimeout, retrying once", 2])
        return lines
      }
      case "qa": {
        const lines: Array<Line> = [cmd, ws, [0.02, "info", "stdout", "oxlint: 0 problems in 318 files"], [0.12, "info", "stdout", "tsc -b: 0 errors"]]
        const total = 412
        for (let i = 1; i <= 24; i++) lines.push([0.15 + (0.8 * i) / 24, "info", "stdout", `vitest: ${Math.round((total * i) / 24)} of ${total} done`])
        lines.push([0.4, "warn", "stderr", "moodle-sync: MOODLE_TOKEN not set, sync tests use the fixture"], [0.98, "info", "stdout", `vitest: ${total} passed (${total})`], [0.99, "info", "kiln", "report: reports/junit.xml decoded, 412 passed"])
        return lines.sort((a, b) => a[0] - b[0])
      }
    }
    return [cmd, ws, [0.99, "info", "kiln", "exit 0"]]
  }
  if (s.plan.name === "promote") return promoteScript(run, s)
  if (s.plan.name === "desktop and mobile") {
    return [[0, "info", "kiln", "Apple.dispatch desktop.yml, mobile.yml"], [0.3, "info", "kiln", "POST git.schnau.dev/api/v1/repos/schnau/t3code/actions/workflows/desktop.yml/dispatches 204"], [0.6, "info", "kiln", "POST git.schnau.dev/api/v1/repos/schnau/t3code/actions/workflows/mobile.yml/dispatches 204"], [0.99, "info", "kiln", "dispatched 2 workflows on m1"]]
  }
  return [[0, "info", "kiln", "Gitea.comment"], [0.9, "info", "kiln", `comment posted on PR #${run.event._tag === "PullRequest" ? run.event.number : 0}`]]
}

/** Phase boundaries of a deploy as fractions of the promote step: per host, from start to activation. */
export function phases(run: SimRun): Array<{ host: string; from: number; activate: number }> {
  const hosts = hostsOf(run.project)
  return hosts.map((host, i) => ({ host, from: (i / hosts.length) * 0.97, activate: ((i + 1) / hosts.length) * 0.97 - 0.01 }))
}

function promoteScript(run: SimRun, s: SimStep): Array<Line> {
  const sha = short(run.commit.sha)
  const duration = (s.finishedAt - s.startedAt) / 1000
  const after = [...(s.plan.after ?? [])]
  const lines: Array<Line> = [
    [0, "info", "kiln", `lease deploy:${run.project} acquired (latest wins, fencing token ${1100 + run.number})`],
    [0.002, "info", "kiln", `required checks passed: ${after.join(", ")}`],
  ]
  for (const ph of phases(run)) {
    const span = ph.activate - ph.from
    const at = (f: number) => ph.from + span * f
    lines.push([at(0.01), "info", "kiln", `POST ${ph.host}:18100/preflight/${run.project} 200`])
    lines.push([at(0.04), "info", "kiln", `attic: narinfo for ${storePathOf(run).slice(11, 19)} present`])
    lines.push([at(0.06), "info", "kiln", `head check: main still at ${sha}`])
    lines.push([at(0.08), "info", "kiln", `POST ${ph.host}:18100/deploy/${run.project} 202 (fence ${1100 + run.number})`])
    const polls = Math.max(1, Math.floor((span * duration) / 15))
    for (let i = 1; i < polls; i++) {
      lines.push([at(0.1 + (0.88 * i) / polls), "debug", "kiln", `readiness: ${ph.host} still reports the previous revision, retry in 15 s`])
    }
    lines.push([at(1), "info", "kiln", `readiness: ${ph.host} reports ${sha}`])
  }
  lines.push([0.99, "info", "kiln", `${run.project} ${sha} live on ${hostsOf(run.project).join(", ")}`])
  return lines
}

export function logLines(run: SimRun, s: SimStep, now: number): Array<Domain.LogLine> {
  const st = stepState(run, s, now)
  const name = s.plan.name
  if (st.status === "reused") {
    return [{ step: name, shard: null, stream: "kiln", level: "info", timestamp: s.queuedAt, text: `reused ${s.key ?? ""} from run ${s.reusedFrom ?? ""}, nothing ran` }]
  }
  if (st.status === "blocked") {
    return [{ step: name, shard: null, stream: "kiln", level: "info", timestamp: s.finishedAt, text: "blocked: a step it depends on didn't pass" }]
  }
  if (st.startedAt === null) return []
  const duration = s.finishedAt - s.startedAt
  const until = st.finishedAt ?? now
  const out: Array<Domain.LogLine> = scriptOf(run, s)
    .sort((a, b) => a[0] - b[0])
    .map(([at, level, stream, text, shard]) => ({ step: name, shard: shard ?? null, stream, level, timestamp: Math.round(s.startedAt + at * duration), text }))
    .filter((l) => l.timestamp <= until)
  if (st.status === "cancelled") out.push({ step: name, shard: null, stream: "kiln", level: "warn", timestamp: until, text: "cancelled by hauke" })
  return out
}

/* ------------------------------------------------------------------ */
/* Traces and metrics                                                  */

export function trace(run: SimRun, now: number): Array<Domain.Span> {
  const status = runStatus(run, now)
  const end = isActive(status) ? now : (status === "cancelled" ? run.cancelledAt ?? run.finishedAt : run.finishedAt)
  const root = hex(`span:${run.id}:root`, 16)
  const spans: Array<Domain.Span> = [{
    spanId: root, parentId: null, name: `run ${run.project} #${run.number}`, start: run.createdAt, end,
    status: isActive(status) ? "unset" : status === "failed" ? "error" : "ok",
    attributes: { "kiln.run": run.id, "kiln.project": run.project, "vcs.revision": run.commit.sha },
  }]
  spans.push({ spanId: hex(`span:${run.id}:plan`, 16), parentId: root, name: "plan", start: run.createdAt, end: run.startedAt, status: "ok", attributes: { "kiln.worker": "kiln-worker-plan", "kiln.steps": String(run.steps.length) } })
  for (const s of run.steps) {
    const st = stepState(run, s, now)
    if (st.status === "pending" || st.status === "blocked" || st.status === "queued") continue
    const id = spanIdOf(run, s.plan.name)
    const from = st.status === "reused" ? s.queuedAt : st.startedAt ?? s.queuedAt
    const to = st.finishedAt ?? now
    const open = st.finishedAt === null
    spans.push({
      spanId: id, parentId: root, name: s.plan.name, start: from, end: to,
      status: open ? "unset" : st.status === "failed" || st.status === "died" ? "error" : "ok",
      attributes: {
        "kiln.step": s.plan.name, "kiln.kind": s.plan.kind, "kiln.status": st.status, ...(s.key ? { "kiln.key": s.key } : {}),
        ...(st.queuedAt !== null && st.startedAt !== null ? { "kiln.queue_ms": String(st.startedAt - st.queuedAt) } : {}),
      },
    })
    if (st.status === "reused" || st.startedAt === null) continue
    const d = s.finishedAt - s.startedAt
    const child = (name: string, a: number, b: number, attributes: Record<string, string>, err = false) => {
      const cs = s.startedAt + a * d
      if (cs > to) return
      const ce = Math.min(to, s.startedAt + b * d)
      spans.push({ spanId: hex(`span:${run.id}:${s.plan.name}:${name}`, 16), parentId: id, name, start: cs, end: ce, status: ce >= to && open ? "unset" : err ? "error" : "ok", attributes })
    }
    if (s.plan.kind === "build") {
      child("nix eval", 0, 0.03, { "nix.attr": s.plan.detail })
      child("substitute from attic", 0.03, 0.12, { "nix.paths": String(12 + (fnv(s.plan.name) % 300)) })
      child(`build ${s.plan.name}.drv`, 0.12, 0.99, { "nix.host": "srv-2" }, st.status === "failed")
    } else if (s.plan.kind === "task") {
      child("workspace", 0, 0.01, { "git.revision": short(run.commit.sha) })
      child(".ci/setup", 0.01, 0.04, {})
      if (s.plan.shards) {
        for (let i = 1; i <= s.plan.shards; i++) child(`shard ${i} of ${s.plan.shards}`, 0.04, 0.9 + i * 0.03, { "kiln.shard": String(i) })
      } else {
        child(s.plan.detail, 0.04, 0.99, { "process.unit": `kiln-task-${hex(`unit:${run.id}:${s.plan.name}`, 6)}.service` }, st.status === "failed")
      }
    } else if (s.plan.name === "promote") {
      child(`lease deploy:${run.project}`, 0, 0.002, { "kiln.fence": String(1100 + run.number) })
      for (const ph of phases(run)) {
        const span = ph.activate - ph.from
        child(`POST ${ph.host} /preflight`, ph.from + span * 0.005, ph.from + span * 0.02, { "http.status": "200", "server.address": ph.host })
        child("attic narinfo", ph.from + span * 0.02, ph.from + span * 0.04, { "attic.cache": "fleet" })
        child(`POST ${ph.host} /deploy`, ph.from + span * 0.07, ph.from + span * 0.1, { "http.status": "202", "server.address": ph.host })
        child(`readiness ${ph.host}`, ph.from + span * 0.1, ph.activate, { "url.full": `${urlOf(run.project)}/api/health/ready` })
      }
    } else {
      child(s.plan.detail, 0, 0.99, {})
    }
  }
  return spans
}

export function metrics(run: SimRun, s: SimStep, now: number): Domain.Metrics {
  const st = stepState(run, s, now)
  if (st.startedAt === null) return { samples: [] }
  const until = st.finishedAt ?? now
  const base = s.plan.kind === "build" ? 310 : s.plan.kind === "task" ? 170 : 4
  const mem = s.plan.kind === "build" ? 2.1 : s.plan.kind === "task" ? 1.1 : 0.06
  const samples: Array<Domain.Metrics["samples"][number]> = []
  const seed = fnv(`${run.id}:${s.plan.name}`)
  for (let t = st.startedAt, i = 0; t <= until; t += 2000, i++) {
    const wave = Math.sin(i / 3 + (seed % 7)) * 0.22 + Math.sin(i / 11) * 0.12
    const ramp = Math.min(1, i / 8)
    samples.push({ timestamp: t, cpuPercent: Math.max(2, Math.round(base * (0.55 + 0.45 * ramp) * (1 + wave))), memoryBytes: Math.round(mem * 2 ** 30 * (0.35 + 0.65 * ramp) * (1 + wave * 0.15)) })
  }
  return { samples: samples.slice(-400) }
}

/* ------------------------------------------------------------------ */
/* Deployments                                                         */

type MutableDeployment = { -readonly [K in keyof Domain.Deployment]: Domain.Deployment[K] }

/** Folds every promote that has started by `now` into what each host runs. */
export function deployments(world: World, now: number): Array<Domain.Deployment> {
  const state = new Map<string, MutableDeployment>()
  for (const project of PROJECTS) {
    for (const host of hostsOf(project)) {
      state.set(`${project}|${host}`, { project, host, revision: null, storePath: null, pending: null, previous: null, since: null, healthy: null, url: urlOf(project), deployingRun: null })
    }
  }
  const promotes = world.runs
    .flatMap((run) => run.steps.filter((s) => s.plan.name === "promote" && s.outcome === "passed").map((s) => ({ run, s })))
    .sort((a, b) => a.s.startedAt - b.s.startedAt)
  for (const { run, s } of promotes) {
    if (now < s.startedAt) continue
    const d = s.finishedAt - s.startedAt
    for (const ph of phases(run)) {
      const dep = state.get(`${run.project}|${ph.host}`)
      if (!dep) continue
      const from = s.startedAt + ph.from * d
      const activate = s.startedAt + ph.activate * d
      const cut = run.cancelledAt
      if (cut !== null && cut < activate) {
        dep.deployingRun = now >= from && now < cut ? run.id : dep.deployingRun === run.id ? null : dep.deployingRun
        continue
      }
      if (now >= activate) {
        if (dep.revision !== run.commit.sha) dep.previous = dep.revision
        dep.revision = run.commit.sha
        dep.storePath = storePathOf(run)
        dep.since = Math.round(activate)
        dep.healthy = true
        if (dep.deployingRun === run.id) dep.deployingRun = null
      } else if (now >= from) {
        dep.deployingRun = run.id
      }
    }
  }
  const ralfs = state.get("ralfs-audio-finder|srv-2")
  if (ralfs) ralfs.healthy = false
  const merkbeet = state.get("merkbeet|srv-2")
  if (merkbeet) merkbeet.healthy = null
  const anna = state.get("anna-fotoalbum|srv-2")
  if (anna) anna.pending = hex("sha:anna-fotoalbum:incompatible", 40)
  return [...state.values()]
}
