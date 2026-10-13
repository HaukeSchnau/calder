import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goMemLimit } from "../src/worker/Steps.ts"

const cgroup = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-cgroup-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), `${text}\n`)
  return dir
}

describe("goMemLimit", () => {
  it("leaves Go a third below the worker's memory.high, or its memory.max without one", () => {
    expect(goMemLimit(cgroup({ "memory.high": String(4.5 * 2 ** 30), "memory.max": String(6 * 2 ** 30) }))).toEqual({ GOMEMLIMIT: "3072MiB" })
    expect(goMemLimit(cgroup({ "memory.high": "max", "memory.max": String(6 * 2 ** 30) }))).toEqual({ GOMEMLIMIT: "4096MiB" })
  })

  it("sets nothing without a limit", () => {
    expect(goMemLimit(cgroup({ "memory.high": "max", "memory.max": "max" }))).toEqual({})
    expect(goMemLimit(null)).toEqual({})
  })
})
