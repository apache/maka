---
title: 安装
description: 从预构建的发行包或源码仓库获取 NSH 命令，以及每个平台（iOS、Android、macOS、Windows 和 Linux）所需的工具。
order: 3
group: start
---

# 安装

NSH 的所有操作都通过一个命令 `nsh` 完成：构建用 Rust 或 TSX 编写的应用、在每个平台上运行它们、以热更新的方式把 TSX 提供给开发宿主，以及打包可安装的应用。你可以使用预构建发行包，也可以从仓库源码构建。

用 Rust 编写的应用还需要 Rust 工具链（[见下文](#用-rust-编写的应用)）；TSX 应用只需要 `nsh`。除此之外，每个平台还需要自己的工具：

| 平台 | 在哪里开发和打包 | 需要 |
|---|---|---|
| iOS | macOS | Xcode 和一个 iOS 模拟器运行时 |
| Android | macOS、Windows 或 Linux | Android SDK 和 JDK；一个模拟器或设备 |
| macOS | macOS | Xcode 命令行工具；应用运行在 macOS 14+ |
| Windows | Windows | Windows 10 1809+；网页视图需要 WebView2 Runtime |
| Linux | Linux | GTK 4.14+（构建运行时还需要它的开发包） |
| [GPUI](./gpui.md)（嵌入 GPUI 应用） | macOS、Windows 或 Linux | GPU（Metal、DirectX 或 Vulkan）；Linux 上需要 Wayland 或 X11 |

macOS 上的默认目标为 AppKit。Mac Catalyst（`--target catalyst`）和 iOS 一样需要 Xcode。详见[平台工具](#平台工具)。

## 安装发布版本

每个 [GitHub release](https://github.com/longbridge/nsh/releases) 都附带 macOS（Apple silicon）、Linux x86_64 和 Windows x86_64 的预构建发行包（见下文）。无论用哪种方式安装，`PATH` 上得到的都是同一个 `nsh` 命令。

**macOS 和 Linux**，使用安装脚本：

```sh
curl -fsSL https://nsh.dev/install.sh | sh
```

它把发行包安装到 `~/.nsh`，并把 `~/.local/bin/nsh` 链接过去；再次运行即可更新。`NSH_VERSION=v0.1.0` 指定版本，`NSH_INSTALL_DIR` 指定其他目录。

**Windows**，在 PowerShell 中：

```powershell
irm https://nsh.dev/install.ps1 | iex
```

它安装到 `%LOCALAPPDATA%\nsh`，并把其中的 `bin` 加入用户 `PATH`（之后打开新的终端）。`$env:NSH_VERSION` 和 `$env:NSH_INSTALL_DIR` 的用法同上。

**Homebrew**（macOS 和 Linux）：

```sh
brew install longbridge/tap/nsh
```

**Scoop**（Windows）：

```powershell
scoop install https://github.com/longbridge/nsh/releases/latest/download/nsh.json
```

**mise**（三个平台）：

```sh
mise use -g github:longbridge/nsh
```

压缩包（`nsh-macos-arm64.tar.gz`、`nsh-linux-x86_64.tar.gz`、`nsh-windows-x86_64.zip`，各带一个 `.sha256`）的文件名不含版本号，所以 `https://github.com/longbridge/nsh/releases/latest/download/<压缩包>` 总是下载最新版本。嵌入用的 SDK 也单独发布，供不需要 CLI 的原生应用使用：`nsh-embed-ios.zip` 和 `nsh-embed-android.zip`。

> [!NOTE]
> 二进制文件暂未签名。macOS 会隔离浏览器下载的文件；安装脚本、Homebrew 和 mise 用 `curl` 下载，不受影响，否则请运行 `xattr -dr com.apple.quarantine <目录>`。Linux 运行时需要 glibc 2.39 和 GTK 4.14 或更新版本（Ubuntu 24.04 及以后）。目前没有 Intel Mac 和 arm64 Linux / Windows 的构建，请从源码构建。

## 用 Rust 编写的应用

通过 [rustup](https://rustup.rs) 安装 Rust。`nsh` 用 Cargo 为每个目标构建 Rust 应用的运行器，使用你的 crate 以及 crates.io 上与 CLI 同版本的 NSH crate，所以请添加你要运行的平台对应的 Rust 目标：

```sh
rustup target add aarch64-apple-ios-sim aarch64-apple-ios aarch64-apple-ios-macabi   # iOS 模拟器、真机、Mac Catalyst
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android # Android（配合 SDK 中的 NDK）
rustup target add wasm32-unknown-unknown                                             # Web
```

桌面平台为你所在的机器构建。在 Rust 应用目录中运行 `cargo run` 会直接在桌面后端上启动它，构建时使用该后端的开发库（[平台工具](#平台工具)）。Android 构建还会使用 SDK 中的 **NDK**，与[构建 Android 运行时](#构建-android-运行时)相同。

## 预构建发行包

发行包是一个目录 `dist/nsh`，包含 CLI 以及它打包应用时使用的预构建原生运行时：

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

把 `dist/nsh/bin` 加入 `PATH`（或直接调用 `dist/nsh/bin/nsh`），并保持目录完整：`nsh` 会在自身旁边的 `bin/../runtime` 中查找运行时（通过指向它的符号链接运行时也一样，安装脚本就是这样做的）。

```sh
export PATH="$PWD/dist/nsh/bin:$PATH"
nsh --version
```

发行包由源码仓库中的 `cargo xtask dist` 生成（见下文）。其中的 `nsh` 可执行文件是为该机器构建的。在装有 Xcode 的 Mac 上，它包含 iOS 和 macOS 运行时（Apple Silicon）；在 Linux 上，它改为包含为该机器构建的 Linux 运行时；在 Windows 上则包含 Windows 运行时，CLI 为 `bin\nsh.exe`。每个发行包还包含为该机器构建的 [GPUI](./gpui.md) 开发宿主。它们都包含
Android 运行时（在 Windows 上，只有找到 Android SDK 时才包含）。

## 安装最新源码版

在 macOS 和 Linux 上，准备好 Git、Rust 和下文的平台构建依赖后，可以安装最新 `main`：

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --source
nsh -V # nsh 0.1.1 (abcdef0)
```

安装器保留 `~/.nsh/source` 中的源码，构建 release CLI，并链接到 `~/.local/bin`。再次运行即可更新；更新前需要保存本地源码改动。NSH 使用保留的源码按需构建原生运行时。Cargo 使用已有配置和 target 目录。`NSH_INSTALL_DIR` 修改安装目录；`NSH_VERSION` 仅用于选择预构建发行版。`-V` 和 `--version` 都显示版本号和七位源码提交 SHA。

## 从源码构建

你需要通过 [rustup](https://rustup.rs) 安装 Rust。仓库中的 `rust-toolchain.toml` 会选择 stable 工具链，并在首次使用时安装 iOS 和 Android 目标。

```sh
git clone https://github.com/longbridge/nsh.git
cd nsh
cargo build -p nsh-cli          # ./target/debug/nsh
```

然后为每个要运行的目标构建开发宿主，构建一次即可，更新源码后再重新构建：

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

如果要使用 `nsh package`，还需要构建发布版运行器：

```sh
cargo build -p nsh-ios-app --target aarch64-apple-ios-sim       # nsh package --target ios-simulator
cargo build -p nsh-ios-app --target aarch64-apple-ios           # nsh package --target ios
cargo xtask android                                             # nsh package --target android
cargo build -p nsh-macos-app                                    # nsh package --target macos
cargo build -p nsh-linux-app                                    # nsh package --target linux
cargo build -p nsh-windows-app                                  # nsh package --target windows
# nsh package --target web uses the same web runtime as nsh run --target web
```

从源码构建的 CLI 会按自身的 profile 在 `target/<triple>/<profile>`（macOS、Linux、Windows 和 GPUI 运行时为本机构建，位于 `target/<profile>`）和 `target/android/<profile>[-dev]` 中查找运行时：`./target/debug/nsh` 使用 debug 运行时，`./target/release/nsh` 使用 release 运行时。请用相同的 profile 构建两者（若希望应用更快，给所有命令都加上 `--release`）。

> [!TIP]
> 设置 `NSH_RUNTIME=/path/to/runtime` 后，无论 CLI 位于何处，`nsh` 都会使用这个目录作为运行时，其结构与发行包的 `runtime/` 相同。

## 平台工具

### iOS 与 Mac Catalyst

- **Xcode**（及其命令行工具）。`nsh run` 用 `xcrun simctl` 启动模拟器并安装开发宿主；`nsh package` 用 `actool` 处理应用图标，用 `codesign` 签名。
- 一个 iOS 模拟器运行时。如果还没有安装，可以用 `xcodebuild -downloadPlatform iOS` 安装。
- 应用支持 iOS 15.0 及以上版本。

### Android

- **Android SDK**，通过 `ANDROID_HOME`、`ANDROID_SDK_ROOT` 或 Android Studio 的默认位置（`~/Library/Android/sdk`，Windows 上为 `%LOCALAPPDATA%\Android\Sdk`）查找，需包含：
  - `platforms;android-35` 和较新的 `build-tools`（NSH 使用其中的 `aapt2`、`zipalign` 和 `apksigner`，不使用 Gradle）；
  - `platform-tools`（`adb`）。
- **JDK**（首次打包时 `keytool` 会在 `~/.android/debug.keystore` 创建调试密钥库，`apksigner` 也需要 Java）。
- 一个正在运行的模拟器，或通过 `adb` 连接的设备。应用要求 Android 9（API 28）及以上。

```sh
sdkmanager "platforms;android-35" "build-tools;35.0.1" "platform-tools"
```

### macOS

- **Xcode 命令行工具**（`xcode-select --install`）：构建运行时需要其中的 SDK 和 clang，打包应用需要 `codesign` 和 `sips`。
- 应用要求 macOS 14 及以上。

见 [macOS](./macos.md)。

### Linux

- **GTK 4.14** 及以上；构建运行时还需要它们的开发包和 clang：`libgtk-4-dev clang`（Debian、Ubuntu 24.04 及以上）、`gtk4 clang`（Arch）、`gtk4-devel clang`（Fedora）。
- Web 视图需要 **WebKitGTK 6.0**（2.40 及以上）：构建运行时需要 `libwebkitgtk-6.0-dev`（Debian、Ubuntu）、`webkitgtk-6.0`（Arch）、`webkitgtk6.0-devel`（Fedora），应用运行的机器上也需要它。没有它时，`cargo xtask dist` 构建的运行时中 Web 视图为占位视图。
- 应用要播放的视频格式对应的 **GStreamer** 插件。

见 [Linux](./linux.md)。

### Windows

- **Windows 10 1809** 及以上，或 Windows 11。Web 视图需要 WebView2 Runtime（Windows 11 自带，Windows 10 上随 Edge 安装）。
- 构建运行时需要：带“使用 C++ 的桌面开发”工作负载的 **Visual Studio Build Tools** 和 Windows SDK，以及 **LLVM**（libclang，用于生成 QuickJS 的绑定；默认在 `C:\Program Files\LLVM` 中查找，否则请设置 `LIBCLANG_PATH`）。

见 [Windows](./windows.md)。

### 构建 Android 运行时

从源码构建 Android 运行时（`cargo xtask android`）还需要 SDK 中的 **NDK**（`ndk;<version>`；如果已安装的最新版本不完整，请设置 `ANDROID_NDK_HOME`）以及 `javac`。

## 各平台可用的命令

| 命令 | macOS | Linux | Windows |
|---|---|---|---|
| `nsh init`, `nsh build`, `nsh test`, `nsh dev`, `nsh check` | 可以 | 可以 | 可以 |
| `nsh run --target catalyst`（Mac Catalyst） | 可以 | 不可以 | 不可以 |
| `nsh run --target macos`, `nsh package --target macos` | 可以 | 不可以 | 不可以 |
| `nsh run --target linux`（Linux 上的默认目标）, `nsh package --target linux` | 不可以 | 可以 | 不可以 |
| `nsh run --target windows`（Windows 上的默认目标）, `nsh package --target windows` | 不可以 | 不可以 | 可以 |
| `nsh run --target gpui`（GPUI 应用嵌入的后端） | 可以 | 可以 | 可以 |
| `nsh run --target ios`, `nsh package --target ios` / `ios-simulator` | 可以，需要 Xcode | 不可以 | 不可以 |
| `nsh run --target android`, `nsh package --target android` | 可以 | 可以，需从源码构建 | 可以，需有 Android 运行时 |
| `nsh keygen`, `certify`, `publish`, `verify`, `revoke` | 可以 | 可以 | 可以 |

在 Linux 上，请从源码构建 CLI 和 Android 运行时（`cargo build -p nsh-cli` 与 `cargo xtask android --dev`）；会自动使用 NDK 的 Linux 工具链。在 Windows 上同样会使用 NDK 的 Windows 工具链，`cargo xtask dist` 找到 Android SDK 时会包含 Android 运行时。

## 编辑器配置

Rust 应用是一个 Cargo 项目：rust-analyzer（VS Code、Zed、Neovim、RustRover）会像对待任何 crate 一样检查它，并补全 NSH 的 API 及其文档注释。

对 TSX，NSH 无需 NPM。`nsh init` 会写入 `tsconfig.json`，并把 NSH 提供的所有内容的类型声明写入 `.nsh/types`，之后每个构建应用的命令都会让它们保持最新。任何使用 TypeScript 语言服务的编辑器（VS Code、Zed、Neovim、WebStorm）都能借此对应用做类型检查。参见 [项目结构](./project-structure.md)。

## 下一步

继续阅读 [快速开始](./getting-started.md)，创建并运行一个应用。
