// The sources of site/example verbatim, what tsc says about the fits' edits to them, and their highlighting.

export const CI_TS = [
  'import { Action, Calder, Files, Nix, On, Step, Task, cmd } from "@calder-ci/core"',
  'import { Pnpm, Vitest } from "@calder-ci/std"',
  'import * as Deploy from "./deploy.ts"',
  'import { flake } from "./flake.ts"',
  "",
  "const shell = flake.devShells.default",
  "const install = Pnpm.install({ shell })",
  "",
  'const typecheck = Task.make("typecheck", {',
  "  shell,",
  "  setup: install,",
  '  inputs: Files.of("apps", "tsconfig.json"),',
  "  run: cmd`pnpm tsc -b`,",
  "})",
  "",
  "const test = Vitest.files({",
  "  shell,",
  "  setup: install,",
  '  tests: ["apps/*/src/**/*.test.ts"],',
  "})",
  "",
  "const site = Nix.build(flake.packages.site)",
  "",
  'const deploy = Action.make("deploy", {',
  "  needs: { site },",
  "  after: [typecheck, test],",
  '  grants: { secrets: ["deploy-token"] },',
  "}, function*({ site }) {",
  "  yield* Deploy.publish(site)",
  "}).pipe(Step.retry({ times: 2 }))",
  "",
  "export default Calder.project({",
  "  rules: [",
  "    On.pullRequest([typecheck, test, site]),",
  '    On.push("main", [deploy]),',
  "  ],",
  "})",
]

export const DEPLOY_TS = [
  'import { Secret, type StorePath } from "@calder-ci/core"',
  'import { Effect, Redacted } from "effect"',
  'import { HttpClient, HttpClientRequest } from "effect/http"',
  "",
  "/** Hands the built site to the hosting provider's deploy hook. */",
  "export const publish = (site: StorePath) =>",
  "  Effect.gen(function*() {",
  '    const token = yield* Secret.value("deploy-token")',
  "    const client = yield* HttpClient.HttpClient",
  "    yield* client.execute(",
  '      HttpClientRequest.post("https://deploy.example.com/hooks/site").pipe(',
  "        HttpClientRequest.bearerToken(Redacted.value(token)),",
  "        HttpClientRequest.bodyJsonUnsafe({ path: site }),",
  "      ),",
  "    )",
  "  })",
]

export const TEST_TS = [
  'import { expect, it } from "@effect/vitest"',
  'import { Calder, Event } from "@calder-ci/core"',
  'import { Effect } from "effect"',
  'import project from "./ci.ts"',
  "",
  'it.effect("never deploys a pull request", () =>',
  "  Effect.gen(function*() {",
  "    const plan = yield* Calder.plan(project, Event.pullRequest({ number: 7 }))",
  '    expect(plan.steps.map((step) => step.name)).not.toContain("deploy")',
  "  }))",
]

// Inferred types (declaration emit of example/.calder/ci.ts).
export const TYPES = {
  install: { head: "Setup" },
  typecheck: ["void", "TaskFailed", "never", "{}", "never"],
  test: ["void", "TaskFailed", "never", "{}", "never"],
  site: ["StorePath", "BuildFailed", "never", "{}", "never"],
  deploy: ["void", "never", "HttpClient", "{}", '{ readonly secrets: readonly ["deploy-token"] }'],
}

export const TSC = {
  deployInPr: (line34, col) => [
    `.calder/ci.ts(34,${col}): error TS2322: Type 'Step<void, never, HttpClient, {}, { readonly secrets: readonly ["deploy-token"]; }>' is not assignable to type 'Step<any, any, any, any, never>'.`,
    `  Type '{ readonly secrets: readonly ["deploy-token"]; }' is not assignable to type 'never'.`,
  ],
  needsTypecheck: [
    ".calder/ci.ts(29,25): error TS2345: Argument of type 'void' is not assignable to parameter of type 'string & Brand<\"@calder-ci/core/StorePath\">'.",
    "  Type 'void' is not assignable to type 'string'.",
  ],
  commentInPush: [
    `.calder/ci.ts(39,5): error TS2322: Type 'Rule<"trusted", HttpClient | PullRequest>' is not assignable to type 'Rule<"pr", PrBase> | Rule<"trusted", Base>'.`,
    `  Type 'Rule<"trusted", HttpClient | PullRequest>' is not assignable to type 'Rule<"trusted", Base>'.`,
    `    Type 'HttpClient | PullRequest' is not assignable to type 'Base'.`,
    `      Type 'PullRequest' is not assignable to type 'Base'.`,
  ],
  noGrant: [
    `.calder/ci.ts(34,5): error TS2322: Type 'Rule<"trusted", HttpClient | Secret<"deploy-token">>' is not assignable to type 'Rule<"pr", PrBase> | Rule<"trusted", Base>'.`,
    `  Type 'Rule<"trusted", HttpClient | Secret<"deploy-token">>' is not assignable to type 'Rule<"trusted", Base>'.`,
    `    Type 'HttpClient | Secret<"deploy-token">' is not assignable to type 'Base'.`,
    `      Type 'Secret<"deploy-token">' is not assignable to type 'Base'.`,
  ],
  typo: [
    ".calder/ci.ts(22,39): error TS2551: Property 'sit' does not exist on type '{ readonly site: FlakeRef<\"packages\">; }'. Did you mean 'site'?",
  ],
}

export const REFUSAL = 'calder: pull-request runs don\'t run steps with grants or secrets, but "deploy" has them'

const KEYWORDS = new Set(["import", "from", "const", "export", "default", "function", "yield", "as", "type"])
export const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Highlights a line. Only meaning is coloured: `marks` maps an identifier to a class (the value
 * `site`, a service, a grant); `def` is the name a line declares.
 */
export function highlight(text, { def, marks = {}, quiet = false } = {}) {
  const re = /(\/\*.*?\*\/|\/\/.*$)|("(?:[^"\\]|\\.)*")|(`[^`]*`)|(\b\d+\b)|([A-Za-z_$][\w$]*)|(\s+)|([{}()[\],.:;=*<>|])|(.)/g
  let html = ""
  let prev = ""
  let defDone = false
  for (const m of text.matchAll(re)) {
    const [t, com, str, tpl, num, id, ws, pun] = m
    if (com) html += `<span class="t-com">${esc(t)}</span>`
    else if (str || tpl) html += `<span class="t-str">${esc(t)}</span>`
    else if (num) html += `<span class="t-num">${t}</span>`
    else if (id) {
      const property = prev === "."
      if (KEYWORDS.has(id) && !property) html += `<span class="t-kw">${id}</span>`
      else if (def === id && !defDone && !property) {
        html += `<span class="t-def">${id}</span>`
        defDone = true
      } else if (marks[id] && !property) html += `<span class="${marks[id]}">${id}</span>`
      else html += esc(id)
    } else if (ws) html += t
    // Lines may break between tokens, never inside one: before a member access, after an opening
    // bracket or a comma (and at spaces, which pre-wrap allows).
    else if (pun === ".") html += `<wbr><span class="t-pun">.</span>`
    else if (pun && "([{,".includes(pun)) html += `<span class="t-pun">${esc(t)}</span><wbr>`
    else if (pun) html += `<span class="t-pun">${esc(t)}</span>`
    else html += esc(t)
    if (!ws) prev = t
  }
  return quiet ? html.replace(/class="t-(def)"/g, "") : html
}

// What each line of ci.ts declares in the drawing. Keys: part:<name>, f:<feature>, rail:<rule>.
export const CI_LINKS = {
  7: "part:install f:plate",
  11: "f:plate",
  18: "f:plate",
  22: "part:site f:tenon",
  25: "f:socket f:tenon",
  26: "f:after",
  27: "f:bit",
  28: "f:socket",
  29: "f:socket",
  34: "rail:pr",
  35: "rail:push",
}

export const CI_BLOCKS = [
  [7, 7, "part:install", "install, line 7"],
  [9, 14, "part:typecheck", "typecheck, lines 9 to 14"],
  [16, 20, "part:test", "test, lines 16 to 20"],
  [22, 22, "part:site", "site, line 22"],
  [24, 30, "part:deploy", "deploy, lines 24 to 30"],
  [34, 34, "rail:pr", "the pull-request rule, line 34"],
  [35, 35, "rail:push", "the push rule, line 35"],
]

export const CI_DEFS = { 6: "shell", 7: "install", 9: "typecheck", 16: "test", 22: "site", 24: "deploy" }

// Meaning colours in ci.ts: the value `site` where deploy receives it, the grant line.
export const CI_MARKS = {
  25: { site: "t-val" },
  28: { site: "t-val" },
  29: { site: "t-val" },
}
export const CHILDREN = {
  "part:install": ["f:plate"],
  "part:site": ["f:tenon"],
  "part:deploy": ["f:socket", "f:after", "f:bit", "f:pin"],
}

/**
 * A line's leading spaces become its indent, so a wrapped line hangs 4ch inside its own
 * indentation instead of at the left edge.
 */
export const indentOf = (html) => {
  const n = (html ?? "").match(/^ */)[0].length
  return { n, rest: (html ?? "").slice(n), style: n ? ` style="--ind:${n}ch"` : "" }
}

/** One numbered line. `html` is already highlighted. */
export function lineEl(no, html, { link, owner, cls } = {}) {
  const ln = document.createElement("div")
  ln.className = `ln${cls ? " " + cls : ""}`
  ln.dataset.line = no
  if (link) ln.dataset.link = link
  if (owner) ln.dataset.owner = owner
  const { rest, style } = indentOf(html)
  ln.innerHTML = `<span class="no">${no}</span><span class="src"${style}>${rest || " "}</span>`
  return ln
}

/**
 * Tool output, escaped, that breaks only between tokens: a string literal and a hyphenated word stay
 * whole, and a type may break after an opening bracket or a comma.
 */
export const keepWords = (text) =>
  text
    .split(/("[^"]*")/)
    .map((part, i) => {
      if (i % 2) return `<span class="nowrap">${esc(part)}</span>`
      return part
        .split(/(\s+)/)
        .map((w) => (/^\s*$/.test(w) ? w : w.includes("-") ? `<span class="nowrap">${esc(w)}</span>` : esc(w).replace(/(&lt;|[([{,])/g, "$1<wbr>")))
        .join("")
    })
    .join("")

/** One line of tool output, indented by its own leading spaces. */
export const oline = (text, { cls = "", attrs = "", html = null } = {}) => {
  const { n, style } = indentOf(text)
  return `<span class="oline${cls ? ` ${cls}` : ""}"${attrs}${style}>${html ?? keepWords(text.slice(n))}</span>`
}

/** Renders lines `from`..`to` into `container`, grouped into focusable blocks where given. */
export function renderCode(container, lines, opts = {}) {
  const { from = 1, to = lines.length, links = {}, defs = {}, blocks = [], marks = {}, custom = {}, after = {}, cls = {} } = opts
  container.replaceChildren()
  container.classList.add("code")
  let block = null
  for (let no = from; no <= to; no++) {
    const b = blocks.find(([a, z]) => no >= a && no <= z)
    if (b && no === b[0]) {
      block = document.createElement("div")
      block.className = "blk"
      block.tabIndex = 0
      block.dataset.link = b[2]
      block.setAttribute("role", "group")
      block.setAttribute("aria-label", b[3])
      container.append(block)
    }
    const html = custom[no] ?? highlight(lines[no - 1], { def: defs[no], marks: marks[no] })
    const ln = lineEl(no, html, { link: links[no], owner: b ? b[2] : undefined, cls: cls[no] })
    ;(b ? block : container).append(ln)
    if (after[no]) (b ? block : container).append(after[no])
    if (b && no === b[1]) block = null
  }
}

/** Parses `calder plan` output into planned names and which were pulled in. */
export function parsePlan(out) {
  const planned = new Set()
  const pulled = new Set()
  for (const line of out.split("\n").slice(1)) {
    const m = line.match(/^\s+(setup|task|build|action)\s+(\S+)(\s+\(pulled in\))?/)
    if (!m) continue
    planned.add(m[2])
    if (m[3]) pulled.add(m[2])
  }
  return { planned, pulled }
}
