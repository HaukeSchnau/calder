import { describe, expect, it } from "@effect/vitest"
import { Cmd } from "@kiln/core"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Vitest from "../src/Vitest.ts"

/** A repository whose package `pkg` has its own `vitest` and `prepare`, which record where and how they ran. */
const repository = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kiln-vitest-")))
  const bin = join(root, "pkg/node_modules/.bin")
  mkdirSync(bin, { recursive: true })
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake("prepare", 'pwd > prepared')
  fake("vitest", [
    'printf "%s\\n" "$PWD" "$@" > ran',
    'for arg; do case $arg in --outputFile.json=*) echo "{}" > "${arg#*=}";; esac; done',
  ].join("\n"))
  return root
}

/** Runs the step's command for `files` in the repository, as the worker would. */
const run = (root: string, step: ReturnType<typeof Vitest.files>, files: ReadonlyArray<string>) => {
  if (step.def._tag !== "Task" || typeof step.def.run !== "function") throw new Error("not a task with each")
  const [command, ...args] = Cmd.render(step.def.run({ index: 1, count: 1, files }), {})
  const exit = spawnSync(command!, args, { cwd: root, encoding: "utf8" })
  expect(exit.stderr).toBe("")
  return { report: step.def.report?.path ?? "", ran: readFileSync(join(root, "pkg/ran"), "utf8").trim().split("\n") }
}

describe("Vitest.files", () => {
  it("runs the package's vitest in its directory with its files and writes the report where Kiln reads it", () => {
    const root = repository()
    const step = Vitest.files({ dir: "pkg", tests: ["src/**/*.test.ts"], args: ["--maxWorkers", "2"] })
    const { report, ran } = run(root, step, ["pkg/src/a.test.ts", "pkg/src/b.test.ts"])
    expect(ran).toEqual([
      join(root, "pkg"),
      "run",
      "--maxWorkers",
      "2",
      "src/a.test.ts",
      "src/b.test.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${join(root, report)}`,
    ])
    expect(existsSync(join(root, report))).toBe(true)
  })

  it("runs `before` in the package directory first", () => {
    const root = repository()
    run(root, Vitest.files({ dir: "pkg", tests: ["**/*.test.ts"], before: ["prepare"] }), ["pkg/a.test.ts"])
    expect(readFileSync(join(root, "pkg/prepared"), "utf8").trim()).toBe(join(root, "pkg"))
  })
})
