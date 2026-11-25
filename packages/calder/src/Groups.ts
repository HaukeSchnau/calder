import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A group's id, or undefined when the host has no such group. macOS keeps its groups in the directory
 * service, whose /etc/group lists only a few built-in ones.
 */
export const groupId = (name: string) => {
  if (process.platform === "darwin") {
    const found = spawnSync("/usr/bin/dscacheutil", ["-q", "group", "-a", "name", name], {
      encoding: "utf8",
    });
    const gid = /^gid: (\d+)$/m.exec(found.stdout ?? "")?.[1];
    return gid === undefined ? undefined : Number(gid);
  }
  let groups: string;
  try {
    groups = readFileSync("/etc/group", "utf8");
  } catch {
    return undefined;
  }
  const line = groups.split("\n").find((l) => l.startsWith(`${name}:`));
  return line === undefined ? undefined : Number(line.split(":")[2]);
};
