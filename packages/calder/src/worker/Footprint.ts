import { sha256 } from "../Keys.ts"

/**
 * What an evaluation read of its flake's source: a footprint. A pure evaluation's result depends only on
 * the files it read, the inputs `flake.lock` pins (and `flake.lock` is read) and Nix itself, so an
 * attribute whose footprint is unchanged at another commit evaluates to the same derivation there.
 *
 * Calder evaluates `path:<source>?rev=…` under strace, which reads the source's files in the store where
 * strace sees them, and puts a marker lookup (`<source>/.calder-derivation-<i>`) after each attribute.
 * Everything touched up to an attribute's marker is its footprint: an evaluator memoizes, so a later
 * attribute may use what an earlier one read.
 */

/** Read a file or a symlink's target, listed a directory, or looked a path up (exists, type). */
export type Access = "read" | "list" | "lookup"

export interface Touch {
  /** Relative to the source's root; "" is the root. */
  readonly path: string
  readonly access: Access
  /** Whether the path existed. */
  readonly found: boolean
}

export interface Trace {
  readonly touches: ReadonlyArray<Touch>
  /** How many touches came before each attribute's marker, in attribute order. */
  readonly marks: ReadonlyArray<number>
  /**
   * How many attributes had their marker when the recorder first saw something it can't attribute, such
   * as an escaped or relative path, an unexpected error or a line about the source it can't read: those
   * after it get no footprint. Null when nothing was.
   */
  readonly broken: number | null
  /**
   * Store paths other than the source the evaluation read, each with how many attributes had their marker
   * by then. An attribute's footprint covers what Nix read of them only through their derivers, which
   * `Resolve` checks like the attribute's own closure.
   */
  readonly outside: ReadonlyArray<readonly [string, number]>
}

/**
 * Reads `strace -f -s 4096 -e trace=…` output of an evaluation of `source` (its store path) whose markers
 * carry `nonce`, so flake code can't forge one. Paths outside the store are Nix's own: a pure evaluation
 * can't read them.
 */
export const parseTrace = (log: string, source: string, nonce: string): Trace => {
  const touches: Array<Touch> = []
  const marks: Array<number> = []
  const outside = new Map<string, number>()
  let broken: number | null = null
  const fail = () => {
    if (broken === null) broken = marks.length
  }
  const marker = new RegExp(`^\\.calder-derivation-${nonce}-(\\d+)$`)
  const pending = new Map<string, string>()
  for (const raw of log.split("\n")) {
    const match = /^(\d+) +(.*)$/.exec(raw)
    if (match === null) continue
    const [, pid, rest] = match as unknown as [string, string, string]
    // A call another thread interrupted comes in two lines.
    if (rest.endsWith("<unfinished ...>")) {
      pending.set(pid, rest.slice(0, -"<unfinished ...>".length))
      continue
    }
    const resumed = /^<\.\.\. \S+ resumed>(.*)$/.exec(rest)
    const line = resumed === null ? rest : `${pending.get(pid) ?? ""}${resumed[1]}`
    if (resumed !== null) pending.delete(pid)
    // Whatever mentions the source has to come out as a touch or a marker.
    const mentions = line.includes(source)
    const touched = (() => {
      const call = /^(\w+)\((.*)\) += (-?\d+|\?)(?: (\w+))?/.exec(line)
      if (call === null) return false
      const [, name, args, result, errno] = call as unknown as [string, string, string, string, string | undefined]
      // The path argument: the first string, after a directory descriptor for the *at calls.
      const atCall = name.endsWith("at") || name === "openat2" || name === "statx" || name === "faccessat2"
      const path = /"((?:[^"\\]|\\.)*)"(\.\.\.)?/.exec(atCall ? args.replace(/^[^,]*, */, "") : args)
      if (path === null) return false
      const [, text, truncated] = path as unknown as [string, string, string | undefined]
      const dirfd = atCall ? args.split(",")[0]!.trim() : "AT_FDCWD"
      if (text === "") return !mentions // fstat of an open descriptor: its open counted.
      if (!text.startsWith("/")) {
        // Relative to a descriptor, which could be inside the source.
        if (dirfd !== "AT_FDCWD") fail()
        return true
      }
      const failed = result.startsWith("-")
      if (text !== source && !text.startsWith(`${source}/`)) {
        // From the flake's first file on: what Nix reads while it starts, such as its configuration, isn't
        // the evaluation's.
        const store = /^\/nix\/store\/[0-9a-z]{32}-[^/]+/.exec(text)?.[0]
        if (store !== undefined && !failed && touches.length > 0 && !outside.has(store)) outside.set(store, marks.length)
        return !mentions
      }
      if (text.includes("\\") || truncated !== undefined) {
        fail()
        return true
      }
      const relative = text === source ? "" : text.slice(source.length + 1)
      const mark = marker.exec(relative)
      if (mark !== null) {
        if (Number(mark[1]) === marks.length) marks.push(touches.length)
        else fail()
        return true
      }
      if (failed && errno !== "ENOENT" && errno !== "ENOTDIR") {
        fail()
        return true
      }
      const access: Access = name.startsWith("readlink")
        ? "read"
        : name.startsWith("open")
        ? (/O_DIRECTORY/.test(args) ? "list" : "read")
        : "lookup"
      touches.push({ path: relative, access, found: !failed })
      return true
    })()
    if (mentions && !touched) fail()
  }
  return { touches, marks, broken, outside: [...outside] }
}

/** The revision's files, from `git ls-tree -r`: what identities are computed against. */
export interface Tree {
  readonly files: ReadonlyMap<string, { readonly mode: string; readonly oid: string }>
  /** Every directory, "" the root, with its entries' names and types. */
  readonly dirs: ReadonlyMap<string, ReadonlyArray<string>>
}

export const tree = (entries: ReadonlyArray<{ readonly path: string; readonly mode: string; readonly oid: string }>): Tree => {
  const files = new Map(entries.map((e) => [e.path, { mode: e.mode, oid: e.oid }]))
  const children = new Map<string, Set<string>>([["", new Set()]])
  for (const entry of entries) {
    const parts = entry.path.split("/")
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      const kind = i === parts.length - 1 ? (entry.mode === "040000" ? "d" : entry.mode === "120000" ? "l" : "f") : "d"
      if (!children.has(dir)) children.set(dir, new Set())
      children.get(dir)!.add(`${parts[i]}:${kind}`)
    }
  }
  return { files, dirs: new Map([...children].map(([dir, names]) => [dir, [...names].sort()])) }
}

/**
 * What a touch depends on at a revision: a read file its mode and blob (a symlink's blob is its target), a
 * looked-up file its type, a listed directory its entries, any other directory that it is one.
 */
export const identity = (at: Tree, path: string, access: Access): string => {
  const file = at.files.get(path)
  if (file !== undefined) return access === "lookup" && file.mode !== "120000" ? `type:${file.mode}` : `${file.mode}:${file.oid}`
  const dir = at.dirs.get(path)
  if (dir !== undefined) return access === "list" ? `dir:${sha256(dir)}` : "dir"
  return "absent"
}

/** One evaluator's touches, deduplicated in order, which its attributes' footprints are prefixes of. */
export interface Pass {
  readonly entries: ReadonlyArray<readonly [string, Access]>
  /** Per attribute in order: how many entries its footprint has, or null when it has none it can trust. */
  readonly counts: ReadonlyArray<number | null>
}

/**
 * The footprints a trace gives at the revision it evaluated. A touch the revision's git tree contradicts,
 * such as a file found inside a submodule that git lists only as a commit, breaks that attribute and every
 * later one, like an unattributable line does.
 */
export const footprints = (trace: Trace, at: Tree): Pass => {
  const entries: Array<readonly [string, Access]> = []
  const seen = new Set<string>()
  const counts: Array<number | null> = []
  let broken = trace.broken ?? Number.POSITIVE_INFINITY
  let next = 0
  for (const [i, mark] of trace.marks.entries()) {
    for (; next < mark; next++) {
      const raw = trace.touches[next]!
      // A directory opened without O_DIRECTORY, then read, is listed all the same.
      const touch = raw.access === "read" && at.dirs.has(raw.path) ? { ...raw, access: "list" as const } : raw
      if ((identity(at, touch.path, touch.access) !== "absent") !== touch.found) broken = Math.min(broken, i)
      const key = `${touch.access}\0${touch.path}`
      if (!seen.has(key)) {
        seen.add(key)
        entries.push([touch.path, touch.access])
      }
    }
    counts.push(i < broken ? entries.length : null)
  }
  return { entries, counts }
}

/**
 * The digest of a footprint's first `count` entries' identities at a revision, with what else decides the
 * evaluation's result (`context`: Nix's version, the system, settings such as import from derivation):
 * equal digests, equal derivation.
 */
export const digest = (at: Tree, entries: ReadonlyArray<readonly [string, Access]>, count: number, context: string) =>
  sha256([context, ...entries.slice(0, count).map(([path, access]) => identity(at, path, access))])

/** Entries of `fresh` that `recorded` lacks: what a record missed, for the audit's log. */
export const missed = (recorded: ReadonlyArray<readonly [string, Access]>, fresh: ReadonlyArray<readonly [string, Access]>) => {
  const known = new Set(recorded.map(([path, access]) => `${access}\0${path}`))
  return fresh.filter(([path, access]) => !known.has(`${access}\0${path}`)).map(([path, access]) => `${access} ${path || "."}`)
}
