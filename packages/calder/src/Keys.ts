import { createHash } from "node:crypto"

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
