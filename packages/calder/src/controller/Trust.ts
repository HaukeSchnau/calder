import type { Domain } from "@calder-ci/api";

/**
 * Whether a branch matches a rule name of Gitea's branch protection (`ProtectedBranch.Match` in Gitea's
 * models/git/protected_branch.go, modules/glob/glob.go as of v28.3.0): a name without `*?\[]{}` matches
 * that branch regardless of case, a glob as Gitea compiles it with `/` as the separator. `*` and `?`
 * stop at `/`, `**` doesn't, `[a-z]` and `[!a-z]` are character classes, `{a,b}` is either, `\` escapes
 * the next character. Undefined for a glob Gitea doesn't compile or that this doesn't translate exactly,
 * such as a POSIX class `[[:alpha:]]`, an escape `\d` that Go's regexp reads as a class, or one longer
 * than 255 characters, which could nest deeper than Go's regexp allows.
 */
export const matcher = (rule: string): ((branch: string) => boolean) | undefined => {
  // By code point, as Gitea walks Go's runes.
  const chars = Array.from(rule);

  if (!/[*?\\[\]{}]/.test(rule)) return (branch) => folded(chars, Array.from(branch));

  if (chars.length > 255) return undefined;
  const source = translate(chars);

  if (source === undefined) return undefined;

  try {
    // `s`: Go's `.` stops only at `\n`, JavaScript's also at `\r` and U+2028, which a branch name may hold.
    const regexp = new RegExp(`^${source}$`, "su");

    return (branch) => regexp.test(branch);
  } catch {
    return undefined;
  }
};

/**
 * Whether a plain rule matches a branch as Go's `strings.EqualFold` does, rune by rune. Its folding of
 * other characters than ASCII, such as `ſ` to `s`, JavaScript can't do, so a non-ASCII rune counts as a
 * match, which errs towards a bot's branch.
 */
const folded = (rule: ReadonlyArray<string>, branch: ReadonlyArray<string>) =>
  rule.length === branch.length &&
  rule.every((r, i) => {
    const b = branch[i]!;

    return (
      r === b ||
      !/^[\0-\x7f]$/.test(r) ||
      !/^[\0-\x7f]$/.test(b) ||
      r.toLowerCase() === b.toLowerCase()
    );
  });

// Characters a regexp with the `u` flag reads as syntax outside a character class, and inside one.
const syntax = new Set("^$\\.*+?()[]{}|/");
const classSyntax = new Set("\\]^-[");
const literal = (c: string) => (syntax.has(c) ? `\\${c}` : c);
const classLiteral = (c: string) => (classSyntax.has(c) ? `\\${c}` : c);

// Go's regexp takes `\` only before ASCII punctuation as itself; before a letter or digit it reads a class
// or an assertion, such as `\d` or `\b`, and it refuses any other character.
const escapable = (c: string | undefined): c is string =>
  c !== undefined && /^[!-/:-@[-`{-~]$/.test(c);

/** Gitea's glob compiler, writing a regexp for the `u` flag; undefined where it fails or reads otherwise. */
const translate = (chars: ReadonlyArray<string>) => {
  let pos = 0;
  let out = "";
  let depth = 0;

  while (pos < chars.length) {
    const c = chars[pos++]!;

    if (c === "}" && depth > 0) {
      out += ")";
      depth--;
    } else if (c === "*") {
      if (chars[pos] === "*") {
        pos++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      let body = "";

      // Gitea writes `!` as `^`, and a `^` there as it is, which Go reads as a negation too.
      if (chars[pos] === "!" || chars[pos] === "^") {
        pos++;
        body += "^";
      }

      const start = body.length;

      for (;;) {
        const d = chars[pos++];

        if (d === undefined || d === "[") return undefined;

        if (d === "]") break;

        if (d === "\\") {
          const e = chars[pos++];

          if (!escapable(e)) return undefined;
          body += classLiteral(e);
        } else {
          // A range's `-` stays one; Go and the `u` flag read a leading or trailing one alike.
          body += d === "-" ? "-" : classLiteral(d);
        }
      }

      // Go reads a `]` right after `[` or `[^` as part of the class, Gitea as its end.
      if (body.length === start) return undefined;
      out += `[${body}]`;
    } else if (c === "{") {
      out += "(?:";
      depth++;
    } else if (c === "," && depth > 0) {
      out += "|";
    } else if (c === "\\") {
      const e = chars[pos++];

      if (!escapable(e)) return undefined;
      out += literal(e);
    } else {
      out += literal(c);
    }
  }

  return depth === 0 ? out : undefined;
};

/**
 * Whether a run's code is a bot's, whose branches `untrustedBranches` names as Gitea's branch protection
 * does (`matcher`): Gitea lets the bot push those branches and no other, and lets only trusted users push
 * the rest. A run of a branch one of them matches runs like a fork's pull request: a push's, a pull
 * request's of its head and a closed pull request's of its base, also a manual run's. The default branch
 * is never the bot's. A rule that doesn't parse makes every other branch the bot's, and so does a pull
 * request whose head is no branch of the repository (`head`).
 */
export const untrusted = (
  untrustedBranches: ReadonlyArray<string>,
  event: Domain.Event,
  branch: string,
  defaultBranch: string,
) => {
  if (event._tag === "PullRequest" && event.head.startsWith("refs/")) return true;

  if (branch === defaultBranch) return false;

  return untrustedBranches.some((rule) => matcher(rule)?.(branch) ?? true);
};

/**
 * The head of pull request `number` as Calder judges it: its branch, or Gitea's `refs/pull/<n>/head` when
 * no branch holds it. That is an AGit pull request, which anyone who may open one pushes to
 * `refs/for/<base>/<topic>`. Gitea blanks its `label`, and where a branch is named like the topic, its
 * list of pull requests gives that branch as `ref` beside the pull request's own `sha`.
 */
export const head = (
  number: number,
  given: { readonly ref?: string | undefined; readonly label?: string | undefined } | undefined,
) =>
  given?.ref === undefined || given.label === undefined || given.label === ""
    ? `refs/pull/${number}/head`
    : given.ref;
