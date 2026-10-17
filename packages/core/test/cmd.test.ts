import { describe, expect, it } from "@effect/vitest"
import { Cmd, cmd, Secret } from "../src/index.ts"
import { release } from "./fixtures.ts"

describe("cmd", () => {
  it("splits literals and keeps values whole", () => {
    const c = cmd`just ${"qa static"} --flag=${3} 'quoted arg' "x ${"y"}"`
    expect(Cmd.render(c, {})).toEqual(["just", "qa static", "--flag=3", "quoted arg", "x y"])
  })
  it("spreads lists and resolves steps", () => {
    const c = cmd`vitest run ${["a.test.ts", "b.test.ts"]} --release ${release}`
    expect(c.steps).toEqual([release])
    expect(Cmd.render(c, { release: "/nix/store/abc-release" })).toEqual([
      "vitest",
      "run",
      "a.test.ts",
      "b.test.ts",
      "--release",
      "/nix/store/abc-release",
    ])
    expect(Cmd.show(c)).toBe("vitest run a.test.ts b.test.ts --release ${release}")
  })
  it("refuses unclosed quotes", () => {
    expect(() => cmd`echo 'oops`).toThrow(/unclosed/)
  })
  it("passes secrets as file paths and the pull request's number", () => {
    const c = cmd`alchemy deploy --stage pr-${Cmd.pullRequest} --env-file ${Secret.file("cloudflare")}`
    expect(c.secrets).toEqual(["cloudflare"])
    expect(c.pullRequest).toBe(true)
    expect(Cmd.render(c, {}, { secrets: { cloudflare: "/run/calder/cloudflare" }, pullRequest: 42 })).toEqual([
      "alchemy",
      "deploy",
      "--stage",
      "pr-42",
      "--env-file",
      "/run/calder/cloudflare",
    ])
    expect(Cmd.show(c)).toBe("alchemy deploy --stage pr-${pull-request} --env-file ${secret:cloudflare}")
  })
  it("refuses to render a secret it wasn't granted or a pull request the run lacks", () => {
    expect(() => Cmd.render(cmd`cat ${Secret.file("token")}`, {})).toThrow(/not granted/)
    expect(() => Cmd.render(cmd`echo ${Cmd.pullRequest}`, {})).toThrow(/no pull request/)
  })
})
