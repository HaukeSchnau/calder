# Kiln's website

The public page at https://kiln-ci.schnau.dev. kiln.schnau.dev is the controller's UI on the
Tailnet. Astro builds one static page, and Cloudflare serves it from `alchemy.run.ts`. The site is a
pnpm project of its own, so its dependencies stay out of the root workspace, whose `node_modules`
ships in Kiln's package.

```
pnpm --dir site install
pnpm --dir site dev     # http://localhost:4321, HOST and PORT override it
pnpm --dir site check   # astro sync, then tsc
pnpm --dir site build   # site/dist
```

Kiln's `.kiln/ci.ts` checks the site with the rest of Kiln. Pull requests deploy a preview at
`https://pr-<n>-kiln-site.hauke-911.workers.dev`, closing one removes it, and pushes to main deploy
production once every check passed. The project's `cloudflare` secret is the dotenv file of
Cloudflare credentials Alchemy reads; infra grants it in `hosts/srv-2/kiln.nix`.

The runs in the hero are simulated (`src/wall/`). `model.ts` derives each step's key from the
versions of the files it reads. The build renders the first runs with it, and the browser replays
them and continues. The page shows Kiln's `.kiln/ci.ts` as it is, and a shortened version of Ebb's
pipeline from `src/samples/`.

What the page says about Kiln comes from the README and the design notes in `~/Code/CI-CD-Lab`.
When Kiln changes, check the page against them, especially the trust table, the four kinds of step
and the `kiln plan` output.
