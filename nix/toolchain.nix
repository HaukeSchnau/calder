# Node and pnpm from projects-sdk, shared by the dev shell and the package. Calder itself runs on Bun.
{ pkgs, sdk }: import "${sdk}/lib/toolchain.nix" { inherit pkgs; } // { inherit (pkgs) bun; }
