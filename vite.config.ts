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
      "typescript/no-non-null-assertion": "error",
      "unicorn/prefer-node-protocol": "error",

      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
  },
});
