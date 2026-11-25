import { antipattern, correctness, style } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

const errors = (rules: ReadonlyArray<string>) =>
  Object.fromEntries(rules.map((rule): [string, "error"] => [rule, "error"]));

const effectRules = [correctness, antipattern, style].flatMap((preset) =>
  Object.keys(preset.rules ?? {}),
);

// Vendored as upstream wrote it, so the next re-vendor is a plain copy. Upstream lints and tests it.
const antiSlop = "tools/oxlint/anti-slop/**";

// A made-up repository the website shows verbatim (site/js/source.js), with its own lockfile.
const example = "site/example/**";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      antiSlop,
      example,
      // Written by site/scripts/plans.py.
      "site/js/plans.js",
      // Written by `calder gen`, which writes them again whenever the flake's outputs change.
      ".calder/flake.ts",
      ".calder/tsconfig.json",
      // The website's pages, laid out by hand and served as they are. Reflowing them would move the
      // whitespace between inline elements, which the browser renders.
      "site/*.html",
    ],
    sortPackageJson: {},
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
  lint: {
    ignorePatterns: [
      antiSlop,
      example,
      // Calder's own ci.ts, which compiles against sdk/tsconfig through the .calder/node_modules
      // that `calder gen` links.
      ".calder/**",
    ],
    plugins: ["effecttsgo", "eslint", "oxc", "typescript", "unicorn"],
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    categories: {
      correctness: "error",
      perf: "error",
      suspicious: "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      ...errors(effectRules),

      "eslint/eqeqeq": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-explicit-any": "error",
      "unicorn/prefer-node-protocol": "error",

      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",

      // Every Effect 4 module Calder builds on (rpc, http, sql, process, cli) is marked unstable.
      // 755 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unstable-api-usage.md
      "effecttsgo/unstable-api-usage": "off",

      // Truthiness checks on optional strings, numbers and nodes, most of them in the UI (477) and
      // the website (278). Rewriting each as an explicit comparison is a refactor of its own. 839
      // findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-boolean-expressions.md
      "effecttsgo/strict-boolean-expressions": "off",

      // Effect's tagged unions and Calder's own plans, events and results expose `_tag`. 337 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-underscore-dangle.html
      "eslint/no-underscore-dangle": "off",

      // Calder's plans, events, results and reports are plain `_tag` data that crosses the worker
      // protocol and the journal as JSON, not Schema or Data classes. 305 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/effect/rules/no-manual-tagged-construction.ts
      "anti-slop-effect/no-manual-tagged-construction": "off",

      // A `switch` on `_tag` narrows each case, and `never` in its default makes it exhaustive
      // without a runtime `Match` call. 274 and 20 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/effect/rules/no-manual-tag-comparison.ts
      "anti-slop-effect/no-manual-tag-comparison": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/effect/rules/prefer-effect-match.ts
      "anti-slop-effect/prefer-effect-match": "off",

      // Index lookups, regex groups and map reads the code has already checked, 201 of them in src.
      // Each needs a check or an Option in its place. 310 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-non-null-assertion.html
      "typescript/no-non-null-assertion": "off",

      // The casts are decoded JSON, test fakes and the worker's step values. Replacing them with
      // schemas or narrowing is a refactor of its own: 172 unsafe assertions, 49 chained through
      // `unknown` (43 in tests), and 267 without a safety comment.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-type-assertion.html
      "typescript/no-unsafe-type-assertion": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-chained-type-assertions.ts
      "anti-slop/no-chained-type-assertions": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/require-safety-comment-for-type-assertion.ts
      "anti-slop/require-safety-comment-for-type-assertion": "off",

      // It treats every exported fixed-arity function as an Effect-style `self` API and asks for
      // dual overloads. 205 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-pipeable-signature.md
      "effecttsgo/missing-pipeable-signature": "off",

      // It can't tell an entry point or a test from library code. 146 findings, 132 in tests.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-effect-provide.md
      "effecttsgo/strict-effect-provide": "off",

      // `unknown` errors come from the platform's process, file and socket calls, and in tests from
      // Effects that run as promises. Typing them needs an error of their own per call. 135
      // findings, 116 in tests.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/any-unknown-in-error-context.md
      "effecttsgo/any-unknown-in-error-context": "off",

      // Reusing a precise name in a nested callback reads better, and TypeScript resolves the scopes.
      // 134 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-shadow.html
      "eslint/no-shadow": "off",

      // exactOptionalPropertyTypes (tsconfig.base.json) rejects an explicit `undefined`, so an
      // optional field is spread in only when it is set. 130 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-conditional-empty-object-spread.ts
      "anti-slop/no-conditional-empty-object-spread": "off",

      // Switching the API's and the journal's numbers to `Schema.Finite` changes what they decode,
      // so it waits for a pass of its own. 114 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-number.md
      "effecttsgo/schema-number": "off",

      // A small helper beside its only caller reads better than one hoisted for a tiny allocation.
      // 101 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/consistent-function-scoping.html
      "unicorn/consistent-function-scoping": "off",

      // The worker's values, the CLI's arguments and the UI's JSON take strings, numbers or
      // objects and tell them apart with `typeof`. 73 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-runtime-typeof.ts
      "anti-slop/no-runtime-typeof": "off",

      // It misreads Effect generators whose terminal branches yield errors; `noImplicitReturns`
      // covers missing returns. 62 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-return.html
      "typescript/consistent-return": "off",

      // A shape is part of the domain in the UI and the website: the outline of a step's part in
      // the drawing (50 of 55 findings). `ConfigShape` is `Context.Service`'s shape.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-shape-in-symbol-names.ts
      "anti-slop/no-shape-in-symbol-names": "off",

      // The flagged values are boundaries: JSON a step returns or a worker reads, values encoded for
      // the journal, and a decoder's input. 29, 23, 21 and 10 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-known-value-widening.ts
      "anti-slop/no-known-value-widening": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-unsafe-dictionary-type.ts
      "anti-slop/no-unsafe-dictionary-type": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-unknown-parameters.ts
      "anti-slop/no-unknown-parameters": "off",
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-unknown-returns.ts
      "anti-slop/no-unknown-returns": "off",

      // A service key is the string Effect looks a service up by. Renaming the 26 findings to the
      // file path is churn without a bug behind it.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/deterministic-keys.md
      "effecttsgo/deterministic-keys": "off",

      // Small immutable updates read better as spreads than as mutation. 20 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-map-spread.html
      "oxc/no-map-spread": "off",

      // 192 of the 213 findings are tests that hand a yielded value straight to `expect`.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/yield-in-call-argument.md
      "effecttsgo/yield-in-call-argument": "off",

      // Nested calls such as `Schema.optional(Schema.String)` read as well as their pipe form, and
      // the rule has no autofix. 53 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missed-pipeable-opportunity.md
      "effecttsgo/missed-pipeable-opportunity": "off",

      // Each of the 51 `forEach` and `all` calls needs its concurrency decided, mostly in the
      // controller, where the order of journal writes and Gitea calls matters.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-concurrency-option.md
      "effecttsgo/missing-concurrency-option": "off",

      // A cast it calls unnecessary still steers the inference of the generic call around it:
      // removing all 32, as its autofix does, broke 76 type checks, most in the worker's Resolve.ts.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-type-assertion.html
      "typescript/no-unnecessary-type-assertion": "off",

      // The 14 calls are the controller's output roots and the worker's transfers, whose callers
      // log the failure or let it die. A typed error for each is a pass of its own.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-try-without-catch.md
      "effecttsgo/effect-try-without-catch": "off",

      // Iterator helpers would fit, but each of the 32 chains needs its callbacks' index and array
      // arguments checked by hand.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-array-filter-map.ts
      "anti-slop/no-array-filter-map": "off",

      // The 6 regexes match terminal escapes and NUL bytes in logs and paths on purpose.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-control-regex.html
      "eslint/no-control-regex": "off",

      // `then` is Environments' option for what runs after a deploy, which every ci.ts names. 3
      // findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-thenable.html
      "unicorn/no-thenable": "off",

      // The CLI's commands fail with plain Errors, which main.ts prints before it exits. 9 findings,
      // 3 of them in tests.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-error-in-effect-failure.md
      "effecttsgo/global-error-in-effect-failure": "off",

      // Default sorts of `[key, value]` entries order what Calder hashes into task keys. A
      // comparator that orders any pair differently changes those keys and drops every cached
      // result. 9 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/require-array-sort-compare.html
      "typescript/require-array-sort-compare": "off",

      // Fields of JSON lines from Nix and Bun, and errors in log messages, which `String()` and
      // template literals print as they come. 7 and 4 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-base-to-string.html
      "typescript/no-base-to-string": "off",
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/restrict-template-expressions.html
      "typescript/restrict-template-expressions": "off",

      // Each of the 3 loops ends when something else in its condition changes: a map of running
      // builds, a directory walked upwards, a file another process writes.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unmodified-loop-condition.html
      "eslint/no-unmodified-loop-condition": "off",

      // Sequential awaits are deliberate: the egress proxy tries a host's addresses in turn, and a
      // test host polls for a file. 2 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-await-in-loop.html
      "eslint/no-await-in-loop": "off",

      // Callbacks that Bun or a Worker calls outside any fiber log or reset state through
      // `Effect.runFork`. 2 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/run-effect-inside-effect.md
      "effecttsgo/run-effect-inside-effect": "off",

      // The 4 catch errors whose tags and reasons span several error types at once, such as every
      // failure of a flake's evaluation but TooLarge, which `catchTag` can't name.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/effect/rules/no-manual-effect-error-tag.ts
      "anti-slop-effect/no-manual-effect-error-tag": "off",

      // Resolve.ts's nested generator returns early, so it can't be inlined. 1 finding, and 1 of
      // `try`/`catch` around the lock file's exclusive create, which retries on EEXIST, and 1 of a
      // `catch` that keeps the parse error as it is for the step's message.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/nested-effect-gen-yield.md
      "effecttsgo/nested-effect-gen-yield": "off",
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/try-catch-in-effect-gen.md
      "effecttsgo/try-catch-in-effect-gen": "off",
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unknown-in-effect-catch.md
      "effecttsgo/unknown-in-effect-catch": "off",
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-pipe-chain.md
      "effecttsgo/unnecessary-pipe-chain": "off",

      // `stopped` checks for a key across the union of a job's outcomes, and a test fixture prints
      // whatever JSON it is given. 2 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-object-parameters.ts
      "anti-slop/no-object-parameters": "off",

      // It flags a Worker's `postMessage`, which takes no target origin. 1 finding.
      // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/require-post-message-target-origin.html
      "unicorn/require-post-message-target-origin": "off",

      // Taking a field out by destructuring the rest (`({ tag: _, ...rest }) => rest`) is the point.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html
      "eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],

      // `Web.verify` returns the payload its signature vouches for, typed by its caller
      // (`verify<Session>`), and `manual`'s overload keeps its inputs' literal type. 2 findings, and
      // 2 in core/test/types.ts, where `Equal`'s type parameters compare types exactly.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-type-parameters.html
      "typescript/no-unnecessary-type-parameters": "off",

      // Catchup's `make` returns the sweep for the layer to run on a schedule, and tests return the
      // Effect the harness runs once a run reaches it. 1 finding and 4 in tests.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/return-effect-in-gen.md
      "effecttsgo/return-effect-in-gen": "off",

      // A brand changes the error classes' types, and the worker protocol builds them from JSON.
      // 13 findings.
      // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-class-missing-brand.md
      "effecttsgo/schema-class-missing-brand": "off",
    },
    overrides: [
      {
        // `Step<any, any, any, any, any>` stands for every step, and conditional types `infer` one
        // parameter against it. `unknown` or `never` there fails on the parameters' variance. 109
        // findings.
        // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-explicit-any.html
        files: ["packages/core/src/**", "packages/std/src/**"],
        rules: { "typescript/no-explicit-any": "off" },
      },
      {
        // The worker runs each project's own steps and layer, whose error and service types it
        // can't know, and so does a test that runs a planned step's body. 2 and 1 findings.
        // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unsafe-effect-type-assertion.md
        files: ["packages/calder/src/worker/Steps.ts", "packages/std/test/project.test.ts"],
        rules: { "effecttsgo/unsafe-effect-type-assertion": "off" },
      },
      {
        // Vite's default build target still includes browsers without `toSorted` and `toReversed`
        // (Firefox before 115), and the website ships as it is. The UI and the website sort fresh
        // arrays in place.
        // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/no-array-sort.html
        files: ["packages/ui/src/**", "site/**"],
        rules: { "unicorn/no-array-sort": "off", "unicorn/no-array-reverse": "off" },
      },
      {
        files: ["packages/*/test/**"],
        rules: {
          // An Action's body is a generator even when it yields nothing, and core/test/types.ts
          // holds statements that exist for the type errors they produce. 3 and 1 findings.
          // https://oxc.rs/docs/guide/usage/linter/rules/eslint/require-yield.html
          "eslint/require-yield": "off",
          // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-expressions.html
          "eslint/no-unused-expressions": "off",
          // A stub service method dies when called. 1 finding.
          // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/lazy-effect.md
          "effecttsgo/lazy-effect": "off",
          // The second provide supplies the capture layer to the first one's construction. 1
          // finding.
          // https://github.com/Effect-TS/tsgo/blob/main/docs/rules/multiple-effect-provide.md
          "effecttsgo/multiple-effect-provide": "off",
        },
      },
    ],
  },
});
