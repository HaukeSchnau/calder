import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://calder.schnau.dev",
  // A preview of the site under a path, such as /calder-site/d/ on files.schnau.dev.
  base: process.env["SITE_BASE"] ?? "/",
  build: { inlineStylesheets: "always" },
  server: { host: process.env["HOST"] ?? "localhost", port: Number(process.env["PORT"] ?? 4321) },
})
