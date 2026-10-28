{
  description = "Calder: CI/CD written in Effect TypeScript, built on Nix";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        calder = pkgs.callPackage ./nix/package.nix { };
        site = pkgs.callPackage ./nix/site.nix { };
        default = calder;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs_24
            pkgs.pnpm_11
            pkgs.git
            # calder check's tests run it against a jj workspace.
            pkgs.jujutsu
          ];
        };
      });

      checks = forAll (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.calder;
        site = self.packages.${pkgs.stdenv.hostPlatform.system}.site;
      });
    };
}
