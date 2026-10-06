import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Imports from "../src/worker/Imports.ts"
import type { Repo } from "../src/worker/Repo.ts"

/** A revision held in memory: paths and their contents. */
const repo = (tree: Record<string, string>): Repo => {
  const entries = Object.keys(tree).map((path, i) => ({ path, oid: `oid-${i}` }))
  return {
    files: Effect.succeed(Object.keys(tree)),
    entries: Effect.succeed(entries),
    show: (path: string) => Effect.succeed(tree[path]),
    objectIds: (paths: ReadonlyArray<string>) => Effect.succeed(new Map(paths.map((p) => [p, `tree-${p}`]))),
    read: (paths: ReadonlyArray<string>) => Effect.succeed(new Map(paths.flatMap((p) => (tree[p] === undefined ? [] : [[p, tree[p]!] as const])))),
  } as unknown as Repo
}

// The repository is in memory; nothing here runs git.
const noProcesses = ChildProcessSpawner.make(() => Effect.die(new Error("no processes in this test")))
const graphOf = (r: Repo) => Imports.make(r, ["packages/contracts", "apps/server", "apps/web"]).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noProcesses))

const fixture = repo({
  "package.json": JSON.stringify({ name: "root" }),
  "packages/contracts/package.json": JSON.stringify({ name: "@t3/contracts", exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" }, "./*": "./src/*.ts" } }),
  "packages/contracts/src/index.ts": `export * from "./schema.js"`,
  "packages/contracts/src/schema.ts": `export const a = 1`,
  "packages/contracts/src/settings.ts": `import type { Opts } from "./types"\nexport const s = 1`,
  "packages/contracts/src/types.d.ts": `export type Opts = {}`,
  "apps/server/package.json": JSON.stringify({ name: "server" }),
  "apps/server/src/git.ts": `import { a } from "@t3/contracts"\nimport { s } from "@t3/contracts/settings"\nimport { Effect } from "effect"`,
  "apps/server/src/git.test.ts": `import {\n  thing,\n} from "./git.ts"\nvi.mock("./mocked")\nconst fixtures = new URL("./fixtures/repo", import.meta.url)`,
  "apps/server/src/mocked/index.ts": `export {}`,
  "apps/server/src/fixtures/repo/HEAD": "ref: refs/heads/main",
  "apps/server/src/plugin.ts": `export const load = (name: string) => import(name)`,
  "apps/server/src/plugin.test.ts": `// kiln: always\nimport { load } from "./plugin"`,
  "apps/server/README.md": "docs",
  "apps/web/package.json": JSON.stringify({ name: "web" }),
  "apps/web/src/app.test.tsx": `import { x } from "~/lib/x"`,
  "apps/web/src/lib/x.ts": `export const x = 1`,
})

describe("Imports", () => {
  it.effect("follows relative, workspace, type-only and mocked imports to repository files", () =>
    Effect.gen(function*() {
      const graph = yield* graphOf(fixture)
      const closure = yield* graph.closure(["apps/server/src/git.test.ts"], { aliases: {}, types: true })
      expect([...closure].sort()).toEqual([
        "apps/server/src/fixtures/repo",
        "apps/server/src/git.test.ts",
        "apps/server/src/git.ts",
        "apps/server/src/mocked/index.ts",
        "packages/contracts/src/index.ts",
        "packages/contracts/src/schema.ts",
        "packages/contracts/src/settings.ts",
        "packages/contracts/src/types.d.ts",
      ])
      // At run time the type-only import is gone.
      expect(yield* graph.closure(["apps/server/src/git.test.ts"], { aliases: {}, types: false })).not.toContain("packages/contracts/src/types.d.ts")
    }))

  it.effect("resolves aliases and widens a computed import to its package", () =>
    Effect.gen(function*() {
      const graph = yield* graphOf(fixture)
      expect([...(yield* graph.closure(["apps/web/src/app.test.tsx"], { aliases: { "~": "apps/web/src" }, types: false }))].sort()).toEqual([
        "apps/web/src/app.test.tsx",
        "apps/web/src/lib/x.ts",
      ])
      expect(yield* graph.closure(["apps/server/src/plugin.test.ts"], { aliases: {}, types: false })).toContain("apps/server")
      expect(graph.always("apps/server/src/plugin.test.ts")).toBe(true)
      expect(graph.always("apps/server/src/git.test.ts")).toBe(false)
    }))

  it.effect("finds a package's data files, without code or docs", () =>
    Effect.gen(function*() {
      const graph = yield* graphOf(fixture)
      expect(graph.packageOf("apps/server/src/git.ts")).toBe("apps/server")
      expect(graph.data("apps/server")).toEqual(["apps/server/package.json", "apps/server/src/fixtures/repo/HEAD"])
      expect(graph.match(["apps/server/**/*.test.ts"])).toEqual(["apps/server/src/git.test.ts", "apps/server/src/plugin.test.ts"])
    }))
})
