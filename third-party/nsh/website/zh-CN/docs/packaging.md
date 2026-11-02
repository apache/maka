---
title: 打包
description: 用 nsh package 为 iOS 真机、iOS 模拟器、Android、macOS、Windows、Linux、终端和 Web 构建可安装的 Rust 和 TSX 应用，包括应用元数据、图标和签名。
order: 19
group: platforms
---

# 打包

`nsh package` 把应用变成可以安装的产物：用于 iOS 模拟器的 `.app`、用于 iOS 真机的已签名 `.ipa`、用于 Android 的已签名
`.apk`、用于 macOS 的 ad hoc 签名 `.app`、用于 Linux 的目录和 `.tar.gz`、用于 Windows 的目录和 `.zip`，或用于 Web 的静态站点；`--target tui` 生成控制台应用。它不需要 Xcode 项目，也不需要 Gradle。

- **Rust 应用**（`nsh.json` 写明 `"root"`）在自己的目录里打包。`nsh` 以 release 模式为目标构建 runner，编译进你的 crate 并挂载根组件，
  不带 QuickJS：需要 Cargo、该平台的 Rust 目标（`rustup target add …`），Android 还需要 NDK。
- **TSX 应用**写明入口。它的 release 构建（压缩并编译为 QuickJS 字节码，与 `nsh build --release` 的构建结果完全相同）与 NSH 自带的
  **预构建运行时**放在一起，因此不需要 Rust 工具链。带有自己 crate 的应用（有 `"rust"` 而没有 `"root"`）使用以其 crate 构建的 runner。

```sh
# Rust 应用，在它的目录里
nsh package --target ios-simulator --run     # 构建、安装并在模拟器中启动
nsh package --target android --run           # 构建、安装并在设备或模拟器上启动
nsh package --target macos --run             # 构建并在这台 Mac 上启动
nsh package --target linux --run             # 构建并在本机启动
nsh package --target windows --run           # 构建并在本机启动
nsh package --target tui --run               # 在当前终端构建并运行
nsh package --target web --run               # 构建、在本机提供服务并在浏览器中打开
nsh package --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile Dev.mobileprovision

# TSX 应用：同样的命令加上入口
nsh package App.tsx --target ios-simulator --run
```

除非传入 `--out`，否则输出到 `.nsh/out/`。下面各节给出的是 Rust 应用的命令；TSX 应用加上它的入口（`nsh package App.tsx --target …`）。

> [!NOTE]
> 如果想把 NSH 放*进*现有的原生应用，请参阅[平台](./platforms.md#嵌入原生应用)；GPUI 或 GPUI Kit 应用请参阅 [GPUI](./gpui.md#嵌入-gpui-应用)。如果想发布由应用下载并验证的更新，请参阅[签名包](./signed-packages.md)。

## 应用元数据：`nsh.json`

`nsh package` 读取应用目录中（TSX 应用即入口文件同目录下）的 `nsh.json`。`nsh init` 会生成一个：

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "icon": "icon.png"
}
```

| 键 | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `name` | string | 入口文件所在目录的名称 | 图标下方显示的名称（`CFBundleDisplayName`、Android 的 `android:label`），也用作输出文件名。 |
| `id` | string | 必填 | Bundle identifier / Android 包名，使用你拥有的域名的反向 DNS 形式。它也决定应用[存储](../modules/nsh.md#storage)的位置，因此每个应用各有一份。`nsh package` 和 `nsh publish` 遇到 `com.example.` 占位 id 时会给出警告。 |
| `version` | string | `"1.0.0"` | 用户可见的版本号（`CFBundleShortVersionString`、`versionName`）。 |
| `build` | number | `1` | 构建号（`CFBundleVersion`、`versionCode`）。每次上传新版本都要递增。 |
| `icon` | string | 无 | 一张正方形 PNG，最好是 1024×1024，路径相对于 `nsh.json`。 |

`nsh.json` 还包含 `rust` 和 `root`（应用的 crate 和根组件，见[用 Rust 开发](./rust.md)）、`theme` 和 `appearance`、`tailwind`（见 [Tailwind](./tailwind.md)）以及 `capabilities`（见[沙箱与能力](./sandbox-and-capabilities.md)）；[项目结构](./project-structure.md#nshjson)列出了所有键。未知的键会导致报错。

上表中的每个键都可以在命令行上覆盖，这在 CI 中很方便：

```sh
nsh package --target android --app-version 1.4.0 --build 42
```

## 选项

| 参数 | 说明 |
|---|---|
| `--target <ios \| ios-simulator \| android \| macos \| linux \| windows \| tui \| web>` | 构建目标（必填）。 |
| `-o, --out <dir>` | 输出目录。默认为 `.nsh/out`。 |
| `--name <name>` | 显示名称。 |
| `--id <id>` | Bundle identifier，如 `com.example.app`。 |
| `--app-version <version>` | 版本号，如 `1.2.0`。 |
| `--build <n>` | 构建号。 |
| `--icon <png>` | 应用图标：一张正方形 PNG，最好是 1024×1024。 |
| `--sign <identity>` | iOS：用于真机的代码签名身份。 |
| `--profile <file>` | iOS：用于真机的描述文件（`.mobileprovision`）。 |
| `--keystore <file>` | Android：release keystore（默认使用 debug 密钥）。 |
| `--key-alias <alias>` | Android：keystore 中的密钥别名。 |
| `--keystore-password <password>` | Android：keystore 密码；也可从 `NSH_KEYSTORE_PASSWORD` 读取。 |
| `--abi <abi>` | Android：APK 包含的 ABI，可重复或用逗号分隔（默认：`arm64-v8a` 和 `armeabi-v7a`）。 |
| `--run` | 构建完成后安装并启动：在 iOS 模拟器中，或在 `adb` 能看到的 Android 设备或模拟器上；macOS、Linux 和 Windows 应用在本机启动；终端应用在当前终端中运行直到退出；Web 站点在本机提供服务并在浏览器中打开。不适用于 `--target ios`。 |

## iOS 模拟器

```sh
nsh package --target ios-simulator --run
```

写出 `.nsh/out/<Name>.app`，使用 ad hoc 签名（模拟器需要签名，但不需要签名身份）。加上 `--run` 时，如果没有正在运行的模拟器，它会先启动一个，再安装并启动应用。需要安装 Xcode。

## iOS 真机

```sh
nsh package --target ios \
  --sign "Apple Distribution: Example Inc (ABCDE12345)" \
  --profile AppStore.mobileprovision
```

写出 `.nsh/out/<Name>.ipa`，可用于 TestFlight、App Store 上传工具或直接安装（取决于描述文件）。具体过程如下：

- 描述文件以 `embedded.mobileprovision` 的名称复制进应用。
- entitlements 取自描述文件。NSH 会检查描述文件的 application identifier 是否覆盖应用的 `id`（`TEAMID.*` 或
  `TEAMID.com.example.*` 这样的通配描述文件也可以），不覆盖则报错退出。
- 用 `codesign` 以指定身份签名应用，再压缩成 `.ipa`（`Payload/<Name>.app`）。

查看可用的签名身份：

```sh
security find-identity -v -p codesigning
```

如果没有传 `--sign` 和 `--profile`，NSH 会写出一个未签名的 `.nsh/out/<Name>.app` 并给出提示；它无法直接安装到真机上。

应用支持 iPhone 和 iPad，支持竖屏和横屏（倒置竖屏仅限 iPad），要求 iOS 15.0 或更高版本。

## Android

```sh
nsh package --target android --run
```

写出 `.nsh/out/<Name>.apk`。APK 直接用 SDK 的构建工具（`aapt2`、`zipalign`、`apksigner`）组装，不经过 Gradle。要求：

- Android SDK，通过 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`，或 `~/Library/Android/sdk`）查找，需要安装 build tools 和
  `platforms;android-35` 包。缺少时 NSH 会告诉你对应的 `sdkmanager` 命令。
- 一个 JDK，用于首次创建 debug keystore。
- Rust 应用还需要 Android NDK（`sdkmanager "ndk;<version>"`，或 `ANDROID_NDK_HOME`），用它构建应用的 `libnsh.so`。

应用的目标 API 为 35，要求 API 28（Android 9）或更高版本。它包含适用于手机 ABI `arm64-v8a` 和 `armeabi-v7a` 的原生代码；
加上 `--run` 时还包含设备的 ABI，例如模拟器的 `x86_64`。用 `--abi` 可以自己选择，例如 `--abi arm64-v8a` 只面向 64 位手机，APK 最小：

```sh
nsh package --target android --abi arm64-v8a
```

### 发布签名

不传 `--keystore` 时，APK 使用标准的 debug 密钥（`~/.android/debug.keystore`，不存在时自动创建）签名，NSH
会警告它不能用于应用商店发布。正式发布时，先创建一次 keystore，然后传入：

```sh
keytool -genkeypair -v -keystore release.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000

NSH_KEYSTORE_PASSWORD=… nsh package --target android \
  --keystore release.jks --key-alias upload
```

建议使用环境变量而不是 `--keystore-password`，以免密码留在 shell 历史记录中。

## macOS

```sh
nsh package --target macos --run
```

写出 `.nsh/out/<Name>.app`：可执行文件位于 `Contents/MacOS/`，`nsh/assets/…`、`nsh/app.json`（窗口标题和应用的外观）以及 TSX 应用的
`nsh/bundle.nshc` 位于 `Contents/Resources/`。应用使用 ad hoc 签名，要求 macOS 14 及以上；要分发它，请用 Developer ID 签名并进行公证。见
[macOS](./macos.md#打包)。

## Linux

```sh
nsh package --target linux --run
```

写出 `.nsh/out/<Name>/`（可执行文件 `<Name>`、`nsh/assets/…`、包含窗口标题和应用 id 的 `nsh/app.json`、TSX 应用的 `nsh/bundle.nshc`、
`<id>.desktop` 和图标 `<id>.png`），以及同样内容的 `.nsh/out/<Name>.tar.gz`。请在 Linux 上打包：运行器是为构建它的机器构建的。运行应用的机器上必须装有
GTK 4（4.14 及以上）、Pango 和 WebKitGTK 6.0（用于 Web 视图）。如何安装应用及其桌面条目：见 [Linux](./linux.md#打包)。

## Windows

```sh
nsh package --target windows --run
```

写出 `.nsh\out\<Name>\`（带应用图标的可执行文件 `<Name>.exe`、`nsh\assets\…`、包含窗口标题、应用 id、版本和外观的 `nsh\app.json`，以及
TSX 应用的 `nsh\bundle.nshc`），以及同样内容的 `.nsh\out\<Name>.zip`。TSX 应用不需要任何工具；Rust 应用的 runner 用 Visual Studio
Build Tools 构建。请在 Windows 上打包：运行器是为构建它的机器构建的，而且只有
Windows 能嵌入图标。应用可以从目录被复制到的任何位置运行，不需要安装。见 [Windows](./windows.md#打包)。

## 终端

```sh
nsh package App.tsx --target tui --run
```

写出 `.nsh/out/<Name>/`，包含控制台可执行文件、`nsh/bundle.nshc`、
`nsh/assets/…` 和 `nsh/app.json`，并在 macOS 和 Linux 上归档为 `.tar.gz`，
在 Windows 上归档为 `.zip`。请在可执行文件将运行的操作系统上打包。
`--run` 使用当前终端，并等待应用退出。参见[终端](./tui.md#打包)。

## Web

```sh
nsh package --target web --run
```

写出 `.nsh/out/<Name>/`，一个静态站点：`index.html`、`manifest.webmanifest`、页面脚本（`nsh.<digest>.js`）和 `nsh.<digest>.wasm`
（Rust 应用的引擎和 crate；TSX 应用则是运行时，旁边是应用的 ES 模块 `app.<digest>.js`）、资源和图标，每个文件都以其内容命名，托管方可以永久缓存它们。把目录部署到任意 Web 服务器或 CDN
即可；`--run` 在 `http://127.0.0.1:4173/` 上提供服务，自行在浏览器中打开即可。缓存头和嵌入方式见 [Web](./web.md#发布应用)。

## 图标

在 `nsh.json` 中（`"icon": "icon.png"`）或通过 `--icon` 提供一张正方形 PNG，最好是 1024×1024：

- **iOS：** 由 Xcode 的 `actool` 编译进应用的资源目录（`Assets.car`），iOS 所需的各种尺寸都由它生成。
- **Android：** 缩放到 192×192，用作启动器图标（`mipmap-xxxhdpi`）。
- **macOS：** 由 `sips` 转换为 `AppIcon.icns`。
- **Linux：** 复制为 `<id>.png`，`.desktop` 文件以它作为 `Icon`。
- **Windows：** 缩放为 16 到 64 像素以及 256 像素，作为图标嵌入可执行文件，窗口、资源管理器和任务栏都会显示它。
- **Web：** 缩放为 32 像素（favicon）、180 像素（`apple-touch-icon`）以及 192 和 512 像素（Web 应用清单）。

没有图标时，系统显示默认图标。

## 包里有什么

Rust 应用的包就是它的 runner：用你的 crate 构建，挂载好根组件，再加上它的 crate 注册的资源（`assets!()`）。TSX 应用的包中包含应用的字节码、
`capabilities.json`（当应用声明了能力时）以及应用导入的资源，与预构建运行时放在一起：

| 目标 | 运行时 | TSX 应用 |
|---|---|---|
| iOS | `nsh-ios-app` 可执行文件 | `<Name>.app/nsh/bundle.nshc`、`nsh/assets/…` |
| Android | `classes.dex`、`lib/<abi>/libnsh.so`（不带符号，不压缩存储，16 KB 对齐） | `assets/nsh/bundle.nshc`、`assets/nsh/assets/…` |
| macOS | `nsh-macos-app` 可执行文件，重命名为 `<Name>` | `<Name>.app/Contents/Resources/nsh/bundle.nshc`、`nsh/assets/…` |
| Linux | `nsh-linux-app` 可执行文件，重命名为 `<Name>` | `<Name>/nsh/bundle.nshc`、`nsh/assets/…` |
| Windows | `nsh-windows-app.exe` 可执行文件，重命名为 `<Name>.exe` | `<Name>\nsh\bundle.nshc`、`nsh\assets\…` |
| 终端 | `nsh-tui-app`，重命名为 `<Name>`（Windows 上为 `<Name>.exe`） | `<Name>/nsh/bundle.nshc`、`nsh/assets/…` |
| Web | `nsh.<digest>.wasm`、`nsh.<digest>.js` | `<Name>/app.<digest>.js`、`assets/…`、`index.html` |

打包出的应用不注册任何[原生组件](./native-components.md)；如需使用原生组件，请把 NSH 嵌入你自己的应用。

## 查找运行时

Rust 应用构建自己的 runner。对 TSX 应用，`nsh package` 会在 CLI 旁边查找预构建运行时（发行包中的 `bin/../runtime`）。在 NSH 的源码仓库中，它使用
`target/<triple>/<profile>` 和 `target/android/<profile>`，profile 与 CLI 自身一致（debug 版 CLI 使用 debug 版运行时）：用
`cargo build -p nsh-ios-app --target aarch64-apple-ios-sim`（真机用 `aarch64-apple-ios`）和 `cargo xtask android`
构建它们（release 版 CLI 需加上 `--release`）；`nsh-macos-app`（在 macOS 上）、`nsh-linux-app`（在 Linux 上）、`nsh-windows-app`（在 Windows 上）、`nsh-tui-app`（在三者任一上）为本机构建，位于 `target/<profile>`（`cargo build -p nsh-macos-app`、`cargo build -p nsh-linux-app`、`cargo build -p nsh-windows-app`、`cargo build -p nsh-tui-app`）；Web 运行时不论 CLI 的 profile 如何，都以 `web` profile 构建，位于 `target/wasm32-unknown-unknown/web/`。环境变量 `NSH_RUNTIME` 可以让 CLI 改用另一个目录，其结构与发行包的
`runtime/` 相同（`ios/iphoneos`、`ios/iphonesimulator`、`android/release`、`macos`、`linux`、`windows`、`gpui`、`tui`、`web` 等）。

## 另请参阅

- [CLI](./cli.md)：所有命令
- [签名包](./signed-packages.md)：应用下载的更新
- [项目结构](./project-structure.md)：`nsh.json` 与应用的各个文件
