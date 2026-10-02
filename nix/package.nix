{
  lib,
  stdenvNoCC,
  bun,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  git,
  gnutar,
  bash,
  coreutils,
}:
let
  root = ../.;
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.difference (lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.base.json
      ../packages
      ../sdk
    ]) (lib.fileset.fileFilter (f: f.name == "node_modules" || f.hasExt "png") root);
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "kiln";
  version = "0.1.0";
  inherit src;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-BxlSZpau2iOy4cxC5glTxsLV2K7uN1WBCs63ZukrNLQ=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild
    if [ -f packages/ui/package.json ]; then
      pnpm --filter @kiln/ui build
    fi
    runHook postBuild
  '';

  # The worker imports each revision's .kiln/ci.ts through sdk/node_modules, and that has to resolve to
  # the very modules the worker runs, so the sources ship unbundled with their node_modules.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/kiln $out/bin
    cp -a package.json pnpm-workspace.yaml tsconfig.base.json node_modules packages sdk $out/lib/kiln/
    makeWrapper ${lib.getExe bun} $out/bin/kiln \
      --add-flags $out/lib/kiln/packages/kiln/src/main.ts \
      --prefix PATH : ${lib.makeBinPath [ git gnutar bash coreutils ]}
    runHook postInstall
  '';

  passthru = {
    sdk = "${placeholder "out"}/lib/kiln/sdk/node_modules";
    ui = "${placeholder "out"}/lib/kiln/packages/ui/dist";
  };

  meta = {
    description = "CI/CD written in Effect TypeScript, built on Nix";
    mainProgram = "kiln";
    platforms = lib.platforms.unix;
  };
})
