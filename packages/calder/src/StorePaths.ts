/**
 * Store paths that go to Nix commands as arguments. What an evaluation reports for an attribute is
 * whatever the flake's Nix made `drvPath` and `outPath`, so a pull request's flake could report
 * `--plugin-files` and have a Nix command load its code. `nix` takes `--` before them; `nix-store` reads
 * an argument that starts with `-` as an option even after `--`, so it gets only absolute paths (`only`).
 */
export const storeDrv = /^\/nix\/store\/[0-9a-z]{32}-[^/\s]+\.drv$/
export const storePath = /^\/nix\/store\/[0-9a-z]{32}-[^/\s]+$/

/** `paths` that are absolute, which no Nix command reads as an option. */
export const only = (paths: ReadonlyArray<string>) => paths.filter((p) => p.startsWith("/"))

/** Why a reported derivation isn't one, or null. */
export const malformed = (d: { readonly drv: unknown; readonly out: unknown; readonly system: unknown }): string | null =>
  typeof d.drv !== "string" || !storeDrv.test(d.drv) ? `its drvPath ${JSON.stringify(d.drv)} isn't a derivation in the store`
  : typeof d.out !== "string" || !storePath.test(d.out) ? `its outPath ${JSON.stringify(d.out)} isn't a path in the store`
  : typeof d.system !== "string" || !/^[A-Za-z0-9_-]+$/.test(d.system) ? `its system ${JSON.stringify(d.system)} isn't a system`
  : null
