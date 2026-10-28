---
title: Packaging
description: Build installable Rust and TSX apps with nsh package for iOS devices, the iOS simulator, Android, macOS, Windows, Linux, terminals and the web, with app metadata, icons and signing.
order: 19
group: platforms
---

# Packaging

`nsh package` turns an app into something you can install: a `.app` for the iOS simulator, a signed `.ipa` for iOS
devices, a signed `.apk` for Android, an ad hoc signed `.app` for macOS, a directory and `.tar.gz` for Linux, a directory and `.zip` for Windows, or a static site for the web; `--target tui` creates a console application. It needs no Xcode project and no Gradle.

- **A Rust app** (`nsh.json` names its `"root"`) is packaged from its directory. `nsh` builds the target's runner in
  release mode with your crate compiled in and the root mounted, with no QuickJS: Cargo, the Rust target of the
  platform (`rustup target add …`), and for Android the NDK.
- **A TSX app** names its entry. Its release build (minified, compiled to QuickJS bytecode, exactly as
  `nsh build --release` builds it) goes next to the **prebuilt runtime** that ships with NSH, so it needs no Rust
  toolchain. An app with a crate of its own (`"rust"` without `"root"`) gets runners built with its crate.

```sh
# A Rust app, from its directory
nsh package --target ios-simulator --run     # build, install and launch in the simulator
nsh package --target android --run           # build, install and launch on a device or emulator
nsh package --target macos --run             # build and launch on this Mac
nsh package --target linux --run             # build and launch on this machine
nsh package --target windows --run           # build and launch on this machine
nsh package --target tui --run               # build and run in this terminal
nsh package --target web --run               # build, serve on this machine and open in the browser
nsh package --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile Dev.mobileprovision

# A TSX app: the same with its entry
nsh package App.tsx --target ios-simulator --run
```

Output goes to `.nsh/out/` unless you pass `--out`. The sections below give each target's command for a Rust app; a
TSX app adds its entry (`nsh package App.tsx --target …`).

> [!NOTE]
> To put NSH *inside* an existing native app instead, see [Platforms](./platforms.md#embed-in-a-native-app), and for a
> GPUI or GPUI Kit app [GPUI](./gpui.md#embedding-in-a-gpui-app). To ship updates that apps download and verify, see
> [Signed packages](./signed-packages.md).

## App metadata: `nsh.json`

`nsh package` reads `nsh.json` in the app's directory (next to the entry file of a TSX app). `nsh init` writes one:

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "icon": "icon.png"
}
```

| Key | Type | Default | Used for |
|---|---|---|---|
| `name` | string | the entry's directory name | The display name under the icon (`CFBundleDisplayName`, Android `android:label`) and the output file name. |
| `id` | string | required | The bundle identifier / Android package name, in reverse-DNS form under a domain you own. It also names where the app keeps its [storage](../modules/nsh.md#storage), so each app has its own. `nsh package` and `nsh publish` warn about the `com.example.` placeholder. |
| `version` | string | `"1.0.0"` | The user-visible version (`CFBundleShortVersionString`, `versionName`). |
| `build` | number | `1` | The build number (`CFBundleVersion`, `versionCode`). Raise it for every release you upload. |
| `icon` | string | none | A square PNG, ideally 1024×1024, relative to `nsh.json`. |

`nsh.json` also holds `rust` and `root` (the app's crates and its root component, [Building with Rust](./rust.md)),
`theme` and `appearance`, `tailwind` (see [Tailwind](./tailwind.md)) and `capabilities` (see
[Sandbox and capabilities](./sandbox-and-capabilities.md)); [Project structure](./project-structure.md#nshjson) lists
every key. Unknown keys are an error.

Every key above can be overridden on the command line, which is handy in CI:

```sh
nsh package --target android --app-version 1.4.0 --build 42
```

## Options

| Flag | Description |
|---|---|
| `--target <ios \| ios-simulator \| android \| macos \| linux \| windows \| tui \| web>` | What to build for (required). |
| `-o, --out <dir>` | Output directory. Default `.nsh/out`. |
| `--name <name>` | Display name. |
| `--id <id>` | Bundle identifier, such as `com.example.app`. |
| `--app-version <version>` | Version, such as `1.2.0`. |
| `--build <n>` | Build number. |
| `--icon <png>` | App icon: a square PNG, ideally 1024×1024. |
| `--sign <identity>` | iOS: the code signing identity for devices. |
| `--profile <file>` | iOS: the provisioning profile for devices (`.mobileprovision`). |
| `--keystore <file>` | Android: a release keystore (default: the debug key). |
| `--key-alias <alias>` | Android: the key alias in the keystore. |
| `--keystore-password <password>` | Android: the keystore password; also read from `NSH_KEYSTORE_PASSWORD`. |
| `--abi <abi>` | Android: the ABIs of the APK, repeated or separated by commas (default: `arm64-v8a` and `armeabi-v7a`). |
| `--run` | Install and launch afterwards: in the iOS simulator, or on the Android device or emulator `adb` sees; macOS, Linux and Windows apps are launched on this machine; terminal apps run in the current terminal until they exit; a web site is served on this machine and opened in the browser. Not for `--target ios`. |

## iOS simulator

```sh
nsh package --target ios-simulator --run
```

Writes `.nsh/out/<Name>.app`, signed ad hoc (the simulator needs a signature but no identity). With `--run` it boots a
simulator if none is running, installs the app and launches it. Requires Xcode.

## iOS devices

```sh
nsh package --target ios \
  --sign "Apple Distribution: Example Inc (ABCDE12345)" \
  --profile AppStore.mobileprovision
```

Writes `.nsh/out/<Name>.ipa`, ready for TestFlight, App Store upload tools or direct installation (depending on the
profile). What happens:

- The provisioning profile is copied into the app as `embedded.mobileprovision`.
- The entitlements come from the profile. NSH checks that the profile's application identifier covers the app's `id`
  (wildcard profiles such as `TEAMID.*` or `TEAMID.com.example.*` work) and stops with an error otherwise.
- The app is signed with `codesign` using the identity, then zipped into an `.ipa` (`Payload/<Name>.app`).

Find your identities with:

```sh
security find-identity -v -p codesigning
```

Without `--sign` and `--profile`, NSH writes an unsigned `.nsh/out/<Name>.app` and tells you so; it cannot be installed on a
device as it is.

The app supports iPhone and iPad, portrait and landscape (portrait upside down on iPad only), and needs iOS 15.0 or
newer.

## Android

```sh
nsh package --target android --run
```

Writes `.nsh/out/<Name>.apk`. The APK is assembled directly with the SDK's build tools (`aapt2`, `zipalign`, `apksigner`),
without Gradle. Requirements:

- The Android SDK, found through `ANDROID_HOME` (or `ANDROID_SDK_ROOT`, or `~/Library/Android/sdk`), with build tools
  and the `platforms;android-35` package. NSH tells you the `sdkmanager` command when one is missing.
- A JDK, to create the debug keystore the first time.
- For a Rust app, the Android NDK (`sdkmanager "ndk;<version>"`, or `ANDROID_NDK_HOME`), which builds its
  `libnsh.so`.

The app targets API 35 and needs API 28 (Android 9) or newer. It contains native code for the ABIs of phones,
`arm64-v8a` and `armeabi-v7a`; with `--run`, also the device's, such as an emulator's `x86_64`. `--abi` picks them
yourself, for example `--abi arm64-v8a` for 64-bit phones only, the smallest APK:

```sh
nsh package --target android --abi arm64-v8a
```

### Signing for release

Without `--keystore`, the APK is signed with the standard debug key (`~/.android/debug.keystore`, created if missing),
and NSH warns that it is not for store releases. For a release, create a keystore once and pass it:

```sh
keytool -genkeypair -v -keystore release.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000

NSH_KEYSTORE_PASSWORD=… nsh package --target android \
  --keystore release.jks --key-alias upload
```

Prefer the environment variable over `--keystore-password` so the password does not end up in your shell history.

## macOS

```sh
nsh package --target macos --run
```

Writes `.nsh/out/<Name>.app`: the executable in `Contents/MacOS/`, and `nsh/assets/…`, `nsh/app.json` (the window
title and the app's appearance) and a TSX app's `nsh/bundle.nshc` in `Contents/Resources/`. The app is signed ad hoc and needs macOS 14 or
later; to distribute it, sign it with a Developer ID and notarize it. See [macOS](./macos.md#packaging).

## Linux

```sh
nsh package --target linux --run
```

Writes `.nsh/out/<Name>/` (the executable `<Name>`, `nsh/assets/…`, `nsh/app.json` with the window title and the
application id, a TSX app's `nsh/bundle.nshc`, `<id>.desktop` and the icon `<id>.png`) and the same as
`.nsh/out/<Name>.tar.gz`. Package on
Linux: the runner is built for the machine it is built on. GTK 4 (4.14 or later), Pango and WebKitGTK 6.0 (for web
views) must be installed where the app runs. Installing it and the desktop entry: [Linux](./linux.md#packaging).

## Windows

```sh
nsh package --target windows --run
```

Writes `.nsh\out\<Name>\` (the executable `<Name>.exe` with the app's icon, `nsh\assets\…`, `nsh\app.json` with the
window title, the app id, the version and the appearance, and a TSX app's `nsh\bundle.nshc`) and the same as
`.nsh\out\<Name>.zip`. A TSX app needs no tools; a Rust app's runner is built with Visual Studio Build Tools. Package on Windows: the runner is built for the machine it is built on, and only Windows can
embed the icon. The app runs from wherever its directory is copied; nothing is installed. See
[Windows](./windows.md#packaging).

## Terminal

```sh
nsh package App.tsx --target tui --run
```

Writes `.nsh/out/<Name>/` with a console executable, `nsh/bundle.nshc`,
`nsh/assets/…` and `nsh/app.json`, plus a `.tar.gz` on macOS and Linux or a
`.zip` on Windows. Package on the OS the executable will run on. `--run`
uses the current terminal and waits until the app exits. See
[Terminal](./tui.md#packaging).

## Web

```sh
nsh package --target web --run
```

Writes `.nsh/out/<Name>/`, a static site: `index.html`, `manifest.webmanifest`, the page script (`nsh.<digest>.js`)
and `nsh.<digest>.wasm` (a Rust app's engine and crate; for a TSX app the runtime, next to the app's bytecode
`app.<digest>.nshc`), its assets and icons, each named after its content
so hosts can cache them for good. Deploy the directory to any web server or CDN; `--run` serves it on
`http://127.0.0.1:4173/` for you to open. Cache headers and embedding: [Web](./web.md#publish-an-app).

## Icons

Give one square PNG, ideally 1024×1024, in `nsh.json` (`"icon": "icon.png"`) or with `--icon`:

- **iOS:** compiled by Xcode's `actool` into the app's asset catalog (`Assets.car`), which derives every size iOS
  needs.
- **Android:** resized to 192×192 and used as the launcher icon (`mipmap-xxxhdpi`).
- **macOS:** converted by `sips` to `AppIcon.icns`.
- **Linux:** copied as `<id>.png`, which the `.desktop` file names as its `Icon`.
- **Windows:** resized to 16 to 64 pixels and 256 pixels and embedded in the executable as its icon, which the window,
  Explorer and the taskbar show.
- **Web:** resized to 32 pixels (the favicon), 180 (`apple-touch-icon`), 192 and 512 (the web app manifest).

Without an icon, the system shows its default.

## What is inside

A Rust app's package is its runner, built with your crate and its root mounted, and the assets its crates register
(`assets!()`). A TSX app's package holds its bytecode, its `capabilities.json` (when it declares capabilities) and the
assets it imports, next to the prebuilt runtime:

| Target | Runtime | A TSX app |
|---|---|---|
| iOS | the `nsh-ios-app` executable | `<Name>.app/nsh/bundle.nshc`, `nsh/assets/…` |
| Android | `classes.dex`, `lib/<abi>/libnsh.so` (without symbols, stored uncompressed, 16 KB aligned) | `assets/nsh/bundle.nshc`, `assets/nsh/assets/…` |
| macOS | the `nsh-macos-app` executable, renamed `<Name>` | `<Name>.app/Contents/Resources/nsh/bundle.nshc`, `nsh/assets/…` |
| Linux | the `nsh-linux-app` executable, renamed `<Name>` | `<Name>/nsh/bundle.nshc`, `nsh/assets/…` |
| Windows | the `nsh-windows-app.exe` executable, renamed `<Name>.exe` | `<Name>\nsh\bundle.nshc`, `nsh\assets\…` |
| Terminal | `nsh-tui-app`, renamed `<Name>` (`<Name>.exe` on Windows) | `<Name>/nsh/bundle.nshc`, `nsh/assets/…` |
| Web | `nsh.<digest>.wasm`, `nsh.<digest>.js` | `<Name>/app.<digest>.nshc`, `assets/…`, `index.html` |

A packaged app registers no [native components](./native-components.md); for those, embed NSH in your own app.

## Finding the runtime

A Rust app builds its own runners. For TSX apps, `nsh package` looks for the prebuilt runtime next to the CLI (`bin/../runtime` in the distribution). In a checkout of
NSH it uses `target/<triple>/<profile>` and `target/android/<profile>`, with the CLI's own profile (a debug CLI uses
debug runtimes): build them with `cargo build -p nsh-ios-app --target aarch64-apple-ios-sim` (or `aarch64-apple-ios`
for devices) and `cargo xtask android` (add `--release` for a release CLI); `nsh-macos-app` (on macOS), `nsh-linux-app` (on Linux), `nsh-windows-app` (on Windows) and `nsh-tui-app` (on any of them) are built for this
machine in `target/<profile>` (`cargo build -p nsh-macos-app`, `cargo build -p nsh-linux-app`, `cargo build -p nsh-windows-app`, `cargo build -p nsh-tui-app`); the web runtime is built with the `web` profile whatever the CLI's, into `target/wasm32-unknown-unknown/web/`. The environment variable `NSH_RUNTIME`
points the CLI at another directory laid out like the distribution's `runtime/` (`ios/iphoneos`,
`ios/iphonesimulator`, `android/release`, `macos`, `linux`, `windows`, `gpui`, `tui`, `web`, ...).

## See also

- [CLI](./cli.md): every command
- [Signed packages](./signed-packages.md): updates apps download
- [Project structure](./project-structure.md): `nsh.json` and the files of an app
