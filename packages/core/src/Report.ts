import type { TaskFailed, TestFailure } from "./Kiln.ts"
import type { Failed } from "./Step.ts"

/** Where a task writes test results. Kiln reads them after the command, also when it fails. */
export type ReportSpec =
  | { readonly _tag: "JUnit"; readonly path: string }
  | { readonly _tag: "Vitest"; readonly path: string }

export const junit = (path: string): ReportSpec => ({ _tag: "JUnit", path })

/** Vitest's `json` reporter (`--reporter=json --outputFile=<path>`). */
export const vitest = (path: string): ReportSpec => ({ _tag: "Vitest", path })

export interface TestResult {
  readonly suite: string
  readonly name: string
  readonly file: string | undefined
  readonly status: "passed" | "failed" | "skipped" | "timeout"
  readonly durationMs: number
  readonly message: string | undefined
}

const timedOut = (message: string) => /timed? ?out/i.test(message)

export const parse = (spec: ReportSpec, text: string): ReadonlyArray<TestResult> =>
  spec._tag === "JUnit" ? parseJUnit(text) : parseVitest(text)

export const failures = (results: ReadonlyArray<TestResult>): ReadonlyArray<TestFailure> =>
  results
    .filter((r) => r.status === "failed" || r.status === "timeout")
    .map((r) => ({
      _tag: r.status === "timeout" ? "TestTimeout" : "TestFailed",
      suite: r.suite,
      name: r.name,
      ...(r.file === undefined ? {} : { file: r.file }),
      message: r.message ?? "",
    }))

interface VitestJson {
  readonly testResults?: ReadonlyArray<{
    readonly name?: string
    readonly message?: string
    readonly status?: string
    readonly assertionResults?: ReadonlyArray<{
      readonly ancestorTitles?: ReadonlyArray<string>
      readonly title?: string
      readonly status?: string
      readonly duration?: number | null
      readonly failureMessages?: ReadonlyArray<string>
    }>
  }>
}

export const parseVitest = (text: string): ReadonlyArray<TestResult> => {
  const json = JSON.parse(text) as VitestJson
  return (json.testResults ?? []).flatMap((file) => {
    const assertions = file.assertionResults ?? []
    // A file that fails to load has no assertions, only a message.
    if (assertions.length === 0 && file.status === "failed") {
      return [{
        suite: file.name ?? "",
        name: "(file)",
        file: file.name,
        status: "failed" as const,
        durationMs: 0,
        message: file.message ?? "failed to load",
      }]
    }
    return assertions.map((a): TestResult => {
      const message = a.failureMessages?.join("\n") || undefined
      const failed = a.status === "failed"
      return {
        suite: (a.ancestorTitles ?? []).join(" > "),
        name: a.title ?? "",
        file: file.name,
        status: failed ? (message !== undefined && timedOut(message) ? "timeout" : "failed")
          : a.status === "passed" ? "passed"
          : "skipped",
        durationMs: Math.round(a.duration ?? 0),
        message,
      }
    })
  })
}

const decodeEntities = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    switch (e.toLowerCase()) {
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "amp":
        return "&"
      case "quot":
        return '"'
      case "apos":
        return "'"
    }
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "")
  return out
}

const text = (body: string) =>
  body
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeEntities(part.replace(/<[^>]+>/g, ""))))
    .join("")
    .trim()

/** JUnit XML as written by vitest, bun test, pytest, PHPUnit and most others. */
export const parseJUnit = (xml: string): ReadonlyArray<TestResult> => {
  const results: Array<TestResult> = []
  const suites: Array<string> = []
  const tokens = xml.matchAll(/<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>|<\/testcase>/g)
  let open: { attrs: Record<string, string>; start: number } | undefined
  for (const m of tokens) {
    const [whole, closing, name, rest, selfClosing] = m
    if (name === "testsuite") {
      if (closing) suites.pop()
      else if (!selfClosing) suites.push(attrs(rest ?? "").name ?? "")
      continue
    }
    if (name === "testcase" && !closing) {
      const a = attrs(rest ?? "")
      if (selfClosing) results.push(testcase(a, "", suites))
      else open = { attrs: a, start: m.index! + whole.length }
      continue
    }
    if (open !== undefined) {
      results.push(testcase(open.attrs, xml.slice(open.start, m.index), suites))
      open = undefined
    }
  }
  return results
}

const testcase = (a: Record<string, string>, body: string, suites: ReadonlyArray<string>): TestResult => {
  const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
  const skipped = /<skipped\b/.test(body)
  const message = failure ? [attrs(failure[2] ?? "").message, text(failure[3] ?? "")].filter(Boolean).join("\n") : undefined
  return {
    suite: a.classname ?? suites.at(-1) ?? "",
    name: a.name ?? "",
    // Vitest and bun put the file in classname; pytest a module path, which isn't one.
    file: a.file ?? (a.classname !== undefined && /\.[cm]?[jt]sx?$/.test(a.classname) ? a.classname : undefined),
    status: failure ? (message !== undefined && timedOut(message) ? "timeout" : "failed") : skipped ? "skipped" : "passed",
    durationMs: Math.round(Number(a.time ?? 0) * 1000),
    message,
  }
}

/** Markdown for a pull-request comment listing failing tests and failed steps. */
export const summarize = (failed: ReadonlyArray<Failed<unknown>>): string => {
  const lines: Array<string> = []
  for (const f of failed) {
    const error = f.error as Partial<TaskFailed> | undefined
    const tests = error?.failures ?? []
    lines.push(`**${f.step}** ${tests.length > 0 ? `has ${tests.length} failing test${tests.length === 1 ? "" : "s"}` : "failed"}`)
    for (const t of tests.slice(0, 20)) {
      const first = t.message.split("\n").find((l) => l.trim() !== "")?.trim() ?? ""
      lines.push(`- \`${[t.suite, t.name].filter(Boolean).join(" > ")}\`${t._tag === "TestTimeout" ? " (timed out)" : ""}${first ? `: ${first.slice(0, 200)}` : ""}`)
    }
    if (tests.length > 20) lines.push(`- and ${tests.length - 20} more`)
  }
  return lines.join("\n")
}
