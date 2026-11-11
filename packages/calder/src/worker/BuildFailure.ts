/**
 * Whether a failed `nix build` failed for an infrastructure reason: Nix couldn't reach or use a builder
 * or its store, and no derivation failed to build. Returns what went wrong, in one line, or null for a
 * real build failure. `lines` are the messages Nix itself printed, in order, without the builds' own logs.
 *
 * infra-887's m1 build failed when the SSH connection to the Mac builder dropped, and infra-909's mbp
 * build when srv-2's garbage collector had deleted its derivation: both would pass when tried again.
 */
export const infrastructure = (lines: ReadonlyArray<string>): string | null => {
  // A derivation that ran and failed, also when an unreachable builder shows up beside it.
  const built =
    /builder for '[^']*' failed|Reason: builder failed|hash mismatch in fixed-output derivation|timed out after \d+ seconds|cycle detected in build of|no output reference for/
  if (lines.some((line) => built.test(line))) return null
  const causes: ReadonlyArray<(line: string) => string | null> = [
    (line) => {
      const m = /failed to start SSH connection to '([^']+)'/.exec(line)
      return m === null ? null : `the builder ${m[1]} could not be reached: failed to start SSH connection`
    },
    (line) => {
      const m = /ssh: connect to host (\S+) port \d+: (.+)/.exec(line)
      return m === null ? null : `the builder ${m[1]} could not be reached: ${m[2]!.trim()}`
    },
    (line) => {
      const m = /cannot build on '([^']+)': (?:error: )?(.+)/.exec(line)
      return m === null ? null : `the builder ${host(m[1]!)} could not be used: ${m[2]!.trim()}`
    },
    (line) => {
      const m = /failed to obtain derivation of '([^']+)'/.exec(line)
      return m === null ? null : `the store lost ${m[1]}`
    },
    (line) => (/don't know how to build these paths/.test(line) ? "the store lost the derivation" : null),
    (line) =>
      /cannot open connection to remote store|kex_exchange_identification|Connection reset by peer|Connection closed by|Broken pipe|unexpected end-of-file/
          .test(line)
        ? `Nix lost its connection to a builder or store: ${line.replace(/^error:\s*/, "").trim()}`
        : null,
    (line) => (/Failed to find a machine for remote build/.test(line) ? "no remote builder could take the build" : null),
  ]
  // The first kind of cause, in that order, that any line shows: an address says more than a lost connection.
  for (const cause of causes) {
    for (const line of lines) {
      const found = cause(line)
      if (found !== null) return found
    }
  }
  return null
}

/** The host of a builder's store URI, such as `100.83.228.36` of `ssh-ng://hauke@100.83.228.36?remote-program=...`. */
const host = (uri: string) => /^[a-z-]+:\/\/(?:[^@/]*@)?([^:/?]+)/.exec(uri)?.[1] ?? uri
