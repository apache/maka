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

Each [GitHub release](https://github.com/longbridge/nsh/releases) carries the prebuilt distribution (below) for macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64 and arm64). Every way of installing it puts the same `nsh` command on your `PATH`.

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

**Homebrew** (Apple silicon Macs and x86_64 Linux):

```sh
brew install longbridge/tap/nsh
```

**Scoop** (x86_64 Windows):

```powershell
scoop install https://github.com/longbridge/nsh/releases/latest/download/nsh.json
```

**mise** (all three):

```sh
mise use -g github:longbridge/nsh
```

The archives (`nsh-macos-arm64.tar.gz`, `nsh-macos-x86_64.tar.gz`, `nsh-linux-x86_64.tar.gz`, `nsh-linux-arm64.tar.gz`, `nsh-windows-x86_64.zip`, `nsh-windows-arm64.zip`, each with a `.sha256`) carry no version in their names, so `https://github.com/longbridge/nsh/releases/latest/download/<archive>` always fetches the latest. Each holds the CLI and the runtime of its own platform; the runtimes of the other platforms are [components](#components), added when they are first needed. The embedding SDKs are released alone, for native apps that embed NSH: `nsh-embed-ios.zip` and `nsh-embed-android.zip`.

> [!NOTE]
> The binaries are not signed yet. macOS quarantines files downloaded by a browser; the install script, Homebrew and mise download with `curl` and are not affected, otherwise run `xattr -dr com.apple.quarantine <dir>`. The Linux runtime needs glibc 2.39 and GTK 4.14 or newer (Ubuntu 24.04 and later). Homebrew and Scoop install the Apple silicon, x86_64 Linux and x86_64 Windows builds; use the install script on the others.

## Components

The runtimes for platforms other than the one you develop on are components of the release, as `rustup component add` installs a toolchain's parts. The first command that needs one, such as `nsh run --target android` or `nsh package --target web`, downloads it from the release of your `nsh`, checks its SHA-256 and installs it next to the CLI. `nsh component` manages them ahead of time:

```sh
nsh component list            # the components for this machine, installed or not
nsh component add android web # install ahead of time, e.g. before going offline
nsh component remove gpui     # free the space again
```

| Component | Holds | Published for |
|---|---|---|
| `android` | The Android runtime (`--target android`) | Every platform |
| `android-symbols` | The Android runtime's symbols, for crash reports and `ndk-stack` | Every platform |
| `ios` | The iOS and Mac Catalyst runtimes (`--target ios`, `catalyst`) | macOS on Apple silicon |
| `web` | The web runtimes (`--target web`) | Every platform |
| `gpui` | The [GPUI](./gpui.md) development host (`--target gpui`) | Every platform, built for it |
| `tui` | The terminal development host (`--target tui`) | Every platform, built for it |

A component always comes from the same build as the CLI. `nsh update` adds the installed components again from the release it updates to. A nightly build's components are replaced every night, so a nightly `nsh` from an earlier night asks you to run `nsh update` first.

## For apps written in Rust

Install Rust through [rustup](https://rustup.rs). `nsh` builds a Rust app's runner for each target with Cargo, from your crate and NSH's crates on crates.io at the CLI's version, so add the Rust targets of the platforms you run on:

```sh
rustup target add aarch64-apple-ios-sim aarch64-apple-ios aarch64-apple-ios-macabi   # iOS simulator, devices, Mac Catalyst
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android # Android (with the SDK's NDK)
rustup target add wasm32-unknown-unknown                                             # the web
```

We recommend building with [huacnlee/cargo](https://github.com/huacnlee/cargo), a fork of Cargo optimized by [huacnlee](https://github.com/huacnlee) so Rust build artifacts never fill the disk: every project and Git worktree shares one build directory that stays under a size limit on its own. With 50 worktrees it takes about 90% less disk space than stock Cargo, and a 512 GB disk is plenty. It is a drop-in replacement for `~/.cargo/bin/cargo` with nothing to configure:

```sh
curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh     # Windows: irm https://huacnlee.github.io/cargo/install.ps1 | iex
```

The desktops build for the machine you are on. `cargo run` in a Rust app's directory starts it on the desktop backend directly, which builds with the backend's development libraries ([Platform tools](#platform-tools)). Android builds also use an **NDK** from the SDK, as [building the Android runtime](#building-the-android-runtime) does.

## The prebuilt distribution

The distribution is a directory, `dist/nsh`, with the CLI and the prebuilt native runtimes it packages apps with:

```sh
dist/nsh/bin/nsh                                             # the CLI
dist/nsh/runtime/ios/iphoneos/nsh-ios-app                    # runs packaged apps on iOS devices
dist/nsh/runtime/ios/iphonesimulator/{nsh-ios-app,nsh-ios-host}
dist/nsh/runtime/ios/maccatalyst/nsh-ios-host                # the Mac Catalyst development host
dist/nsh/runtime/android/{release,dev}/                      # classes.dex, lib/<abi>/libnsh.so, symbols/<abi>/libnsh.so
dist/nsh/runtime/macos/{nsh-macos-host,nsh-macos-app}        # the macOS (AppKit) development host and release runner
dist/nsh/runtime/linux/{nsh-linux-host,nsh-linux-app}        # the Linux development host and release runner
dist/nsh/runtime/windows/{nsh-windows-host,nsh-windows-app}.exe  # the Windows development host and release runner
dist/nsh/runtime/gpui/nsh-gpui-host[.exe]                    # the GPUI development host, for this OS
dist/nsh/runtime/tui/nsh-tui-host[.exe]                      # the terminal development host (nsh run --target tui)
dist/nsh/runtime/web/{nsh.wasm,nsh-dev.wasm,nsh.js}          # the web runtimes (nsh package / run --target web)
dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework  # embedding in iOS apps
dist/nsh/embed/android/{nsh,nsh-dev}.aar                     # embedding in Android apps
```

Put `dist/nsh/bin` on your `PATH` (or call `dist/nsh/bin/nsh` directly) and keep the directory together: `nsh` finds the runtimes next to itself, in `bin/../runtime` (through a symlink to it, as the installers make, too). The release archives are made from it: each platform's archive keeps `bin` and its own runtime, the other runtimes become [components](#components) and `embed` the SDK archives.

```sh
export PATH="$PWD/dist/nsh/bin:$PATH"
nsh --version
```

The distribution is made with `cargo xtask dist` in a checkout (below). The `nsh` binary it contains is built for that machine. On a Mac with Xcode it includes the iOS and macOS runtimes (Apple Silicon); on Linux it includes the Linux runtime instead, built for that machine; on Windows the Windows runtime, with `bin\nsh.exe`. Each also includes the [GPUI](./gpui.md) and terminal development hosts, built for that machine. All include the Android runtime (on Windows only when the Android SDK is found).

## Installing the nightly build

Every night that `main` changes, it is built and published as the [nightly release](https://github.com/longbridge/nsh/releases/tag/nightly), with the same archives as a release:

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --nightly
nsh -V # nsh 0.4.0 (abcdef0 nightly)
```

Apps written in Rust build their runner with NSH's crates on crates.io at the CLI's version, the last release's; for those apps, use a release or the source.

## Updating

`nsh update` updates an installed `nsh` to the latest build of its channel: the latest release, or the latest nightly for a nightly build. Naming a channel switches to it, as `rustup update nightly` does:

```sh
nsh update                    # the latest of the channel it is on
nsh update nightly            # to the nightly build of main
nsh update stable             # back to the latest release
```

It downloads the same archive as the install scripts, checks its SHA-256, replaces the whole distribution directory and adds the components that were installed again. Homebrew, Scoop and mise update the `nsh` they installed themselves (`brew upgrade nsh`, `scoop update nsh`, `mise upgrade`).

## Building from source

With Git, Rust and the [platform tools](#platform-tools), on macOS and Linux:

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --source
```

It keeps the checkout in `~/.nsh/source`, builds the CLI and links it into `~/.local/bin`; run it again to update. To work on NSH itself, clone the repository and build the CLI there; it builds the desktop and web runtimes it runs on when they are missing:

```sh
git clone https://github.com/longbridge/nsh.git && cd nsh
cargo build -p nsh-cli          # ./target/debug/nsh
```

The commands for the iOS and Android runtimes and the release runners are in the repository's [AGENTS.md](https://github.com/longbridge/nsh/blob/main/AGENTS.md#commands).

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
- A running emulator or a device connected over `adb`. Apps need Android 8 (API 26) or later.

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
- **GStreamer** 1.14 or later, for video and sound: `libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev` (Debian, Ubuntu), `gstreamer gst-plugins-base` (Arch), `gstreamer1-devel gstreamer1-plugins-base-devel` (Fedora) to build the runtime, and the plug-ins for the video and audio formats apps play.

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
