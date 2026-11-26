---
title: Packaging
description: Build installable TSX and Rust apps with nsh package for iOS devices, the iOS simulator, Android, macOS, Windows, Linux and the web, with app metadata, icons, signing and distribution outside the stores.
order: 19
group: publishing
---

# Packaging

`nsh package` turns an app into something you can install: a `.app` for the iOS simulator, a signed `.ipa` for iOS
devices, a signed `.apk` or `.aab` (Android App Bundle, for Google Play) for Android, a signed `.app` (ad hoc without
`--sign`) for macOS, a directory and `.tar.gz` for Linux, a directory, `.zip` and installer (`<Name>-setup.exe`, with Inno Setup) for Windows, or a static site for the web. It needs no Xcode project and no Gradle.

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
| `icon` | string \| object | none | A square PNG, ideally 1024×1024, relative to `nsh.json`, or one per platform ([Icons](#icons)). |

`nsh.json` also holds `rust` and `root` (the app's crates and its root component, [Building with Rust](./rust.md)),
`theme` and `appearance`, `tailwind` (see [Tailwind](./tailwind.md)), `capabilities` (see
[Sandbox and capabilities](./sandbox-and-capabilities.md)), `android` (`targetSdk`, `usesCleartextTraffic`, `permissions`, `libraries`, `manifestPlaceholders`, `queries` and `application`, [below](#target-api-level)), `ios` and `macos` (the `Info.plist` keys and entitlements
of their packages, [below](#infoplist-keys-and-entitlements); `ios.extensions` and `macos.extensions`, [iOS app extensions](#app-extensions) and [macOS app extensions](#macos-app-extensions); `macos.activationPolicy`, a [menu bar app](./macos.md#menu-bar-apps)) and `updater`, which makes desktop packages update themselves
(see [App Updates](./app-updates.md)) and every native package take [OTA updates](./ota-updates.md); [Project structure](./project-structure.md#nshjson) lists
every key. A key or value NSH cannot read is reported as a warning and left out, so an app written for a newer NSH
still builds with an older one, and the warning catches a typo.

Every key above can be overridden on the command line, which is handy in CI:

```sh
nsh package --target android --app-version 1.4.0 --build 42
```

## Options

| Flag | Description |
|---|---|
| `--target <ios \| ios-simulator \| android \| macos \| linux \| windows \| web>` | What to build for (required). |
| `-o, --out <dir>` | Output directory. Default `.nsh/out`. |
| `--name <name>` | Display name. |
| `--id <id>` | Bundle identifier, such as `com.example.app`. |
| `--app-version <version>` | Version, such as `1.2.0`. |
| `--build <n>` | Build number. |
| `--icon <png>` | App icon: a square PNG, ideally 1024×1024. |
| `--sign <identity>` | iOS and macOS: the code signing identity (for iOS devices, or macOS packages with Hardened Runtime and a secure timestamp). |
| `--profile <file>` | iOS: the provisioning profile for devices (`.mobileprovision`). Repeat it to give each [app extension](#app-extensions) its own. |
| `--keystore <file>` | Android: a release keystore (default: the debug key). |
| `--key-alias <alias>` | Android: the key alias in the keystore. |
| `--keystore-password <password>` | Android: the keystore password; also read from `NSH_KEYSTORE_PASSWORD`. |
| `--abi <abi>` | Android: the ABIs of the APK, repeated or separated by commas (default: `arm64-v8a` and `armeabi-v7a`). |
| `--format <apk \| aab>` | Android: an APK (default), installed directly, or an Android App Bundle for Google Play ([below](#google-play-app-bundles)). |
| `--arch <arm64 \| x86_64 \| universal>` | macOS: the processors the app runs on: Apple silicon, Intel, or both in one universal executable ([below](#macos)). Default: this Mac's. |
| `--run` | Install and launch afterwards: in the iOS simulator, or on the Android device or emulator `adb` sees; macOS, Linux and Windows apps are launched on this machine; a web site is served on this machine and opened in the browser. Not for `--target ios`. |
| `--asset-url <URL>` | Web: the http(s) URL the site's files are served from, a CDN, as the page names them; `index.html` and `manifest.webmanifest` stay at the page's address (named relatively, as without the flag), and the CDN answers with `Access-Control-Allow-Origin`. Default: next to the page, named relatively. `--run` serves the site from this machine as it is, so it goes without it. |

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

- The executable is checked for an `arm64` slice. `UIRequiredDeviceCapabilities` defaults to `["arm64"]`;
  `ios.infoPlist` can replace this list. Xcode and SDK build metadata is read from the active Xcode toolchain
  and written into `Info.plist` before signing.
- The provisioning profile is copied into the app as `embedded.mobileprovision`.
- The entitlements come from the profile, with the app's own from `nsh.json` `ios.entitlements` checked against it
  ([below](#infoplist-keys-and-entitlements)). NSH checks that the profile's application identifier covers the app's `id`
  (wildcard profiles such as `TEAMID.*` or `TEAMID.com.example.*` work) and stops with an error otherwise.
- The app's extensions, if any, are signed first, each with its own profile ([App extensions](#app-extensions)).
- The app is signed with `codesign` using the identity, then zipped into an `.ipa` (`Payload/<Name>.app`).

Find your identities with:

```sh
security find-identity -v -p codesigning
```

Without `--sign` and `--profile`, NSH writes an unsigned `.nsh/out/<Name>.app` and tells you so; it cannot be installed on a
device as it is.

The app supports iPhone and iPad, portrait and landscape (portrait upside down on iPad only), and needs iOS 15.0 or
newer, or the later version it names ([Minimum system version](#minimum-system-version)).

### App extensions

Widgets, Live Activities, notification service extensions and other app extensions are bundles of their own
(`.appex`) that iOS finds in the app's `PlugIns/` folder. Build them with Xcode or `swiftc`, then list them under
`ios.extensions` in the app's `nsh.json`, relative to `nsh.json`, as `android.libraries` lists Java libraries:

```json
{
  "ios": {
    "extensions": [
      {
        "path": "ios/build/iphoneos/Widget.appex",
        "simulatorPath": "ios/build/iphonesimulator/Widget.appex",
        "entitlements": { "com.apple.security.application-groups": ["group.com.example.app"] }
      }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `path` | The extension built for devices. |
| `simulatorPath` | The extension built for the simulator. Without it, simulator packages carry `path` when it is built for the simulator and leave the extension out (with a warning) when it is not. |
| `entitlements` | The extension's entitlements, as `ios.entitlements` are the app's ([below](#infoplist-keys-and-entitlements)). |

Each package copies the extensions into `PlugIns/` and gives them the app's `version` and `build`: an extension's
version should match its app's (App Store Connect flags a mismatch). An extension's identifier must start with the app's (`com.example.app.Widget` for
`com.example.app`). The simulator package signs them ad hoc; the device package signs each one with the profile for its
identifier, which it carries as `embedded.mobileprovision`, before it signs the app. `nsh run --target ios` carries them
too: the simulator's development host runs every TSX app, so each extension takes the host's identifier in place of
the app's (`com.longbridge.nsh.host.Widget`).  Pass one `--profile` for the app
and one for each extension; a profile that names a bundle's identifier is taken before a wildcard that covers it:

```sh
nsh package --target ios \
  --sign "Apple Distribution: Example Inc (ABCDE12345)" \
  --profile AppStore.mobileprovision \
  --profile AppStoreWidget.mobileprovision
```

Code the app and an extension share, such as a Live Activity's attributes, is built into each of them. They share
data through an app group, which both list in their entitlements. An app that starts Live Activities also declares
`NSSupportsLiveActivities` in its own `Info.plist`, through `ios.infoPlist`:

```json
{
  "ios": { "infoPlist": { "NSSupportsLiveActivities": true } }
}
```

## Android

```sh
nsh package --target android --run
```

Writes `.nsh/out/<Name>.apk`. The APK is assembled directly with the SDK's build tools (`aapt2`, `zipalign`, `apksigner`),
without Gradle. Requirements:

- The Android SDK, found through `ANDROID_HOME` (or `ANDROID_SDK_ROOT`, or `~/Library/Android/sdk`), with build tools
  and the `platforms;android-35` package. NSH tells you the `sdkmanager` command when one is missing.
- A JDK, to create the debug keystore the first time and to build the [Java libraries](#java-code) an app lists.
- For a Rust app, the Android NDK (`sdkmanager "ndk;<version>"`, or `ANDROID_NDK_HOME`), which builds its
  `libnsh.so`.

The app targets API 35 (`targetSdkVersion`, what Google Play requires) unless `nsh.json` names another level, and
needs API 26 (Android 8) or newer. It contains native code for the ABIs of phones,
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

### Target API level

`android.targetSdk` in `nsh.json` sets the API level the app targets (default 35, at least 28). The app also compiles
against that level, so the SDK needs its platform (`sdkmanager "platforms;android-36"`):

```json
{
  "android": { "targetSdk": 36 }
}
```

### Plain HTTP

Packaged apps make requests over HTTPS. For servers without TLS, such as one on the local network,
`android.usesCleartextTraffic` lets the app make plain `http://` requests as well
([`android:usesCleartextTraffic`](https://developer.android.com/guide/topics/manifest/application-element#usesCleartextTraffic)):

```json
{
  "android": { "usesCleartextTraffic": true }
}
```

Development builds (`nsh run --target android`) always allow plain HTTP: they load the app from the dev server over it.

### Permissions

The manifest declares the permissions NSH's own features need: `INTERNET`, `ACCESS_NETWORK_STATE` for
[`network()`](./device-and-environment.md#the-network), `POST_NOTIFICATIONS` for
[notifications](./sandbox-and-capabilities.md#notifications), `RECORD_AUDIO` and `CAMERA` for a web view's `media`. `android.permissions` adds
others, for code of the app or an extension that calls Android itself: a bare name is one of Android's
(`android.permission.<NAME>`), a dotted one is written as it is.

```json
{
  "android": { "permissions": ["ACCESS_WIFI_STATE", "com.example.permission.READ_ORDERS"] }
}
```

A normal permission such as `ACCESS_WIFI_STATE` is granted when the app is installed. A runtime permission
(`ACCESS_FINE_LOCATION`, say) is only declared: the app's own code still asks the user for it. The TSX development
host (`nsh run --target android` of a TSX app) declares none of these; a Rust app's `nsh run` builds its package and
declares them.

### Java code

Rust reaches most Android APIs through JNI, but some take a class the app defines (a listener, a callback, a
`PrintDocumentAdapter`), and some SDKs come as Java libraries. `android.libraries` in the app's `nsh.json` lists jar,
Android library (`.aar`) and dex files, relative to `nsh.json`. An nshm lists its own in its `Cargo.toml`
([What the packaged app needs](./nshm.md#what-the-packaged-app-needs)), so the apps that use it list nothing:

```json
{
  "android": { "libraries": ["android/libs/vendor-sdk.jar", "java/out/glue.jar"] }
}
```

The package turns the jars into dex with the SDK's `d8` and carries their classes after NSH's runtime, where the
app's class loader finds them. The files a jar carries besides its classes (`META-INF/services/...` for
`ServiceLoader`, for one) go to the root of the package; those under `assets/` are the package's assets, as Android's
Gradle plugin makes them. A dex file goes in as it is, without `d8`, so a class it defines again besides a jar is not found
when packaging. A file listed twice, or by two
crates, goes in once; a class that two different files define stops the build, naming both files. An app that lists
no libraries is packaged as before, without `d8`.

The libraries are local files: NSH does not download them or resolve Maven dependencies, so list the libraries an SDK
depends on as well. The third-party tool [nsh-maven](https://github.com/SuperNSH/maven) resolves a library from Maven
repositories with what it depends on (`nsh-maven add com.google.firebase:firebase-messaging:26.0.1`), downloads the
files into the app and lists them here; with `--crate` it lists them in an nshm crate's `Cargo.toml`.

An Android library (`.aar`) brings more than its classes, which go the jars' way: its native libraries
(`jni/<abi>/*.so`) go in for the ABIs the package has, stored uncompressed like NSH's own; its assets join the app's
own; its resources (`res/`) join the package's, and its code reads them through its `R` class as it was built to; and
its manifest's permissions, features, `<queries>` and components join the app's manifest, its relative class
names (`.PushService`) completed with its package and `${applicationId}` filled in with the app's. Components that
several libraries declare under one name (a startup provider each adds an initializer to) become one. Other
placeholders in its manifest, or in a crate's `android.application`, take their values from
`android.manifestPlaceholders`, which only the app's `nsh.json` sets: they are the app's, such as a service's key. The shared development host that
`nsh test --target android` installs reads no app's `nsh.json`, so it leaves them empty, with a warning.

```json
{
  "android": {
    "libraries": ["android/libs/push-sdk-5.2.0.aar"],
    "manifestPlaceholders": { "PUSH_APP_KEY": "…" }
  }
}
```

Each library goes in once, as its manifest's package names it: the same file from two crates goes in once, two
versions of one library stop the build naming both, and the version the app lists in its own `nsh.json` is the one the
package takes. The package also stops, naming the library, when it needs what an NSH app does not have: a minimum API
level above 26, a newer platform than `android.targetSdk`, an `Application` class of its own, a manifest merge rule
(`tools:node="remove"`, `tools:replace`), native libraries that leave out an ABI the package has, or resources
without the `R.txt` Android's build writes next to them.

Resources share one namespace, as in any Android app. When several define a resource of one name for one configuration
(density, night mode, language...), the package's own win (`android/res/`), then the libraries the app's `nsh.json`
lists, an earlier one over a later one, then its crates' libraries, the crate whose name sorts first over the others.
A style is taken whole from the one that wins, not item by item. What NSH makes for the package (its icon, launch
screen and notification sounds) is the package's in every configuration: a library's resources of those names are left
out, with a warning. A library's `R.txt` also lists the resources of the libraries it was built with; those no library
listed defines are left out of its `R` class, with one note. A library's code that reads such a resource stops the
build, naming the library, the class and the resource: list the library that has it.

Compile your own Java sources against the platform's `android.jar` into a jar:

```sh
javac --release 11 -classpath "$ANDROID_HOME/platforms/android-35/android.jar" -d java/classes java/src/*.java
jar cf java/out/glue.jar -C java/classes .
```

A thread Rust started finds only the system's classes through JNI's `FindClass`; load the app's classes from the
activity's class loader (`Context.getClassLoader()`) there.

An NSH app has no `Application` class of its own, so an SDK that must be initialized from one, or must be its
subclass, cannot be used. An SDK that starts with the app is initialized by a content provider, which its AAR declares
itself, or which an nshm declares in its `android.application`:

```toml
[package.metadata.nsh.features.push.android]
libraries = ["android/libs/push-sdk.jar", "android/libs/push-glue.jar"]
application = ['<provider android:name="com.example.push.Init" android:authorities="${applicationId}.push-init" android:exported="false"/>']
```

`nsh run --target android` carries the libraries too: a TSX app's in its development host, a Rust app's in the package
it builds. The development host has the same package name for every app, so an SDK that checks the app's package name
(a push service's SDK, a maps SDK) works only in the app's own package: try it with `nsh package --target android --run`.

### Components and queries

A class the system starts (a `<service>`, a `<receiver>`, a `<provider>`) works only once the manifest declares it, and
an SDK may need `<meta-data>`, or `<queries>` entries to see other apps. `android.application` adds elements of the
manifest's `<application>`: `<service>`, `<receiver>`, `<provider>`, `<activity>` and `<meta-data>`. `android.queries`
adds `<intent>`, `<package>` and `<provider>` elements of its `<queries>`. Each entry is one element, written out whole;
`${applicationId}` in it becomes the app's package, another `${name}` the value `android.manifestPlaceholders` gives it.
An entry that is not one such element, carries `tools:` attributes (those are for libraries' manifests) or takes a name
NSH declares itself (its `com.longbridge.nsh.*` classes and meta-data, the `${applicationId}.files` authority of its
file provider) is left out with a warning:

```json
{
  "android": {
    "libraries": ["java/out/classes.dex"],
    "application": [
      "<receiver android:name=\"com.example.orders.SyncReceiver\" android:exported=\"false\"/>",
      "<provider android:name=\"com.example.orders.Files\" android:authorities=\"${applicationId}.orders\" android:exported=\"false\"/>"
    ],
    "queries": ["<package android:name=\"com.example.wallet\"/>"]
  }
}
```

The crates the app links add theirs the same way ([What the packaged app needs](./nshm.md#what-the-packaged-app-needs)),
after the app's. When the app has Android libraries (`.aar`), these entries are merged with what the libraries declare:
one of the same name as a library's (`<meta-data>` for a provider a library declares) joins it. `<application>`'s own
attributes stay NSH's. The development host (`nsh run` of a TSX app, and
`nsh test --target android`) declares the crates' entries but not the app's own; a Rust app's `nsh run` builds its
package and declares them.

### Google Play: App Bundles

Google Play takes Android App Bundles, not APKs. `--format aab` writes `.nsh/out/<Name>.aab` instead of the APK, from
the same app, without Gradle or bundletool; Google Play builds from it the APKs each device installs (one per ABI). The
bundle is signed with `jarsigner` from the JDK, with the same `--keystore` options: that key is the upload key you
register in Play App Signing.

```sh
NSH_KEYSTORE_PASSWORD=… nsh package --target android --format aab \
  --keystore release.jks --key-alias upload
```

`--run` installs APKs, so it does not take `--format aab`; to try a bundle on a device, use
[bundletool](https://github.com/google/bundletool) (`build-apks`, then `install-apks`).

## macOS

```sh
nsh package --target macos --run
```

Writes `.nsh/out/<Name>.app`: the executable in `Contents/MacOS/`, and `nsh/assets/…`, `nsh/app.json` (the window
title, the app's appearance, its activation policy and nsh.json's window options) and a TSX app's `nsh/bundle.nshc` in
`Contents/Resources/`. Without `--sign`, the app is signed ad hoc; it needs macOS 14 or later, or the later version it
names ([Minimum system version](#minimum-system-version)). See [macOS](./macos.md#packaging).

To sign the app for distribution, pass `--sign <identity>` (such as `"Developer ID Application: …"` or
`"Apple Development: …"`):

```sh
nsh package --target macos --sign "Developer ID Application: Example Inc (ABCDE12345)"
```

When signed with a certificate, NSH enables Hardened Runtime (`--options runtime`) and a secure timestamp
(`--timestamp`) as notarization requires, signs any embedded extensions and their nested frameworks/libraries inside-out
first, signs the `.app`, and verifies the result with `codesign --verify --deep --strict`.

The app runs on this Mac's processor. `--arch` picks another: `x86_64` for Intel Macs, `arm64` for Apple silicon, or
`universal` for both in one executable. A runner for another processor needs its Rust target:

```sh
rustup target add x86_64-apple-darwin
nsh package --target macos --arch universal
```

### macOS app extensions

Prebuilt macOS app extensions (`.appex` bundles built with Xcode or `swiftc`) can be listed under `macos.extensions` in
the app's `nsh.json`, relative to `nsh.json`:

```json
{
  "macos": {
    "extensions": [
      {
        "path": "macos/build/Share.appex",
        "entitlements": {
          "com.apple.security.app-sandbox": true,
          "com.apple.security.application-groups": ["TEAM123456.com.example.app"]
        }
      }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `path` | The macOS `.appex` bundle directory, containing `Contents/Info.plist` and `Contents/MacOS/<executable>`. |
| `entitlements` | The extension's entitlements, as `macos.entitlements` are the app's ([below](#infoplist-keys-and-entitlements)). |

Each package copies the extensions into `Contents/PlugIns/` and syncs their `CFBundleShortVersionString` and
`CFBundleVersion` to match the app's `version` and `build`. Each extension's bundle identifier must start with the app's
(`<app_id>.`), and when `CFBundleSupportedPlatforms` is present it must include `MacOSX`. Before signing the `.app`,
NSH signs each extension inside-out — nested `.framework` and `.dylib` items in `Contents/Frameworks/` first (with no
entitlements), then the `.appex` with its own entitlements — using the package's signing identity (ad hoc or `--sign`).

### Sign, notarize and distribute

A Mac app is distributed outside the Mac App Store as a signed and notarized `.app`, downloaded from your site or a
GitHub Release. `nsh package --target macos --sign …` builds the app and signs it with your Developer ID;
notarization, stapling and uploading are done with Apple's command line tools and your release host.
[App Updates](./app-updates.md) then keeps installed copies up to date.

`nsh publish` has no macOS store upload: NSH does not package for the Mac App Store yet.

#### Before the first release

Once per developer account:

1. **Join the Apple Developer Program.**
2. **Create a Developer ID Application certificate** (Certificates, Identifiers & Profiles → Certificates; only the
   account holder can create one) and install it in the login keychain of the Mac (or CI runner) that packages the
   app. `security find-identity -v -p codesigning` lists it as
   `Developer ID Application: Example Inc (ABCDE12345)`.
3. **Set up notarization credentials** for `notarytool`, stored once in the keychain under a profile name. With an App
   Store Connect team API key (the same kind [iOS uploads](./publish.md#before-the-first-release) use):

   ```sh
   xcrun notarytool store-credentials notes-notary \
     --key /secure/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --issuer 69a6de70-0000-0000-0000-000000000000
   ```

   or with an Apple ID and an app-specific password: `xcrun notarytool store-credentials notes-notary --apple-id
   you@example.com --team-id ABCDE12345`.

#### Configure the app

| Key | In the build | Notes |
|---|---|---|
| `id` | `CFBundleIdentifier` | Also the app's [storage](../modules/nsh.md#storage) location; keep it stable. |
| `name` | The `.app` name and `CFBundleName` | |
| `version`, `build` | `CFBundleShortVersionString`, `CFBundleVersion` | `version` must be semver and grow for [self-updates](./app-updates.md). |
| `icon` (or `icon.macos`) | `AppIcon.icns` | macOS artwork sits inset on a transparent canvas ([Icons](./packaging.md#icons)). |
| `macos.infoPlist` | `Info.plist` keys | Usage descriptions and other keys ([Info.plist keys](./packaging.md#infoplist-keys-and-entitlements)). |
| `macos.entitlements` | The app's entitlements | Signed into the app with Hardened Runtime; add the exceptions it needs, such as camera access. |
| `LSMinimumSystemVersion` in `macos.infoPlist` | The lowest macOS that opens the app | Default macOS 14 ([Minimum system version](./packaging.md#minimum-system-version)). |
| `macos.extensions` | `Contents/PlugIns/` | Prebuilt `.appex` bundles, signed inside-out ([macOS app extensions](./packaging.md#macos-app-extensions)). |

#### Build and sign

```sh
nsh package --target macos --arch universal \
  --sign "Developer ID Application: Example Inc (ABCDE12345)"
```

This writes `.nsh/out/<Name>.app`. With a certificate, NSH signs nested frameworks and extensions first, then the app,
with Hardened Runtime (`--options runtime`) and a secure timestamp (`--timestamp`) as notarization requires, and
verifies the result with `codesign --verify --deep --strict`. `--arch universal` runs on both Apple silicon and Intel
Macs (it needs `rustup target add x86_64-apple-darwin` for a Rust app); leave it out for this Mac's processor only.
Without `--sign` the app is signed ad hoc, which runs on the Mac that built it but is stopped by Gatekeeper elsewhere.

#### Notarize and staple

Apple scans a notarized app for malicious content and records it, so Gatekeeper opens it without a warning. Submit a
zip of the app, wait for the result, then staple the ticket to the app so it opens offline too:

```sh
cd .nsh/out
ditto -c -k --keepParent Notes.app Notes-notarize.zip
xcrun notarytool submit Notes-notarize.zip --keychain-profile notes-notary --wait
xcrun stapler staple Notes.app
spctl --assess --type execute --verbose Notes.app   # "accepted, source=Notarized Developer ID"
```

If the submission is `Invalid`, `xcrun notarytool log <submission-id> --keychain-profile notes-notary` lists every
problem.

#### Distribute it

Archive the stapled app for download. A zip made with `ditto` keeps its signature and extended attributes:

```sh
ditto -c -k --keepParent Notes.app Notes-1.4.0-macos.zip
```

With [`"updater"`](./app-updates.md#set-the-source) in `nsh.json`, `nsh package` also writes
`<Name>-<version>-macos-<arch>.tar.gz` for self-updates. It holds the app as packaged, before notarization: archive the
stapled app again under the same name, then write the manifest, as [App Updates](./app-updates.md#publish-a-release)
describes:

```sh
tar -czf Notes-1.4.0-macos-aarch64.tar.gz Notes.app
nsh update-manifest *.tar.gz --notes CHANGES.md --key keys/update.secret
```

Upload the archives, `latest.json` and its signature to the GitHub Release or your host. Installed copies check the
manifest, download the archive, verify it and the app's code signature, and replace themselves.

#### Common errors

| Problem | What to do |
|---|---|
| `codesign` cannot find the identity | The certificate is not in the keychain the build uses, or its private key is missing: import the `.p12` exported with the key. |
| `errSecInternalComponent` while signing on CI | The keychain is locked: unlock it (`security unlock-keychain`) and allow `codesign` to use the key (`security set-key-partition-list`). |
| Notarization `Invalid`: not signed with a valid Developer ID certificate | The app was signed ad hoc or with an Apple Development certificate: package with `--sign "Developer ID Application: …"`. |
| Notarization `Invalid`: the signature does not include a secure timestamp | Sign through `nsh package --sign`, which adds it; do not re-sign by hand without `--timestamp`. |
| "Notes is damaged and can't be opened" after download | The archive lost the signature (zipped with a tool that drops attributes, or modified after signing): archive with `ditto` or `tar` after stapling. |
| Gatekeeper warns although notarization succeeded | The ticket was not stapled and the Mac is offline, or the downloaded app is not the one notarized: staple, then archive again. |
| The app cannot use the camera, microphone or other protected resources | Add the usage description to `macos.infoPlist` and the Hardened Runtime exception to `macos.entitlements`. |

## Linux

```sh
nsh package --target linux --run
```

Writes `.nsh/out/<Name>/` (the executable `<Name>`, `nsh/assets/…`, `nsh/app.json` with the window title, the
application id and nsh.json's window options, a TSX app's `nsh/bundle.nshc`, `<id>.desktop` and the icon
`<id>.png`) and the same as `.nsh/out/<Name>.tar.gz`. Package on
Linux: the runner is built for the machine it is built on. GTK 4 (4.14 or later), Pango and WebKitGTK 6.0 (for web
views) must be installed where the app runs. Installing it and the desktop entry: [Linux](./linux.md#packaging).


### AppImage and Flatpak

`--format appimage` or `--format flatpak` also writes the desktop entry, the 256×256 icon and AppStream metainfo
(`<id>.metainfo.xml`) from `nsh.json` and its `store` section ([Store listing](./publish.md#store-listing)).

#### AppImage

```sh
nsh package --target linux --format appimage
```

Writes `.nsh/out/<Name>.AppDir` and `.nsh/out/<Name>-<arch>.AppImage`, besides the directory and archive. The
AppImage carries the desktop entry, icon and metainfo, and runs on the system's GTK 4 and WebKitGTK like the archive,
so the target system needs them installed. Attach it to your release; users run:

```sh
chmod +x Counter-x86_64.AppImage
./Counter-x86_64.AppImage
```

#### Flatpak

```sh
nsh package --target linux --format flatpak
```

Writes `.nsh/out/flatpak/<id>.yml`, a manifest that installs the package's archive on the GNOME runtime, which
provides GTK 4 and WebKitGTK. When `flatpak-builder` is installed it also builds it and writes
`.nsh/out/<Name>.flatpak`, a single-file bundle to test or hand out:

```sh
flatpak install --user .nsh/out/Counter.flatpak
flatpak run io.github.example.Counter
```

Requirements: [appimagetool](https://github.com/AppImage/appimagetool/releases) on `PATH` or in `NSH_APPIMAGETOOL`
(without FUSE, set `APPIMAGE_EXTRACT_AND_RUN=1`); for a local Flatpak build, `flatpak`, `flatpak-builder` and the GNOME
runtime and SDK. AppImage bundles NSH but not GTK 4 or WebKitGTK; when an AppImage starts without a window, the system
lacks them, and the Flatpak brings them. Releasing on Flathub: [Publishing](./publish.md#publish-to-flathub).

### Distribute

`nsh package --target linux` writes the app as a directory and a `.tar.gz` of it, with a desktop entry and the icon.
You upload the archive to your site or a GitHub Release, and users unpack it and install the desktop entry;
[App Updates](./app-updates.md) keeps installed copies up to date.

`--format appimage` and `--format flatpak` also write an AppImage and a Flatpak ([above](#appimage-and-flatpak));
`nsh package` does not write `.deb` or `.rpm` packages yet. Releasing on Flathub is
[Publishing](./publish.md#publish-to-flathub).

#### Before the first release

Package on Linux: the runner is built for the machine it is built on, so package on the processor you publish for
(`x86_64` or `aarch64`), on a distribution old enough for the users you support, as a newer glibc than theirs stops the
app from starting. Ubuntu 24.04 is a good base for current desktops. The build needs the development packages of
GTK 4 (4.14 or later), Pango and WebKitGTK 6.0 ([Linux: Requirements](./linux.md#requirements)).

#### Configure the app

| Key | In the package | Notes |
|---|---|---|
| `id` | `<id>.desktop`, `StartupWMClass`, the GTK application id, `<id>.png` | Desktops match the app's windows to its launcher by it; reverse-DNS, as `com.example.notes`. Keep it stable. |
| `name` | The executable `<Name>`, the directory, and the desktop entry's `Name` | |
| `version` | Self-update archives | Must be semver and grow for [self-updates](./app-updates.md). |
| `icon` (or `icon.linux`) | `<id>.png`, named by the desktop entry's `Icon` | A square PNG that fills its canvas ([Icons](./packaging.md#icons)). |

#### Build

```sh
nsh package --target linux
```

```text
.nsh/out/<Name>/
  <Name>          the executable
  nsh/            the app's code, assets and app.json
  <id>.desktop    the desktop entry
  <id>.png        the icon
.nsh/out/<Name>.tar.gz
```

[Packaging: Linux](./packaging.md#linux) has the details.

#### Distribute it

Upload `<Name>.tar.gz` to your site or a GitHub Release, and tell users which libraries to install. The runtime needs
GTK 4, Pango and WebKitGTK 6.0:

| Distribution | Install |
|---|---|
| Debian, Ubuntu | `sudo apt install libgtk-4-1 libwebkitgtk-6.0-4` |
| Fedora | `sudo dnf install gtk4 webkitgtk6.0` |
| Arch | `sudo pacman -S gtk4 webkitgtk-6.0` |

Installing for one user takes four steps, which an install script can run: unpack the directory somewhere stable, link
the executable onto the `PATH`, and copy the desktop entry and the icon where desktops find them.

```sh
mkdir -p ~/.local/opt ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/256x256/apps
tar -xzf Notes.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/Notes/Notes ~/.local/bin/Notes
cp ~/.local/opt/Notes/com.example.notes.desktop ~/.local/share/applications/
cp ~/.local/opt/Notes/com.example.notes.png ~/.local/share/icons/hicolor/256x256/apps/
```

The executable finds its `nsh/` directory through the link. Check the desktop entry with
`desktop-file-validate ~/.local/share/applications/com.example.notes.desktop` before you ship it.

With [`"updater"`](./app-updates.md#set-the-source) in `nsh.json`, `nsh package` also writes
`<Name>-<version>-linux-<arch>.tar.gz` for self-updates. Upload it with the manifest
([App Updates](./app-updates.md#publish-a-release)):

```sh
nsh update-manifest *.tar.gz *.zip --notes CHANGES.md --key keys/update.secret
```

#### Common errors

| Problem | What to do |
|---|---|
| `error while loading shared libraries: libgtk-4.so.1` (or `libwebkitgtk-6.0.so.4`) | Install the runtime libraries above. |
| `version 'GLIBC_2.39' not found` | The app was packaged on a newer distribution than the user's: package on an older one. |
| The app does not show in the launcher | The desktop entry is not in `~/.local/share/applications`, or its `Exec` does not find the executable: link it onto the `PATH`. |
| The launcher shows a generic icon, or a second icon while the app runs | The icon is not in an icon theme directory, or the desktop entry was renamed: keep the file name `<id>.desktop`, which `StartupWMClass` matches. |
| `exec format error` | The archive was built for another processor: package on `x86_64` and `aarch64` separately. |

## Windows

```sh
nsh package --target windows --run
```

Writes `.nsh\out\<Name>\` (the executable `<Name>.exe` with the app's icon, `nsh\assets\…`, `nsh\app.json` with the
window title, the app id, the version, the appearance and nsh.json's window options, and a TSX app's `nsh\bundle.nshc`)
and the same as `.nsh\out\<Name>.zip`. A TSX app needs no tools; a Rust app's runner is built with Visual Studio Build
Tools. Package on Windows: the runner is built for the machine it is built on, and only Windows can
embed the icon. The app runs from wherever its directory is copied. `nsh package` also writes the Inno Setup script
`.nsh\out\<Name>.iss` and, when Inno Setup 6 is installed, compiles it to `.nsh\out\<Name>-setup.exe`: a per-user
installer (no administrator rights) with a Start menu shortcut, an Installed apps entry, and in-place upgrades. See
[Windows](./windows.md#packaging).

### MSIX

```sh
nsh package --target windows --format msix                  # .nsh/out/<Name>.msix, for the Store
nsh package --target windows --format msix --sign cert.pfx  # signed, to install outside the Store
```

`--format msix` also writes `.nsh\out\<Name>.msix`: the packaged directory with `AppxManifest.xml` (a full-trust
desktop app), the logos made from the app's icon, and the block map. It needs no Windows SDK, so Linux and macOS CI
can make it (the icon is then not embedded in the `.exe`, but the Start menu and the Store use the logos). The
package's identity comes from `nsh.json`:

```json
{
  "windows": {
    "identityName": "12345Example.MyApp",
    "publisher": "CN=0A1B2C3D-1234-5678-9ABC-0123456789AB",
    "publisherDisplayName": "Example Inc."
  }
}
```

Copy `identityName` and `publisher` from Partner Center (the app → Product identity: Package/Identity/Name and
Package/Identity/Publisher); defaults are the app id and `CN=<name>`. The version is `version` with a fourth part 0,
which the Store reserves. The Store signs what it publishes, so submit the unsigned package with
`nsh publish windows` ([Publishing](./publish.md#publish-to-the-microsoft-store)). Outside the Store, Windows installs only signed
packages: `--sign <cert.pfx>` signs it with `signtool` on Windows or `osslsigncode` (2.6 or newer) elsewhere, its
password in `NSH_WINDOWS_CERT_PASSWORD`; the certificate's subject must equal `windows.publisher`.

### Sign and distribute

`nsh package --target windows` writes everything a Windows release needs for direct download: the app's directory, a
`.zip` of it, and a per-user installer built with Inno Setup. You sign the executables with your code signing
certificate and upload them to your site or a GitHub Release; [App Updates](./app-updates.md) keeps installed copies
up to date.

For the Microsoft Store, package an [MSIX](#msix) and submit it with `nsh publish windows`
([Publishing](./publish.md#publish-to-the-microsoft-store)).

#### Before the first release

On the Windows machine (or CI runner) that packages the app:

1. **Install the tools.** A TSX app needs none; a Rust app's runner is built with Visual Studio Build Tools. For the
   installer, install Inno Setup 6: `winget install JRSoftware.InnoSetup`.
2. **Get a code signing certificate** from a certificate authority, or use a cloud signing service such as Azure
   Trusted Signing. Unsigned executables still run, but SmartScreen warns about an unknown publisher, and some
   antivirus products treat them with suspicion.
3. **Install the Windows SDK** for `signtool.exe` (it comes with the Visual Studio installer's Windows SDK component).

#### Configure the app

| Key | In the build | Notes |
|---|---|---|
| `id` | The installer's AppId, the Start menu shortcut's AppUserModelID | Groups the app's windows in the taskbar and identifies it for notifications; a newer installer with the same id upgrades the installed app. Keep it stable. |
| `name` | `<Name>.exe`, the install directory and the Start menu entry | |
| `version` | The installer's version and the Installed apps entry | Must be semver and grow for [self-updates](./app-updates.md). |
| `icon` (or `icon.windows`) | Embedded in `<Name>.exe`, written as `nsh\icon.ico` | Package on Windows: only Windows can embed the icon ([Icons](./packaging.md#icons)). |

#### Build

```powershell
nsh package --target windows
```

```text
.nsh\out\<Name>\           the app: <Name>.exe and nsh\
.nsh\out\<Name>.zip        the same, as an archive
.nsh\out\<Name>.iss        the Inno Setup script
.nsh\out\<Name>-setup.exe  the installer, when Inno Setup 6 is installed
```

The installer needs no administrator rights: it installs for the current user in `%LOCALAPPDATA%\Programs\<Name>`,
adds a Start menu shortcut and an Installed apps entry that uninstalls it, and upgrades an installed copy in place,
closing the app first. The app's data is never touched, by upgrades or by the uninstaller.
[Packaging: Windows](./packaging.md#windows) has the details.

#### Sign

Sign the app's executable before the installer is built, so the installed app is signed too, then sign the installer.
With a certificate in the Windows certificate store:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /n "Example Inc" .nsh\out\Notes\Notes.exe
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" .nsh\out\Notes.iss
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /n "Example Inc" .nsh\out\Notes-setup.exe
signtool verify /pa .nsh\out\Notes-setup.exe
```

`ISCC.exe` compiles the installer again from the script `nsh package` wrote, now with the signed executable; its path
depends on where Inno Setup is installed (`C:\Program Files (x86)\Inno Setup 6\ISCC.exe` for a machine-wide install).
Make the `.zip` again from the signed directory too if you publish it. Always timestamp (`/tr`): the signature then
stays valid after the certificate expires.

#### Distribute it

Upload `Notes-setup.exe` (and the `.zip`, for people who prefer a portable copy) to your site or a GitHub Release.

With [`"updater"`](./app-updates.md#set-the-source) in `nsh.json`, `nsh package` also writes
`<Name>-<version>-windows-<arch>.zip` for self-updates. Put the signed app in it, then write the manifest with the other
platforms' archives ([App Updates](./app-updates.md#publish-a-release)):

```powershell
nsh update-manifest *.zip *.tar.gz --notes CHANGES.md --key keys\update.secret
```

#### SmartScreen

SmartScreen decides by reputation, which grows as people download and run files signed with the same certificate. A
new certificate, or a new kind of certificate, can show the "Windows protected your PC" warning for a while even when
the file is signed. Keep signing every release with the same certificate so the reputation carries over.

#### Common errors

| Problem | What to do |
|---|---|
| No `<Name>-setup.exe` in `.nsh\out` | Inno Setup 6 is not installed, or not where `nsh package` looks: install it with `winget install JRSoftware.InnoSetup`, or compile `.nsh\out\<Name>.iss` with `ISCC.exe`. |
| The executable shows the default icon | It was packaged on macOS or Linux: package on Windows to embed the icon. |
| `signtool` is not recognized | Run it from a Developer PowerShell, or add the Windows SDK's `bin\<version>\x64` directory to `PATH`. |
| `SignTool Error: No certificates were found that met all the given criteria` | The certificate is not in the store `signtool` searches, or `/n` does not match its subject: list them with `certutil -user -store My`. |
| "Windows protected your PC" on a signed installer | SmartScreen reputation is still building for the certificate (above). |
| The installer asks to close the app | It upgrades in place and closes the running copy first; this is expected. |

## Web

```sh
nsh package --target web --run
```

Writes `.nsh/out/<Name>/`, a static site: `index.html`, `manifest.webmanifest`, the page script (`nsh.<digest>.js`)
and `nsh.<digest>.wasm` (a Rust app's engine and crate; for a TSX app the runtime, next to the app's ES module
`app.<digest>.js`), its assets and icons, each named after its content
so hosts can cache them for good. Deploy the directory to any web server or CDN; `--run` serves it on
`http://127.0.0.1:4173/` for you to open. Cache headers and embedding: [Web](./web.md#publish-an-app).

### Host the site

On the web an app is a static site. `nsh package --target web` writes it; you copy the directory to any web server,
object store or static host. There is no store, no signing and no review, and a deploy updates every user on their next
load. `nsh publish` has nothing to do here.

#### Configure the app

| Key | In the site | Notes |
|---|---|---|
| `name` | The page title and the web app manifest's name | |
| `id` | The web app manifest's id | |
| `icon` (or `icon.web`) | The favicon, `apple-touch-icon` and manifest icons | Resized to 32, 180, 192 and 512 pixels ([Icons](./packaging.md#icons)). |
| `appearance` | The page's colors while it loads | |
| `web.base` | The path the site is served under | Needed when the app is opened at its own paths ([Links into the app](./web.md#links-into-the-app)). |
| `web.host` | The page's host script | [The host's functions](./web.md#the-hosts-functions). |

#### Build

```sh
nsh package --target web            # a Rust app, from its directory
nsh package App.tsx --target web    # a TSX app
nsh package --target web --run      # and serve it on http://127.0.0.1:4173/ to try it
```

This writes `.nsh/out/<Name>/` (`--out` for another directory): `index.html`, `manifest.webmanifest`, and every other
file named after its content (`nsh.<digest>.wasm`, `app.<digest>.js`, `assets/…`), with Brotli and gzip copies
beside them. A release changes only `index.html` and the files that really changed. The full list of files and the
runtime's size: [Web: Publish an app](./web.md#publish-an-app).

By default the site uses relative URLs, so it works from any directory of any host. To serve the files from a CDN while
the page stays at the app's own address, pass `--asset-url https://cdn.example.com/notes/`.

#### Deploy

Any static host works. Two rules make the app load fast and update at once:

| Files | `Cache-Control` |
|---|---|
| `index.html`, `manifest.webmanifest` | `no-cache` |
| everything else | `public, max-age=31536000, immutable` |

Serve `.wasm` as `application/wasm`, and send the precompressed `.br` and `.gz` copies to browsers that accept them
([Deploy it](./web.md#deploy-it) has nginx and Caddy settings). Upload the hashed files before `index.html`, so a
visitor never gets a page whose files are not there yet.

##### GitHub Pages

```yaml
on:
  push:
    tags: ["v*"]

permissions:
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/checkout@v4
      # Install nsh (pin the version), then:
      - run: nsh package --target web --out site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - uses: actions/deploy-pages@v4
```

A project site lives under `/<repo>/`; relative URLs handle that. An app opened at its own paths sets
`"web": { "base": "/<repo>/" }` and adds a copy of `index.html` as `404.html` (`cp site/index.html site/404.html`
before the upload), which GitHub Pages answers unknown paths with. GitHub Pages cannot set `Cache-Control` per file, so returning visitors revalidate
the hashed files too; a host that lets you set headers loads faster.

##### An object store and a CDN

```sh
nsh package --target web --out site
aws s3 sync site s3://example-notes --exclude index.html --exclude manifest.webmanifest \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp site/index.html s3://example-notes/ --cache-control no-cache
aws s3 cp site/manifest.webmanifest s3://example-notes/ --cache-control no-cache
```

Configure the CDN to serve `.wasm` as `application/wasm` and to compress with Brotli, or to serve the `.br` copies.

#### Supported browsers

Safari 16.4 (iOS and iPadOS 16.4), Chrome and Edge 97, and Firefox 108 or later. Earlier browsers show a blank page
([Supported browsers](./web.md#supported-browsers)).

#### Common errors

| Problem | What to do |
|---|---|
| A blank page and `Failed to load module script` in the console | The host serves `.js` or `.wasm` with the wrong content type, or the files were not uploaded: check the Network panel. |
| `WebAssembly.instantiateStreaming` fails with an incorrect response MIME type | Serve `.wasm` as `application/wasm`. |
| Opening a path of the app, or reloading on one, gives 404 | Answer every path under the app with `index.html` and set `web.base` ([Links into the app](./web.md#links-into-the-app)). |
| Users see the old version after a deploy | `index.html` is cached: serve it with `Cache-Control: no-cache`. |
| Files from the CDN are blocked by CORS | The CDN must answer with `Access-Control-Allow-Origin` for the page's origin when `--asset-url` names it. |
| A blank page on an older iPhone or Android WebView | The browser is older than the supported ones. |

## Info.plist keys and entitlements

NSH writes the `Info.plist` of iOS and macOS packages, and signs them. An app adds keys of its own, such as export
compliance, an App Store category or App Transport Security exceptions, and entitlements, such as associated domains,
under `ios` and `macos` in `nsh.json`. (The web links that open the app go in `links`, which adds their `applinks:`
entries to iOS packages: [Web links](../modules/nsh.md#web-links).)

```json
{
  "ios": {
    "infoPlist": {
      "ITSAppUsesNonExemptEncryption": false,
      "LSApplicationCategoryType": "public.app-category.finance",
      "NSAppTransportSecurity": {
        "NSExceptionDomains": { "example.com": { "NSIncludesSubdomains": true } }
      }
    },
    "entitlements": {
      "com.apple.developer.associated-domains": ["webcredentials:example.com"]
    }
  },
  "macos": {
    "infoPlist": { "LSApplicationCategoryType": "public.app-category.finance" },
    "entitlements": { "com.apple.security.network.client": true }
  }
}
```

Values are written as property list values: strings, numbers (integers or reals), booleans, arrays and objects
(dictionaries); `null` is an error. A key the app sets replaces NSH's default, so an app may also reword the usage
descriptions NSH adds, narrow the orientations or raise the minimum system version
([below](#minimum-system-version)).

NSH keeps the keys it sets from other `nsh.json` keys or that the packaged app depends on. Setting one is an error that
says what to set instead:

| Keys | Set from |
|---|---|
| `CFBundleIdentifier` | `id` |
| `CFBundleName`, `CFBundleDisplayName` | `name` |
| `CFBundleShortVersionString`, `CFBundleVersion` | `version`, `build` |
| `CFBundleURLTypes` | `schemes` |
| `CFBundleDocumentTypes` | `fileTypes` ([Opening files](../modules/nsh-desktop.md#opening-files)) |
| iOS: `CFBundleIcons`, `CFBundleIcons~ipad`, `CFBundleIconName`; macOS: `CFBundleIconFile` | `icon` |
| iOS: `UIUserInterfaceStyle` | `appearance` |
| iOS: `UIStatusBarStyle`, `UIStatusBarHidden` | `statusBar` |
| iOS: `UILaunchScreen`, when `ios.launchScreen` is set | `ios.launchScreen` ([Launch screen](#launch-screen)) |
| macOS: `LSUIElement` | `macos.activationPolicy` ([Menu bar apps](./macos.md#menu-bar-apps)) |
| `CFBundleExecutable`, `CFBundlePackageType`, `CFBundleSupportedPlatforms`; iOS: `LSRequiresIPhoneOS`, `UIApplicationSceneManifest`, `UIApplicationSupportsMultipleScenes`; macOS: `NSPrincipalClass` | the package itself |
| Entitlements: `application-identifier`, `com.apple.application-identifier`, `com.apple.developer.team-identifier` | `id` and the provisioning profile |

Entitlements:

- **iOS devices** are signed with the entitlements the provisioning profile grants, each of the app's in place of the
  profile's value. Every entitlement the app names must be one the profile grants, with a value it covers (a profile
  grants associated domains as `*` and keychain groups as `TEAMID.*`); otherwise `nsh package` stops and names the
  entitlement, so enable its capability for the app's identifier and download the profile again.
- **The iOS simulator** is signed with the app's entitlements as they are.
- **macOS** packages are signed with the app's entitlements, ad hoc by default or with `--sign <identity>` (Hardened
  Runtime). macOS launches an app with `com.apple.developer.*` entitlements or keychain access groups only under a
  provisioning profile that grants them: `nsh package` warns about them, and a matching profile must be embedded as
  `Contents/embedded.provisionprofile` and signed before the app runs.

### Info.plist text in other languages

The system shows the strings of `Info.plist`, such as the usage descriptions in a permission prompt or the app's name
under its icon, in the user's language when the app has a translation of them. `ios.infoPlistStrings` and
`macos.infoPlistStrings` give them, by language:

```json
{
  "ios": {
    "infoPlist": {
      "NSLocationWhenInUseUsageDescription": "Shows the stores near you."
    },
    "infoPlistStrings": {
      "zh-Hans": {
        "CFBundleDisplayName": "示例",
        "NSLocationWhenInUseUsageDescription": "显示你附近的门店。"
      },
      "ja": { "NSLocationWhenInUseUsageDescription": "近くの店舗を表示します。" }
    }
  }
}
```

Packages write each language's `<language>.lproj/InfoPlist.strings`, and `nsh run` gives the iOS simulator's and Mac
Catalyst's development host the same, so a prompt can be checked in each language before packaging. The system asks
once per app: reset the answer before checking a prompt again, `xcrun simctl privacy booted reset camera <id>` in the
iOS simulator, `tccutil reset Camera <id>` on macOS and Mac Catalyst, with the app's `id`, or under `nsh run` the
development host's.

- **Languages** are named as Xcode names them: a language, then a script or a region if needed, joined with `-` (`en`,
  `ja`, `zh-Hans`, `zh-Hant`, `pt-BR`). Other spellings (`zh-hans`, `zh_TW`, `Chinese`) are an error naming the key.
- **The `Info.plist` value** stays the text of every language without a translation, so each translated key needs one:
  set it in `infoPlist`, or have it from NSH (the app's name, the usage descriptions NSH adds) or from a
  [crate](./nshm.md#what-the-packaged-app-needs). A translation of a key the package's `Info.plist` does not have as a
  string stops `nsh package` with an error naming it: the system would never show it.
- **Translated keys** are the app's own and, of NSH's, only `CFBundleDisplayName` and `CFBundleName`; values are
  strings. A macOS package whose name is translated also says so to Finder (`LSHasLocalizedDisplayName`).
- **The languages are declared** to the system with the app's [`locales`](./i18n.md) (`CFBundleLocalizations`),
  English first: users of a language the app has no translation for see the `Info.plist` text, and the system's own UI
  in the app shows in the translated languages too. A language given as an empty `{}` has no file and is not declared;
  it takes the [crates'](./nshm.md#what-the-packaged-app-needs) translations, which apps take for their own languages
  only.

### Privacy manifest

App Store Connect checks an iOS app's privacy manifest, `PrivacyInfo.xcprivacy`, when it is uploaded: why the app
calls the APIs Apple requires a reason for, whether it tracks and with which domains, and the data it collects
([Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)).
Every iOS package carries one. NSH's runtime is part of the app's executable, so the APIs it calls count as the app's;
packages declare them for every app:

| Category | What in NSH calls it | Reason |
|---|---|---|
| `NSPrivacyAccessedAPICategoryFileTimestamp` | Rust's standard library reading file metadata; the image cache, which ages its files | `C617.1` |
| `NSPrivacyAccessedAPICategorySystemBootTime` | the renderer's timer | `35F9.1` |

`ios.privacyManifest` in `nsh.json` is what the app adds: the APIs its own code and the SDKs it links call, whether it
tracks, and the data it collects. Packages write it at the root of the app before signing it, with NSH's entries joined
to the app's by category: one entry per category, with the reasons of both, each once (an app extension carries its
own, in its `.appex`):

```json
{
  "ios": {
    "privacyManifest": {
      "NSPrivacyTracking": false,
      "NSPrivacyAccessedAPITypes": [
        {
          "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
          "NSPrivacyAccessedAPITypeReasons": ["3B52.1"]
        }
      ]
    }
  }
}
```

Here the package's file timestamp entry gives `3B52.1`, for files people pick, and NSH's `C617.1`, and a system boot
time entry with `35F9.1` follows it.

It takes the four keys of Apple's format (`NSPrivacyTracking`, `NSPrivacyTrackingDomains`,
`NSPrivacyCollectedDataTypes`, `NSPrivacyAccessedAPITypes`) and their entries' keys. An unknown key, a value of the
wrong type or an entry without all its keys is left out with a warning. What App Store Connect would refuse as written
(an entry with no reason, tracking without its domains) is warned about too; App Store Connect still checks the
category and reason codes themselves.

NSH reads no user defaults on iOS (the temperature unit comes from the locale): declare
`NSPrivacyAccessedAPICategoryUserDefaults` only when the app's own code or an SDK it links calls `NSUserDefaults`.

### Minimum system version

Packages run on iOS 15.0 and macOS 14 or later, the systems NSH's runtime runs on. An app that uses the APIs of a
later system, through its own [Rust crate](./rust.md) for example, raises its minimum with the key the system reads:
`MinimumOSVersion` in `ios.infoPlist`, `LSMinimumSystemVersion` in `macos.infoPlist`.

```json
{
  "ios": { "infoPlist": { "MinimumOSVersion": "16.4" } },
  "macos": { "infoPlist": { "LSMinimumSystemVersion": "15.2" } }
}
```

The value is a string of one to three numbers joined by dots (`"15"`, `"15.2"`, `"15.2.1"`) from NSH's minimum up:
`"15.0"` on iOS, `"14.0"` on macOS. The package declares it as written, the app's Rust code (Rust and C alike) is
built for it, and the iOS app icon is compiled for it. A deployment target set in the environment
(`IPHONEOS_DEPLOYMENT_TARGET`, `MACOSX_DEPLOYMENT_TARGET`) is used as it is. A lower version, or a value of another
form, is an error that names NSH's minimum, reported as soon as `nsh.json` is read.

## Icons

Give one square PNG, ideally 1024×1024, in `nsh.json` (`"icon": "icon.png"`) or with `--icon`:

- **iOS:** compiled by Xcode's `actool` into the app's asset catalog (`Assets.car`), which derives every size iOS
  needs.
- **Android:** resized to 192×192 and used as the launcher icon (`mipmap-xxxhdpi`); see adaptive icons below.
- **macOS:** converted by `sips` to `AppIcon.icns`. `nsh run --target macos` and `nsh test --target macos` show the
  PNG in the Dock and the app switcher.
- **Linux:** copied as `<id>.png`, which the `.desktop` file names as its `Icon`.
- **Windows:** resized to 16 to 64 pixels and 256 pixels and embedded in the executable as its icon, which the window,
  Explorer and the taskbar show, and written beside the bundle as `nsh\icon.ico`, which notifications show. Packaged on
  macOS or Linux, the executable keeps the default icon in Explorer, and the window and the taskbar show `icon.ico`.
  `nsh run --target windows` and `nsh test --target windows` show it too.
- **Web:** resized to 32 pixels (the favicon), 180 (`apple-touch-icon`), 192 and 512 (the web app manifest).

Platforms draw icons differently: macOS artwork sits inset on a transparent canvas (824 of 1024 pixels), while
Windows, Linux and Android fill it. Give `icon` an object to use a PNG per platform; its keys are `macos`, `windows`,
`linux`, `ios`, `android` and `web`, and a platform left out gets the system's default:

```json
{
  "icon": {
    "macos": "icon-macos.png",
    "windows": "icon.png",
    "linux": "icon.png"
  }
}
```

`icon.android` also takes an adaptive icon, whose layers the launcher masks to its own shape (circle, squircle, ...).
Each layer is 108×108dp; the inner 72×72dp appears within the mask, and the outer 18dp on each side is left for the
launcher's visual effects. Keep the artwork within the central circle of 66dp: about 61% of the width, 264 pixels of a
432-pixel layer.

```json
{
  "icon": {
    "android": {
      "foreground": "icon-foreground.png",
      "background": "#ffffff",
      "monochrome": "icon-monochrome.png"
    }
  }
}
```

- `foreground`: a square PNG with a transparent background, ideally 432×432 or larger.
- `background`: a color (`"#rrggbb"`, `"#rrggbbaa"`) or a square PNG.
- `monochrome` (optional): the artwork in one color on transparent, which Android 13 and later tint for themed icons.

Only `icon.android` takes this form.

`--icon` replaces it for the target being packaged.

Without an icon, the system shows its default.

## Launch screen

From the tap on the icon until the app's first frame, iOS shows the app's launch screen: the system's background
color in the app's appearance unless `nsh.json` gives one. `ios.launchScreen` sets its color and an image in the
middle of the screen, the same in both appearances or one for each:

```json
{
  "ios": {
    "launchScreen": {
      "background": { "light": "#ffffff", "dark": "#131312" },
      "image": { "light": "launch.png", "dark": "launch-dark.png" }
    }
  }
}
```

- `background` is `#rrggbb` or `#rrggbbaa`, or an object with `light` and `dark`.
- `image` is a PNG relative to `nsh.json`, or an object with `light` and `dark`. It is drawn for 3x screens: the
  system shows it at a third of its size in pixels, so a 288×288 PNG is 96×96 points, centered.

Both are compiled into the app's asset catalog with its icon and named in `UILaunchScreen`, which the app no longer
sets in `ios.infoPlist`. A launch screen that matches the app's first frame (its background, the same image in the
same place) makes the start look seamless. `appearance` picks which of the two the system shows.

On Android, `android.launchScreen` takes the same keys. The package gives the app a theme whose window background is
`background`, so the window matches the app's first frame from the tap on the icon on, and stays behind it. On Android
12 and later the system splash screen also uses `background` (behind the icon too), with `image` in the middle at the
same size as on iOS (a 288×288 PNG is 96×96 dp). Without `image` the splash screen shows the launcher icon. An app
that targets an API level below 31 has no splash screen to show `image` in, though the file is still checked. The dark
values apply in the system's dark mode, and `appearance` set to `light` or `dark` keeps that one.

```json
{
  "android": {
    "launchScreen": {
      "background": { "light": "#ffffff", "dark": "#131312" },
      "image": { "light": "launch.png", "dark": "launch-dark.png" }
    }
  }
}
```

## Camera, Bluetooth and other hardware

A packaged app declares the hardware NSH's own features use, from its `nsh.json`:

| Feature | iOS and macOS | Android |
|---|---|---|
| Web pages that capture media ([`capabilities.webview.media`](./sandbox-and-capabilities.md#webview)) | `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`; on macOS the entitlements `com.apple.security.device.audio-input` and `com.apple.security.device.camera` | `RECORD_AUDIO`, `CAMERA` |
| [`Notifications`](../modules/nsh.md#notifications), when the app grants `notifications` or declares no capabilities | | `POST_NOTIFICATIONS` |

The [nshm](./nshm.md) an app installs add what their features need: `nsh-extra`'s `speech`, for example, the
microphone's and speech recognition's usage descriptions and `RECORD_AUDIO`. Every Android package also declares `INTERNET` and `ACCESS_NETWORK_STATE`. A usage description is what the system shows when the app first asks;
the app's `infoPlist` words it its own way ([above](#infoplist-keys-and-entitlements)).

On iOS and macOS, an app's own [Rust crate](./rust.md) reaches other hardware through the system's frameworks, with the
usage descriptions it needs in `infoPlist` and, on macOS, the entitlements in `entitlements`: the system ends an app
that reaches protected hardware without its usage description.

An Android app that uses other hardware embeds NSH in its own Gradle project
([Android](./android.md#embedding-in-an-android-app)), and an iOS app may do the same in its Xcode project
([iOS](./ios.md#embedding-in-an-ios-app)). That project owns `AndroidManifest.xml` and `Info.plist`, so it declares
what it uses there and writes the platform code itself: a camera preview is a [native component](./native-components.md),
and the app reaches everything else through [`host.call`](./ios.md#talking-to-the-app)
([on Android](./android.md#talking-to-the-app)).

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
| Web | `nsh.<digest>.wasm`, `nsh.<digest>.js` | `<Name>/app.<digest>.js`, `assets/…`, `index.html` |

A packaged app registers no [native components](./native-components.md); for those, embed NSH in your own app.

## Logs

A packaged app logs its warnings, its errors and its `console.log` and `console.info` lines to the platform's log: the
unified log on macOS and iOS, under the app's id (Console, or `log stream --predicate 'subsystem == "com.example.notes"'`),
logcat on Android, the debugger's output on Windows, standard error on Linux and the browser console on the web. See
[A packaged app's logs](./dev-server-and-debugging.md#a-packaged-apps-logs).

## Finding the runtime

A Rust app builds its own runners. For TSX apps, `nsh package` looks for the prebuilt runtime next to the CLI (`bin/../runtime` in the distribution). In a checkout of
NSH it uses `target/<triple>/<profile>` and `target/android/<profile>`, with the CLI's own profile (a debug CLI uses
debug runtimes): build them with `cargo build -p nsh-ios-app --target aarch64-apple-ios-sim` (or `aarch64-apple-ios`
for devices) and `cargo xtask android` (add `--release` for a release CLI); `nsh-macos-app` (on macOS), `nsh-linux-app` (on Linux) and `nsh-windows-app` (on Windows) are built for this
machine in `target/<profile>` (`cargo build -p nsh-macos-app`, `cargo build -p nsh-linux-app`, `cargo build -p nsh-windows-app`); the web runtime is built with the `web` profile whatever the CLI's, into `target/wasm32-unknown-unknown/web/`. The environment variable `NSH_RUNTIME`
points the CLI at another directory laid out like the distribution's `runtime/` (`ios/iphoneos`,
`ios/iphonesimulator`, `android/release`, `macos`, `linux`, `windows`, `gpui`, `web`, ...).

## Publish

`nsh package` stops at the installable file. Releasing it on a store is covered in [Publishing](./publish.md):
[App Store](./publish.md#publish-to-the-app-store), [Google Play](./publish.md#publish-to-google-play),
[Flathub](./publish.md#publish-to-flathub) and [Microsoft Store](./publish.md#publish-to-the-microsoft-store). Apps
outside a store are distributed as described above: [macOS](#sign-notarize-and-distribute),
[Windows](#sign-and-distribute), [Linux](#distribute) and [Web](#host-the-site).

## See also

- [Publishing](./publish.md): releasing on the App Store, Google Play, Flathub and the Microsoft Store
- [CLI](./cli.md): every command
- [App Updates](./app-updates.md): packaged apps that update themselves
- [OTA Updates](./ota-updates.md): new TSX for packaged apps, iOS and Android included, without a new build
- [Signed packages](./signed-packages.md): updates apps download
- [Project structure](./project-structure.md): `nsh.json` and the files of an app
- [Native components](./native-components.md): views of the host app inside an NSH app
