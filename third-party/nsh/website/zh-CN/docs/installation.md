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

每个 [GitHub release](https://github.com/longbridge/nsh/releases) 都附带 macOS（Apple silicon 和 Intel）、Linux（x86_64 和 arm64）和 Windows（x86_64 和 arm64）的预构建发行包（见下文）。无论用哪种方式安装，`PATH` 上得到的都是同一个 `nsh` 命令。

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

**Homebrew**（Apple silicon Mac 和 x86_64 Linux）：

```sh
brew install longbridge/tap/nsh
```

**Scoop**（x86_64 Windows）：

```powershell
scoop install https://github.com/longbridge/nsh/releases/latest/download/nsh.json
```

**mise**（三个平台）：

```sh
mise use -g github:longbridge/nsh
```

压缩包（`nsh-macos-arm64.tar.gz`、`nsh-macos-x86_64.tar.gz`、`nsh-linux-x86_64.tar.gz`、`nsh-linux-arm64.tar.gz`、`nsh-windows-x86_64.zip`、`nsh-windows-arm64.zip`，各带一个 `.sha256`）的文件名不含版本号，所以 `https://github.com/longbridge/nsh/releases/latest/download/<压缩包>` 总是下载最新版本。每个压缩包包含 CLI 和所在平台自己的运行时；其他平台的运行时是[组件](#组件)，第一次用到时再安装。嵌入用的 SDK 单独发布，供嵌入 NSH 的原生应用使用：`nsh-embed-ios.zip` 和 `nsh-embed-android.zip`。

> [!NOTE]
> 二进制文件暂未签名。macOS 会隔离浏览器下载的文件；安装脚本、Homebrew 和 mise 用 `curl` 下载，不受影响，否则请运行 `xattr -dr com.apple.quarantine <目录>`。Linux 运行时需要 glibc 2.39 和 GTK 4.14 或更新版本（Ubuntu 24.04 及以后）。Homebrew 和 Scoop 安装 Apple silicon、x86_64 Linux 和 x86_64 Windows 的构建，其他平台请用安装脚本。

## 组件

开发所在平台之外的运行时是发布版的组件，就像 `rustup component add` 安装工具链的组成部分。第一个用到它的命令（例如 `nsh run --target android` 或 `nsh package --target web`）会从当前 `nsh` 所属的发布版下载它，校验 SHA-256，并安装到 CLI 旁边。也可以用 `nsh component` 提前管理：

```sh
nsh component list            # 本机可用的组件，以及是否已安装
nsh component add android web # 提前安装，例如离线之前
nsh component remove gpui     # 删除以释放空间
```

| 组件 | 内容 | 发布平台 |
|---|---|---|
| `android` | Android 运行时（`--target android`） | 所有平台 |
| `android-symbols` | Android 运行时的符号，用于崩溃报告和 `ndk-stack` | 所有平台 |
| `ios` | iOS 和 Mac Catalyst 运行时（`--target ios`、`catalyst`） | Apple silicon 的 macOS |
| `web` | Web 运行时（`--target web`） | 所有平台 |
| `gpui` | [GPUI](./gpui.md) 开发宿主（`--target gpui`） | 所有平台，各自构建 |
| `tui` | 终端开发宿主（`--target tui`） | 所有平台，各自构建 |

组件总是来自与 CLI 相同的构建。`nsh update` 会从更新到的发布版重新安装已安装的组件。nightly 构建的组件每晚都会替换，因此较早一晚的 nightly `nsh` 会提示先运行 `nsh update`。

## 用 Rust 编写的应用

通过 [rustup](https://rustup.rs) 安装 Rust。`nsh` 用 Cargo 为每个目标构建 Rust 应用的运行器，使用你的 crate 以及 crates.io 上与 CLI 同版本的 NSH crate，所以请添加你要运行的平台对应的 Rust 目标：

```sh
rustup target add aarch64-apple-ios-sim aarch64-apple-ios aarch64-apple-ios-macabi   # iOS 模拟器、真机、Mac Catalyst
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android # Android（配合 SDK 中的 NDK）
rustup target add wasm32-unknown-unknown                                             # Web
```

推荐使用 [huacnlee/cargo](https://github.com/huacnlee/cargo) 构建：这是 [huacnlee](https://github.com/huacnlee) 基于官方 Cargo 优化的分支，专门避免 Rust 编译产物把磁盘占满。所有项目和 Git worktree 共用一个构建目录，它会自己控制在大小限制之内；实测在 50 个 worktree 的场景下比官方 Cargo 少占约 90% 的磁盘空间，512 GB 的硬盘基本就够用。它直接替换 `~/.cargo/bin/cargo`，不需要任何配置：

```sh
curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh     # Windows：irm https://huacnlee.github.io/cargo/install.ps1 | iex
```

桌面平台为你所在的机器构建。在 Rust 应用目录中运行 `cargo run` 会直接在桌面后端上启动它，构建时使用该后端的开发库（[平台工具](#平台工具)）。Android 构建还会使用 SDK 中的 **NDK**，与[构建 Android 运行时](#构建-android-运行时)相同。

## 预构建发行包

发行包是一个目录 `dist/nsh`，包含 CLI 以及它打包应用时使用的预构建原生运行时：

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
dist/nsh/runtime/tui/nsh-tui-host[.exe]                      # 终端开发宿主（nsh run --target tui）
dist/nsh/runtime/web/{nsh.wasm,nsh-dev.wasm,nsh.js}          # the web runtimes (nsh package / run --target web)
dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework  # embedding in iOS apps
dist/nsh/embed/android/{nsh,nsh-dev}.aar                     # embedding in Android apps
```

把 `dist/nsh/bin` 加入 `PATH`（或直接调用 `dist/nsh/bin/nsh`），并保持目录完整：`nsh` 会在自身旁边的 `bin/../runtime` 中查找运行时（通过指向它的符号链接运行时也一样，安装脚本就是这样做的）。发布用的压缩包由它生成：每个平台的压缩包保留 `bin` 和自己的运行时，其他运行时成为[组件](#组件)，`embed` 成为 SDK 压缩包。

```sh
export PATH="$PWD/dist/nsh/bin:$PATH"
nsh --version
```

发行包由源码仓库中的 `cargo xtask dist` 生成（见下文）。其中的 `nsh` 可执行文件是为该机器构建的。在装有 Xcode 的 Mac 上，它包含 iOS 和 macOS 运行时（Apple Silicon）；在 Linux 上，它改为包含为该机器构建的 Linux 运行时；在 Windows 上则包含 Windows 运行时，CLI 为 `bin\nsh.exe`。每个发行包还包含为该机器构建的 [GPUI](./gpui.md) 开发宿主和终端开发宿主。它们都包含
Android 运行时（在 Windows 上，只有找到 Android SDK 时才包含）。

## 安装 nightly 版本

`main` 有新提交的每一天，夜间都会构建并发布为 [nightly release](https://github.com/longbridge/nsh/releases/tag/nightly)，包含和正式版相同的发行包：

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --nightly
nsh -V # nsh 0.4.0 (abcdef0 nightly)
```

用 Rust 编写的应用会用 crates.io 上与 CLI 同版本号的 NSH crate 构建 runner，也就是上一个正式版的 crate；这类应用请使用正式版或源码版。

## 更新

`nsh update` 把已安装的 `nsh` 更新到所在渠道的最新构建：正式版更新到最新正式版，nightly 版更新到最新 nightly。指定渠道即切换过去，与 `rustup update nightly` 一致：

```sh
nsh update                    # 所在渠道的最新版本
nsh update nightly            # 切换到 main 的 nightly 构建
nsh update stable             # 回到最新正式版
```

它下载和安装脚本相同的压缩包，校验 SHA-256，替换整个发行包目录，并重新安装之前已安装的组件。Homebrew、Scoop 和 mise 安装的 `nsh` 由它们自己更新（`brew upgrade nsh`、`scoop update nsh`、`mise upgrade`）。

## 从源码构建

准备好 Git、Rust 和[平台工具](#平台工具)后，在 macOS 和 Linux 上：

```sh
curl -fsSL https://nsh.dev/install.sh | sh -s -- --source
```

它把源码保留在 `~/.nsh/source`，构建 CLI 并链接到 `~/.local/bin`；再次运行即可更新。如果要开发 NSH 本身，克隆仓库并在其中构建 CLI；运行时缺少的桌面和 Web 运行时会自动构建：

```sh
git clone https://github.com/longbridge/nsh.git && cd nsh
cargo build -p nsh-cli          # ./target/debug/nsh
```

iOS、Android 运行时和发布版运行器的构建命令见仓库的 [AGENTS.md](https://github.com/longbridge/nsh/blob/main/AGENTS.md#commands)。

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
- 一个正在运行的模拟器，或通过 `adb` 连接的设备。应用要求 Android 8（API 26）及以上。

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
- **GStreamer** 1.14 及以上，用于视频和声音：构建运行时需要 `libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev`（Debian、Ubuntu）、`gstreamer gst-plugins-base`（Arch）、`gstreamer1-devel gstreamer1-plugins-base-devel`（Fedora），以及应用要播放的视频和音频格式对应的插件。

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
