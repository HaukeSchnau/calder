import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://kiln-ci.schnau.dev",
  build: { inlineStylesheets: "always" },
  server: { host: process.env["HOST"] ?? "localhost", port: Number(process.env["PORT"] ?? 4321) },
})
