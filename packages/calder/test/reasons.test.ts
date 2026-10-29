import { Calder } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import type { JobResult } from "../src/Protocol.ts"
import * as Redact from "../src/worker/Redact.ts"
import { lastWords } from "../src/worker/Steps.ts"

const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD"
const said = (lines: ReadonlyArray<string>, redact = Redact.make([token])) => {
  const last = lastWords(redact)
  for (const line of lines) last.see(line)
  return new Calder.TaskFailed({ exitCode: 1, failures: [], ...last.said() }).message
}

describe("why a task failed", () => {
  it("is the last line it printed that says something, after the exit code", () => {
    expect(said([
      "checking previews",
      "\u001b[31m3 previews are running (pr-3, pr-7, pr-9); close a PR or wait\u001b[0m",
      "   ",
      " ELIFECYCLE  Command failed with exit code 1.",
      "error: Recipe `qa` failed on line 3 with exit code 1",
      "exit status 1",
    ])).toBe("exited with 1: 3 previews are running (pr-3, pr-7, pr-9); close a PR or wait")
    expect(said([])).toBe("exited with 1")
  })

  it("keeps a tool's own failure that names an exit code, such as Nix's", () => {
    expect(said(["error: builder for '/nix/store/aaaa-site.drv' failed with exit code 2"])).toBe(
      "exited with 1: error: builder for '/nix/store/aaaa-site.drv' failed with exit code 2",
    )
  })

  it("is cut only after its secrets are masked", () => {
    const message = said([`${"x".repeat(480)} ${token} refused`])
    expect(message).not.toContain(token.slice(0, 19))
    expect(message.endsWith(`${"x".repeat(480)} *** refused`)).toBe(true)
  })
})

describe("redaction", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n"
  const redact = Redact.make([
    token,
    'CLOUDFLARE_API_TOKEN="cf-secret-0123"\nexport ACCOUNT_ID=acct-4242\nAWS_REGION=auto\nCI=true\nSIGNING_KEY="-----BEGIN KEY-----\\nMIIEdotenvLine1234\\n-----END KEY-----"',
    JSON.stringify({ type: "service_account", private_key: key }),
    "p@ss.w0rd(1)*",
    "a/b+c=d&e?f",
    "pass word!x9",
  ])

  it("masks each secret, and the parts of 8 characters or more of one with several", () => {
    expect(redact(`token ${token}, cf-secret-0123 for acct-4242`)).toBe("token ***, *** for ***")
    expect(redact("AWS_REGION=auto CI=true NODE_ENV=test")).toBe("AWS_REGION=auto CI=true NODE_ENV=test")
    expect(redact("login with p@ss.w0rd(1)* and p@ssXw0rd(1)")).toBe("login with *** and p@ssXw0rd(1)")
  })

  it("masks the lines of a JSON secret's strings and of a double-quoted dotenv value, such as a private key", () => {
    expect(redact("signing with MIIEvQIBADANBgkqhkiG9w0BAQEFAASC")).toBe("signing with ***")
    expect(redact("signing with MIIEdotenvLine1234")).toBe("signing with ***")
  })

  it("masks a secret as JSON, a URL, a form and base64 show it", () => {
    expect(redact(JSON.stringify({ key }))).toBe('{"key":"***\\n"}')
    expect(redact(`https://example.com/?password=${encodeURIComponent("a/b+c=d&e?f")}`)).toBe("https://example.com/?password=***")
    expect(redact(new URLSearchParams({ password: "pass word!x9" }).toString())).toBe("password=***")
    expect(redact(Buffer.from("cf-secret-0123").toString("base64"))).not.toContain(Buffer.from("cf-secret-0123").toString("base64").slice(0, 16))
    for (const prefix of ["", "x", "xy"]) {
      const encoded = Buffer.from(`${prefix}${token} and more`).toString("base64")
      expect(redact(encoded)).toContain("***")
      expect(redact(encoded)).not.toContain(Buffer.from(token).toString("base64").slice(4, 20))
    }
  })

  it("masks every reason a failure gives, but not its outputs and key, nor a passed step's value", () => {
    const failed: JobResult = {
      _tag: "Failed",
      tag: "TaskFailed",
      message: `exited with 1: ${token} was refused`,
      error: { _tag: "TaskFailed", exitCode: 1, failures: [], lastLine: `${token} was refused` },
      key: "acct-4242",
      outputs: { report: "/nix/store/acct-4242-report" },
    }
    expect(Redact.result(redact, failed)).toEqual({
      ...failed,
      message: "exited with 1: *** was refused",
      error: { _tag: "TaskFailed", exitCode: 1, failures: [], lastLine: "*** was refused" },
    })
    expect(Redact.result(redact, { _tag: "Skipped", reason: "acct-4242 is offline" })).toEqual({ _tag: "Skipped", reason: "*** is offline" })
    const passed: JobResult = { _tag: "Passed", value: { url: "https://acct-4242.example" }, outputs: {}, key: null }
    expect(Redact.result(redact, passed)).toBe(passed)
  })
})
