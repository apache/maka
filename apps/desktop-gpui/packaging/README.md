<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Packaging

How the desktop app is packaged. Only macOS is packaged so far.

## macOS app bundle

```sh
just bundle          # or scripts/bundle-macos.sh
open -n "target/bundle/Maka GPUI.app" --args --root "$PWD/.dev-root"
```

`MAKA_GPUI_BUNDLE_DIR=target/bundle-check scripts/bundle-macos.sh` writes the
bundle to another directory, for example to check a build while a copy from
`target/bundle` is running.

`scripts/bundle-macos.sh` builds `maka-gpui` with the release profile of the
workspace `Cargo.toml` (thin LTO, one codegen unit, stripped) and assembles
`target/bundle/Maka GPUI.app`:

| Path in the bundle | From |
| --- | --- |
| `Contents/MacOS/maka-gpui` | `cargo build --release -p app` |
| `Contents/Info.plist` | `packaging/macos/Info.plist`, with the workspace version and the minimum macOS filled in; the script fails unless the result passes `plutil -lint` and has `NSAppleEventsUsageDescription` |
| `Contents/Resources/AppIcon.icns` | `assets/maka-icon.png` (1024 px, Maka's `sky` icon; see `assets/README.md`), scaled into an iconset with `sips` and packed with `iconutil` |

The bundle identifier is `com.longbridge.maka-gpui`. The version is the
workspace version (`scripts/workspace-version.sh`), used for both
`CFBundleShortVersionString` and `CFBundleVersion`. `MACOSX_DEPLOYMENT_TARGET`
(default 11.0, the lowest macOS the arm64 toolchain targets) sets the
binary's minimum macOS and `LSMinimumSystemVersion` together.

The bundle is signed ad hoc (`codesign --force --deep --sign -`). It runs on
the Mac that built it. On another Mac, Gatekeeper refuses a downloaded copy
until its quarantine attribute is removed
(`xattr -dr com.apple.quarantine "Maka GPUI.app"`).

### Privacy permissions

The Runtime Host the app starts, and every command an agent task runs through
it, are child processes of the app, and macOS attributes their privacy
requests to it (the responsible process; a copy of the binary started from a
terminal is attributed to the terminal instead). For each protected service
macOS asks the user only when the responsible app's `Info.plist` has a
purpose string for it; without one it refuses the request without asking.
An `osascript` the agent runs then fails with `errAEEventNotPermitted`
(-1743), and a camera or microphone capture fails the same way. The template
therefore carries:

| Key | Asked when a task… | Source |
| --- | --- | --- |
| `NSAppleEventsUsageDescription` | automates another app (`osascript`, AppleScript) | Maka Desktop's wording (`apps/desktop/electron-builder.config.mjs`, `mac.extendInfo`), with this app's name |
| `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSBluetoothAlwaysUsageDescription` | captures video, sound or system audio, or uses Bluetooth | the keys Desktop's Electron bundle carries |

Nothing beyond Desktop's set: calendars, reminders, contacts, photos and
location stay without a purpose string, so a task that reaches them is refused
as it is under Maka Desktop. Files in Desktop, Documents, Downloads and on
other volumes need no key:
macOS asks with its own wording. The strings are English only, as Desktop's
are (localizing them takes `InfoPlist.strings` per language).

The grants belong to the code signature. An ad-hoc signature changes with
every build, so macOS asks again after a rebuild and a grant made to an older
build no longer applies; `tccutil reset AppleEvents com.longbridge.maka-gpui`
(or `Camera`, `Microphone`, …) clears stale entries. Under the hardened
runtime that Developer ID signing needs, each of these also requires its
entitlement (`com.apple.security.automation.apple-events`,
`com.apple.security.device.camera`, `com.apple.security.device.audio-input`,
`com.apple.security.personal-information.*`), as Desktop's
`build/entitlements.mac.plist` has for Apple events; the ad-hoc bundle has no
hardened runtime, so it needs none.

The completion notification (Settings › General) goes through
`UNUserNotificationCenter`, which only works from a bundle: GPUI checks for
the bundle identifier and posts nothing from a bare `cargo run` binary. From
the bundle, the first notification asks for permission; nothing in
`Info.plist` is needed for it.

### Environment

`open` passes the environment of the shell that runs it to the app: provider
keys, `MAKA_*` variables and the shell's `PATH` reach the app and the Runtime
Host it spawns. In the Phase 2 acceptance run (`docs/acceptance/phase-2-2026-09-26.md`,
D1), `ps eww` showed `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` in both. On a
State Root that has no connections yet, the Host imports the first of
`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` as a connection
(`env-deepseek`, `env-anthropic` or `env-openai`) and makes it the default
when none is set (`ensureBootstrapRuntimePolicy` in
`$MAKA_REPO/packages/runtime-host/src/server/bootstrap-runtime-policy.ts`).
To keep the keys out, remove them for that one command:

```sh
env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
  open -n "target/bundle/Maka GPUI.app" --args --root "$PWD/.dev-root"
```

or start the app from Finder, the Dock or Spotlight. Those launches get
launchd's environment, not the shell's: `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`,
and `MAKA_REPO`, `MAKA_NODE` and the provider keys are unset unless
`launchctl setenv` set them. They also pass no arguments, so the app asks for
a State Root or uses the one it saved. The Host lookup then uses its defaults
(`~/code/maka-pin`, Node from nvm); see `docs/dev-host.md`.

## CI

No CI job in this repository builds the client yet. The standalone repository
it came from had a `bundle` job that ran `scripts/bundle-macos.sh`
on `macos-latest` for every pull request and push, zipped the bundle with
`ditto -c -k --keepParent` (which keeps the executable bit and the signature;
`upload-artifact` on its own would drop the permissions), and uploaded it as
the `maka-gpui-macos` artifact:
`Maka-GPUI-<version>-macos-<arch>.zip`. The artifact was ad-hoc signed like a
local build, so it was for testing, not distribution.

## Releases

The version lives only in the workspace `Cargo.toml`, and `CHANGELOG.md`
(Keep a Changelog) is the source of the release notes. To cut a release:

1. Set `[workspace.package].version` in `Cargo.toml`.
2. In `CHANGELOG.md`, move the `Unreleased` entries under
   `## [<version>] - <YYYY-MM-DD>`.
3. Run `scripts/release-check.sh v<version>`; it fails unless the tag
   matches the version and the changelog has a dated, non-empty section for
   it. `--notes` also prints that section, for the release description.
4. Tag `v<version>` and push the tag. CI runs the same check on the tag
   before it bundles.

## Follow-ups

Not done, and deliberately out of this first bundle:

- Developer ID signing with the hardened runtime, so the app opens on other
  Macs without removing the quarantine attribute. Needs an Apple Developer
  ID certificate in CI secrets.
- Notarization (`xcrun notarytool submit --wait`, then `xcrun stapler
  staple`), which requires the Developer ID signature.
- A disk image (`.dmg`) for distribution instead of a zipped bundle.
- Automatic updates, for example with Sparkle: an appcast, an EdDSA signing
  key, and an update check in the app. Auto-update is out of scope for
  Phase 2 (`docs/plan/phase-2-daily-use.md`).
- A universal (arm64 and x86_64) binary; the bundle has the build host's
  architecture.
- Windows and Linux packages.
