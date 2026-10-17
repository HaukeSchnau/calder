{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
}:
let
  root = ../.;
  # The page shows Calder's own pipeline, so the build reads .calder/ci.ts next to site/.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference (lib.fileset.unions [
      ../site
      ../.calder/ci.ts
    ]) (lib.fileset.fileFilter (f: f.name == "node_modules" || f.name == "dist" || f.name == ".astro") root);
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "calder-site";
  version = "0.1.0";
  inherit src;

  pnpmRoot = "site";
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version;
    src = lib.fileset.toSource {
      root = ../site;
      fileset = lib.fileset.unions [
        ../site/package.json
        ../site/pnpm-lock.yaml
        ../site/pnpm-workspace.yaml
      ];
    };
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-nq2Y1V2euGXcaAX732+Hzm4IQbWbtsCK4xbiDMzvi1c=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
  ];

  env.ASTRO_TELEMETRY_DISABLED = "1";

  buildPhase = ''
    runHook preBuild
    pnpm --dir site build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r site/dist $out
    runHook postInstall
  '';

  meta.description = "Calder's website, which the proxy in front of the controller serves at /";
})
