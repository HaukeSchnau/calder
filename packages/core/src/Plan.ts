import { Effect, Schema } from "effect"
import type { Event } from "./Event.ts"
import type { Project } from "./Kiln.ts"
import { matchesBranch, type Reuse, type Rule } from "./On.ts"
import { dependencies, isStep, type Kind, type Step } from "./Step.ts"

export class PlanError extends Schema.TaggedError<PlanError>("@kiln/core/PlanError")("PlanError", {
  message: Schema.String,
}) {}

export interface PlannedStep {
  readonly step: Step.Any
  readonly name: string
  readonly kind: Kind
  /** Steps whose values this one reads. */
  readonly needs: ReadonlyArray<string>
  /** Steps whose outcome this one reads through `Step.exit`. It runs whether they pass or not. */
  readonly exits: ReadonlyArray<string>
  /** Steps that must pass first, including the implicit required checks. */
  readonly after: ReadonlyArray<string>
  /** The required checks among `after`, added because the step has grants. */
  readonly required: ReadonlyArray<string>
  /** Requested by a rule rather than pulled in by another step. */
  readonly target: boolean
  /** Downstream of an action, so its result is never reused. */
  readonly neverReuse: boolean
}

export interface Plan {
  readonly trust: "pr" | "trusted"
  readonly reuse: Reuse
  readonly event: Event
  /** Topologically ordered: every step comes after what it depends on. */
  readonly steps: ReadonlyArray<PlannedStep>
  /** Every step the project's rules can reach, by name. */
  readonly universe: ReadonlyMap<string, Step.Any>
  /** The project's schedules, so the controller knows when to plan the default branch. */
  readonly schedules: ReadonlyArray<string>
  readonly get: (step: Step.Any | string) => PlannedStep | undefined
  readonly runs: (step: Step.Any) => boolean
  readonly needs: (step: Step.Any) => ReadonlyArray<Step.Any>
  readonly waitsFor: (step: Step.Any) => ReadonlyArray<Step.Any>
}

export interface Options {
  /** Status contexts that branch protection requires, such as `kiln/qa`. */
  readonly requiredChecks?: ReadonlyArray<string>
}

const fail = (message: string) => new PlanError({ message })

const matches = (rule: Rule<any, any>, event: Event): boolean => {
  const t = rule.trigger
  switch (event._tag) {
    case "PullRequest":
    case "Check":
      return t._tag === "PullRequest"
    case "Push":
      return t._tag === "Push" && matchesBranch(t.branch, event.branch)
    case "Schedule":
      return t._tag === "Schedule" && t.cron === event.cron
    case "Manual":
      return t._tag === "Manual"
  }
}

const hasGrants = (step: Step.Any) =>
  (step.def._tag === "Action" && (step.def.grants.deploy === true || (step.def.grants.secrets?.length ?? 0) > 0)) ||
  (step.def._tag === "Task" && Object.keys(step.def.secrets).length > 0)

const sameBuild = (a: Step.Any, b: Step.Any) =>
  a.def._tag === "Build" && b.def._tag === "Build" && a.def.ref.output === b.def.ref.output &&
  a.def.ref.name === b.def.ref.name && a.policies.length === 0 && b.policies.length === 0

/** Every step reachable from the project's rules, by name. Two different steps with one name are an error. */
export const universe = (project: Project): Effect.Effect<Map<string, Step.Any>, PlanError> =>
  Effect.gen(function*() {
    const byName = new Map<string, Step.Any>()
    const seen = new Set<Step.Any>()
    const visit = (step: Step.Any): PlanError | undefined => {
      if (seen.has(step)) return
      seen.add(step)
      const existing = byName.get(step.name)
      if (existing !== undefined && existing !== step && !sameBuild(existing, step)) {
        return fail(`two different steps are named "${step.name}"`)
      }
      if (existing === undefined) byName.set(step.name, step)
      for (const dep of dependencies(step)) {
        const error = visit(dep.step)
        if (error) return error
      }
    }
    for (const rule of project.rules) {
      for (const target of rule.targets) {
        if (!isStep(target)) return yield* fail(`a rule lists something that isn't a step: ${String(target)}`)
        const error = visit(target)
        if (error) return yield* error
      }
    }
    return byName
  })

/**
 * Resolves which steps an event runs and how they depend on each other. Pure: it never runs user code
 * and reads nothing but the project, so pipelines can be tested with `Kiln.plan`.
 */
export const plan = (project: Project, event: Event, options: Options = {}): Effect.Effect<Plan, PlanError> =>
  Effect.gen(function*() {
    const all = yield* universe(project)
    const canonical = (step: Step.Any) => all.get(step.name) ?? step

    const rules = project.rules.filter((rule) => matches(rule, event))
    const trust: "pr" | "trusted" = event._tag === "PullRequest" || event._tag === "Check" ? "pr" : "trusted"
    const reuse: Reuse = rules.some((r) => r.reuse === "none") ? "none"
      : rules.some((r) => r.reuse === "builds") ? "builds"
      : rules[0]?.reuse ?? (trust === "pr" ? "all" : "builds")

    if (event._tag === "Manual") {
      for (const rule of rules) {
        if (rule.trigger._tag !== "Manual") continue
        if (!Schema.is(Schema.Struct(rule.trigger.inputs))(event.inputs)) {
          return yield* fail(`manual inputs ${JSON.stringify(event.inputs)} don't match the rule`)
        }
      }
    }

    const required = (options.requiredChecks ?? []).map((context) => {
      const name = context.startsWith("kiln/") ? context.slice("kiln/".length) : undefined
      return { context, name }
    })

    const planned = new Map<string, PlannedStep>()
    const order: Array<string> = []
    const targets = new Set(rules.flatMap((r) => r.targets.map((t) => canonical(t).name)))
    const state = new Map<string, "visiting" | "done">()

    const visit = (input: Step.Any, path: ReadonlyArray<string>): PlanError | undefined => {
      const step = canonical(input)
      const mark = state.get(step.name)
      if (mark === "done") return
      if (mark === "visiting") return fail(`steps depend on each other in a cycle: ${[...path, step.name].join(" → ")}`)
      state.set(step.name, "visiting")

      if (trust === "pr" && hasGrants(step)) {
        return fail(`pull-request runs don't run steps with grants or secrets, but "${step.name}" has them`)
      }

      const def = step.def
      if (def._tag === "Setup" && def.run.steps.length > 0) {
        return fail(`setup "${step.name}" interpolates other steps; its command can only depend on its inputs`)
      }
      if (def._tag === "Task" && def.setup !== undefined && def.setup.def._tag === "Setup" && def.setup.def.platform !== def.platform) {
        return fail(`"${step.name}" runs on ${def.platform ?? "the controller's platform"} but its setup "${def.setup.name}" on ${def.setup.def.platform ?? "the controller's platform"}`)
      }
      const deps = dependencies(step).map((d) => ({ ...d, step: canonical(d.step) }))
      const needs = deps.filter((d) => d.via === "needs").map((d) => d.step.name)
      const exits = deps.filter((d) => d.via === "exit").map((d) => d.step.name)
      const after = deps.filter((d) => d.via === "after").map((d) => d.step.name)

      const conflict = after.find((name) => exits.includes(name))
      if (conflict !== undefined) {
        return fail(`"${step.name}" waits for "${conflict}" and reads its exit, which contradict each other`)
      }

      const implicit: Array<string> = []
      if (trust === "trusted" && step.kind === "action" && hasGrants(step)) {
        for (const r of required) {
          if (r.name === undefined) {
            return fail(`branch protection requires "${r.context}", which Kiln doesn't report; required checks must be kiln/<step>`)
          }
          if (!all.has(r.name)) {
            return fail(`branch protection requires "${r.context}", but no step is named "${r.name}"`)
          }
          if (r.name !== step.name && !after.includes(r.name)) implicit.push(r.name)
        }
      }

      for (const name of [...needs, ...exits, ...after, ...implicit]) {
        const error = visit(all.get(name)!, [...path, step.name])
        if (error) return error
      }

      const upstream = [...needs, ...exits, ...after, ...implicit].map((n) => planned.get(n)!)
      planned.set(step.name, {
        step,
        name: step.name,
        kind: step.kind,
        needs: unique(needs),
        exits: unique(exits),
        after: unique([...after, ...implicit]),
        required: unique(implicit),
        target: targets.has(step.name),
        neverReuse: step.kind === "action" || upstream.some((p) => p.kind === "action" || p.neverReuse),
      })
      state.set(step.name, "done")
      order.push(step.name)
    }

    for (const name of targets) {
      const error = visit(all.get(name)!, [])
      if (error) return yield* error
    }

    const steps = order.map((name) => planned.get(name)!)
    const get = (step: Step.Any | string) => planned.get(typeof step === "string" ? step : step.name)
    return {
      trust,
      reuse,
      event,
      steps,
      universe: all,
      schedules: unique(project.rules.flatMap((r) => (r.trigger._tag === "Schedule" ? [r.trigger.cron] : []))),
      get,
      runs: (step) => planned.has(step.name),
      needs: (step) => (get(step)?.needs ?? []).map((n) => all.get(n)!),
      waitsFor: (step) => (get(step)?.after ?? []).map((n) => all.get(n)!),
    }
  })

const unique = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(xs)]
