{
  description = "Calder: CI/CD written in Effect TypeScript, built on Nix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-infra-modules = {
      url = "github:HaukeSchnau/nix-infra-modules/b365d13637b9dc83c397df542b5112a50ac8cbb9";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-infra-modules,
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      toolchain = pkgs: import ./nix/toolchain.nix { inherit pkgs; sdk = nix-infra-modules; };
    in
    {
      packages = forAll (pkgs: rec {
        calder = pkgs.callPackage ./nix/package.nix { toolchain = toolchain pkgs; };
        site = pkgs.callPackage ./nix/site.nix { };
        default = calder;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = builtins.attrValues (toolchain pkgs) ++ [
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
