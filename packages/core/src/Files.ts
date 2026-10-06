/**
 * What a task reads. Keys are made of git tree ids of these paths at the revision, so a task is
 * reused only when its inputs are byte-identical.
 */
export type Files =
  | { readonly _tag: "All" }
  | { readonly _tag: "Of"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "Workspace"; readonly dirs: ReadonlyArray<string> }
  | { readonly _tag: "Glob"; readonly patterns: ReadonlyArray<string> }
  | {
    readonly _tag: "Imports"
    readonly patterns: ReadonlyArray<string>
    readonly aliases: { readonly [prefix: string]: string }
    readonly types: boolean
  }
  | { readonly _tag: "Union"; readonly members: ReadonlyArray<Files> }

/** The whole repository. */
export const all = (): Files => ({ _tag: "All" })

/** Exact files or directories. */
export const of = (...paths: ReadonlyArray<string>): Files => ({ _tag: "Of", paths: paths.map(normalize) })

/**
 * Workspace packages (pnpm or npm workspaces) and every workspace package they depend on.
 * `"."` means the whole repository.
 */
export const workspace = (...dirs: ReadonlyArray<string>): Files => ({ _tag: "Workspace", dirs: dirs.map(normalize) })

/** Files matching globs. `*` stays within a directory, `**` crosses directories. */
export const glob = (...patterns: ReadonlyArray<string>): Files => ({ _tag: "Glob", patterns })

/**
 * Files matching the globs and every repository file they import, transitively: relative paths,
 * workspace packages through their `exports`, and `aliases` (an import prefix and the path it stands
 * for, like Vite's `resolve.alias`). Packages from the registry count through the lockfile instead.
 * Type-only imports vanish when code runs, so they count only with `types: true`, as for a typecheck.
 *
 * As a task's `each`, every matching file is keyed on its own imports, so a change reruns only the
 * files that can reach it.
 */
export const imports = (
  patterns: string | ReadonlyArray<string>,
  options: { readonly aliases?: { readonly [prefix: string]: string }; readonly types?: boolean } = {},
): Files => ({
  _tag: "Imports",
  patterns: typeof patterns === "string" ? [patterns] : patterns,
  aliases: options.aliases ?? {},
  types: options.types ?? false,
})

export const union = (...members: ReadonlyArray<Files>): Files => ({ _tag: "Union", members })

const normalize = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "") || "."

const globCache = new Map<string, RegExp>()

export const globToRegExp = (pattern: string): RegExp => {
  let re = globCache.get(pattern)
  if (re === undefined) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, "(?:.*/)?")
    re = new RegExp(`^${source}$`)
    globCache.set(pattern, re)
  }
  return re
}
