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
  pname = "calder";
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
      pnpm --filter @calder-ci/ui build
    fi
    runHook postBuild
  '';

  # The worker imports each revision's .calder/ci.ts through sdk/node_modules, and that has to resolve to
  # the very modules the worker runs, so the sources ship unbundled with their node_modules.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/calder $out/bin
    cp -a package.json pnpm-workspace.yaml tsconfig.base.json node_modules packages sdk $out/lib/calder/
    # The source's path depends only on its content, so every platform's build of it gets the same id.
    # Twelve characters, because Nix would take the whole hash for a runtime reference to the source.
    basename "$src" | cut -c1-12 > $out/lib/calder/build
    makeWrapper ${lib.getExe bun} $out/bin/calder \
      --add-flags $out/lib/calder/packages/calder/src/main.ts \
      --prefix PATH : ${lib.makeBinPath [ git gnutar bash coreutils ]}
    # The name before the rename, for scripts and habits; remove once nothing calls `kiln`.
    ln -s calder $out/bin/kiln
    runHook postInstall
  '';

  passthru = {
    sdk = "${finalAttrs.finalPackage}/lib/calder/sdk/node_modules";
    ui = "${finalAttrs.finalPackage}/lib/calder/packages/ui/dist";
  };

  meta = {
    description = "CI/CD written in Effect TypeScript, built on Nix";
    mainProgram = "calder";
    platforms = lib.platforms.unix;
  };
})
