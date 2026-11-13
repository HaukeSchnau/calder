// Run by agent-units.test.ts under Bun, whose sockets the agent's unit mode uses and vitest's Node lacks:
// runs two jobs through Agent.runInUnit with fake-systemctl.ts first on PATH as systemctl and prints
// what happened.
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Agent from "../../src/Agent.ts"

const root = mkdtempSync(join(tmpdir(), "calder-units-"))
const units = join(root, "jobs")
const out = join(root, "out")
mkdirSync(units)
mkdirSync(out)
process.env.FAKE_UNITS = units
process.env.FAKE_OUT = out
const bin = join(root, "bin")
mkdirSync(bin)
writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fake-systemctl.ts")} "$@"\n`)
chmodSync(join(bin, "systemctl"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`

// The controller's side: what a worker's requests and messages reach.
const controller = Bun.serve<undefined, never>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/worker" && server.upgrade(request, { data: undefined })) return undefined
    const body = request.method === "POST" ? await request.text() : ""
    return new Response(`${request.method} ${url.pathname}${url.search} ${request.headers.get("authorization") ?? ""} ${body}`.trim())
  },
  websocket: {
    message(ws, message) {
      ws.send(`controller got ${message}`)
    },
  },
})

process.env.FAKE_PORT = String(controller.port)
const options = {
  units,
  url: `http://127.0.0.1:${controller.port}`,
  group: () => process.getgid!(),
}

const result = await Effect.runPromise(Effect.gen(function*() {
  const code = yield* Effect.scoped(Agent.runInUnit(options, {
    _tag: "Start",
    job: "0a1b",
    token: "secret",
    pool: "pr",
    // localhost resolves to ::1 first, where the controller's stand-in doesn't listen.
    egress: { allow: ["registry.npmjs.org"], allowPrivate: [`localhost:${controller.port}`] },
  }))
  const kept = existsSync(join(units, "0a1b"))
  const stopping = yield* Effect.forkChild(Effect.scoped(Agent.runInUnit(options, { _tag: "Start", job: "5709", token: "t", pool: "trusted" })))
  while (!existsSync(join(out, "5709.json"))) yield* Effect.sleep("20 millis")
  yield* Fiber.interrupt(stopping)
  return {
    code,
    kept,
    keptStopped: existsSync(join(units, "5709")),
    pr: JSON.parse(readFileSync(join(out, "0a1b.json"), "utf8")),
    trusted: JSON.parse(readFileSync(join(out, "5709.json"), "utf8")),
    calls: readFileSync(join(out, "calls"), "utf8").trim().split("\n"),
  }
}).pipe(Effect.provide(BunServices.layer)))

console.log(JSON.stringify(result))
controller.stop(true)
rmSync(root, { recursive: true, force: true })
process.exit(0)
