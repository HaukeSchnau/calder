// A stand-in for systemctl in agent-units.ts: `start --wait` acts as the job's unit would, through the
// job's directory under $FAKE_UNITS, and writes what it found to $FAKE_OUT/<job>.json. Job 5709 runs
// until it is stopped.
import { Effect } from "effect"
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import * as Tunnel from "../../src/Tunnel.ts"

const [verb, ...rest] = process.argv.slice(2)
const out = process.env.FAKE_OUT!
appendFileSync(join(out, "calls"), `${[verb, ...rest].join(" ")}\n`)
const unit = rest.at(-1)!

if (verb === "show") {
  console.log("0")
  process.exit(0)
}
if (verb !== "start") process.exit(0)

const [, pool, job] = /^calder-job-(\w+)@(\w+)\.service$/.exec(unit)!
const dir = join(process.env.FAKE_UNITS!, job!)
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

/** What the egress proxy answers to a CONNECT, on its socket. */
const connectVia = (socket: string, target: string) =>
  new Promise<string>((resolve) => {
    const client = connect(socket, () => client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    client.once("data", (data) => {
      resolve(data.toString("latin1").split("\r\n")[0]!)
      client.destroy()
    })
  })

const found = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const socket = join(dir, "controller.sock")
  const bridge = yield* Tunnel.loopback(socket)
  const base = `http://127.0.0.1:${bridge.port}`
  return yield* Effect.promise(async () => {
    const refs = await fetch(`${base}/git/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: "Bearer j:t" } })
    const pack = await fetch(`${base}/git/app.git/git-upload-pack`, { method: "POST", body: "want 0123" })
    const rpc = await fetch(`${base}/rpc`)
    const agent = await fetch(`${base}/agent`)
    const echoed = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/worker`)
      ws.onopen = () => ws.send("hello")
      ws.onmessage = (event) => {
        resolve(String(event.data))
        ws.close()
      }
    })
    const egressSocket = join(dir, "egress.sock")
    const egress = existsSync(egressSocket) ? await connectVia(egressSocket, "example.org:443") : null
    const listed = existsSync(egressSocket) ? await connectVia(egressSocket, `localhost:${process.env.FAKE_PORT}`) : null
    return {
      pool,
      modes: { dir: mode(dir), token: mode(join(dir, "token")), controller: mode(socket) },
      token: readFileSync(join(dir, "token"), "utf8"),
      refs: `${refs.status} ${await refs.text()}`,
      pack: `${pack.status} ${await pack.text()}`,
      rpc: rpc.status,
      agent: agent.status,
      echoed,
      egress,
      listed,
    }
  })
})))
writeFileSync(join(out, `${job}.json`), JSON.stringify(found))
if (job === "5709") await new Promise(() => {})
