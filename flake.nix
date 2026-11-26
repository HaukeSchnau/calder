{
  description = "Calder: CI/CD written in Effect TypeScript, built on Nix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    projects-sdk = {
      url = "github:HaukeSchnau/projects-sdk/v0.1.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      projects-sdk,
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      toolchain = pkgs: import ./nix/toolchain.nix { inherit pkgs; sdk = projects-sdk; };
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
