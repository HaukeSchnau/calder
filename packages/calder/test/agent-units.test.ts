import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { forwarded, withoutHopByHop } from "../src/ControllerProxy.ts"

const hasBun = spawnSync("bun", ["--version"]).status === 0

describe("an agent's units", () => {
  it("forward a worker's routes to the controller and nothing else", () => {
    for (const route of ["/worker", "/store", "/outputs", "/git/app.git/info/refs", "/git/app.git/git-upload-pack"]) expect(forwarded(route)).toBe(true)
    for (const route of ["/rpc", "/agent", "/hooks/gitea", "/", "/gitx", "/worker/x"]) expect(forwarded(route)).toBe(false)
  })

  it("keep a connection's own headers to it, in requests and responses alike", () => {
    const headers = withoutHopByHop(new Headers({
      authorization: "Bearer j:t",
      "content-type": "application/x-git-upload-pack-request",
      connection: "keep-alive, X-Internal",
      "x-internal": "1",
      "keep-alive": "timeout=5",
      te: "trailers",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "proxy-authorization": "Basic x",
    }))
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"])
  })

  // The agent serves its sockets with Bun's, which vitest's Node lacks: bun/agent-units.ts runs two jobs
  // through Agent.runInUnit with a fake systemctl that acts as the job's unit.
  it.skipIf(!hasBun)("run each job in its pool's unit, reaching the controller and, for pull requests, the allowlist through the job's sockets", () => {
    const ran = spawnSync("bun", [join(import.meta.dirname, "bun", "agent-units.ts")], { encoding: "utf8", timeout: 60_000 })
    expect(ran.status, ran.stderr).toBe(0)
    const result = JSON.parse(ran.stdout.trim().split("\n").at(-1)!)
    expect(result.code).toBe(0)
    // Only the job's pool's group may enter its directory and read its token.
    expect(result.pr.modes).toEqual({ dir: "750", token: "640", controller: "660" })
    expect(result.pr.token).toBe("secret")
    expect(result.pr.refs).toBe("200 GET /git/app.git/info/refs?service=git-upload-pack Bearer j:t")
    expect(result.pr.pack).toBe("200 POST /git/app.git/git-upload-pack  want 0123")
    expect(result.pr.echoed).toBe("controller got hello")
    // The UI's RPC, which can start trusted runs, and the agents' own stay out of reach.
    expect([result.pr.rpc, result.pr.agent]).toEqual([404, 404])
    expect(result.pr.egress).toBe("HTTP/1.1 403 Not On The Allowlist")
    // A listed host goes through on whichever of its addresses answers, here 127.0.0.1 after ::1.
    expect(result.pr.listed).toBe("HTTP/1.1 200 Connection Established")
    // A trusted job's unit has the network, and no egress proxy.
    expect(result.trusted.egress).toBeNull()
    // A job's unit is stopped however the job ends, also when the job is stopped; its directory goes with it.
    expect(result.calls).toEqual([
      "start --wait calder-job-pr@0a1b.service",
      "stop calder-job-pr@0a1b.service",
      "start --wait calder-job-trusted@5709.service",
      "stop calder-job-trusted@5709.service",
    ])
    expect([result.kept, result.keptStopped]).toEqual([false, false])
  })
})
