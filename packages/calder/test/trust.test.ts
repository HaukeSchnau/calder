import type { Domain } from "@calder-ci/api";
import { describe, expect, it } from "@effect/vitest";
import { head, matcher, untrusted } from "../src/controller/Trust.ts";

describe("a rule of Gitea's branch protection", () => {
  // As Gitea v28.3.0 matches them (models/git/protected_branch.go `Match`).
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ["renovate/**", "renovate/toolchain", true],
    ["renovate/**", "renovate/a/b", true],
    ["renovate/**", "renovate/", true],
    ["renovate/**", "renovate", false],
    ["renovate/**", "Renovate/toolchain", false],
    ["renovate/**", "feature/renovate/toolchain", false],
    ["renovate/*", "renovate/toolchain", true],
    ["renovate/*", "renovate/a/b", false],
    ["**", "feature/x", true],
    ["*", "feature/x", false],
    ["renovate/?", "renovate/a", true],
    ["renovate/?", "renovate//", false],
    ["{renovate,deps}/**", "deps/x", true],
    ["{renovate,deps}/**", "other/x", false],
    ["a,b", "a,b", true],
    ["[a-c]x", "bx", true],
    ["[!a-c]x", "bx", false],
    ["[^a-c]x", "dx", true],
    ["[^a-c]x", "^x", true],
    ["[!^]x", "^x", false],
    ["\\*", "*", true],
    ["\\*", "a", false],
    ["a.b", "axb", false],
    ["a+", "aa", false],
    ["a}", "a}", true],
    ["[a-]]", "-]", true],
    ["renovate/**", "renovate/a\u2028b", true],
    ["main", "MAIN", true],
    ["main", "main2", false],
    // Go's strings.EqualFold folds ſ to s.
    ["deps", "dep\u017f", true],
    ["deps", "dep", false],
    ["release-1.0", "release-1x0", false],
  ];

  for (const [rule, branch, matches] of cases) {
    it(`${rule} ${matches ? "matches" : "doesn't match"} ${JSON.stringify(branch)}`, () => {
      expect(matcher(rule)?.(branch)).toBe(matches);
    });
  }

  // Gitea matches these literally, or as Go's regexp reads them, which a JavaScript regexp may not.
  for (const rule of [
    "renovate/[",
    "{renovate/**",
    "a\\",
    "\\d",
    "\\é",
    "[[:alpha:]]",
    "[]a]",
    "[z-a]",
  ]) {
    it(`${rule} doesn't parse`, () => {
      expect(matcher(rule)).toBeUndefined();
    });
  }

  it("doesn't parse beyond 255 characters, which Go's regexp may nest too deep to compile", () => {
    expect(matcher(`${"{".repeat(300)}a${"}".repeat(300)}`)).toBeUndefined();
    expect(matcher(`${"{".repeat(100)}a${"}".repeat(100)}`)?.("a")).toBe(true);
  });
});

describe("a run's code is a bot's", () => {
  const bot = ["renovate/**"];
  const push = (branch: string): Domain.Event => ({ _tag: "Push", branch });

  const pull = (head: string): Domain.Event => ({
    _tag: "PullRequest",
    number: 7,
    base: "main",
    head,
    fork: false,
  });

  it("when a rule matches its branch", () => {
    expect(untrusted(bot, push("renovate/toolchain"), "renovate/toolchain", "main")).toBe(true);
    expect(untrusted(bot, push("feature"), "feature", "main")).toBe(false);
  });

  it("but never on the default branch", () => {
    expect(untrusted(["**"], push("main"), "main", "main")).toBe(false);
    expect(untrusted(["**"], push("feature"), "feature", "main")).toBe(true);
  });

  it("and on any other branch when a rule doesn't parse", () => {
    expect(untrusted(["renovate/["], push("feature"), "feature", "main")).toBe(true);
    expect(untrusted(["renovate/["], push("main"), "main", "main")).toBe(false);
  });

  it("when a pull request's head is no branch, as with Gitea's AGit flow", () => {
    expect(untrusted([], pull("refs/pull/7/head"), "refs/pull/7/head", "main")).toBe(true);
    expect(untrusted([], pull("feature"), "feature", "main")).toBe(false);
  });
});

describe("a pull request's head", () => {
  it("is its branch, or its ref when Gitea blanks the label, as for an AGit pull request", () => {
    expect(head(7, { ref: "feature", label: "feature" })).toBe("feature");
    expect(head(7, { ref: "feature", label: "" })).toBe("refs/pull/7/head");
    expect(head(7, { ref: "feature" })).toBe("refs/pull/7/head");
    expect(head(7, undefined)).toBe("refs/pull/7/head");
  });
});
