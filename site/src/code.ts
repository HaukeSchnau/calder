import type { Code } from "astro:components"
import type { ComponentProps } from "astro/types"

/** Code as it reads in an editor on a light page: names in ink, the language's own words a step back. */
export const theme = {
  name: "calder-light",
  type: "light",
  colors: { "editor.background": "#ffffff", "editor.foreground": "#15171c" },
  settings: [
    { settings: { foreground: "#15171c", background: "#ffffff" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8a8f98", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.operator.new", "keyword.control"], settings: { foreground: "#7b808a" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#9aa0a8" } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: "#1f6f55" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#1f6f55" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#15171c" } },
    { scope: ["variable.other.object", "entity.name.type", "support.type", "support.class"], settings: { foreground: "#15171c" } },
  ],
} satisfies ComponentProps<typeof Code>["theme"]
