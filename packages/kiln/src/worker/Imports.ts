import { Files } from "@kiln/core"
import { Effect } from "effect"
import { posix } from "node:path"
import type { Repo } from "./Repo.ts"

const code = /\.(?:[cm]?[jt]sx?)$/
const docs = /\.mdx?$/i
const resolvable = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]
const jsToTs: Record<string, ReadonlyArray<string>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

// Regular expressions instead of a parser: a typecheck's closure needs type-only imports, which
// transpilers drop, and a specifier found in a comment only makes a key more conservative.
const staticImport = /(?:^|[^\w$.])(?:import|export)\s*(type\s+)?(?:[\w$*{},\s]+?\s*from\s*)?["']([^"'\n]+)["']/g
const callImport = /(?:^|[^\w$.])(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\s*\(\s*["']([^"'\n]+)["']/g
const urlImport = /new\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g
const globImport = /import\.meta\.glob(?:Eager)?\s*\(\s*["']([^"'\n]+)["']/g
const computedImport = /(?:^|[^\w$.])import\s*\(\s*(?!["'])/

type Imports = Extract<Files.Files, { readonly _tag: "Imports" }>
type Aliases = Imports["aliases"]
/** How a closure follows imports. */
export type Follow = Pick<Imports, "aliases" | "types">

interface Package {
  readonly dir: string
  readonly name: string
  readonly exports: unknown
  readonly main: string | undefined
}

/** Every path an `exports` value can point at, whatever the conditions. */
const targets = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(targets)
    : value !== null && typeof value === "object" ? Object.values(value).flatMap(targets)
    : []

const exported = (pkg: Package, subpath: string): ReadonlyArray<string> => {
  const { exports } = pkg
  if (exports === undefined || exports === null) {
    return subpath === "." ? [pkg.main ?? "index"] : [subpath]
  }
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === "." ? targets(exports) : []
  const entries = Object.entries(exports as Record<string, unknown>)
  if (!entries.some(([k]) => k.startsWith("."))) return subpath === "." ? targets(exports) : []
  const exact = entries.find(([k]) => k === subpath)
  if (exact !== undefined) return targets(exact[1])
  return entries.flatMap(([k, v]) => {
    const star = k.indexOf("*")
    if (star < 0) return []
    const [prefix, suffix] = [k.slice(0, star), k.slice(star + 1)]
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) return []
    const match = subpath.slice(prefix.length, subpath.length - suffix.length)
    return targets(v).map((t) => t.replaceAll("*", match))
  })
}

/**
 * The import graph of a revision, read lazily from git: which repository files a set of entry files
 * reach. Each module is read and scanned once, however many closures it is part of. `workspace` lists
 * the directories of the workspace's packages; manifests elsewhere, such as vendored repositories,
 * don't make a package.
 */
export const make = (repo: Repo, workspace: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const entries = yield* repo.entries
    const files = new Set(entries.map((e) => e.path))
    const dirs = new Set<string>()
    for (const path of files) {
      for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir)
    }

    const manifests = [".", ...workspace].map((dir) => (dir === "." ? "package.json" : `${dir}/package.json`)).filter((p) => files.has(p))
    const texts = yield* repo.read(manifests)
    const packages: Array<Package> = []
    for (const [path, text] of texts) {
      const json = (() => {
        try {
          return JSON.parse(text) as Record<string, unknown>
        } catch {
          return undefined
        }
      })()
      if (json === undefined || typeof json.name !== "string") continue
      packages.push({
        dir: posix.dirname(path),
        name: json.name,
        exports: json.exports,
        main: typeof json.module === "string" ? json.module : typeof json.main === "string" ? json.main : undefined,
      })
    }
    const byName = new Map(packages.map((p) => [p.name, p]))
    /** The package a file belongs to: the deepest directory with a manifest, or the root. */
    const packageOf = (path: string) => {
      let best: Package | undefined
      for (const pkg of packages) {
        if ((pkg.dir === "." || path.startsWith(`${pkg.dir}/`)) && (best === undefined || pkg.dir.length > best.dir.length)) best = pkg
      }
      return best?.dir ?? "."
    }

    const file = (base: string): string | undefined => {
      const path = posix.normalize(base)
      if (path.startsWith("..")) return undefined
      if (files.has(path)) return path
      const ext = posix.extname(path)
      for (const alt of jsToTs[ext] ?? []) {
        const swapped = path.slice(0, -ext.length) + alt
        if (files.has(swapped)) return swapped
      }
      for (const add of resolvable) if (files.has(path + add)) return path + add
      for (const add of resolvable) if (files.has(`${path}/index${add}`)) return `${path}/index${add}`
      if (dirs.has(path)) return path
      return undefined
    }

    const bare = (spec: string) => {
      const parts = spec.split("/")
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
      return { name, subpath: spec === name ? "." : `./${spec.slice(name.length + 1)}` }
    }

    const resolve = (from: string, spec: string, aliases: Aliases): ReadonlyArray<string> => {
      const clean = spec.split(/[?#]/)[0]!
      if (clean === "") return []
      if (clean.startsWith(".")) {
        const hit = file(posix.join(posix.dirname(from), clean))
        return hit === undefined ? [] : [hit]
      }
      for (const [prefix, target] of Object.entries(aliases)) {
        if (clean === prefix || clean.startsWith(`${prefix}/`)) {
          const hit = file(target + clean.slice(prefix.length))
          return hit === undefined ? [] : [hit]
        }
      }
      if (clean.startsWith("/") || clean.startsWith("node:")) return []
      const { name, subpath } = bare(clean)
      const pkg = byName.get(name)
      // Not in the repository: the lockfile covers it.
      if (pkg === undefined) return []
      const hits = exported(pkg, subpath).flatMap((t) => file(posix.join(pkg.dir, t)) ?? [])
      // A subpath the exports don't explain: count the whole package.
      return hits.length > 0 ? hits : [pkg.dir === "." ? "." : pkg.dir]
    }

    const scanned = new Map<string, {
      readonly specs: ReadonlyArray<string>
      readonly typeSpecs: ReadonlyArray<string>
      readonly urls: ReadonlyArray<string>
      readonly computed: boolean
      readonly always: boolean
    }>()
    const scan = (source: string) => {
      const statics = [...source.matchAll(staticImport)]
      const specs = [
        ...statics.filter((m) => m[1] === undefined).map((m) => m[2]!),
        ...[callImport, globImport].flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!)),
      ]
      const typeSpecs = statics.filter((m) => m[1] !== undefined).map((m) => m[2]!)
      const urls = [...source.matchAll(urlImport)].map((m) => m[1]!)
      return { specs, typeSpecs, urls, computed: computedImport.test(source), always: /^\s*(?:\/\/|\/?\*)\s*kiln:\s*always\b/m.test(source) }
    }
    const load = (paths: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const missing = paths.filter((p) => !scanned.has(p) && code.test(p))
        const read = yield* repo.read(missing)
        for (const path of missing) scanned.set(path, scan(read.get(path) ?? ""))
      })

    const edges = new Map<string, Map<string, ReadonlyArray<string>>>()
    const edgesOf = (path: string, follow: Follow, followKey: string) => {
      let byPath = edges.get(followKey)
      if (byPath === undefined) edges.set(followKey, byPath = new Map())
      let out = byPath.get(path)
      if (out === undefined) {
        const s = scanned.get(path)
        out = s === undefined ? [] : [
          ...(follow.types ? [...s.specs, ...s.typeSpecs] : s.specs).flatMap((spec) => resolve(path, spec, follow.aliases)),
          ...s.urls.flatMap((url) => file(posix.join(posix.dirname(path), url)) ?? []),
          // An import computed at run time could load anything in the package.
          ...(s.computed ? [packageOf(path)] : []),
        ]
        byPath.set(path, out)
      }
      return out
    }

    /**
     * What each root reaches, roots included; directories stand for everything under them. One pass for
     * all roots: modules import each other in cycles, so the graph is condensed into its strongly
     * connected components, whose closures (bitsets) are built in reverse topological order.
     */
    const closures = (roots: ReadonlyArray<string>, follow: Follow) =>
      Effect.gen(function*() {
        const followKey = JSON.stringify([follow.aliases, follow.types])
        const nodes: Array<string> = []
        const index = new Map<string, number>()
        const add = (path: string) => {
          if (index.has(path)) return false
          index.set(path, nodes.length)
          nodes.push(path)
          return true
        }
        let frontier = [...new Set(roots.filter((r) => files.has(r) || dirs.has(r)))]
        for (const r of frontier) add(r)
        while (frontier.length > 0) {
          yield* load(frontier)
          frontier = frontier.flatMap((p) => edgesOf(p, follow, followKey)).filter(add)
        }
        const adj = nodes.map((p) => edgesOf(p, follow, followKey).map((q) => index.get(q)!))

        const n = nodes.length
        const words = (n + 31) >>> 5
        const order = new Int32Array(n).fill(-1)
        const low = new Int32Array(n)
        const comp = new Int32Array(n).fill(-1)
        const onStack = new Uint8Array(n)
        const stack: Array<number> = []
        const sets: Array<Uint32Array> = []
        let counter = 0
        for (let start = 0; start < n; start++) {
          if (order[start] !== -1) continue
          const calls: Array<[number, number]> = [[start, 0]]
          order[start] = low[start] = counter++
          stack.push(start)
          onStack[start] = 1
          while (calls.length > 0) {
            const frame = calls[calls.length - 1]!
            const v = frame[0]
            if (frame[1] < adj[v]!.length) {
              const w = adj[v]![frame[1]++]!
              if (order[w] === -1) {
                order[w] = low[w] = counter++
                stack.push(w)
                onStack[w] = 1
                calls.push([w, 0])
              } else if (onStack[w] === 1) low[v] = Math.min(low[v]!, order[w]!)
              continue
            }
            calls.pop()
            if (calls.length > 0) {
              const u = calls[calls.length - 1]![0]
              low[u] = Math.min(low[u]!, low[v]!)
            }
            if (low[v] !== order[v]) continue
            const c = sets.length
            const set = new Uint32Array(words)
            const members: Array<number> = []
            let w: number
            do {
              w = stack.pop()!
              onStack[w] = 0
              comp[w] = c
              set[w >>> 5]! |= 1 << (w & 31)
              members.push(w)
            } while (w !== v)
            // Components this one reaches were completed before it.
            for (const m of members) {
              for (const x of adj[m]!) {
                const other = comp[x]!
                if (other === c) continue
                const from = sets[other]!
                for (let i = 0; i < words; i++) set[i]! |= from[i]!
              }
            }
            sets.push(set)
          }
        }
        const decode = (set: Uint32Array) => {
          const out: Array<string> = []
          for (let i = 0; i < words; i++) {
            let bits = set[i]!
            while (bits !== 0) {
              const bit = 31 - Math.clz32(bits & -bits)
              out.push(nodes[(i << 5) + bit]!)
              bits &= bits - 1
            }
          }
          return out
        }
        return new Map(roots.flatMap((r) => {
          const i = index.get(r)
          return i === undefined ? [] : [[r, decode(sets[comp[i]!]!)] as const]
        })) as ReadonlyMap<string, ReadonlyArray<string>>
      })

    /** Every file reachable from `roots`, the roots included. */
    const closure = (roots: ReadonlyArray<string>, follow: Follow) =>
      Effect.map(closures(roots, follow), (byRoot) => new Set([...byRoot.values()].flat()) as ReadonlySet<string>)

    /** Files a package keeps beside its code, such as fixtures tests read without importing them. */
    const dataOf = new Map<string, ReadonlyArray<string>>()
    const data = (dir: string) => {
      let out = dataOf.get(dir)
      if (out === undefined) {
        out = dir === "." ? [] : [...files].filter((p) => p.startsWith(`${dir}/`) && !code.test(p) && !docs.test(p) && packageOf(p) === dir).sort()
        dataOf.set(dir, out)
      }
      return out
    }

    return {
      /** Paths matching the patterns. */
      match: (patterns: ReadonlyArray<string>) => {
        const res = patterns.map(Files.globToRegExp)
        return [...files].filter((f) => res.some((r) => r.test(f))).sort()
      },
      closures,
      closure,
      packageOf,
      data,
      /** Whether the file asks to run every time: a comment line starting with `kiln: always`. */
      always: (path: string) => scanned.get(path)?.always === true,
    }
  })

export type Graph = Effect.Success<ReturnType<typeof make>>
