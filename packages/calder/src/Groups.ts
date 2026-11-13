import { readFileSync } from "node:fs"

/** A group's id from /etc/group, or undefined when the host has no such group. */
export const groupId = (name: string) => {
  let groups: string
  try {
    groups = readFileSync("/etc/group", "utf8")
  } catch {
    return undefined
  }
  const line = groups.split("\n").find((l) => l.startsWith(`${name}:`))
  return line === undefined ? undefined : Number(line.split(":")[2])
}
