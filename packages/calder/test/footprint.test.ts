import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Calder, Event, Flake, Nix, On } from "@calder-ci/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Sink, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { vi } from "vitest"
import * as Rows from "../src/controller/Rows.ts"
import type { RunInfo } from "../src/Protocol.ts"
import * as Footprint from "../src/worker/Footprint.ts"
import { byDependencies, evaluationContext, fromRecords, ownReads, recorder, resolve, vetted } from "../src/worker/Resolve.ts"
import { memoryRepo } from "./memoryRepo.ts"
import { layer as sqlite } from "./sqlite.ts"

vi.mock("@effect/sql-sqlite-bun", () => ({}))

const src = "/nix/store/00000000000000000000000000000000-source"
/** strace's lines for a call: `openat` of a file, a directory, a lookup, or a failed one. */
const open = (path: string, fd = 7) => `1 openat(AT_FDCWD, "${path}", O_RDONLY|O_NOFOLLOW|O_CLOEXEC) = ${fd}`
const list = (path: string) => `1 openat(AT_FDCWD, "${path}", O_RDONLY|O_NONBLOCK|O_CLOEXEC|O_DIRECTORY) = 8`
const look = (path: string) => `1 newfstatat(AT_FDCWD, "${path}", {st_mode=S_IFREG|0444, st_size=1, ...}, AT_SYMLINK_NOFOLLOW) = 0`
const missing = (path: string) => `1 newfstatat(AT_FDCWD, "${path}", 0x7ffc, AT_SYMLINK_NOFOLLOW) = -1 ENOENT (No such file or directory)`
const nonce = "5eed"
const mark = (i: number) => missing(`${src}/.calder-derivation-${nonce}-${i}`)

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
    ].join("\n"), src, nonce)
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

    const digests = (tree: Footprint.Tree) => pass.counts.map((count) => Footprint.digest(tree, pass.entries, count!, "nix"))
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
    const trace = (line: string) => Footprint.parseTrace([open(`${src}/flake.nix`), mark(0), line, mark(1), open(`${src}/flake.nix`), mark(2)].join("\n"), src, nonce)
    const counts = (line: string) => Footprint.footprints(trace(line), at).counts
    // A flake input relative to the source (`path:./sub`) is read from the source: an ordinary entry.
    expect(counts(open(`${src}/sub/flake.nix`))).toEqual([1, 2, 2])
    // A file inside a submodule, which git lists only as a commit: the source and git disagree.
    expect(counts(open(`${src}/vendor/lib.nix`))).toEqual([1, null, null])
    // A path strace had to escape, a path relative to a descriptor, an error other than a missing path.
    expect(counts(open(`${src}/caf\\303\\251.nix`))).toEqual([1, null, null])
    expect(counts("1 openat(9, \"flake.nix\", O_RDONLY) = 10")).toEqual([1, null, null])
    // A line about the source that comes out as neither a touch nor a marker, such as a call strace
    // printed in a form the recorder doesn't read, or a marker flake code made without the nonce.
    expect(counts(`1 getdents64(8</nix/store/00000000000000000000000000000000-source/sub>, 0x5555 /* 3 entries */, 32768) = 72`)).toEqual([1, null, null])
    expect(counts(missing(`${src}/.calder-derivation-0`))).toEqual([1, 2, 2])
    expect(counts(missing(`${src}/.calder-derivation-forged-1`))).toEqual([1, 2, 2])
    // A directory opened without O_DIRECTORY is listed all the same.
    expect(Footprint.footprints(trace(open(`${src}/sub`)), at).entries).toContainEqual(["sub", "list"])
    expect(counts(`1 openat(AT_FDCWD, "${src}/secret", O_RDONLY) = -1 EACCES (Permission denied)`)).toEqual([1, null, null])
  })
})

describe("records", () => {
  const at = files({ "flake.nix": "1", "flake.lock": "2", "src/app.ts": "3" })
  const entries = [["flake.nix", "read"], ["flake.lock", "read"]] as const
  const drv = { drv: "/nix/store/x-shell.drv", out: "/nix/store/x-shell", system: "aarch64-linux" }
  const records = {
    footprints: [{ id: "1", revision: "a".repeat(40), entries: [...entries] }],
    evaluations: [{ id: 7, attr: "devShells.aarch64-linux.ci", footprint: "1", count: 2, digest: Footprint.digest(at, entries, 2, "nix 2.34"), derivation: drv }],
  }

  it("takes an attribute's derivation where its footprint holds, and evaluates it where it doesn't", () => {
    expect(fromRecords(records, ["devShells.aarch64-linux.ci"], files({ "flake.nix": "1", "flake.lock": "2", "src/app.ts": "4" }), "nix 2.34"))
      .toEqual(new Map([["devShells.aarch64-linux.ci", { derivation: drv, id: 7 }]]))
    expect(fromRecords(records, ["devShells.aarch64-linux.ci"], files({ "flake.nix": "1", "flake.lock": "5", "src/app.ts": "3" }), "nix 2.34")).toEqual(new Map())
    // Another Nix, system or setting that changes results: the record counts nowhere.
    expect(fromRecords(records, ["devShells.aarch64-linux.ci"], at, "nix 2.35")).toEqual(new Map())
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
      const nix = { "nix --version": { code: 0, stdout: "nix (Nix) 2.34.9" }, "nix config": { code: 0, stdout: "true" }, "sh -c": { code: 0, stdout: "" } }
      if (process.platform === "linux") {
        expect((yield* with_({ ...nix, "strace -V": { code: 0 }, "nix flake": { code: 0, stdout: metadata } }))?.url)
          .toBe(`path:${src}?rev=${"a".repeat(40)}&revCount=3&lastModified=1&narHash=sha256-x%3D`)
      }
      expect(yield* with_({ "nix flake": { code: 0, stdout: metadata } })).toBeUndefined()
      expect(yield* with_({ "strace -V": { code: 0 }, "nix flake": { code: 1 } })).toBeUndefined()
      expect(yield* with_({ "strace -V": { code: 0 }, "nix flake": { code: 0, stdout: "{}" } })).toBeUndefined()
    }))

  it.effect("are read by trusted runs and forks only from trusted runs, and written by no fork", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const push = (branch: string) => JSON.stringify({ _tag: "Push", branch })
      const keep = (id: string, trust: "pr" | "trusted", fork: 0 | 1, derivation: typeof drv, event = push("main")) =>
        Rows.keepRecords({ project: "app", id, trust, fork, event }, "main", { ...records, evaluations: [{ ...records.evaluations[0]!, derivation }] })
      yield* keep("app-1", "trusted", 0, drv)
      yield* keep("app-2", "pr", 0, { ...drv, drv: "/nix/store/y-shell.drv" }, JSON.stringify({ _tag: "PullRequest", number: 1 }))
      yield* keep("app-3", "pr", 1, { ...drv, drv: "/nix/store/z-fork.drv" }, JSON.stringify({ _tag: "PullRequest", number: 2 }))
      // A push to another branch runs that branch's ci.ts in the trusted worker: it keeps nothing.
      yield* keep("app-4", "trusted", 0, { ...drv, drv: "/nix/store/b-branch.drv" }, push("feature"))
      expect((yield* sql<{ run_id: string }>`select run_id from evaluations order by id`).map((r) => r.run_id)).toEqual(["app-1", "app-2"])
      expect(Rows.writesRecords({ fork: 0, trust: "trusted", event: JSON.stringify({ _tag: "Schedule", cron: "0 * * * *" }) }, "main")).toBe(true)
      const newest = (trust: "pr" | "trusted", fork: 0 | 1) =>
        Effect.map(Rows.records({ project: "app", trust, fork }), (r) => r?.evaluations.map((e) => e.derivation?.drv))
      // A pull request's ci.ts runs in the worker that records, so what it recorded never reaches a trusted run.
      expect(yield* newest("trusted", 0)).toEqual(["/nix/store/x-shell.drv"])
      expect(yield* newest("pr", 1)).toEqual(["/nix/store/x-shell.drv"])
      // A same-repo pull request takes both, newest first.
      expect(yield* newest("pr", 0)).toEqual(["/nix/store/y-shell.drv", "/nix/store/x-shell.drv"])
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

/** Answers commands by their first two words; `nix eval` of the plan's expression reports `evaluate`'s derivations. */
const answering = (answers: Record<string, { readonly code?: number; readonly stdout?: string | ((argv: ReadonlyArray<string>) => string) }>, evaluate?: (attr: string) => unknown) => {
  const evaluated: Array<string> = []
  const line = (text: string) => new TextEncoder().encode(`${text}\n`)
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const argv = ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []
      const reports = [...(argv.at(-1) ?? "").matchAll(/\(report (\d+) f\.(\S+)\)/g)]
      let stderr: Stream.Stream<Uint8Array> = Stream.empty
      let code = 1
      let stdout = ""
      if (argv[1] === "eval" && reports.length > 0 && evaluate !== undefined) {
        evaluated.push(...reports.map((m) => m[2]!))
        stderr = Stream.make(line("trace: calder-flake"), ...reports.map((m) => line(`trace: calder-derivation ${JSON.stringify([Number(m[1]), evaluate(m[2]!)])}`)))
        code = 0
      } else {
        const answer = answers[argv.slice(0, 2).join(" ")]
        code = answer?.code ?? (answer === undefined ? 1 : 0)
        stdout = typeof answer?.stdout === "function" ? answer.stdout(argv) : answer?.stdout ?? ""
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  )
  return { spawner, evaluated }
}

describe("what a record may be trusted with", () => {
  it.effect("trusts no attribute that read a store path built from the source, or whose deriver Nix doesn't know", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "calder-ifd-"))
      // `gen = derivation { src = self; … }` and `import gen`: its output's deriver names the source.
      const gen = join(dir, "gen.drv")
      writeFileSync(gen, `Derive([("out","/nix/store/g-gen","","")],[],["${src}"],"x86_64-linux","/bin/sh",[],[])`)
      const plain = join(dir, "plain.drv")
      writeFileSync(plain, `Derive([("out","/nix/store/p-plain","","")],[],[],"x86_64-linux","/bin/sh",[],[])`)
      const derivers: Record<string, string> = { "/nix/store/g-gen": gen, "/nix/store/p-plain": plain }
      // A JSON file the evaluation wrote with builtins.toFile has no deriver but is addressed by its text.
      const json = join(dir, "inventory.json")
      writeFileSync(json, "{}")
      // A copy of the whole source under another name has the source's NAR hash.
      const copy = "/nix/store/c-src"
      // A derivation whose input is `builtins.toFile "rev" self.rev`: a text file in its closure names the commit.
      const rev = join(dir, "rev")
      writeFileSync(rev, `${src}`)
      const reads = join(dir, "reads-rev.drv")
      writeFileSync(reads, `Derive([("out","/nix/store/r-reads","","")],[],["${rev}"],"x86_64-linux","/bin/sh",[],[])`)
      const requisites: Record<string, ReadonlyArray<string>> = { [reads]: [reads, rev] }
      const { spawner } = answering({
        "nix-store --query": {
          stdout: (argv) => argv[2] === "--deriver" ? argv.slice(3).map((p) => derivers[p] ?? "unknown-deriver").join("\n") : (requisites[argv.at(-1)!] ?? [argv.at(-1)!]).join("\n"),
        },
        "nix path-info": {
          stdout: JSON.stringify({
            [json]: { ca: "text:sha256:x", references: [], narHash: "sha256-json=" },
            "/nix/store/u-unknown": { ca: null },
            [copy]: { ca: "fixed:r:sha256:y", references: [], narHash: "sha256-source=" },
            [rev]: { ca: "text:sha256:z", references: [], narHash: "sha256-rev=" },
          }),
        },
      })
      const recorder = {
        source: src, url: "", revision: "a", at: files({}), marks: [src], pinned: new Set(["/nix/store/n-nixpkgs"]),
        context: "nix", nonce, narHash: "sha256-source=", read: () => Effect.succeed(new Map<string, string>()),
      }
      const candidate = (attr: string, outside: ReadonlyArray<string>) => ({ attr, index: 0, count: 0, entries: [], derivation: null, outside })
      const kept = yield* vetted(recorder, [
        candidate("imports-gen", ["/nix/store/g-gen"]),
        candidate("reads-unknown", ["/nix/store/u-unknown"]),
        candidate("reads-nixpkgs", ["/nix/store/n-nixpkgs"]),
        candidate("reads-plain", ["/nix/store/p-plain"]),
        candidate("reads-a-written-file", [json]),
        candidate("reads-a-copy-of-the-source", [copy]),
        { ...candidate("builds-from-the-commit's-rev", []), derivation: { drv: reads, out: "/nix/store/r-reads", system: "x86_64-linux" } },
      ]).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      expect(kept.map((c) => c.attr)).toEqual(["reads-nixpkgs", "reads-plain", "reads-a-written-file"])
    }))

  it.effect("is checked by an audit that evaluates through the mirror, as plans did before records", () =>
    Effect.gen(function*() {
      // As with `self ? submodules`, the record's evaluation (through path:) and the mirror's disagree.
      const attr = "packages.x86_64-linux.app"
      const recordedDrv = { drv: "/nix/store/r-app.drv", out: "/nix/store/r-app", system: "x86_64-linux" }
      const freshDrv = { drv: "/nix/store/f-app.drv", out: "/nix/store/f-app", system: "x86_64-linux" }
      const { spawner, evaluated } = answering({
        "nix --version": { stdout: "nix (Nix) 2.34.9" },
        "nix config": { stdout: "true" },
        "nix-store --check-validity": {},
        "nix-store --query": {},
      }, () => freshDrv)
      const tree = { "flake.nix": "{ outputs = _: { }; }" }
      const context = yield* evaluationContext("x86_64-linux").pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const entries = [["flake.nix", "read"]] as const
      const records = {
        footprints: [{ id: "1", revision: "a", entries: [...entries] }],
        evaluations: [{ id: 7, attr, footprint: "1", count: 1, digest: Footprint.digest(files({ "flake.nix": createHash("sha256").update(tree["flake.nix"]).digest("hex") }), entries, 1, context!), derivation: recordedDrv }],
      }
      const run = { id: "app-1", project: "app", number: 1, revision: "b", branch: "main", trust: "trusted", event: Event.push("main"),
        flake: "git+file:///mirror", mirror: "/mirror", mirrors: {}, pipelineDir: "", system: "x86_64-linux" } satisfies RunInfo
      const project = Calder.project({ rules: [On.push("main", [Nix.build(Flake.attr(attr), { name: "app" })])] })
      const plan = (audit: boolean) =>
        Effect.gen(function*() {
          return yield* resolve(yield* Calder.plan(project, run.event), project, run, memoryRepo(tree), undefined, { records, audit })
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      // A plan takes the record, and says which.
      const planned = yield* plan(false)
      expect(planned.derivations?.[attr]).toEqual(recordedDrv)
      expect(planned.fromRecords).toEqual({ [attr]: 7 })
      expect(evaluated).toEqual([])
      // The audit evaluates afresh and reports the record.
      const audited = yield* plan(true)
      expect(evaluated).toEqual([attr])
      expect(audited.mismatches).toMatchObject([{ attr, recorded: recordedDrv, evaluated: freshDrv, record: 7 }])
    }))
})
