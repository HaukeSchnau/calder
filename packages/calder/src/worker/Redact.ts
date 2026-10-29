import type { JobEvent, JobResult } from "../Protocol.ts"

/** What stands in for a secret. */
export const mask = "***"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/

const lines = (text: string) => text.split(/\r?\n/)

/** Every string in a JSON value, such as the private key of a service account. */
const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
    ? value.flatMap(strings)
    : typeof value === "object" && value !== null
    ? Object.values(value).flatMap(strings)
    : []

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A `KEY=value` line's value without its quotes; a double-quoted one with its `\n` escapes as newlines. */
const assigned = (line: string) => {
  const raw = assignment.exec(line)?.[1]?.trim()
  if (raw === undefined) return undefined
  const quoted = /^(["'])(.*)\1$/.exec(raw)
  if (quoted === null) return raw
  return quoted[1] === '"' ? quoted[2]!.replaceAll("\\n", "\n") : quoted[2]!
}

/**
 * Parts of a secret: its lines, but of a `KEY=value` line only the value, since the key names it in
 * the clear, and the lines of a value or a JSON string, such as a key whose newlines are `\n` escapes.
 */
const parts = (secret: string) => [
  ...lines(secret).flatMap((line) => {
    const value = assigned(line)
    return value === undefined ? [line] : [value, ...lines(value)]
  }),
  ...strings(json(secret)).flatMap((s) => [s, ...lines(s)]),
]

/**
 * The secret as base64 shows it inside a longer encoding, at each of the three offsets it may start
 * at: only the characters that its bytes alone decide.
 */
const base64 = (secret: string) =>
  [0, 1, 2].map((offset) => {
    const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(secret)])
    const whole = Math.floor(bytes.length / 3) * 4
    return bytes.toString("base64").slice([0, 2, 3][offset], whole)
  })

const uri = (piece: string) => {
  try {
    return encodeURIComponent(piece)
  } catch {
    // A lone surrogate, which no URL carries.
    return piece
  }
}

/** How a piece shows in JSON, in a URL and in a form. */
const encodings = (piece: string) => [piece, JSON.stringify(piece).slice(1, -1), uri(piece), new URLSearchParams({ v: piece }).toString().slice(2)]

/**
 * Replaces the job's secrets wherever its output would show them, also as JSON, in a URL or form,
 * or in base64. A whole secret counts from 4 characters. Its parts count from 8, so that a dotenv file's
 * `CI=true` doesn't mask every "true": its lines, a `KEY=value` line's value, and a JSON secret's
 * strings, such as a key whose newlines are `\n` escapes. Masking works line by line, so it can't
 * catch a secret that a tool wraps over two lines or splits with color codes.
 */
export const make = (secrets: Iterable<string>): (text: string) => string => {
  const values = new Set<string>()
  for (const secret of secrets) {
    const whole = secret.trim()
    if (whole.length < 4) continue
    for (const piece of [whole, ...parts(whole).map((p) => p.trim()).filter((p) => p.length >= 8)]) {
      for (const shown of encodings(piece)) values.add(shown)
    }
    // A whole secret and each of a dotenv file's values, as tools pass credentials on in base64.
    const encoded = [whole, ...lines(whole).flatMap((line) => assigned(line) ?? []).filter((v) => v.length >= 8)]
    for (const shown of encoded.flatMap(base64)) if (shown.length >= 8) values.add(shown)
  }
  if (values.size === 0) return (text) => text
  const pattern = new RegExp([...values].sort((a, b) => b.length - a.length).map(escape).join("|"), "g")
  return (text) => text.replace(pattern, mask)
}

/** A job's event with its log line and test messages redacted. */
export const event = (redact: (text: string) => string, event: JobEvent): JobEvent => {
  switch (event._tag) {
    case "Log":
      return { ...event, text: redact(event.text) }
    case "Tests":
      return { ...event, results: event.results.map((r) => (r.message === null ? r : { ...r, message: redact(r.message) })) }
    default:
      return event
  }
}

const deep = (redact: (text: string) => string, value: unknown): unknown =>
  typeof value === "string"
    ? redact(value)
    : Array.isArray(value)
    ? value.map((v) => deep(redact, v))
    : typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(redact, v)]))
    : value

/**
 * A result whose reasons are redacted, since they go to commit statuses and Calder's comment on a pull
 * request: a failure's message and error, a skip's reason. Outputs and keys are store paths and hashes,
 * and a passed step's value is what its schema decoded, which keeps out what the step meant to keep out.
 */
export const result = (redact: (text: string) => string, result: JobResult): JobResult => {
  switch (result._tag) {
    case "Failed":
      return { ...result, message: redact(result.message), error: deep(redact, result.error) }
    case "Died":
    case "Lost":
    case "PlanFailed":
      return { ...result, message: redact(result.message) }
    case "Skipped":
      return { ...result, reason: redact(result.reason) }
    case "Evaluated": {
      const each = (reasons: Record<string, string>) => Object.fromEntries(Object.entries(reasons).map(([name, why]) => [name, redact(why)]))
      return { ...result, tooLarge: each(result.tooLarge), ...(result.errors === undefined ? {} : { errors: each(result.errors) }) }
    }
    case "Passed":
    case "Planned":
      return result
  }
}
