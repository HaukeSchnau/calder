import type { Code } from "astro:components"
import type { ComponentProps } from "astro/types"

/** Code on the firebox: Kiln's UI colours, with glazes for strings, calls and types. */
export const theme = {
  name: "firebox",
  type: "dark",
  colors: { "editor.background": "#17181c", "editor.foreground": "#e8e6e1" },
  settings: [
    { settings: { foreground: "#e8e6e1", background: "#17181c" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8a8a84" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.operator.new"], settings: { foreground: "#a7a6a0" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#82827c" } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: "#8fc1a9" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#e7c9a0" } },
    { scope: ["entity.name.type", "support.type", "support.class", "entity.name.class", "variable.other.object"], settings: { foreground: "#86a8e7" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#c7a0d9" } },
    { scope: ["variable.parameter"], settings: { foreground: "#ddd3bf" } },
  ],
} satisfies ComponentProps<typeof Code>["theme"]
