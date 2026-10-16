/**
 * The hero's simulated runs of a small TypeScript monorepo. A step's key comes from the versions of
 * the files it reads, the way Kiln's come from git tree ids, and a tile takes the glaze of its key.
 * The page renders the opening runs at build time, and the browser replays them to continue.
 */

// Kiln's UI glazes (packages/ui/src/format.ts). No reds or oranges: those mean failure and heat.
const glazes = [
  "#8fc1a9", "#86a8e7", "#5b7fe0", "#e7c9a0", "#4fb3a9", "#a592e0",
  "#7fa65e", "#a7aea4", "#ddd3bf", "#d4b04a", "#3f9b98", "#c7a0d9",
] as const

export type File =
  | "package.json"
  | "pnpm-lock.yaml"
  | "README.md"
  | "core/Plan.ts"
  | "core/Files.ts"
  | "core/Keys.ts"
  | "ui/app.tsx"

export interface Step {
  readonly name: string
  readonly reads: ReadonlyArray<File>
  /** Starts from the install, so the install's key is part of its own. */
  readonly setup: boolean
  readonly seconds: number
}

const sources = ["core/Plan.ts", "core/Files.ts", "core/Keys.ts", "ui/app.tsx"] as const satisfies ReadonlyArray<File>
const install: Step = { name: "install", reads: ["package.json", "pnpm-lock.yaml"], setup: false, seconds: 34 }

export const steps: ReadonlyArray<Step> = [
  install,
  { name: "typecheck", reads: sources, setup: true, seconds: 21 },
  { name: "lint", reads: sources, setup: true, seconds: 9 },
  { name: "Plan.test", reads: ["core/Plan.ts"], setup: true, seconds: 6 },
  { name: "Files.test", reads: ["core/Files.ts"], setup: true, seconds: 4 },
  { name: "Keys.test", reads: ["core/Keys.ts", "core/Plan.ts"], setup: true, seconds: 5 },
  { name: "app.test", reads: ["ui/app.tsx"], setup: true, seconds: 8 },
  { name: "release", reads: ["package.json", "pnpm-lock.yaml", ...sources], setup: false, seconds: 47 },
]

/** The pull requests a visitor can open, each changing one file. */
export const changes = [
  { file: "README.md", label: "Edit README.md" },
  { file: "core/Plan.ts", label: "Edit core/Plan.ts" },
  { file: "ui/app.tsx", label: "Edit ui/app.tsx" },
  { file: "pnpm-lock.yaml", label: "Update pnpm-lock.yaml" },
] as const satisfies ReadonlyArray<{ readonly file: File; readonly label: string }>

export interface Tile {
  readonly step: Step
  readonly key: string
  readonly glaze: string
  /** The run whose result this is: this one when it ran, an earlier one when reused. */
  readonly from: number
  readonly ran: boolean
  /** Simulated seconds after the run started, when it ran. */
  readonly start: number
}

export interface Run {
  readonly id: number
  readonly event: string
  readonly change: string
  readonly tiles: ReadonlyArray<Tile>
  /** Simulated seconds until the last tile settled. */
  readonly seconds: number
}

const fnv = (text: string, seed: number) => {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash
}

const hex = (text: string) =>
  (fnv(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(text, 0x9e3779b9).toString(16).padStart(8, "0")).slice(0, 12)

/** Settling a reused step still takes Kiln a moment: planning, the lookup and the status. */
const overhead = 2

export class Simulation {
  private readonly versions = new Map<File, number>()
  private readonly results = new Map<string, number>()
  private readonly glazeOf = new Map<string, string>()
  private readonly lastGlaze = new Map<string, string>()
  private nextRun = 38
  private nextPullRequest = 14

  /** The runs before a visitor did anything: a cold start, a pull request and its merge. */
  seed(): ReadonlyArray<Run> {
    return [this.run("main", "first run, nothing to reuse"), ...this.pullRequest("core/Files.ts")]
  }

  /** A pull request that changes `file`, and the push to main that merges it. */
  pullRequest(file: File): readonly [Run, Run] {
    this.versions.set(file, (this.versions.get(file) ?? 0) + 1)
    const number = this.nextPullRequest++
    return [this.run(`pull request ${number}`, `edits ${file}`), this.run("main", `merges pull request ${number}`)]
  }

  private run(event: string, change: string): Run {
    const id = this.nextRun++
    const installKey = this.keyOf(install)
    const installRan = !this.results.has(installKey)
    const tiles = steps.map((step): Tile => {
      const key = this.keyOf(step)
      const glaze = this.glaze(step, key)
      const from = this.results.get(key)
      const start = step.setup && installRan ? install.seconds : 0
      return from === undefined
        ? { step, key, glaze, from: id, ran: true, start }
        : { step, key, glaze, from, ran: false, start: 0 }
    })
    for (const tile of tiles) if (tile.ran) this.results.set(tile.key, id)
    const seconds = Math.max(overhead, ...tiles.filter((t) => t.ran).map((t) => t.start + t.step.seconds))
    return { id, event, change, tiles, seconds }
  }

  private keyOf(step: Step): string {
    const reads = step.reads.map((file) => `${file}@${this.versions.get(file) ?? 0}`)
    return hex([step.name, ...reads, step.setup ? this.keyOf(install) : ""].join("\n"))
  }

  /**
   * Kiln hashes a key to one of twelve glazes, so two keys can share one. Here a new key skips the
   * glazes any column shows, so that a change of glaze always means a change of key.
   */
  private glaze(step: Step, key: string): string {
    const known = this.glazeOf.get(key)
    if (known !== undefined) return known
    const taken = new Set(this.lastGlaze.values())
    const start = fnv(key, 0x811c9dc5) % glazes.length
    const free = glazes.map((_, i) => glazes[(start + i) % glazes.length] ?? glazes[0])
    const glaze = free.find((g) => !taken.has(g)) ?? glazes[start] ?? glazes[0]
    this.glazeOf.set(key, glaze)
    this.lastGlaze.set(step.name, glaze)
    return glaze
  }
}

export const duration = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`

export const tally = (run: Run) => {
  const ran = run.tiles.filter((t) => t.ran).length
  const reused = run.tiles.length - ran
  if (ran === 0) return `${reused} reused`
  if (reused === 0) return `${ran} ran`
  return `${ran} ran, ${reused} reused`
}
