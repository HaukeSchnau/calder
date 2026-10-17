import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://calder.schnau.dev",
  build: { inlineStylesheets: "always" },
  server: { host: process.env["HOST"] ?? "localhost", port: Number(process.env["PORT"] ?? 4321) },
})
