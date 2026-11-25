{
  lib,
  stdenvNoCC,
  toolchain,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  git,
  gnutar,
  bash,
  coreutils,
  strace,
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
    inherit (toolchain) pnpm;
    fetcherVersion = 4;
    hash = "sha256-kocAx6CtHUt5yzZR78oDeBn8sWgTHKbudKuO7PGpKMs=";
  };

  nativeBuildInputs = [
    toolchain.nodejs
    toolchain.pnpm
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
    # Vite+, tsrs and the UI's build tools stay out of the package, which needs only what Calder runs with.
    # That includes @schnau/tsconfig, which tsconfig.base.json extends: none of its options change how Bun runs the sources.
    pnpm install --offline --prod --frozen-lockfile --ignore-scripts --config.modules-cache-max-age=0
    mkdir -p $out/lib/calder $out/bin
    cp -a package.json pnpm-workspace.yaml tsconfig.base.json node_modules packages sdk $out/lib/calder/
    # The source's path depends only on its content, so every platform's build of it gets the same id.
    # Twelve characters, because Nix would take the whole hash for a runtime reference to the source.
    basename "$src" | cut -c1-12 > $out/lib/calder/build
    makeWrapper ${lib.getExe toolchain.bun} $out/bin/calder \
      --add-flags $out/lib/calder/packages/calder/src/main.ts \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            git
            gnutar
            bash
            coreutils
          ]
          # Plans record what Nix read of a flake through it (worker/Footprint.ts).
          ++ lib.optional stdenvNoCC.hostPlatform.isLinux strace
        )
      }
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
