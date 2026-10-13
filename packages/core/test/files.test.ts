import { describe, expect, it } from "@effect/vitest"
import { globToRegExp } from "../src/Files.ts"

const matches = (pattern: string, paths: ReadonlyArray<string>) => paths.filter((p) => globToRegExp(pattern).test(p))

describe("globToRegExp", () => {
  const paths = ["package.json", "src/a.ts", "src/deep/b.ts", "packages/x/package.json", "static/panel.css"]

  it("reads a trailing ** as everything below, like gitignore", () => {
    expect(matches("src/**", paths)).toEqual(["src/a.ts", "src/deep/b.ts"])
  })

  it("reads **/ as any number of directories, none included", () => {
    expect(matches("**/package.json", paths)).toEqual(["package.json", "packages/x/package.json"])
    expect(matches("src/**/*.ts", paths)).toEqual(["src/a.ts", "src/deep/b.ts"])
  })

  it("keeps * and ? within one path segment", () => {
    expect(matches("src/*.ts", paths)).toEqual(["src/a.ts"])
    expect(matches("static/panel.cs?", paths)).toEqual(["static/panel.css"])
  })
})
