import { describe, expect, it } from "@effect/vitest"
import { Effect, Sink, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import type { RunInfo } from "../src/Protocol.ts"
import * as Footprint from "../src/worker/Footprint.ts"
import { byDependencies, fromRecords, ownReads, recorder } from "../src/worker/Resolve.ts"
import { memoryRepo } from "./memoryRepo.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const src = "/nix/store/00000000000000000000000000000000-source"
/** strace's lines for a call: `openat` of a file, a directory, a lookup, or a failed one. */
const open = (path: string, fd = 7) => `1 openat(AT_FDCWD, "${path}", O_RDONLY|O_NOFOLLOW|O_CLOEXEC) = ${fd}`
const list = (path: string) => `1 openat(AT_FDCWD, "${path}", O_RDONLY|O_NONBLOCK|O_CLOEXEC|O_DIRECTORY) = 8`
const look = (path: string) => `1 newfstatat(AT_FDCWD, "${path}", {st_mode=S_IFREG|0444, st_size=1, ...}, AT_SYMLINK_NOFOLLOW) = 0`
const missing = (path: string) => `1 newfstatat(AT_FDCWD, "${path}", 0x7ffc, AT_SYMLINK_NOFOLLOW) = -1 ENOENT (No such file or directory)`
const mark = (i: number) => missing(`${src}/.calder-derivation-${i}`)

const files = (tree: Record<string, string>, modes: Record<string, string> = {}) =>
  Footprint.tree(Object.entries(tree).map(([path, oid]) => ({ path, oid, mode: modes[path] ?? "100644" })))

describe("footprints", () => {
  it("splits an evaluator's touches of the source between its attributes, each a prefix", () => {
    const trace = Footprint.parseTrace([
      "1 execve(\"/run/current-system/sw/bin/nix\", [\"nix\"], 0x0 /* 3 vars */) = 0",
      open("/etc/nix/nix.conf"),
      open(`${src}/flake.nix`),
      open(`${src}/flake.lock`),
      // nixpkgs and other store paths come from what was read and the pinned inputs.
      open("/nix/store/11111111111111111111111111111111-source/lib/default.nix"),
      mark(0),
      list(`${src}/hosts`),
      "2 newfstatat(AT_FDCWD, \"" + `${src}/hosts/a.nix` + "\",  <unfinished ...>",
      look(`${src}/README.md`),
      "2 <... newfstatat resumed>{st_mode=S_IFREG|0444, st_size=1, ...}, AT_SYMLINK_NOFOLLOW) = 0",
      missing(`${src}/hosts/b.nix`),
      mark(1),
    ].join("\n"), src)
    expect(trace.broken).toBeNull()
    expect(trace.marks).toEqual([2, 6])
    const at = files({ "flake.nix": "1", "flake.lock": "2", "hosts/a.nix": "3", "README.md": "4" })
    const pass = Footprint.footprints(trace, at)
    expect(pass.entries).toEqual([
      ["flake.nix", "read"],
      ["flake.lock", "read"],
      ["hosts", "list"],
      ["README.md", "lookup"],
      ["hosts/a.nix", "lookup"],
      ["hosts/b.nix", "lookup"],
    ])
    expect(pass.counts).toEqual([2, 6])

    const digests = (tree: Footprint.Tree) => pass.counts.map((count) => Footprint.digest(tree, pass.entries, count!))
    const before = digests(at)
    // Changing a file only looked up, or one nobody touched, keeps both footprints.
    expect(digests(files({ "flake.nix": "1", "flake.lock": "2", "hosts/a.nix": "9", "README.md": "8", "docs/x.md": "7" }))).toEqual(before)
    // A file appearing in a listed directory, or one that was missing, changes the second only.
    expect(digests(files({ "flake.nix": "1", "flake.lock": "2", "hosts/a.nix": "3", "hosts/b.nix": "5", "README.md": "4" })))
      .toEqual([before[0], expect.not.stringMatching(before[1]!)])
    // A read file's content or mode changes the first, and so the second.
    const changed = digests(files({ "flake.nix": "1", "flake.lock": "6", "hosts/a.nix": "3", "README.md": "4" }))
    expect(changed[0]).not.toEqual(before[0])
    expect(changed[1]).not.toEqual(before[1])
    expect(digests(files({ "flake.nix": "1", "flake.lock": "2", "hosts/a.nix": "3", "README.md": "4" }, { "flake.nix": "100755" }))[0])
      .not.toEqual(before[0])
  })

  it("gives no footprint from the first touch it can't attribute on", () => {
    const at = files({ "flake.nix": "1", "sub/flake.nix": "2", vendor: "c0ffee" }, { vendor: "160000" })
    const trace = (line: string) => Footprint.parseTrace([open(`${src}/flake.nix`), mark(0), line, mark(1), open(`${src}/flake.nix`), mark(2)].join("\n"), src)
    const counts = (line: string) => Footprint.footprints(trace(line), at).counts
    // A flake input relative to the source (`path:./sub`) is read from the source: an ordinary entry.
    expect(counts(open(`${src}/sub/flake.nix`))).toEqual([1, 2, 2])
    // A file inside a submodule, which git lists only as a commit: the source and git disagree.
    expect(counts(open(`${src}/vendor/lib.nix`))).toEqual([1, null, null])
    // A path strace had to escape, a path relative to a descriptor, an error other than a missing path.
    expect(counts(open(`${src}/caf\\303\\251.nix`))).toEqual([1, null, null])
    expect(counts("1 openat(9, \"flake.nix\", O_RDONLY) = 10")).toEqual([1, null, null])
    expect(counts(`1 openat(AT_FDCWD, "${src}/secret", O_RDONLY) = -1 EACCES (Permission denied)`)).toEqual([1, null, null])
  })
})

describe("records", () => {
  const at = files({ "flake.nix": "1", "flake.lock": "2", "src/app.ts": "3" })
  const entries = [["flake.nix", "read"], ["flake.lock", "read"]] as const
  const drv = { drv: "/nix/store/x-shell.drv", out: "/nix/store/x-shell", system: "aarch64-linux" }
  const records = {
    footprints: [{ id: "1", revision: "a".repeat(40), entries: [...entries] }],
    evaluations: [{ attr: "devShells.aarch64-linux.ci", footprint: "1", count: 2, digest: Footprint.digest(at, entries, 2), derivation: drv }],
  }

  it("takes an attribute's derivation where its footprint holds, and evaluates it where it doesn't", () => {
    expect(fromRecords(records, ["devShells.aarch64-linux.ci"], files({ "flake.nix": "1", "flake.lock": "2", "src/app.ts": "4" })))
      .toEqual(new Map([["devShells.aarch64-linux.ci", drv]]))
    expect(fromRecords(records, ["devShells.aarch64-linux.ci"], files({ "flake.nix": "1", "flake.lock": "5", "src/app.ts": "3" }))).toEqual(new Map())
  })

  it.effect("records nothing without strace or a flake Nix describes, so the plan evaluates as before", () =>
    Effect.gen(function*() {
      const answering = (answers: Record<string, { code: number; stdout?: string }>) =>
        ChildProcessSpawner.make((command) =>
          Effect.succeed((() => {
            const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
            const answer = answers[argv.slice(0, 2).join(" ")] ?? { code: 1 }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.code)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(answer.stdout ?? "")),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          })())
        )
      const run = { flake: `git+file:///mirror?rev=${"a".repeat(40)}` } as RunInfo
      const repo = memoryRepo({ "flake.nix": "{}" })
      const with_ = (answers: Record<string, { code: number; stdout?: string }>) =>
        recorder(run, repo).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, answering(answers)))
      const metadata = JSON.stringify({ path: src, locked: { rev: "a".repeat(40), revCount: 3, lastModified: 1, narHash: "sha256-x=" } })
      if (process.platform === "linux") {
        expect((yield* with_({ "strace -V": { code: 0 }, "nix flake": { code: 0, stdout: metadata } }))?.url)
          .toBe(`path:${src}?rev=${"a".repeat(40)}&revCount=3&lastModified=1&narHash=sha256-x%3D`)
      }
      expect(yield* with_({ "nix flake": { code: 0, stdout: metadata } })).toBeUndefined()
      expect(yield* with_({ "strace -V": { code: 0 }, "nix flake": { code: 1 } })).toBeUndefined()
      expect(yield* with_({ "strace -V": { code: 0 }, "nix flake": { code: 0, stdout: "{}" } })).toBeUndefined()
    }))

  it.effect("follow the trust rules of results: forks read trusted records only and write none", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const keep = (id: string, trust: "pr" | "trusted", fork: 0 | 1, derivation: typeof drv) =>
        Rows.keepRecords({ project: "app", id, trust, fork }, { ...records, evaluations: [{ ...records.evaluations[0]!, derivation }] })
      yield* keep("app-1", "trusted", 0, drv)
      yield* keep("app-2", "pr", 0, { ...drv, drv: "/nix/store/y-shell.drv" })
      yield* keep("app-3", "pr", 1, { ...drv, drv: "/nix/store/z-fork.drv" })
      expect((yield* sql<{ run_id: string }>`select run_id from evaluations order by id`).map((r) => r.run_id)).toEqual(["app-1", "app-2"])
      expect((yield* Rows.records("app", false))?.evaluations[0]?.derivation?.drv).toBe("/nix/store/y-shell.drv")
      expect((yield* Rows.records("app", true))?.evaluations[0]?.derivation?.drv).toBe("/nix/store/x-shell.drv")
    }).pipe(Effect.provide(sqlite)))
})

describe("evaluation order", () => {
  it("evaluates an attribute after those its last derivation depended on, those without one last", () => {
    const closures = new Map([
      ["release", { drv: "r.drv", closure: new Set(["r.drv", "deps.drv", "x.drv"]) }],
      ["shell", { drv: "s.drv", closure: new Set(["s.drv"]) }],
      ["gate", { drv: "g.drv", closure: new Set(["g.drv", "r.drv", "deps.drv"]) }],
      ["deps", { drv: "deps.drv", closure: new Set(["deps.drv"]) }],
    ])
    expect(byDependencies(["shell", "gate", "release", "new", "deps"], closures)).toEqual(["shell", "deps", "release", "gate", "new"])
    expect(byDependencies(["shell", "release"], new Map())).toEqual(["shell", "release"])
  })

  it("puts what read least first among attributes that don't depend on each other", () => {
    const entry = (attr: string, count: number) => ({ attr, footprint: "1", count, digest: "", derivation: null })
    // Last time two hosts went first and read 900 files each; the check after them read 10 more.
    const records = { footprints: [{ id: "1", revision: "a", entries: [] }], evaluations: [entry("srv-1", 900), entry("srv-2", 1800), entry("lint", 1810)] }
    const own = ownReads(records)
    expect(own).toEqual(new Map([["srv-1", 900], ["srv-2", 900], ["lint", 10]]))
    const alone = (attr: string) => ({ drv: `${attr}.drv`, closure: new Set([`${attr}.drv`]) })
    const closures = new Map(["srv-1", "srv-2", "lint"].map((attr) => [attr, alone(attr)]))
    expect(byDependencies(["srv-1", "srv-2", "lint"], closures, own)).toEqual(["lint", "srv-1", "srv-2"])
  })
})
