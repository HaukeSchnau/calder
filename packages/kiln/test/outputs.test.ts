import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { below } from "../src/controller/Outputs.ts"

describe("outputs", () => {
  it("serves what is inside an output, links included, and nothing a link or .. leads out to", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "kiln-output-")))
    writeFileSync(join(parent, "secret"), "")
    const root = join(parent, "screenshots")
    mkdirSync(join(root, "home"), { recursive: true })
    writeFileSync(join(root, "home", "a.png"), "")
    symlinkSync("home", join(root, "latest"))
    symlinkSync(join(parent, "secret"), join(root, "secret"))

    expect(below(root, [])).toBe(root)
    expect(below(root, ["latest", "a.png"])).toBe(join(root, "home", "a.png"))
    expect(below(root, ["secret"])).toBeNull()
    expect(below(root, ["..", "secret"])).toBeNull()
    expect(below(root, ["missing.png"])).toBeNull()
  })
})
