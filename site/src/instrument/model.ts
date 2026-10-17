/**
 * What the instrument plays: the example pipeline in src/example/ci.ts. The plans, errors and
 * refusals are the real output of `calder plan` and tsc on that file (see the README for how to
 * check them again); line numbers point into it.
 */

export type StepName = "install" | "typecheck" | "test" | "site" | "deploy"
export type EventName = "pr" | "push" | "check"
export type Lamp = "planned" | "pulled" | "off" | "runs" | "remembered" | "fault"

export interface Step {
  readonly name: StepName
  readonly kind: "setup" | "task" | "build" | "action"
  /** The lines of ci.ts that define it. */
  readonly lines: readonly [number, number]
}

export const steps: ReadonlyArray<Step> = [
  { name: "install", kind: "setup", lines: [7, 7] },
  { name: "typecheck", kind: "task", lines: [9, 14] },
  { name: "test", kind: "task", lines: [16, 20] },
  { name: "site", kind: "build", lines: [22, 22] },
  { name: "deploy", kind: "action", lines: [24, 30] },
]

export interface Event {
  readonly label: string
  /** The rule of ci.ts this event matches. */
  readonly rule: number
  readonly lamps: Readonly<Record<StepName, Lamp>>
  readonly plan: string
}

export const events: Readonly<Record<EventName, Event>> = {
  pr: {
    label: "Pull request",
    rule: 34,
    lamps: { install: "pulled", typecheck: "planned", test: "planned", site: "planned", deploy: "off" },
    plan: `$ calder plan --event pr:7
pull request #7: pr, reuse all
  setup  install (pulled in)
  task   typecheck  ← needs install
  task   test  ← needs install
  build  site`,
  },
  push: {
    label: "Push to main",
    rule: 35,
    lamps: { install: "pulled", typecheck: "pulled", test: "pulled", site: "pulled", deploy: "planned" },
    plan: `$ calder plan --event push:main
push to main: trusted, reuse all
  build  site (pulled in)
  setup  install (pulled in)
  task   typecheck (pulled in)  ← needs install
  task   test (pulled in)  ← needs install
  action deploy  ← needs site, after typecheck, after test`,
  },
  check: {
    label: "Before you push",
    rule: 34,
    lamps: { install: "pulled", typecheck: "planned", test: "planned", site: "planned", deploy: "off" },
    plan: `$ calder plan --event check
check of calder/check/local: pr, reuse all
  setup  install (pulled in)
  task   typecheck  ← needs install
  task   test  ← needs install
  build  site`,
  },
}

/** Handing the pull-request rule the step that deploys. */
export const mistake = {
  line: 34,
  before: "    On.pullRequest([typecheck, test, site]),",
  after: "    On.pullRequest([typecheck, test, site, deploy]),",
  column: 44,
  error: `ci.ts:34:44 error TS2322: Type 'Step<void, never, HttpClient, {},
  { readonly secrets: readonly ["deploy-token"]; }>' is not assignable to
  type 'Step<any, any, any, any, never>'.`,
  reason: `Type '{ readonly secrets: readonly ["deploy-token"]; }' is not assignable to type 'never'.`,
  refusal: `$ calder plan --event pr:7
calder: pull-request runs don't run steps with grants or secrets, but "deploy" has them`,
} as const

export type FileName = "README.md" | "apps/web/src/price.ts" | "apps/api/src/health.ts" | "pnpm-lock.yaml"

export interface Edit {
  readonly file: FileName
  readonly lamps: Readonly<Record<StepName, Lamp>>
  /** The test files that run, of price.test.ts and health.test.ts. */
  readonly tests: string
  readonly why: string
}

/** What a pull request reruns after an edit to one file, given what main already ran. */
export const edits: ReadonlyArray<Edit> = [
  {
    file: "README.md",
    lamps: { install: "remembered", typecheck: "remembered", test: "remembered", site: "remembered", deploy: "off" },
    tests: "0 of 2 test files",
    why: "No step reads it, so every key stays the same and every result comes from main.",
  },
  {
    file: "apps/web/src/price.ts",
    lamps: { install: "remembered", typecheck: "runs", test: "runs", site: "runs", deploy: "off" },
    tests: "1 of 2 test files",
    why: "typecheck reads apps/. Only price.test.ts imports price.ts, so health.test.ts keeps its result. Nix rebuilds the site, which is built from apps/web.",
  },
  {
    file: "apps/api/src/health.ts",
    lamps: { install: "remembered", typecheck: "runs", test: "runs", site: "remembered", deploy: "off" },
    tests: "1 of 2 test files",
    why: "typecheck reads apps/ and health.test.ts imports health.ts. The site isn't built from apps/api, so Nix has nothing to build.",
  },
  {
    file: "pnpm-lock.yaml",
    lamps: { install: "runs", typecheck: "runs", test: "runs", site: "runs", deploy: "off" },
    tests: "2 of 2 test files",
    why: "The lockfile is part of install's key, and every task that starts from install includes that key in its own. The site's Nix build reads it too.",
  },
]
