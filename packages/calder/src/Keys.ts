import { createHash, createHmac } from "node:crypto"

/** A project's placement token: the release's host accepts it for that project's placement only. */
export const placementToken = (key: string, project: string): string =>
  createHmac("sha256", key).update(project).digest("hex")

/**
 * What a rerun compares a step's secrets by (Runs.ts `fromRerun`): an HMAC under the controller's secret
 * key, so the journal holds nothing that tells a short secret, such as a passcode, from a guess.
 */
export const secretsDigest = (key: string, secrets: Record<string, string>): string =>
  createHmac("sha256", key).update(JSON.stringify(Object.entries(secrets).sort())).digest("hex")

export const sha256 = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")

/**
 * A task's key: its plan-time base plus the values it interpolates and its shard. The controller
 * computes it to look for a reusable result; the worker never needs it.
 */
export const taskKey = (
  keyBase: string,
  values: { readonly [step: string]: unknown },
  shard: { readonly index: number; readonly count: number } | null,
): string =>
  sha256({
    keyBase,
    values: Object.keys(values).sort().map((k) => [k, values[k]]),
    shard: shard === null ? null : [shard.index, shard.count],
  })
