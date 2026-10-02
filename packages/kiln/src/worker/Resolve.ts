import { Cmd, Files, Flake, Kiln, type Step } from "@kiln/core"
import { Effect } from "effect"
import * as Exec from "../Exec.ts"
import { sha256 } from "../Keys.ts"
import type { PlannedStep, PlanSpec, RunInfo } from "../Protocol.ts"
import type { Repo } from "./Repo.ts"

/** Root files every workspace package reads: manifests, lockfiles and the fleet's `.ci/` contract. */
const rootFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  ".npmrc",
  ".ci",
]

interface Manifest {
  readonly dir: string
  readonly name: string
  readonly deps: ReadonlyArray<string>
}

const workspaceGlobs = (repo: Repo) =>
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

const manifests = (repo: Repo) =>
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

/** Concrete paths for a `Files` value at the revision. Directories stay directories. */
export const paths = (repo: Repo, files: Files.Files): Effect.Effect<ReadonlyArray<string>, Exec.ExecError, Exec.Spawner> =>
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
      case "Union":
        return (yield* Effect.forEach(files.members, (m) => paths(repo, m))).flat()
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
        return [...rootFiles, ...[...seen].sort()]
      }
    }
  })

export const devShellDrv = (run: RunInfo, attr: string) =>
  Exec.run(["nix", "eval", "--raw", `${run.flake}#${attr}.drvPath`]).pipe(Effect.map((s) => s.trim()))

const describeCmd = (run: Cmd.Cmd<unknown> | ((shard: Step.Shard) => Cmd.Cmd<unknown>), count: number) =>
  Cmd.show(typeof run === "function" ? run({ index: 1, count, files: ["<files>"] }) : run)

/** Turns a plan into the wire format, resolving tree ids, dev shells and task keys at the revision. */
export const resolve = (plan: Kiln.Plan, project: Kiln.Project, run: RunInfo, repo: Repo) =>
  Effect.gen(function*() {
    const shared = project.shared === undefined ? [] : yield* paths(repo, project.shared)
    const shellAttrs = new Set(
      plan.steps.flatMap((p) => (p.step.def._tag === "Task" && p.step.def.shell !== undefined ? [Flake.attrPath(p.step.def.shell, run.system)] : [])),
    )
    const shells = new Map(
      yield* Effect.forEach(shellAttrs, (attr) => devShellDrv(run, attr).pipe(Effect.map((drv) => [attr, drv] as const)), {
        concurrency: "unbounded",
      }),
    )

    const steps = yield* Effect.forEach(plan.steps, (p) =>
      Effect.gen(function*() {
        const def = p.step.def
        const base = {
          name: p.name,
          kind: p.kind,
          needs: p.needs,
          exits: p.exits,
          after: p.after,
          required: p.required,
          target: p.target,
          neverReuse: p.neverReuse,
          build: null,
          task: null,
          action: null,
          output: null,
        } satisfies Partial<PlannedStep>
        switch (def._tag) {
          case "Build": {
            const attr = Flake.attrPath(def.ref, run.system)
            return { ...base, detail: attr, build: { attr } }
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
              action: { deploy: def.grants.deploy === true, secrets: [...(def.grants.secrets ?? [])] },
            }
          case "Task": {
            const inputs = [...new Set([...(yield* paths(repo, def.inputs)), ...shared])].sort()
            const ids = yield* repo.objectIds(inputs)
            const split = def.shards?.split === undefined ? [] : yield* paths(repo, def.shards.split)
            const splitIds = split.length === 0 ? new Map<string, string>() : yield* repo.objectIds(split)
            const shell = def.shell === undefined ? null : Flake.attrPath(def.shell, run.system)
            const toolchain = shell === null ? null : shells.get(shell) ?? null
            const count = def.shards?.count ?? 1
            const command = typeof def.run === "function" ? def.run({ index: 1, count, files: [] }) : def.run
            const keyBase = sha256({
              kind: "task",
              inputs: inputs.map((path) => [path, ids.get(path) ?? null]),
              split: split.map((path) => [path, splitIds.get(path) ?? null]),
              toolchain,
              command: describeCmd(def.run, count),
              env: Object.entries(def.env).sort(),
              secrets: Object.keys(def.secrets).sort(),
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
                interpolates: command.steps.map((s) => s.name),
                shards: def.shards?.count ?? null,
                outputs: Object.keys(def.outputs),
                secrets: Object.values(def.secrets).map((s) => s.name),
                platform: def.platform ?? null,
              },
            }
          }
        }
      }), { concurrency: 4 })

    const spec: PlanSpec = { version: 1, trust: plan.trust, reuse: plan.reuse, schedules: plan.schedules, steps }
    return spec
  })
