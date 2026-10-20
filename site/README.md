# Calder's website

The page at https://calder.schnau.dev, where the app is at `/app/`. It is plain HTML, CSS and
JavaScript modules with no build step. The flake packages the public files as `packages.site`
(`nix/site.nix`), and the proxy on Calder's host serves that store path at `/`
(`modules/features/calder` in infra). A new site goes live when infra deploys a new Calder.

```
python3 -m http.server -d site 8000   # then open http://localhost:8000
nix build .#site                      # what the host serves
```

Everything the page says about Calder is real output on `site/example`, a small made-up repository:

- `js/source.js` holds its `.calder/ci.ts` and `.calder/deploy.ts` verbatim.
- `js/plans.js` is what tsc and `calder plan` say for every arrangement of the hero's parts.
  `python3 -I site/scripts/plans.py` (from the repository root, after `pnpm install`) writes it
  again with this checkout's Calder. Run it when Calder's error or plan output changes.
- The fits edit the example in place and show fixed outputs (`TSC` and `REFUSAL` in
  `js/source.js`, the comment plan in `js/sections.js`). Those need the same check by hand.
