# Node and pnpm from nix-infra-modules, shared by the dev shell and the package. Calder itself runs on Bun.
{ pkgs, sdk }: import "${sdk}/lib/toolchain.nix" { inherit pkgs; } // { inherit (pkgs) bun; }
