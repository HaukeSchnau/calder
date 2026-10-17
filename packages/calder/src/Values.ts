import { Calder } from "@calder-ci/core"
import { Schema } from "effect"

/**
 * Turns a step's value or failure into JSON. Instances of registered `Calder.Result` and `Calder.Failure`
 * classes keep their class id in `$calder` and decode into instances of the registered class, which has
 * the fields and tag but not methods a subclass adds.
 */
export const encode = (value: unknown): unknown => {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(encode)
  for (const [id, entry] of Calder.registry) {
    if (value instanceof (entry.schema as unknown as abstract new(...args: never) => unknown)) {
      const encoded = Schema.encodeUnknownSync(entry.schema as Schema.Codec<unknown, unknown>)(value)
      return { $calder: id, value: encoded }
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
}

export const decode = (json: unknown): unknown => {
  if (json === null || typeof json !== "object") return json
  if (Array.isArray(json)) return json.map(decode)
  const record = json as Record<string, unknown>
  if (typeof record.$calder === "string") {
    const entry = Calder.registry.get(record.$calder)
    if (entry !== undefined) return Schema.decodeUnknownSync(entry.schema as Schema.Codec<unknown, unknown>)(record.value)
    return record.value
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]))
}

/** A short text of a value for statuses and the UI. */
export const describe = (json: unknown): string => {
  if (json === null || json === undefined) return ""
  if (typeof json === "string") return json
  if (typeof json !== "object") return String(json)
  const record = json as Record<string, unknown>
  if (typeof record.$calder === "string") {
    const fields = (record.value ?? {}) as Record<string, unknown>
    const tag = typeof fields._tag === "string" ? fields._tag : record.$calder.split("/").at(-1)
    const rest = Object.entries(fields)
      .filter(([k]) => k !== "_tag")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 12) : v) : JSON.stringify(v)}`)
    return rest.length > 0 ? `${tag} (${rest.join(", ")})` : tag ?? ""
  }
  return JSON.stringify(json)
}
