import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { shortLink } from "../src/worker/Steps.ts"

describe("shortLink", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-tmp-"))
  const deep = join(root, "workspaces/pr/a-project-with-a-long-name/slot-12/cache/tmp")
  mkdirSync(deep, { recursive: true })

  it("gives a deep temporary directory a short path that leaves room for a socket", () => {
    const short = shortLink(deep, root)
    expect(short.length).toBeLessThan(root.length + 20)
    expect(realpathSync(short)).toBe(realpathSync(deep))
  })

  it("is stable per directory, and different directories get different links", () => {
    const other = join(root, "workspaces/pr/other/slot-1/cache/tmp")
    mkdirSync(other, { recursive: true })
    expect(shortLink(deep, root)).toBe(shortLink(deep, root))
    expect(shortLink(other, root)).not.toBe(shortLink(deep, root))
  })
})
