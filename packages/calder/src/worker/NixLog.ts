import type { NixActivity } from "../Protocol.ts"

// Nix's internal-json activity and result types (src/libutil/logging.hh).
const activityTypes: Record<number, string> = {
  100: "copy",
  101: "download",
  102: "realise",
  103: "copy",
  104: "builds",
  105: "build",
  108: "substitute",
  109: "query",
  110: "post-build-hook",
  111: "waiting",
  112: "fetch",
}
const resBuildLogLine = 101

export type NixMessage =
  | { readonly _tag: "Activity"; readonly activity: NixActivity }
  | { readonly _tag: "Log"; readonly text: string; readonly error: boolean }

/** Parses Nix's `--log-format internal-json` stderr, keeping the state of open activities. */
export const parser = () => {
  const open = new Map<number, NixActivity>()
  return (line: string, now: number): ReadonlyArray<NixMessage> => {
    if (!line.startsWith("@nix ")) return line.trim() === "" ? [] : [{ _tag: "Log", text: line, error: false }]
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line.slice(5))
    } catch {
      return [{ _tag: "Log", text: line, error: false }]
    }
    switch (msg.action) {
      case "start": {
        const type = activityTypes[msg.type as number]
        if (type === undefined) return []
        const fields = (msg.fields ?? []) as Array<unknown>
        const activity: NixActivity = {
          id: msg.id,
          parent: msg.parent ?? 0,
          type,
          text: msg.text ?? "",
          drv: type === "build" ? String(fields[0] ?? "") : type === "substitute" ? String(fields[0] ?? "") : null,
          start: now,
          end: null,
          failed: false,
        }
        open.set(activity.id, activity)
        return type === "build" || type === "substitute" || type === "fetch" ? [{ _tag: "Activity", activity }] : []
      }
      case "stop": {
        const activity = open.get(msg.id)
        if (activity === undefined) return []
        open.delete(msg.id)
        const done = { ...activity, end: now }
        return activity.type === "build" || activity.type === "substitute" || activity.type === "fetch"
          ? [{ _tag: "Activity", activity: done }]
          : []
      }
      case "result":
        if (msg.type === resBuildLogLine) return [{ _tag: "Log", text: String(msg.fields?.[0] ?? ""), error: false }]
        return []
      case "msg": {
        const text = String(msg.msg ?? "").replace(/\x1b\[[0-9;]*m/g, "")
        if (text === "") return []
        return [{ _tag: "Log", text, error: (msg.level ?? 3) <= 1 }]
      }
      default:
        return []
    }
  }
}
