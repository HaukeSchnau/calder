import { lstatSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { freshTmp } from "../src/worker/Steps.ts"

describe("freshTmp", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-tmp-"))
  const slot = "/var/lib/kiln/workspaces/trusted/a-project-with-a-long-name/slot-12"

  it("gives a slot a real directory at a short path, so sockets fit and paths resolve to themselves", () => {
    const tmp = freshTmp(slot, root)
    expect(tmp.length).toBeLessThan(realpathSync(root).length + 20)
    expect(lstatSync(tmp).isDirectory()).toBe(true)
    expect(realpathSync(tmp)).toBe(tmp)
    expect(lstatSync(tmp).mode & 0o777).toBe(0o700)
  })

  it("empties it for each task and keeps slots apart", () => {
    writeFileSync(join(freshTmp(slot, root), "left-over"), "")
    expect(readdirSync(freshTmp(slot, root))).toEqual([])
    expect(freshTmp(`${slot}0`, root)).not.toBe(freshTmp(slot, root))
  })
})
