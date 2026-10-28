import { cmd, Files, type Flake, Secret, type Setup, type Step, Task } from "@calder-ci/core"
import { Schema } from "effect"

/**
 * Releases of an Expo app: its runtime versions, over-the-air updates through EAS Update, TestFlight
 * and Google Play's internal track. Each is a step, so a pipeline puts them where it wants:
 *
 * ```ts
 * const ios = Expo.runtimeVersion("ios", { shell, setup: install })
 * const android = Expo.runtimeVersion("android", { shell, setup: install })
 * const update = Expo.exportUpdate({ platform: "x86_64-linux", shell, setup: towerInstall, after: checks })
 * const ota = Expo.publishUpdate({ shell, setup: install, update, channel: "production", token: "expo-token", runtimes: { ios, android } })
 * const testflight = Expo.testflight({ platform: "aarch64-darwin", runtime: ios, appId: "6818526671", appStoreConnect })
 * const play = Expo.playInternal({ platform: "x86_64-linux", shell, runtime: android, keystore, password, serviceAccount })
 * ```
 *
 * The app's runtime version policy is `fingerprint`: Expo's hash of its native code, which store
 * builds embed and updates are published to. The store builds interpolate it and read no other files,
 * so Calder keys them by it: a push that changes only JavaScript reuses the last builds and reaches
 * phones as an update alone. The app's fingerprint config should hash `version` and leave build
 * numbers out (`sourceSkips: ["ExpoConfigVersions"]` plus the version as an extra source), since every
 * store build stamps its own. The app config takes them from the environment:
 *
 * ```ts
 * ios: { ...config.ios, buildNumber: process.env.IOS_BUILD_NUMBER ?? config.ios?.buildNumber },
 * android: { ...config.android, versionCode: Number(process.env.ANDROID_VERSION_CODE) || config.android?.versionCode },
 * ```
 *
 * Updates export on x86_64, where React Native's hermesc runs on Linux too, or on a Mac. The steps
 * install with pnpm.
 */

/** Where a step runs: an agent of `platform`, the controller's by default, in the dev shell `shell`. */
export interface Host {
  readonly platform?: Step.Platform
  /** The dev shell with node and pnpm. Without one the step runs with the host's PATH. */
  readonly shell?: Flake.FlakeRef<"devShells">
}

export interface AppOptions extends Host {
  /** The app's directory, relative to the repository root. The root by default. */
  readonly dir?: string
  /** The step's name. Each function has its own default. */
  readonly name?: string
  /** Steps that must pass first, such as the checks. */
  readonly after?: ReadonlyArray<Step.Any>
  /**
   * Plain environment variables the app config or the JavaScript reads, such as `EXPO_PUBLIC_API_URL`.
   * Give an update's export and its store builds the same ones.
   */
  readonly env?: { readonly [name: string]: string }
}

export interface InstalledOptions extends AppOptions {
  /** The app's dependencies, installed on the step's platform: `Pnpm.install` with the same `platform`. */
  readonly setup: Setup.Setup
}

/** A runtime version: the value of `runtimeVersion`, which the release steps interpolate. */
export type Runtime = Step.Step<string, unknown, never, unknown, unknown>

/** eas-cli, pinned so that a new release can't change how updates publish. */
const easCli = "eas-cli@25.3.0"

const hostOf = (options: Host) => ({
  ...(options.platform === undefined ? {} : { platform: options.platform }),
  ...(options.shell === undefined ? {} : { shell: options.shell }),
})

const inDir = (dir: string, path: string) => (dir === "." ? path : `${dir}/${path}`)

/** Enters the app's directory `$1` with the app's own binaries first on PATH, as in a package script. */
const enter = `cd "$1"
PATH="$PWD/node_modules/.bin:$PATH"`

/** `runtime <platform>` prints the app's runtime version, as expo-updates resolves it. */
const runtimeFunction = `runtime() {
  expo-updates runtimeversion:resolve --platform "$1" | node -e '
    const { runtimeVersion } = JSON.parse(require("fs").readFileSync(0, "utf8"))
    if (typeof runtimeVersion !== "string") {
      console.error("the app has no " + process.argv[1] + " runtime version: set runtimeVersion in its Expo config")
      process.exit(1)
    }
    console.log(runtimeVersion)' "$1"
}`

/** `field <path>` prints a field of the app's public Expo config, such as `ios.appleTeamId`. */
const fieldFunction = `config=$(expo config --json --type public)
field() {
  CONFIG=$config node -e '
    const value = process.argv[1].split(".").reduce((at, key) => at?.[key], JSON.parse(process.env.CONFIG))
    if (value === undefined || value === null) {
      console.error("the Expo config has no " + process.argv[1])
      process.exit(1)
    }
    console.log(value)' "$1"
}`

/** `same_runtime <what> <found> <expected>` fails unless a build or host has the runtime version CI computed. */
const sameRuntimeFunction = `same_runtime() {
  if [ "$2" != "$3" ]; then
    echo "$1 has the runtime version $2, but CI computed $3 for this commit" >&2
    exit 1
  fi
}`

// ----------------------------------------------------------------------------------- runtime version

const runtimeFile = ".calder-expo-runtime.json"

/** `$1` is the app's directory, `$2` the platform, `$3` the value's file relative to the repository. */
const runtimeScript = `set -euo pipefail
value=$PWD/$3
${enter}
${runtimeFunction}
version=$(runtime "$2")
echo "$2 runtime version $version"
node -e 'console.log(JSON.stringify(process.argv[1]))' "$version" >"$value"`

/**
 * The app's runtime version on `platform`, named `runtime-<platform>`: Expo's fingerprint of the native
 * code. Its value changes only when the native app does, so steps that interpolate it, such as the
 * store builds, are reused until then.
 */
export const runtimeVersion = (platform: "ios" | "android", options: InstalledOptions) => {
  const dir = options.dir ?? "."
  return Task.make(options.name ?? `runtime-${platform}`, {
    ...hostOf(options),
    setup: options.setup,
    after: options.after ?? [],
    ...(options.env === undefined ? {} : { env: options.env }),
    run: cmd`bash -c ${runtimeScript} calder-expo ${dir} ${platform} ${runtimeFile}`,
    value: { path: runtimeFile, schema: Schema.String },
  })
}

// ------------------------------------------------------------------------------------ update export

const updateDir = ".calder-expo-update"

/**
 * `$1` is the app's directory, `$2` where the export goes, relative to it. With source maps hermesc
 * moves debug info out of the bytecode, which makes what phones download a fifth smaller (4.4 MB
 * instead of 5.4 MB for Hopwatch). eas uploads no maps without `--upload-source-maps`, so they go.
 */
const exportScript = `set -euo pipefail
${enter}
rm -rf "$2"
expo export --platform ios --platform android --output-dir "$2" --dump-assetmap --source-maps
find "$2" -name '*.map' -delete`

/**
 * This commit's JavaScript and assets for both platforms, as `eas update` would export them, named
 * `ota-export`. Its output `update` goes to the Nix store, where `publishUpdate` takes it from. The
 * Hermes bytecode compiler ships for macOS and x86_64 Linux only, so the export runs on an agent of
 * one of those (`platform`). It is reused for a tree it exported before, such as after a revert.
 */
export const exportUpdate = (options: InstalledOptions) => {
  const dir = options.dir ?? "."
  return Task.make(options.name ?? "ota-export", {
    ...hostOf(options),
    setup: options.setup,
    after: options.after ?? [],
    ...(options.env === undefined ? {} : { env: options.env }),
    run: cmd`bash -c ${exportScript} calder-expo ${dir} ${updateDir}`,
    outputs: { update: inDir(dir, updateDir) },
  })
}

// ----------------------------------------------------------------------------------- update publish

/** What `eas update --json` says about each platform's update of the group it published. */
export const Update = Schema.Struct({
  id: Schema.String,
  group: Schema.String,
  platform: Schema.String,
  runtimeVersion: Schema.String,
})
export type Update = typeof Update.Type

export interface PublishOptions extends InstalledOptions {
  /** An `exportUpdate` step: its export is what goes out. */
  readonly update: Step.Step<unknown, unknown, never, { readonly update: string }, unknown>
  /** The EAS Update channel, such as `production`. The step's name is `ota-<channel>` by default. */
  readonly channel: string
  /** The project's secret with an Expo access token that may publish updates, such as a robot's. */
  readonly token: string
  /** The runtime versions the store builds were keyed by. The step fails when eas would publish to others. */
  readonly runtimes: { readonly ios: Runtime; readonly android: Runtime }
}

const updatesFile = ".calder-expo-updates.json"

/**
 * `$1` is the app's directory, `$2` the export, `$3` the channel, `$4` and `$5` the iOS and Android
 * runtime versions, `$6` the value's file relative to the repository and `$7` eas-cli. eas fails on a
 * dirty working tree, so its output goes to the value's file only once it is done.
 */
const publishScript = `set -euo pipefail
value=$PWD/$6
${enter}
${runtimeFunction}
${sameRuntimeFunction}
# eas resolves the runtime versions it publishes to on this host; the store builds were keyed by CI's.
ios=$(runtime ios)
android=$(runtime android)
same_runtime "iOS on this host" "$ios" "$4"
same_runtime "Android on this host" "$android" "$5"
EXPO_TOKEN=$(<"$EXPO_TOKEN_FILE")
export EXPO_TOKEN
published=$(mktemp)
pnpm dlx "$7" update --skip-bundler --input-dir "$2" --channel "$3" --platform all \\
  --message "$(git log -1 --format=%s)" --non-interactive --json >"$published"
cat "$published"
mv "$published" "$value"`

/**
 * Publishes an exported update to the EAS Update channel `channel`, named `ota-<channel>`, for the
 * installed builds whose runtime version matches. It runs every time its rule does, since a revert
 * has to ship too, although an update with its files went out before. Its value is the update of each
 * platform.
 */
export const publishUpdate = (options: PublishOptions) => {
  const dir = options.dir ?? "."
  return Task.make(options.name ?? `ota-${options.channel}`, {
    ...hostOf(options),
    setup: options.setup,
    after: options.after ?? [],
    reuse: "never",
    // eas wants --environment only for the variables it bundles with, and the export is bundled already.
    env: { EAS_UPDATE_SKIP_ENVIRONMENT_CHECK: "1", ...options.env },
    secrets: { EXPO_TOKEN_FILE: Secret.file(options.token) },
    run: cmd`bash -c ${publishScript} calder-expo ${dir} ${options.update.outputs.update} ${options.channel} ${options.runtimes.ios} ${options.runtimes.android} ${updatesFile} ${easCli}`,
    value: { path: updatesFile, schema: Schema.Array(Update) },
  })
}

// ------------------------------------------------------------------------------------- store builds

export interface StoreBuildOptions extends AppOptions {
  /**
   * Files the build reads that the runtime version doesn't cover, such as a store listing it uploads.
   * None by default, so the build runs again only when the runtime version or the command changes.
   */
  readonly inputs?: Files.Files
}

/** A store build's toolchain and key: it installs itself, so that a lockfile change alone doesn't build again. */
const storeBuild = (options: StoreBuildOptions) => ({
  ...hostOf(options),
  after: options.after ?? [],
  inputs: options.inputs ?? Files.of(),
})

export interface AppStoreConnectKey {
  /** The project's secret with the API key's `.p8` file. */
  readonly key: string
  readonly keyId: string
  readonly issuerId: string
}

export interface TestflightOptions extends StoreBuildOptions {
  /** The iOS runtime version: `runtimeVersion("ios", ...)`. */
  readonly runtime: Runtime
  /** The app's Apple ID in App Store Connect. */
  readonly appId: string
  /** An API key that may sign and upload, for xcodebuild and `asc`. Only this step receives it. */
  readonly appStoreConnect: AppStoreConnectKey
}

/**
 * `$1` is the app's directory, `$2` the runtime version CI computed and `$3` the app's Apple ID. The
 * team comes from the Expo config's `ios.appleTeamId`, the workspace and scheme from what prebuild
 * generates.
 */
const testflightScript = `set -euo pipefail
expected=$2
app=$3
pnpm install --frozen-lockfile
${enter}
${fieldFunction}
${sameRuntimeFunction}
version=$(field version)
team=$(field ios.appleTeamId)

# App Store Connect takes no new builds of a version once it passed review; fail now rather than at the upload.
approved=$(asc versions list --app "$app" --platform IOS --version "$version" --output json \\
  --state READY_FOR_SALE,PENDING_DEVELOPER_RELEASE,PENDING_APPLE_RELEASE,PROCESSING_FOR_APP_STORE,REPLACED_WITH_NEW_VERSION,REMOVED_FROM_SALE,DEVELOPER_REMOVED_FROM_SALE |
  node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).data.length')
if [ "$approved" != 0 ]; then
  echo "$version already passed App Store review; raise the version for new builds" >&2
  exit 1
fi

# Every upload of a version needs a higher build number than the last: the UTC minute, as YYYYMMDDHHMM.
IOS_BUILD_NUMBER=$(date -u +%Y%m%d%H%M)
export IOS_BUILD_NUMBER
echo "build $IOS_BUILD_NUMBER of $version, runtime $expected"

expo prebuild --platform ios --no-install --clean
(cd ios && pod install)
workspaces=(ios/*.xcworkspace)
if [ "\${#workspaces[@]}" != 1 ] || [ ! -d "\${workspaces[0]}" ]; then
  echo "expected one workspace in ios/, found \${workspaces[*]}" >&2
  exit 1
fi
scheme=$(basename "\${workspaces[0]}" .xcworkspace)
archive=ios/build/$scheme.xcarchive
auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_PRIVATE_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)
xcodebuild archive -quiet -workspace "\${workspaces[0]}" -scheme "$scheme" -configuration Release \\
  -destination generic/platform=iOS -archivePath "$archive" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic "\${auth[@]}"

# Updates for this commit go to the runtime version CI computed, so the build must report the same one.
apps=("$archive"/Products/Applications/*.app)
fingerprint=\${apps[0]}/EXUpdates.bundle/fingerprint
if [ ! -f "$fingerprint" ]; then
  echo "the build has no $fingerprint; Expo's release steps need the runtime version policy fingerprint" >&2
  exit 1
fi
embedded=$(<"$fingerprint")
same_runtime "the build" "$embedded" "$expected"

# App Store Connect, not internal-only: internal testers get every build without beta review, and the
# same build can go to the App Store.
options=$(mktemp -d)/export.plist
cat >"$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -quiet -archivePath "$archive" -exportPath ios/build/upload -exportOptionsPlist "$options" "\${auth[@]}"
asc builds wait --app "$app" --build-number "$IOS_BUILD_NUMBER" --platform IOS --timeout 45m --fail-on-invalid`

/**
 * Archives a Release build with a fresh build number, uploads it to App Store Connect and waits until
 * Apple processed it, so the app's internal TestFlight testers can install it. Named `testflight`. It
 * runs on a Mac agent in the logged-in GUI session, where the keychain can sign, and the Calder agent
 * there already holds the builder's admission for the job. Only this step receives the App Store
 * Connect key, as `ASC_PRIVATE_KEY_PATH` with `ASC_KEY_ID` and `ASC_ISSUER_ID`, which `asc` reads too.
 */
export const testflight = (options: TestflightOptions) =>
  Task.make(options.name ?? "testflight", {
    platform: "aarch64-darwin",
    ...storeBuild(options),
    env: {
      // CocoaPods fails without a UTF-8 locale, and launchd starts agents without one.
      LANG: "en_US.UTF-8",
      ASC_KEY_ID: options.appStoreConnect.keyId,
      ASC_ISSUER_ID: options.appStoreConnect.issuerId,
      ASC_BYPASS_KEYCHAIN: "1",
      ...options.env,
    },
    secrets: { ASC_PRIVATE_KEY_PATH: Secret.file(options.appStoreConnect.key) },
    run: cmd`bash -c ${testflightScript} calder-expo ${options.dir ?? "."} ${options.runtime} ${options.appId}`,
  })

export interface PlayOptions extends StoreBuildOptions {
  /** The Android runtime version: `runtimeVersion("android", ...)`. */
  readonly runtime: Runtime
  /** The project's secret with the upload key: a PKCS12 keystore in base64, alias `upload`. */
  readonly keystore: string
  /** The project's secret with the keystore's password, which is also the key's. */
  readonly password: string
  /** The project's secret with the JSON key of a Play Console service account that may release. */
  readonly serviceAccount: string
}

/**
 * Pins every Android module to React Native's NDK and build tools. A builder's SDK holds only those,
 * and modules that don't pin their own, such as expo-updates, would get the Android Gradle plugin's
 * defaults, which Gradle then fails to install into the read-only SDK.
 */
const sdkInit = `allprojects {
  ['com.android.library', 'com.android.application'].each { id ->
    plugins.withId(id) {
      android.ndkVersion = rootProject.ext.ndkVersion
      android.buildToolsVersion = rootProject.ext.buildToolsVersion
    }
  }
}`

/**
 * `$1` is the app's directory and `$2` the runtime version CI computed. The package comes from the
 * Expo config's `android.package`. Gradle takes the upload key from `android.injected.signing.*`
 * properties, which go into the generated gradle.properties rather than onto a command line.
 */
const playScript = `set -euo pipefail
expected=$2
pnpm install --frozen-lockfile
${enter}
${fieldFunction}
${sameRuntimeFunction}
package=$(field android.package)

# Play caps versionCode at 2100000000. Minutes since 1970 stay below it until the year 5962 and grow with every upload.
ANDROID_VERSION_CODE=$(( $(date -u +%s) / 60 ))
export ANDROID_VERSION_CODE
echo "build $ANDROID_VERSION_CODE of $package, runtime $expected"

expo prebuild --platform android --no-install --clean
umask 077
key=$(mktemp -d)
trap 'rm -rf "$key" android/gradle.properties' EXIT
base64 -d <"$UPLOAD_KEYSTORE" >"$key/upload.p12"
password=$(<"$UPLOAD_KEYSTORE_PASSWORD")
chmod 600 android/gradle.properties
{
  echo
  printf '%s\\n' \\
    "android.injected.signing.store.file=$key/upload.p12" \\
    "android.injected.signing.store.password=$password" \\
    "android.injected.signing.key.alias=upload" \\
    "android.injected.signing.key.password=$password"
} >>android/gradle.properties
cat >"$key/sdk.gradle" <<'GRADLE'
${sdkInit}
GRADLE

# --no-daemon: builders are shared, so no Gradle daemon should linger for hours.
(cd android && ./gradlew --no-daemon --console=plain --quiet --init-script "$key/sdk.gradle" :app:bundleRelease)
aab=android/app/build/outputs/bundle/release/app-release.aab
"\${JAVA_HOME:+$JAVA_HOME/bin/}keytool" -printcert -jarfile "$aab" | grep -E 'Owner|SHA256:'

# Updates for this commit go to the runtime version CI computed, so the build must report the same one.
embedded=$(unzip -p "$aab" base/assets/fingerprint)
same_runtime "the build" "$embedded" "$expected"
gplay release --package "$package" --track internal --bundle "$aab" --wait`

/**
 * Builds a release bundle with a fresh versionCode, signed with the Play upload key, and releases it to
 * Google Play's internal testing track once Play processed it. Named `play`. The host provides the
 * Android SDK and a JDK (`ANDROID_HOME`, `JAVA_HOME`), `unzip` and `gplay`; the step brings the upload
 * key and the service account, as `UPLOAD_KEYSTORE`, `UPLOAD_KEYSTORE_PASSWORD` and
 * `GPLAY_SERVICE_ACCOUNT_JSON`.
 */
export const playInternal = (options: PlayOptions) =>
  Task.make(options.name ?? "play", {
    platform: "x86_64-linux",
    ...storeBuild(options),
    env: { LANG: "en_US.UTF-8", ...options.env },
    secrets: {
      UPLOAD_KEYSTORE: Secret.file(options.keystore),
      UPLOAD_KEYSTORE_PASSWORD: Secret.file(options.password),
      GPLAY_SERVICE_ACCOUNT_JSON: Secret.file(options.serviceAccount),
    },
    run: cmd`bash -c ${playScript} calder-expo ${options.dir ?? "."} ${options.runtime}`,
  })
