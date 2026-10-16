import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

const productionStage = "prod"

const headers = `
/*
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`

/**
 * The website, built by Astro and served by Cloudflare's asset layer without a script. Production
 * answers at kiln-ci.schnau.dev, because kiln.schnau.dev is the controller's UI on the Tailnet. Any
 * other stage, such as pr-42, is a Worker Preview of production at
 * https://pr-42-kiln-site.hauke-911.workers.dev.
 */
export default Alchemy.Stack(
  "KilnSite",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const site = yield* Cloudflare.Website.StaticSite("Site", {
      command: "pnpm build",
      outdir: "dist",
      memo: false,
      compatibility: { date: "2026-10-01" },
      assets: { headers, notFoundHandling: "404-page" },
      ...(stage === productionStage
        ? { name: "kiln-site", workersDev: { enabled: false, previewsEnabled: true }, domain: "kiln-ci.schnau.dev" }
        : { preview: { of: yield* Cloudflare.Worker.ref("Site", { stage: productionStage }) } }),
    })
    return { url: site.url }
  }),
)
