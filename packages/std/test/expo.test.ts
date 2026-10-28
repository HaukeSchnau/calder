import { describe, expect, it } from "@effect/vitest"
import { Calder, Cmd, Event, Files, Flake, On, Secret, Step } from "@calder-ci/core"
import { Effect, Schema } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Expo from "../src/Expo.ts"
import * as Pnpm from "../src/Pnpm.ts"

const shell = Flake.make({ packages: [], checks: [], devShells: ["ci"] }).devShells.ci
const install = Pnpm.install({ shell })
const tower = { platform: "x86_64-linux", shell } as const
const towerInstall = Pnpm.install({ ...tower, name: "install-tower" })

const ios = Expo.runtimeVersion("ios", { shell, setup: install })
const android = Expo.runtimeVersion("android", { shell, setup: install })
const appStoreConnect = { key: "asc-key", keyId: "KEY123", issuerId: "issuer-1" }

/** What the stand-ins answer, as the real tools would for this commit. */
interface World {
  readonly runtimes?: { readonly ios?: string | null; readonly android?: string | null }
  /** The runtime versions the store builds embed. */
  readonly embedded?: { readonly ios?: string; readonly android?: string }
  /** How many App Store versions of the app's version passed review. */
  readonly approved?: number
}

const config = {
  name: "Hop",
  version: "1.2.0",
  ios: { bundleIdentifier: "dev.example.hop", appleTeamId: "TEAM42" },
  android: { package: "dev.example.hop" },
}

/**
 * Stand-ins for the tools the steps call. Each appends its name, its directory relative to the
 * repository and its arguments to `$FAKE/calls`, and answers from files in `$FAKE`.
 */
const fakes: { readonly [tool: string]: string } = {
  "expo-updates": `v=$(cat "$FAKE/runtime-$3")
if [ "$v" = null ]; then echo '{"runtimeVersion":null}'; else echo "{\\"runtimeVersion\\":\\"$v\\"}"; fi`,
  expo: `case "$1" in
  config) cat "$FAKE/config.json" ;;
  export) out=$(echo "$@" | sed 's/.*--output-dir \\([^ ]*\\).*/\\1/'); mkdir -p "$out/js"; echo '{"version":0}' > "$out/metadata.json"
    touch "$out/js/index.hbc" "$out/js/index.hbc.map" ;;
  prebuild)
    if [ "$3" = ios ]; then mkdir -p ios/Hop.xcworkspace; exit; fi
    mkdir -p android
    echo 'org.gradle.jvmargs=-Xmx2g' > android/gradle.properties
    cp "$FAKE/gradlew" android/gradlew ;;
esac`,
  pod: "true",
  xcodebuild: `if [ "$1" = archive ]; then
  app=$(echo "$@" | sed 's/.*-archivePath \\([^ ]*\\).*/\\1/')/Products/Applications/Hop.app
  mkdir -p "$app/EXUpdates.bundle"
  cp "$FAKE/embedded-ios" "$app/EXUpdates.bundle/fingerprint"
else
  cp "$(echo "$@" | sed 's/.*-exportOptionsPlist \\([^ ]*\\).*/\\1/')" "$FAKE/export.plist"
fi`,
  asc: `echo "$ASC_KEY_ID $ASC_ISSUER_ID $(cat "$ASC_PRIVATE_KEY_PATH")" > "$FAKE/asc-auth"
if [ "$1" = versions ]; then echo "{\\"data\\":[$(cat "$FAKE/approved")]}"; fi`,
  unzip: `cat "$FAKE/embedded-android"`,
  keytool: `echo "Owner: CN=upload"; echo "SHA256: AA:BB"`,
  gplay: `echo "$GPLAY_SERVICE_ACCOUNT_JSON" > "$FAKE/gplay-account"`,
  git: `echo "feat: a change"`,
  pnpm: `if [ "$1" = dlx ]; then
  echo "$EXPO_TOKEN" > "$FAKE/expo-token"
  echo '[{"id":"u-ios","group":"g-1","platform":"ios","runtimeVersion":"rv-ios","branch":"beta"},{"id":"u-android","group":"g-1","platform":"android","runtimeVersion":"rv-android","branch":"beta"}]'
fi`,
}

/** Prebuild's Gradle wrapper: keeps what it was given and writes the bundle. */
const gradlew = `#!/usr/bin/env bash
echo "gradlew \${PWD#$REPO} $*" >> "$FAKE/calls"
cp gradle.properties "$FAKE/gradle.properties"
cp "\${@: -2:1}" "$FAKE/init.gradle"
mkdir -p app/build/outputs/bundle/release
touch app/build/outputs/bundle/release/app-release.aab
`

interface Ran {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Each stand-in call: the tool, its directory relative to the repository and its arguments. */
  readonly calls: ReadonlyArray<string>
  readonly read: (path: string) => string | undefined
  readonly repo: string
}

/**
 * Runs a step's command in a scratch repository with the stand-ins first on PATH, the step's
 * environment, the values of the steps it interpolates and a file for each secret holding
 * `secret:<name>`.
 */
const run = (step: Step.Any, options: { readonly dir?: string; readonly world?: World; readonly values?: { readonly [step: string]: unknown } } = {}): Ran => {
  const def = step.def
  if (def._tag !== "Task" || typeof def.run === "function") throw new Error("not a task with one command")
  const repo = mkdtempSync(join(tmpdir(), "expo-"))
  const fake = join(repo, ".fake")
  const bin = join(fake, "bin")
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(repo, options.dir ?? "."), { recursive: true })
  for (const [tool, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, tool), `#!/usr/bin/env bash\nat=\${PWD#$REPO}\necho "${tool} \${at:-/} $*" >> "$FAKE/calls"\n${body}\n`, { mode: 0o755 })
  }
  writeFileSync(join(fake, "gradlew"), gradlew, { mode: 0o755 })
  const world = options.world ?? {}
  writeFileSync(join(fake, "config.json"), JSON.stringify(config))
  writeFileSync(join(fake, "runtime-ios"), String(world.runtimes?.ios === undefined ? "rv-ios" : world.runtimes.ios))
  writeFileSync(join(fake, "runtime-android"), String(world.runtimes?.android === undefined ? "rv-android" : world.runtimes.android))
  writeFileSync(join(fake, "embedded-ios"), world.embedded?.ios ?? "rv-ios")
  writeFileSync(join(fake, "embedded-android"), world.embedded?.android ?? "rv-android")
  writeFileSync(join(fake, "approved"), Array.from({ length: world.approved ?? 0 }, () => "{}").join(","))
  const secrets = Object.fromEntries(Step.taskSecrets(def).map((name) => {
    const path = join(fake, `secret-${name}`)
    writeFileSync(path, name === "keystore" ? Buffer.from("keystore bytes").toString("base64") : `secret:${name}`)
    return [name, path]
  }))
  const [command, ...args] = Cmd.render(def.run, options.values ?? {}, { secrets })
  const result = spawnSync(command!, args, {
    cwd: repo,
    env: {
      ...process.env,
      ...def.env,
      ...Object.fromEntries(Object.entries(def.secrets).map(([env, ref]) => [env, secrets[ref.name]!])),
      PATH: `${bin}:${process.env.PATH}`,
      FAKE: fake,
      REPO: repo,
    },
    // With a socket for stdin, as in Calder's workers, NixOS's bash sources /etc/bashrc, which resets PATH.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  const read = (path: string) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8").trim() : undefined)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: (read(".fake/calls") ?? "").split("\n"), read, repo }
}

const task = (step: Step.Any) => {
  if (step.def._tag !== "Task") throw new Error("not a task")
  return step.def
}

const values = { "runtime-ios": "rv-ios", "runtime-android": "rv-android" }

describe("Expo.runtimeVersion", () => {
  it("is what expo-updates resolves in the app's directory, as the step's value", () => {
    const step = Expo.runtimeVersion("android", { shell, setup: install, dir: "apps/app" })
    const ran = run(step, { dir: "apps/app" })
    expect(ran.status).toBe(0)
    expect(ran.calls[0]).toBe("expo-updates /apps/app runtimeversion:resolve --platform android")
    const value = task(step).value!
    expect(Schema.decodeUnknownSync(value.schema)(JSON.parse(ran.read(value.path)!))).toBe("rv-android")
    expect(step.name).toBe("runtime-android")
  })

  it("fails for an app without a runtime version", () => {
    const ran = run(ios, { world: { runtimes: { ios: null } } })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain("the app has no ios runtime version")
  })
})

describe("Expo.exportUpdate", () => {
  it("exports both platforms into its output without source maps, on the agent it names", () => {
    const step = Expo.exportUpdate({ ...tower, setup: towerInstall, dir: "apps/app" })
    const ran = run(step, { dir: "apps/app" })
    expect(ran.status).toBe(0)
    expect(ran.calls[0]).toBe(
      "expo /apps/app export --platform ios --platform android --output-dir .calder-expo-update --dump-assetmap --source-maps",
    )
    expect(ran.read("apps/app/.calder-expo-update/metadata.json")).toBeDefined()
    expect(ran.read("apps/app/.calder-expo-update/js/index.hbc")).toBeDefined()
    expect(ran.read("apps/app/.calder-expo-update/js/index.hbc.map")).toBeUndefined()
    expect(task(step).outputs).toEqual({ update: "apps/app/.calder-expo-update" })
    expect(task(step).platform).toBe("x86_64-linux")
  })
})

describe("Expo.publishUpdate", () => {
  const update = Expo.exportUpdate({ ...tower, setup: towerInstall }).pipe(Step.timeout("30 minutes"))
  const publish = Expo.publishUpdate({ shell, setup: install, update, channel: "beta", token: "expo-token", runtimes: { ios, android } })
  const exported = { ...values, "ota-export.update": "/nix/store/abc-ota-export-update" }

  it("publishes the export with the token, and its value is each platform's update", () => {
    const ran = run(publish, { values: exported })
    expect(ran.status).toBe(0)
    expect(ran.calls.at(-1)).toBe(
      "pnpm / dlx eas-cli@25.3.0 update --skip-bundler --input-dir /nix/store/abc-ota-export-update --channel beta --platform all " +
        "--message feat: a change --non-interactive --json",
    )
    expect(ran.read(".fake/expo-token")).toBe("secret:expo-token")
    const value = task(publish).value!
    expect(Schema.decodeUnknownSync(value.schema)(JSON.parse(ran.read(value.path)!))).toEqual([
      { id: "u-ios", group: "g-1", platform: "ios", runtimeVersion: "rv-ios" },
      { id: "u-android", group: "g-1", platform: "android", runtimeVersion: "rv-android" },
    ])
  })

  it("publishes nothing when this host resolves another runtime version than the store builds were keyed by", () => {
    const ran = run(publish, { values: exported, world: { runtimes: { android: "rv-other" } } })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain("Android on this host has the runtime version rv-other, but CI computed rv-android")
    expect(ran.calls.some((call) => call.startsWith("pnpm"))).toBe(false)
  })

  it.effect("runs every time, after the export, and is named after its channel", () =>
    Effect.gen(function*() {
      expect(publish.name).toBe("ota-beta")
      expect(task(publish).reuse).toBe("never")
      const plan = yield* Calder.plan(Calder.project({ rules: [On.push("main", [publish])] }), Event.push("main"))
      expect(plan.get("ota-beta")?.needs).toEqual(expect.arrayContaining(["install", "ota-export.update", "runtime-ios", "runtime-android"]))
      expect(plan.get("ota-export.update")?.needs).toEqual(["ota-export"])
    }))
})

describe("Expo.testflight", () => {
  const step = Expo.testflight({ runtime: ios, appId: "123", appStoreConnect })

  it("archives with a fresh build number and uploads with the step's own key", () => {
    const ran = run(step, { values })
    expect(ran.status).toBe(0)
    expect(ran.calls[0]).toBe("pnpm / install --frozen-lockfile")
    const archive = ran.calls.find((call) => call.startsWith("xcodebuild / archive"))!
    expect(archive).toContain("-workspace ios/Hop.xcworkspace -scheme Hop -configuration Release")
    expect(archive).toContain("DEVELOPMENT_TEAM=TEAM42")
    expect(archive).toContain(`-authenticationKeyPath ${ran.repo}/.fake/secret-asc-key -authenticationKeyID KEY123 -authenticationKeyIssuerID issuer-1`)
    expect(ran.read(".fake/export.plist")).toContain("<key>teamID</key><string>TEAM42</string>")
    expect(ran.read(".fake/asc-auth")).toBe("KEY123 issuer-1 secret:asc-key")
    const build = /build (\d+) of 1\.2\.0, runtime rv-ios/.exec(ran.stdout)?.[1]
    expect(build).toBe(new Date().toISOString().replace(/\D/g, "").slice(0, 12))
    expect(ran.calls.at(-1)).toBe(`asc / builds wait --app 123 --build-number ${build} --platform IOS --timeout 45m --fail-on-invalid`)
  })

  it("stops before building when the version already passed review", () => {
    const ran = run(step, { values, world: { approved: 1 } })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain("1.2.0 already passed App Store review")
    expect(ran.calls.some((call) => call.startsWith("xcodebuild"))).toBe(false)
  })

  it("uploads nothing when the build embeds another runtime version", () => {
    const ran = run(step, { values, world: { embedded: { ios: "rv-stale" } } })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain("the build has the runtime version rv-stale, but CI computed rv-ios")
    expect(ran.calls.some((call) => call.includes("-exportArchive"))).toBe(false)
  })

  it("runs on the Mac, keyed by the runtime version alone, and is the only step with the key", () => {
    const def = task(step)
    expect(def.platform).toBe("aarch64-darwin")
    expect(def.setup).toBeUndefined()
    expect(def.inputs).toEqual(Files.of())
    expect(def.secrets).toEqual({ ASC_PRIVATE_KEY_PATH: Secret.file("asc-key") })
    expect(task(ios).secrets).toEqual({})
  })
})

describe("Expo.playInternal", () => {
  const step = Expo.playInternal({ runtime: android, keystore: "keystore", password: "password", serviceAccount: "play" })

  it("signs with the upload key, releases to the internal track and leaves no key behind", () => {
    const ran = run(step, { values })
    expect(ran.status).toBe(0)
    const properties = ran.read(".fake/gradle.properties")!
    expect(properties).toMatch(/^android\.injected\.signing\.store\.file=\/\S+\/upload\.p12$/m)
    expect(properties).toContain("android.injected.signing.store.password=secret:password")
    expect(properties).toContain("android.injected.signing.key.alias=upload")
    expect(ran.read(".fake/init.gradle")).toContain("android.ndkVersion = rootProject.ext.ndkVersion")
    expect(existsSync(join(ran.repo, "android/gradle.properties"))).toBe(false)
    expect(ran.calls.at(-1)).toBe(
      "gplay / release --package dev.example.hop --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --wait",
    )
    expect(ran.read(".fake/gplay-account")).toBe(`${ran.repo}/.fake/secret-play`)
  })

  it("gives Gradle a versionCode in minutes since 1970", () => {
    const before = Math.floor(Date.now() / 60_000)
    const ran = run(step, { values })
    const code = Number(/build (\d+) of dev\.example\.hop/.exec(ran.stdout)?.[1])
    expect(code).toBeGreaterThanOrEqual(before)
    expect(code).toBeLessThanOrEqual(before + 1)
  })

  it("releases nothing when the bundle embeds another runtime version", () => {
    const ran = run(step, { values, world: { embedded: { android: "rv-stale" } } })
    expect(ran.status).not.toBe(0)
    expect(ran.stderr).toContain("the build has the runtime version rv-stale, but CI computed rv-android")
    expect(ran.calls.some((call) => call.startsWith("gplay"))).toBe(false)
  })

  it("runs on the tower unless told otherwise, keyed by the runtime version alone", () => {
    const def = task(step)
    expect(def.platform).toBe("x86_64-linux")
    const mac = Expo.playInternal({ platform: "aarch64-darwin", runtime: android, keystore: "k", password: "p", serviceAccount: "s" })
    expect(task(mac).platform).toBe("aarch64-darwin")
    expect(def.inputs).toEqual(Files.of())
    expect(Object.keys(def.secrets).sort()).toEqual(["GPLAY_SERVICE_ACCOUNT_JSON", "UPLOAD_KEYSTORE", "UPLOAD_KEYSTORE_PASSWORD"])
  })
})

describe("an Expo release pipeline", () => {
  it.effect("exports on the tower from the tower's install, and refuses the controller's", () =>
    Effect.gen(function*() {
      const update = Expo.exportUpdate({ ...tower, setup: towerInstall })
      const plan = yield* Calder.plan(Calder.project({ rules: [On.push("main", [ios, android, update])] }), Event.push("main"))
      expect(plan.get("ota-export")?.needs).toEqual(["install-tower"])
      const wrong = Expo.exportUpdate({ ...tower, setup: install })
      const error = yield* Effect.flip(Calder.plan(Calder.project({ rules: [On.push("main", [wrong])] }), Event.push("main")))
      expect(String(error.message ?? error)).toContain(`"ota-export" runs on x86_64-linux but its setup "install" on the controller's platform`)
    }))
})
