# Calder's website

The public page at https://calder.schnau.dev, where the app is at `/app/`. Astro builds it, the flake
packages it as `packages.site`, and the proxy on Calder's host serves the store path at `/`
(`modules/features/calder` in infra). The site is a pnpm project of its own, so its dependencies stay
out of the root workspace, whose `node_modules` ships in Calder's package.

```
pnpm --dir site install
pnpm --dir site dev     # http://localhost:4321, HOST and PORT override it
pnpm --dir site check   # astro sync, then tsc
pnpm --dir site build   # site/dist
nix build .#site        # what the host serves; update its pnpmDeps hash in nix/site.nix with the lockfile
```

Calder's `.calder/ci.ts` checks and builds the site with the rest of Calder. A new site goes live when
infra deploys a new Calder.

The runs in the hero are simulated (`src/wall/`). `model.ts` derives each step's key from the
versions of the files it reads. The build renders the first runs with it, and the browser replays
them and continues. The page shows Calder's `.calder/ci.ts` as it is, and a shortened version of Ebb's
pipeline from `src/samples/`.

What the page says about Calder comes from the README and the design notes in `~/Code/CI-CD-Lab`.
When Calder changes, check the page against them, especially the trust table, the four kinds of step
and the `calder plan` output.
