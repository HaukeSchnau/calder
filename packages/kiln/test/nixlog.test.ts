import { describe, expect, it } from "@effect/vitest"
import * as NixLog from "../src/worker/NixLog.ts"

describe("NixLog", () => {
  it("turns internal-json into build activities and log lines", () => {
    const parse = NixLog.parser()
    const lines = [
      `@nix {"action":"start","id":7,"level":3,"parent":0,"text":"building '/nix/store/aaa-hello.drv'","type":105,"fields":["/nix/store/aaa-hello.drv","",1,1]}`,
      `@nix {"action":"result","id":7,"type":101,"fields":["compiling hello.c"]}`,
      `@nix {"action":"start","id":8,"level":4,"parent":0,"text":"querying info","type":109,"fields":[]}`,
      `@nix {"action":"stop","id":7}`,
      `@nix {"action":"msg","level":0,"msg":"\\u001b[31;1merror:\\u001b[0m builder failed"}`,
      "plain line",
    ]
    const out = lines.flatMap((line, i) => NixLog.parser === undefined ? [] : parse(line, 1000 + i))
    expect(out.map((m) => (m._tag === "Activity" ? `${m.activity.type}:${m.activity.end ?? "open"}` : `log:${m.text}`))).toEqual([
      "build:open",
      "log:compiling hello.c",
      "build:1003",
      "log:error: builder failed",
      "log:plain line",
    ])
  })
})
