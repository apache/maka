---
title: Installation
description: Get the NSH command, from a prebuilt distribution or a source checkout, and the tools each platform needs - iOS, Android, macOS, Windows and Linux.
order: 3
group: start
---

# Installation

Everything NSH does goes through one command, `nsh`. It builds apps written in Rust or TSX, runs them on every platform, serves TSX to development hosts with hot updates, and packages installable apps. You can use it from a prebuilt distribution or build it from a checkout of the repository.

Apps written in Rust also need a Rust toolchain ([below](#for-apps-written-in-rust)); TSX apps need `nsh` alone. On top of that, each platform needs its own tools:

| Platform | Develop and package on | Needs |
|---|---|---|
| iOS | macOS | Xcode and an iOS simulator runtime |
| Android | macOS, Windows or Linux | The Android SDK and a JDK; an emulator or a device |
| macOS | macOS | Xcode's command line tools; apps run on macOS 14+ |
| Windows | Windows | Windows 10 1809+; the WebView2 Runtime for web views |
| Linux | Linux | GTK 4.14+ (and its development packages to build the runtime) |
| [GPUI](./gpui.md) (embedding in GPUI apps) | macOS, Windows or Linux | A GPU (Metal, DirectX or Vulkan); on Linux, Wayland or X11 |

The AppKit host is the default on macOS. Mac Catalyst (`--target catalyst`) needs Xcode like iOS. Details are under [Platform tools](#platform-tools).

## Installing a release

Each [GitHub release](https://github.com/longbridge/nsh/releases) carries the prebuilt distribution (below) for macOS (Apple silicon), Linux x86_64 and Windows x86_64. Every way of installing it puts the same `nsh` command on your `PATH`.

**macOS and Linux**, with the install script:

```sh
curl -fsSL https://nsh.dev/install.sh | sh
```

It installs the distribution to `~/.nsh` and links `~/.local/bin/nsh` to it; running it again updates it. `NSH_VERSION=v0.1.0` pins a release, `NSH_INSTALL_DIR` picks another directory.

**Windows**, in PowerShell:

```powershell
irm https://nsh.dev/install.ps1 | iex
```

It installs to `%LOCALAPPDATA%\nsh` and adds its `bin` to your user `PATH` (open a new terminal afterwards). `$env:NSH_VERSION` and `$env:NSH_INSTALL_DIR` work as above.

**Homebrew** (macOS and Linux):

```sh
brew install longbridge/tap/nsh
```

**Scoop** (Windows):

```powershell
scoop install https://github.com/longbridge/nsh/releases/latest/download/nsh.json
```

**mise** (all three):

```sh
mise use -g github:longbridge/nsh
```

The archives (`nsh-macos-arm64.tar.gz`, `nsh-linux-x86_64.tar.gz`, `nsh-windows-x86_64.zip`, each with a `.sha256`) carry no version in their names, so `https://github.com/longbridge/nsh/releases/latest/download/<archive>` always fetches the latest. The embedding SDKs are also released alone, for native apps that need no CLI: `nsh-embed-ios.zip` and `nsh-embed-android.zip`.

> [!NOTE]
> The binaries are not signed yet. macOS quarantines files downloaded by a browser; the install script, Homebrew and mise download with `curl` and are not affected, otherwise run `xattr -dr com.apple.quarantine <dir>`. The Linux runtime needs glibc 2.39 and GTK 4.14 or newer (Ubuntu 24.04 and later). There is no Intel Mac or arm64 Linux / Windows build: build those from a checkout.

## For apps written in Rust

Install Rust through [rustup](https://rustup.rs). `nsh` builds a Rust app's runner for each target with Cargo, from your crate and NSH's crates on crates.io at the CLI's version, so add the Rust targets of the platforms you run on:

```sh
rustup target add aarch64-apple-ios-sim aarch64-apple-ios aarch64-apple-ios-macabi   # iOS simulator, devices, Mac Catalyst
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android # Android (with the SDK's NDK)
rustup target add wasm32-unknown-unknown                                             # the web
```

The desktops build for the machine you are on. `cargo run` in a Rust app's directory starts it on the desktop backend directly, which builds with the backend's development libraries ([Platform tools](#platform-tools)). Android builds also use an **NDK** from the SDK, as [building the Android runtime](#building-the-android-runtime) does.

## The prebuilt distribution

The distribution is a directory, `dist/nsh`, with the CLI and the prebuilt native runtimes it packages apps with:

```sh
dist/nsh/bin/nsh                                             # the CLI
dist/nsh/runtime/ios/iphoneos/nsh-ios-app                    # runs packaged apps on iOS devices
dist/nsh/runtime/ios/iphonesimulator/{nsh-ios-app,nsh-ios-host}
dist/nsh/runtime/ios/maccatalyst/nsh-ios-host                # the Mac Catalyst development host
dist/nsh/runtime/android/{release,dev}/                      # classes.dex, lib/<abi>/libnsh.so
dist/nsh/runtime/macos/{nsh-macos-host,nsh-macos-app}        # the macOS (AppKit) development host and release runner
dist/nsh/runtime/linux/{nsh-linux-host,nsh-linux-app}        # the Linux development host and release runner
dist/nsh/runtime/windows/{nsh-windows-host,nsh-windows-app}.exe  # the Windows development host and release runner
dist/nsh/runtime/gpui/nsh-gpui-host[.exe]                    # the GPUI development host, for this OS
dist/nsh/runtime/web/{nsh.wasm,nsh-dev.wasm,nsh.js}          # the web runtimes (nsh package / run --target web)
dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework  # embedding in iOS apps
dist/nsh/embed/android/{nsh,nsh-dev}.aar                     # embedding in Android apps
```

Put `dist/nsh/bin` on your `PATH` (or call `dist/nsh/bin/nsh` directly) and keep the directory together: `nsh` finds the runtimes next to itself, in `bin/../runtime` (through a symlink to it, as the installers make, too).

```sh
export PATH="$PWD/dist/nsh/bin:$PATH"
nsh --version
```

The distribution is made with `cargo xtask dist` in a checkout (below). The `nsh` binary it contains is built for that machine. On a Mac with Xcode it includes the iOS and macOS runtimes (Apple Silicon); on Linux it includes the Linux runtime instead, built for that machine; on Windows the Windows runtime, with `bin\nsh.exe`. Each also includes the [GPUI](./gpui.md) development host, built for that machine. All include the Android runtime (on Windows only when the Android SDK is found).

## Installing the latest source

On macOS and Linux, install the latest `main` with Git, Rust and the platform build dependencies below:

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --source
nsh -V # nsh 0.1.1 (abcdef0)
```

The installer keeps the checkout in `~/.nsh/source`, builds the release CLI and links it into `~/.local/bin`. Re-run the command to update; local source changes must be saved first. The retained checkout lets NSH build native runtimes on demand. Cargo uses its existing configuration and target directory. `NSH_INSTALL_DIR` changes the installation prefix; `NSH_VERSION` selects prebuilt releases only. Both `-V` and `--version` show the version and seven-character source revision.

## Building from a checkout

You need Rust through [rustup](https://rustup.rs). The repository's `rust-toolchain.toml` selects the stable toolchain and installs the iOS and Android targets on first use.

```sh
git clone https://github.com/longbridge/nsh.git
cd nsh
cargo build -p nsh-cli          # ./target/debug/nsh
```

Then build the development host of each target you want to run on, once, and again after you update the checkout:

```sh
cargo build -p nsh-ios-host --target aarch64-apple-ios-macabi   # nsh run (Mac Catalyst window)
cargo build -p nsh-ios-host --target aarch64-apple-ios-sim      # nsh run --target ios
cargo xtask android --dev                                       # nsh run --target android
cargo build -p nsh-macos-host                                   # nsh run --target macos (built for you in a checkout)
cargo build -p nsh-linux-host                                   # nsh run on Linux (built for you in a checkout)
cargo build -p nsh-windows-host                                 # nsh run on Windows (built for you in a checkout)
cargo build --manifest-path crates/gpui/Cargo.toml --target-dir target -p nsh-gpui-host   # nsh run --target gpui (built for you in a checkout)
cargo build --profile web -p nsh-platform-web --target wasm32-unknown-unknown   # nsh run --target web (built for you in a checkout)
```

For `nsh package`, build the release runners as well:

```sh
cargo build -p nsh-ios-app --target aarch64-apple-ios-sim       # nsh package --target ios-simulator
cargo build -p nsh-ios-app --target aarch64-apple-ios           # nsh package --target ios
cargo xtask android                                             # nsh package --target android
cargo build -p nsh-macos-app                                    # nsh package --target macos
cargo build -p nsh-linux-app                                    # nsh package --target linux
cargo build -p nsh-windows-app                                  # nsh package --target windows
# nsh package --target web uses the same web runtime as nsh run --target web
```

A CLI built from a checkout looks for the runtimes in `target/<triple>/<profile>` (the macOS, Linux, Windows and GPUI ones, built for this machine, in `target/<profile>`) and `target/android/<profile>[-dev]`, using its own profile: `./target/debug/nsh` uses debug runtimes, `./target/release/nsh` release ones. Build both with the same profile (add `--release` to all of them for faster apps).

> [!TIP]
> `NSH_RUNTIME=/path/to/runtime` makes `nsh` use a runtime directory laid out like the distribution's `runtime/`, wherever the CLI itself lives.

## Platform tools

### iOS and Mac Catalyst

- **Xcode** (with its command line tools). `nsh run` uses `xcrun simctl` to boot simulators and install the development host; `nsh package` uses `actool` for app icons and `codesign` for signing.
- An iOS simulator runtime. If none is installed, install one with `xcodebuild -downloadPlatform iOS`.
- Apps target iOS 15.0 and later.

### Android

- **The Android SDK**, found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android Studio's default place (`~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk` on Windows), with:
  - `platforms;android-35` and a recent `build-tools` (NSH uses `aapt2`, `zipalign` and `apksigner` from it, no Gradle);
  - `platform-tools` (`adb`).
- **A JDK** (`keytool` creates the debug keystore in `~/.android/debug.keystore` the first time you package, `apksigner` needs Java).
- A running emulator or a device connected over `adb`. Apps need Android 9 (API 28) or later.

```sh
sdkmanager "platforms;android-35" "build-tools;35.0.1" "platform-tools"
```

### macOS

- **Xcode's command line tools** (`xcode-select --install`): the SDK and clang to build the runtime, `codesign` and `sips` to package apps.
- Apps need macOS 14 or later.

See [macOS](./macos.md).

### Linux

- **GTK 4.14** or later, with their development packages and clang to build the runtime: `libgtk-4-dev clang` (Debian, Ubuntu 24.04 or later), `gtk4 clang` (Arch), `gtk4-devel clang` (Fedora).
- **WebKitGTK 6.0** (2.40 or later) for web views: `libwebkitgtk-6.0-dev` (Debian, Ubuntu), `webkitgtk-6.0` (Arch), `webkitgtk6.0-devel` (Fedora) to build the runtime; apps then need it where they run. Without it, `cargo xtask dist` builds the runtime with placeholders for web views.
- **GStreamer** plugins for the video formats apps play.

See [Linux](./linux.md).

### Windows

- **Windows 10 1809** or later, or Windows 11. The WebView2 Runtime (part of Windows 11, installed with Edge on Windows 10) for web views.
- To build the runtime: **Visual Studio Build Tools** with the "Desktop development with C++" workload and the Windows SDK, and **LLVM** (libclang, for QuickJS' bindings; found in `C:\Program Files\LLVM`, else set `LIBCLANG_PATH`).

See [Windows](./windows.md).

### Building the Android runtime

Building the Android runtime from a checkout (`cargo xtask android`) additionally needs an **NDK** from the SDK (`ndk;<version>`; set `ANDROID_NDK_HOME` if the newest one installed is incomplete) and `javac`.

## What works where

| Command | macOS | Linux | Windows |
|---|---|---|---|
| `nsh init`, `nsh build`, `nsh test`, `nsh dev`, `nsh check` | Yes | Yes | Yes |
| `nsh run --target catalyst` (Mac Catalyst) | Yes | No | No |
| `nsh run --target macos`, `nsh package --target macos` | Yes | No | No |
| `nsh run --target linux` (the default on Linux), `nsh package --target linux` | No | Yes | No |
| `nsh run --target windows` (the default on Windows), `nsh package --target windows` | No | No | Yes |
| `nsh run --target gpui` (the backend GPUI apps embed) | Yes | Yes | Yes |
| `nsh run --target ios`, `nsh package --target ios` / `ios-simulator` | Yes, with Xcode | No | No |
| `nsh run --target android`, `nsh package --target android` | Yes | Yes, from a checkout | Yes, with the Android runtime |
| `nsh keygen`, `certify`, `publish`, `verify`, `revoke` | Yes | Yes | Yes |

On Linux, build the CLI and the Android runtime from a checkout (`cargo build -p nsh-cli` and `cargo xtask android --dev`); the NDK's Linux toolchain is used automatically. On Windows the NDK's Windows toolchain is used the same way, and `cargo xtask dist` includes the Android runtime when it finds the Android SDK.

## Editor setup

A Rust app is a Cargo project: rust-analyzer (VS Code, Zed, Neovim, RustRover) checks it and completes NSH's API, with its doc comments, as for any crate.

For TSX, NSH needs no NPM. `nsh init` writes a `tsconfig.json` and the type declarations of everything NSH provides into `.nsh/types`, and every command that builds the app keeps them up to date. Any editor that uses the TypeScript language server (VS Code, Zed, Neovim, WebStorm) type-checks the app with them. See [Project structure](./project-structure.md#tsconfigjson-and-nshtypes).

## Next steps

Continue with [Getting started](./getting-started.md) to create an app and run it.
