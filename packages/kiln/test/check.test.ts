import { describe, expect, it } from "@effect/vitest"
import { target } from "../src/Check.ts"

describe("kiln check", () => {
  it("pushes to the remote of a repository the controller knows", () => {
    const repos = ["schnau/t3code", "schnau/kiln"]
    expect(target(["git@github.com:HaukeSchnau/t3code.git", "git@git.schnau.dev:schnau/t3code.git"], repos))
      .toEqual({ remote: "git@git.schnau.dev:schnau/t3code.git", repo: "schnau/t3code" })
    expect(target(["https://git.schnau.dev/schnau/Kiln/"], repos)).toEqual({ remote: "https://git.schnau.dev/schnau/Kiln/", repo: "schnau/kiln" })
    expect(target(["git@github.com:HaukeSchnau/t3code.git"], repos)).toBeUndefined()
  })
})
