import { Effect } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as Exec from "../Exec.ts"

const btrfsMagic = 0x9123683e

/**
 * A task slot: a btrfs subvolume with the checkout (`src`) and the `.ci/` cache root (`cache`), so both
 * travel together when a slot is cloned. `deps` records the dependency key the slot was set up for.
 */
export interface Slot {
  readonly root: string
  readonly src: string
  readonly cache: string
  /** Whether `.ci/setup` has to run for this key and the result should become a snapshot. */
  readonly fresh: boolean
  readonly restored: boolean
  readonly snapshots: boolean
}

const isBtrfs = (dir: string) => {
  try {
    return statfsSync(dir).type === btrfsMagic
  } catch {
    return false
  }
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim() : null)

const btrfs = (args: ReadonlyArray<string>) => Exec.run(["btrfs", ...args])

const isSubvolume = (path: string) => existsSync(path) && statSync(path).ino === 256

const remove = (path: string) =>
  isSubvolume(path) ? btrfs(["subvolume", "delete", path]).pipe(Effect.asVoid) : Effect.sync(() => rmSync(path, { recursive: true, force: true }))

const snapshotDir = (root: string) => join(dirname(root), ".deps")

/**
 * Marks a snapshot as just used. A snapshot starts with its slot's modification time, which can be
 * days old, and the cleanup keeps the most recently used ones.
 */
const used = (snapshot: string) => {
  const now = new Date()
  utimesSync(snapshot, now, now)
}

/**
 * Opens a slot for a dependency key. A slot set up for another key is replaced by a writable snapshot of
 * one that was set up for this key, which takes a second instead of an install.
 */
export const open = (root: string, deps: string | null) =>
  Effect.gen(function*() {
    mkdirSync(dirname(root), { recursive: true })
    const snapshots = deps !== null && isBtrfs(dirname(root))
    const snapshot = deps === null ? null : join(snapshotDir(root), deps)
    let restored = false
    if (snapshots && snapshot !== null && read(join(root, "deps")) !== deps && existsSync(snapshot)) {
      if (existsSync(root)) yield* remove(root)
      yield* btrfs(["subvolume", "snapshot", snapshot, root])
      used(snapshot)
      restored = true
    } else if (!existsSync(root)) {
      if (snapshots) yield* btrfs(["subvolume", "create", root])
      else mkdirSync(root, { recursive: true })
    }
    const src = join(root, "src")
    const cache = join(root, "cache")
    mkdirSync(src, { recursive: true })
    mkdirSync(cache, { recursive: true })
    return { root, src, cache, fresh: deps !== null && read(join(root, "deps")) !== deps, restored, snapshots } satisfies Slot
  })

/** After `.ci/setup` succeeded for a new key: remember it and keep a snapshot for other slots to clone. */
export const remember = (slot: Slot, deps: string, keep = 3) =>
  Effect.gen(function*() {
    writeFileSync(join(slot.root, "deps"), `${deps}\n`)
    if (!slot.snapshots) return
    const dir = snapshotDir(slot.root)
    mkdirSync(dir, { recursive: true })
    rmSync(join(slot.cache, "tmp"), { recursive: true, force: true })
    const target = join(dir, deps)
    // Slots set up for the same key at once race for the snapshot: each takes its own, and only the
    // first rename wins.
    if (!existsSync(target)) {
      const own = `${target}.${process.pid}`
      yield* btrfs(["subvolume", "snapshot", slot.root, own])
      const won = yield* Effect.sync(() => {
        try {
          renameSync(own, target)
          return true
        } catch {
          return false
        }
      })
      if (!won) yield* remove(own)
    }
    used(target)
    const old = readdirSync(dir)
      .filter((name) => !name.includes("."))
      .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(keep)
    yield* Effect.forEach(old, (s) => remove(s.path).pipe(Effect.ignore), { discard: true })
  })
