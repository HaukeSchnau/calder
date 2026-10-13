import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extract } from "../src/controller/Mirror.ts"

const revision = () => join(mkdtempSync(join(tmpdir(), "kiln-revs-")), "project", "sha")

/** Writes `.kiln/ci.ts` first and `.kiln/flake.ts` after other fibers had a turn. */
const fill = (scratch: string) =>
  Effect.gen(function*() {
    mkdirSync(join(scratch, ".kiln"))
    writeFileSync(join(scratch, ".kiln", "ci.ts"), "")
    yield* Effect.yieldNow
    writeFileSync(join(scratch, ".kiln", "flake.ts"), "")
  })

describe("extract", () => {
  it.effect("leaves one complete copy when two runs extract the same revision at once", () =>
    Effect.gen(function*() {
      const root = revision()
      const seen: Array<ReadonlyArray<string>> = []
      const watching = (scratch: string) =>
        Effect.andThen(fill(scratch), Effect.sync(() => seen.push(existsSync(root) ? readdirSync(join(root, ".kiln")) : [])))
      yield* Effect.all([extract(root, watching), extract(root, watching)], { concurrency: 2 })
      expect(seen.every((files) => files.length === 0 || files.length === 2)).toBe(true)
      expect(readdirSync(join(root, ".kiln")).sort()).toEqual(["ci.ts", "flake.ts"])
      expect(readdirSync(join(root, ".."))).toEqual(["sha"])
    }))

  it.effect("replaces a revision that was left without ci.ts", () =>
    Effect.gen(function*() {
      const root = revision()
      mkdirSync(join(root, ".kiln"), { recursive: true })
      writeFileSync(join(root, ".kiln", "flake.ts"), "")
      yield* extract(root, fill)
      expect(readdirSync(join(root, ".kiln")).sort()).toEqual(["ci.ts", "flake.ts"])
    }))

  it.effect("leaves nothing behind when the extraction fails", () =>
    Effect.gen(function*() {
      const root = revision()
      const failed = yield* extract(root, (scratch) => Effect.andThen(fill(scratch), Effect.fail("tar failed"))).pipe(Effect.flip)
      expect(failed).toBe("tar failed")
      expect(readdirSync(join(root, ".."))).toEqual([])
    }))
})
