{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }: let pkgs = nixpkgs.legacyPackages.aarch64-linux; in {
    packages.aarch64-linux.site = pkgs.runCommand "site" { src = ./apps/web; } "cp -r $src $out";
    devShells.aarch64-linux.default = pkgs.mkShellNoCC { packages = [ pkgs.nodejs_24 pkgs.pnpm_11 ]; };
  };
}
