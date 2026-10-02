import { describe, expect, it } from "@effect/vitest"
import { Kiln } from "@kiln/core"
import { Schema } from "effect"
import * as Values from "../src/Values.ts"

class Live extends Kiln.Result<Live>("@test/values")("Live", { revision: Schema.String, hosts: Schema.Array(Schema.String) }) {}
class Busy extends Kiln.Failure<Busy>("@test/values")("Busy", { target: Schema.String }) {}

describe("Values", () => {
  it("round-trips Kiln results and failures through JSON", () => {
    const live = new Live({ revision: "abc", hosts: ["srv-2"] })
    const json = JSON.parse(JSON.stringify(Values.encode({ live, n: 1, path: "/nix/store/x" })))
    expect(json.live.$kiln).toBe("@test/values/Live")
    const back = Values.decode(json) as { live: Live; n: number }
    expect(back.live._tag).toBe("Live")
    expect(back.live.hosts).toEqual(["srv-2"])
    expect(back.n).toBe(1)
    expect(Values.decode(Values.encode(new Busy({ target: "srv-1" })))).toMatchObject({ _tag: "Busy", target: "srv-1" })
  })
  it("describes values for statuses", () => {
    expect(Values.describe(Values.encode(new Live({ revision: "0123456789abcdef0123456789abcdef01234567", hosts: [] }))))
      .toBe("Live (revision: 0123456789ab, hosts: [])")
    expect(Values.describe("/nix/store/abc-release")).toBe("/nix/store/abc-release")
  })
})
