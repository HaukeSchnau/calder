import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { type Duration, Effect } from "effect"
import * as Exec from "../Exec.ts"

/**
 * A line in a plan's log while `nix eval` runs, saying what it does, for an evaluation that takes long:
 * srv-2 once planned casa-crema for 24 minutes without a word, while the Nix daemon copied a nixpkgs
 * source under its slice's memory.high. The first comes after a minute, since most plans finish within
 * one; then one every 3 minutes, at most 10 in a plan's 30, each over long enough that the CPU time,
 * pressure and trace it compares say more than noise.
 */
export interface Cadence {
  readonly first: Duration.Input
  readonly every: Duration.Input
}

export const cadence: Cadence = { first: "1 minute", every: "3 minutes" }

/** What the evaluator itself knows: where it is, its budget, and Nix's activities and messages. */
export interface Progress {
  /** When the evaluator started, in ms. */
  readonly started: number
  readonly loaded: boolean
  /** The attribute it evaluates, counted over the whole evaluation, once the flake loaded. */
  readonly attr?: { readonly index: number; readonly total: number; readonly name: string }
  readonly budget: number | null
  /** Nix's newest activity that hasn't ended, such as a copy to the store or a download. */
  readonly activity?: { readonly text: string; readonly started: number; readonly done?: number; readonly expected?: number }
  /** The last line Nix printed other than Calder's reports. */
  readonly said?: { readonly text: string; readonly at: number }
}

/** Microseconds some and all non-idle tasks waited, from a PSI file (`total=`). */
interface Stall {
  readonly some: number
  readonly full: number
}

/** What the host showed at one moment. A field the platform doesn't have, as on macOS, is absent. */
export interface Sample {
  readonly at: number
  /** CPU seconds Nix used, all threads. */
  readonly cpu?: number
  /** Anonymous resident bytes of the evaluator, strace included. */
  readonly resident?: number
  /** Nix's main thread: its state letter, and the kernel function it sleeps in. */
  readonly main?: { readonly state: string; readonly wchan: string }
  /** The last file the footprint trace shows Nix opening, and how large the trace was. */
  readonly opened?: { readonly path: string | undefined; readonly size: number }
  readonly host?: { readonly memory?: Stall; readonly io?: Stall }
  readonly daemon?: {
    readonly unit: string
    readonly memory?: Stall
    /** The cgroup whose memory.high limits the daemon most: it or an ancestor. */
    readonly limit?: { readonly name: string; readonly current: number; readonly high: number; readonly over: number }
    readonly current?: number
  }
}

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const number = (file: string) => {
  const text = read(file)?.trim()
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined
}

/** Under the recorder, `pid` is strace and Nix its child. */
const nixOf = (pid: number) => {
  const queue = [pid]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (read(`/proc/${id}/comm`)?.trim() === "nix") return id
    queue.push(...(read(`/proc/${id}/task/${id}/children`) ?? "").trim().split(/\s+/).filter(Boolean).map(Number))
  }
  return pid
}

/** State and CPU time from `/proc/<pid>/stat`, whose fields count after the parenthesized name. */
const stat = (file: string) => {
  const text = read(file)
  if (text === undefined) return undefined
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  // utime and stime, in ticks of USER_HZ, which is 100 on x86_64 and aarch64.
  return { state: fields[0]!, cpu: (Number(fields[11]) + Number(fields[12])) / 100 }
}

const stalls = (file: string): Stall | undefined => {
  const text = read(file)
  const total = (kind: string) => Number(new RegExp(`^${kind} .*total=(\\d+)`, "m").exec(text ?? "")?.[1])
  const [some, full] = [total("some"), total("full")]
  return Number.isFinite(some) && Number.isFinite(full) ? { some, full } : undefined
}

/**
 * The last store path strace saw Nix open, from the trace's last 64 KiB, which a long evaluation grows to
 * gigabytes. A pure evaluation reads only the store; Nix itself opens files such as /etc/localtime as it logs.
 */
const lastOpened = (trace: string) => {
  let fd: number | undefined
  try {
    fd = openSync(trace, "r")
    const size = fstatSync(fd).size
    const length = Math.min(size, 64 * 1024)
    const tail = Buffer.alloc(length)
    readSync(fd, tail, 0, length, size - length)
    const path = tail.toString("utf8").split("\n").map((line) => /^\d+ +open(?:at2?)?\((?:\w+, *)?"(\/nix\/store\/(?:[^"\\]|\\.)*)"/.exec(line)?.[1])
      .findLast((p) => p !== undefined)
    return { path, size }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const cgroups = "/sys/fs/cgroup"

/** The daemon's cgroup and what limits it, or nothing where cgroup v2 isn't mounted there. */
const daemonOf = (unit: string): Sample["daemon"] => {
  const dir = join(cgroups, unit)
  const current = number(join(dir, "memory.current"))
  if (current === undefined) return undefined
  let limit: NonNullable<Sample["daemon"]>["limit"]
  // Like the job's budget, the smallest memory.high of it and its ancestors: on srv-2 its slice's.
  for (let at = dir; at.startsWith(cgroups) && at !== cgroups; at = dirname(at)) {
    const high = number(join(at, "memory.high"))
    if (high !== undefined && (limit === undefined || high < limit.high)) {
      const over = Number(/^high (\d+)$/m.exec(read(join(at, "memory.events")) ?? "")?.[1] ?? 0)
      limit = { name: basename(at), current: number(join(at, "memory.current")) ?? 0, high, over }
    }
  }
  const memory = stalls(join(dir, "memory.pressure"))
  return { unit: basename(unit), current, ...(memory === undefined ? {} : { memory }), ...(limit === undefined ? {} : { limit }) }
}

let daemonUnit: string | null | undefined
/** The Nix daemon's cgroup, asked of systemd once per worker; null where there is no systemd, as on macOS. */
export const daemonCgroup = Effect.suspend(() =>
  daemonUnit !== undefined ? Effect.succeed(daemonUnit) : Exec.exec(["systemctl", "show", "-p", "ControlGroup", "--value", "nix-daemon.service"]).pipe(
    Effect.map((out) => (out.exitCode === 0 && out.stdout.trim().startsWith("/") ? out.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
    Effect.tap((unit) => Effect.sync(() => void (daemonUnit = unit))),
  )
)

/** What `/proc` and the cgroups show of an evaluator whose process is `pid`. */
export const sample = (pid: number, options: {
  readonly resident: (pid: number) => number
  /** The footprint trace, under the recorder. */
  readonly trace?: string | undefined
  readonly daemon: string | null
}): Sample => {
  const nix = nixOf(pid)
  const whole = stat(`/proc/${nix}/stat`)
  const main = stat(`/proc/${nix}/task/${nix}/stat`)
  const wchan = read(`/proc/${nix}/task/${nix}/wchan`)?.trim()
  const opened = options.trace === undefined ? undefined : lastOpened(options.trace)
  const memory = stalls("/proc/pressure/memory")
  const io = stalls("/proc/pressure/io")
  const daemon = options.daemon === null ? undefined : daemonOf(options.daemon)
  return {
    at: Date.now(),
    ...(whole === undefined ? {} : { cpu: whole.cpu, resident: options.resident(pid) }),
    ...(main === undefined ? {} : { main: { state: main.state, wchan: wchan ?? "0" } }),
    ...(opened === undefined ? {} : { opened }),
    ...(memory === undefined && io === undefined ? {} : { host: { ...(memory === undefined ? {} : { memory }), ...(io === undefined ? {} : { io }) } }),
    ...(daemon === undefined ? {} : { daemon }),
  }
}

const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1)

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

const seconds = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`

/** The share of `interval` ms that tasks stalled, from two PSI totals in µs. */
const stalled = (before: Stall | undefined, now: Stall | undefined, interval: number) => {
  if (before === undefined || now === undefined || interval <= 0) return undefined
  const pct = (a: number, b: number) => Math.round(Math.min(100, (b - a) / (interval * 10)))
  return `${pct(before.some, now.some)}% some and ${pct(before.full, now.full)}% full`
}

const thread = (main: NonNullable<Sample["main"]>) => {
  const where = main.wchan === "0" || main.wchan === "" ? "" : ` in ${main.wchan}`
  switch (main.state) {
    case "R":
      return "Its main thread is running."
    // The only Unix socket nix eval holds is its store's, the daemon for any user but root. Its peer can't
    // be checked: a pull request's worker has a network namespace of its own, which hides the daemon's end.
    case "S":
      return main.wchan.startsWith("unix_") ? `Its main thread waits for the Nix daemon (${main.wchan}).` : `Its main thread sleeps${where}.`
    case "D":
      return `Its main thread is in uninterruptible sleep${where}.`
    case "t":
    case "T":
      return "Its main thread is stopped by strace."
    default:
      return undefined
  }
}

/**
 * One line of plain sentences from what the evaluator knows and two samples: the last heartbeat's, or the
 * evaluator's start, and now. What changed between them goes in one sentence about that interval.
 */
export const describe = (progress: Progress, before: Sample, now: Sample) => {
  const where = !progress.loaded
    ? "loading the flake"
    : progress.attr === undefined
    ? "after its last attribute"
    : `at attribute ${progress.attr.index} of ${progress.attr.total}, ${progress.attr.name}`
  const parts = [`Still evaluating after ${span(now.at - progress.started)}, ${where}.`]
  if (now.resident !== undefined) {
    parts.push(`Nix holds ${gib(now.resident)} GiB${progress.budget === null ? "" : ` of its ${gib(progress.budget)} GiB budget`}.`)
  }
  const doing = now.main === undefined ? undefined : thread(now.main)
  if (doing !== undefined) parts.push(doing)
  if (now.opened?.path !== undefined) {
    // The trace grows with every file Nix opens or looks up.
    const still = now.opened.size === before.opened?.size
    parts.push(`The last file it opened is ${now.opened.path}${still ? ", and it touched no file since the last heartbeat" : ""}.`)
  }
  if (progress.activity !== undefined) {
    const { text, started, done, expected } = progress.activity
    const of = done === undefined || !expected ? "" : ` (${(done / 2 ** 20).toFixed(1)} of ${(expected / 2 ** 20).toFixed(1)} MiB)`
    parts.push(`Nix has been ${text}${of} for ${span(now.at - started)}.`)
  } else if (progress.said !== undefined) {
    parts.push(`Nix last said, ${span(now.at - progress.said.at)} ago: "${progress.said.text}".`)
  }
  const daemon = now.daemon
  if (daemon?.limit !== undefined) {
    const { name, current, high } = daemon.limit
    const holder = name === daemon.unit ? daemon.unit : `${daemon.unit} is in ${name}, which`
    parts.push(`The Nix daemon's ${holder} holds ${gib(current)} of its ${gib(high)} GiB memory.high.`)
  } else if (daemon?.current !== undefined) {
    parts.push(`The Nix daemon's ${daemon.unit} holds ${gib(daemon.current)} GiB and has no memory.high.`)
  }
  const interval = now.at - before.at
  const over = daemon?.limit === undefined ? 0 : daemon.limit.over - (before.daemon?.limit?.over ?? daemon.limit.over)
  const pressure = (what: string, a: Stall | undefined, b: Stall | undefined) => {
    const share = stalled(a, b, interval)
    return share === undefined ? [] : [`${what} was ${share}`]
  }
  const during = [
    ...(now.cpu === undefined ? [] : [`Nix used ${seconds(now.cpu - (before.cpu ?? 0))} of CPU, ${seconds(now.cpu)} in all`]),
    ...pressure("the host's memory pressure", before.host?.memory, now.host?.memory),
    ...pressure("its io pressure", before.host?.io, now.host?.io),
    ...pressure("the Nix daemon's memory pressure", before.daemon?.memory, daemon?.memory),
    ...(over > 0 ? [`${daemon!.limit!.name} went over its memory.high ${over} times`] : []),
  ]
  if (during.length > 0) parts.push(`In the last ${span(interval)}, ${during.join("; ")}.`)
  return parts.join(" ")
}
