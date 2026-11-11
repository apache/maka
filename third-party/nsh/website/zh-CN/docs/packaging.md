---
title: 打包
description: 用 nsh package 为 iOS 真机、iOS 模拟器、Android、macOS、Windows、Linux 和 Web 构建可安装的 Rust 和 TSX 应用，包括应用元数据、图标和签名。
order: 19
group: platforms
---

# 打包

`nsh package` 把应用变成可以安装的产物：用于 iOS 模拟器的 `.app`、用于 iOS 真机的已签名 `.ipa`、用于 Android 的已签名
`.apk` 或 `.aab`（Android App Bundle，用于 Google Play）、用于 macOS 的 ad hoc 签名 `.app`、用于 Linux 的目录和 `.tar.gz`、用于 Windows 的目录、`.zip` 和安装程序（`<Name>-setup.exe`，需 Inno Setup），或用于 Web 的静态站点。它不需要 Xcode 项目，也不需要 Gradle。

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
| `icon` | string \| object | 无 | 一张正方形 PNG，最好是 1024×1024，路径相对于 `nsh.json`；也可按平台分别提供（[图标](#图标)）。 |

`nsh.json` 还包含 `rust` 和 `root`（应用的 crate 和根组件，见[用 Rust 开发](./rust.md)）、`theme` 和 `appearance`、`tailwind`（见 [Tailwind](./tailwind.md)）、`capabilities`（见[沙箱与能力](./sandbox-and-capabilities.md)）、`android`（`targetSdk` 和 `usesCleartextTraffic`，见下文“目标 API 级别”和“明文 HTTP”）、`ios` 和 `macos`（对应包的 `Info.plist` 键和 entitlements，见[下文](#infoplist-键与-entitlements)；`macos.activationPolicy` 用于[菜单栏应用](./macos.md#菜单栏应用)）以及让桌面包自我更新、让所有原生包接收 [OTA 更新](./ota-updates.md)的 `updater`（见[应用更新](./app-updates.md)）；[项目结构](./project-structure.md#nshjson)列出了所有键。NSH 读不懂的键或值会给出警告并被略过：为更新的 NSH 写的应用在较旧的 NSH 上照样能构建，拼写错误也会在警告里看到。

上表中的每个键都可以在命令行上覆盖，这在 CI 中很方便：

```sh
nsh package --target android --app-version 1.4.0 --build 42
```

## 选项

| 参数 | 说明 |
|---|---|
| `--target <ios \| ios-simulator \| android \| macos \| linux \| windows \| web>` | 构建目标（必填）。 |
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
| `--format <apk \| aab>` | Android：写出 APK（默认，直接安装）或用于 Google Play 的 Android App Bundle（见下文“Google Play：App Bundle”）。 |
| `--arch <arm64 \| x86_64 \| universal>` | macOS：应用运行的处理器：Apple 芯片、Intel，或两者合在一个通用可执行文件里（见下文 [macOS](#macos)）。默认：本机的。 |
| `--run` | 构建完成后安装并启动：在 iOS 模拟器中，或在 `adb` 能看到的 Android 设备或模拟器上；macOS、Linux 和 Windows 应用在本机启动；Web 站点在本机提供服务并在浏览器中打开。不适用于 `--target ios`。 |
| `--asset-url <URL>` | Web：站点文件所在的 http(s) 地址（CDN），页面按它引用这些文件；`index.html` 和 `manifest.webmanifest` 仍在页面自己的地址下（和不带它时一样按相对路径引用），CDN 要返回 `Access-Control-Allow-Origin`。默认：放在页面旁边，用相对路径引用。`--run` 从本机直接提供站点，所以不带它。 |

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
- entitlements 取自描述文件，加上 `nsh.json` `ios.entitlements` 中应用自己的项，并对照描述文件检查（见[下文](#infoplist-键与-entitlements)）。NSH 会检查描述文件的 application identifier 是否覆盖应用的 `id`（`TEAMID.*` 或
  `TEAMID.com.example.*` 这样的通配描述文件也可以），不覆盖则报错退出。
- 用 `codesign` 以指定身份签名应用，再压缩成 `.ipa`（`Payload/<Name>.app`）。

查看可用的签名身份：

```sh
security find-identity -v -p codesigning
```

如果没有传 `--sign` 和 `--profile`，NSH 会写出一个未签名的 `.nsh/out/<Name>.app` 并给出提示；它无法直接安装到真机上。

应用支持 iPhone 和 iPad，支持竖屏和横屏（倒置竖屏仅限 iPad），要求 iOS 15.0 或更高版本，或应用指定的更高版本（见[最低系统版本](#最低系统版本)）。

## Android

```sh
nsh package --target android --run
```

写出 `.nsh/out/<Name>.apk`。APK 直接用 SDK 的构建工具（`aapt2`、`zipalign`、`apksigner`）组装，不经过 Gradle。要求：

- Android SDK，通过 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`，或 `~/Library/Android/sdk`）查找，需要安装 build tools 和
  `platforms;android-35` 包。缺少时 NSH 会告诉你对应的 `sdkmanager` 命令。
- 一个 JDK，用于首次创建 debug keystore。
- Rust 应用还需要 Android NDK（`sdkmanager "ndk;<version>"`，或 `ANDROID_NDK_HOME`），用它构建应用的 `libnsh.so`。

应用的目标 API 为 35（`targetSdkVersion`，Google Play 的要求），除非 `nsh.json` 指定了其他级别；应用要求 API 26（Android 8）或更高版本。它包含适用于手机 ABI `arm64-v8a` 和 `armeabi-v7a` 的原生代码；
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

### 目标 API 级别

`nsh.json` 中的 `android.targetSdk` 设置应用的目标 API 级别（默认 35，最低 28）。应用也会针对这个级别编译，所以 SDK 中需要有对应的
platform（`sdkmanager "platforms;android-36"`）：

```json
{
  "android": { "targetSdk": 36 }
}
```

### 明文 HTTP

打包后的应用通过 HTTPS 发请求。对于没有 TLS 的服务器（比如局域网里的服务器），`android.usesCleartextTraffic`
让应用也可以发普通的 `http://` 请求（[`android:usesCleartextTraffic`](https://developer.android.com/guide/topics/manifest/application-element#usesCleartextTraffic)）：

```json
{
  "android": { "usesCleartextTraffic": true }
}
```

开发构建（`nsh run --target android`）始终允许明文 HTTP：它们通过明文 HTTP 从开发服务器加载应用。

### Google Play：App Bundle

Google Play 接收 Android App Bundle，而不是 APK。`--format aab` 用同一个应用写出 `.nsh/out/<Name>.aab` 代替 APK，不需要 Gradle 或
bundletool；Google Play 会据此为每台设备生成要安装的 APK（每个 ABI 一个）。bundle 使用 JDK 中的 `jarsigner` 签名，签名选项与
`--keystore` 相同：这个密钥就是你在 Play 应用签名中登记的上传密钥。

```sh
NSH_KEYSTORE_PASSWORD=… nsh package --target android --format aab \
  --keystore release.jks --key-alias upload
```

`--run` 安装的是 APK，所以不能与 `--format aab` 同时使用；要在设备上试用 bundle，请使用
[bundletool](https://github.com/google/bundletool)（先 `build-apks`，再 `install-apks`）。

## macOS

```sh
nsh package --target macos --run
```

写出 `.nsh/out/<Name>.app`：可执行文件位于 `Contents/MacOS/`，`nsh/assets/…`、`nsh/app.json`（窗口标题、应用的外观、激活策略和 nsh.json 中的窗口设置）以及
TSX 应用的 `nsh/bundle.nshc` 位于 `Contents/Resources/`。应用使用 ad hoc 签名，要求 macOS 14 及以上，或应用指定的更高版本（见[最低系统版本](#最低系统版本)）；
要分发它，请用 Developer ID 签名并进行公证。见
[macOS](./macos.md#打包)。

应用运行在本机的处理器上。`--arch` 可以换成别的：`x86_64` 面向 Intel Mac，`arm64` 面向 Apple 芯片，`universal` 把两者合在一个可执行文件里。为另一种处理器编 runner
需要它的 Rust target：

```sh
rustup target add x86_64-apple-darwin
nsh package --target macos --arch universal
```

## Linux

```sh
nsh package --target linux --run
```

写出 `.nsh/out/<Name>/`（可执行文件 `<Name>`、`nsh/assets/…`、
包含窗口标题、应用 id 和 nsh.json 中窗口设置的 `nsh/app.json`、TSX 应用的 `nsh/bundle.nshc`、
`<id>.desktop` 和图标 `<id>.png`），以及同样内容的 `.nsh/out/<Name>.tar.gz`。请在 Linux 上打包：运行器是为构建它的机器构建的。运行应用的机器上必须装有
GTK 4（4.14 及以上）、Pango 和 WebKitGTK 6.0（用于 Web 视图）。如何安装应用及其桌面条目：见 [Linux](./linux.md#打包)。

## Windows

```sh
nsh package --target windows --run
```

写出 `.nsh\out\<Name>\`（带应用图标的可执行文件 `<Name>.exe`、`nsh\assets\…`、包含窗口标题、应用 id、版本、外观和 nsh.json 中窗口设置的 `nsh\app.json`，以及
TSX 应用的 `nsh\bundle.nshc`），以及同样内容的 `.nsh\out\<Name>.zip`。TSX 应用不需要任何工具；Rust 应用的 runner 用 Visual Studio
Build Tools 构建。请在 Windows 上打包：运行器是为构建它的机器构建的，而且只有
Windows 能嵌入图标。应用可以从目录被复制到的任何位置运行。`nsh package` 还会写出 Inno Setup 脚本 `.nsh\out\<Name>.iss`，装有 Inno Setup 6
时编译成 `.nsh\out\<Name>-setup.exe`：按用户安装（不需要管理员权限），带开始菜单快捷方式和“已安装的应用”条目，并支持原地升级。见 [Windows](./windows.md#打包)。

## Web

```sh
nsh package --target web --run
```

写出 `.nsh/out/<Name>/`，一个静态站点：`index.html`、`manifest.webmanifest`、页面脚本（`nsh.<digest>.js`）和 `nsh.<digest>.wasm`
（Rust 应用的引擎和 crate；TSX 应用则是运行时，旁边是应用的 ES 模块 `app.<digest>.js`）、资源和图标，每个文件都以其内容命名，托管方可以永久缓存它们。把目录部署到任意 Web 服务器或 CDN
即可；`--run` 在 `http://127.0.0.1:4173/` 上提供服务，自行在浏览器中打开即可。缓存头和嵌入方式见 [Web](./web.md#发布应用)。

## Info.plist 键与 entitlements

iOS 和 macOS 包的 `Info.plist` 由 NSH 写出，签名也由它完成。应用在 `nsh.json` 的 `ios` 和 `macos` 下添加自己的键（例如出口合规、
App Store 分类、App Transport Security 例外）和 entitlements（例如 Associated Domains）：

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
      "com.apple.developer.associated-domains": ["applinks:example.com"]
    }
  },
  "macos": {
    "infoPlist": { "LSApplicationCategoryType": "public.app-category.finance" },
    "entitlements": { "com.apple.security.network.client": true }
  }
}
```

值按属性列表（property list）写入：字符串、数字（整数或实数）、布尔值、数组和对象（字典）；`null` 会报错。应用设置的键会替换 NSH
的默认值，因此应用也可以改写 NSH 添加的权限说明文字、缩小支持的屏幕方向，或提高最低系统版本（见[下文](#最低系统版本)）。

NSH 根据 `nsh.json` 其他键设置的键、以及打包后的应用所依赖的键由 NSH 掌握。设置其中之一会报错，并说明应改设什么：

| 键 | 来自 |
|---|---|
| `CFBundleIdentifier` | `id` |
| `CFBundleName`、`CFBundleDisplayName` | `name` |
| `CFBundleShortVersionString`、`CFBundleVersion` | `version`、`build` |
| `CFBundleURLTypes` | `schemes` |
| `CFBundleDocumentTypes` | `fileTypes`（见[打开文件](../modules/nsh-desktop.md#opening-files)） |
| iOS：`CFBundleIcons`、`CFBundleIcons~ipad`、`CFBundleIconName`；macOS：`CFBundleIconFile` | `icon` |
| iOS：`UIUserInterfaceStyle` | `appearance` |
| iOS：`UIStatusBarStyle`、`UIStatusBarHidden` | `statusBar` |
| macOS：`LSUIElement` | `macos.activationPolicy`（见[菜单栏应用](./macos.md#菜单栏应用)） |
| `CFBundleExecutable`、`CFBundlePackageType`、`CFBundleSupportedPlatforms`；iOS：`LSRequiresIPhoneOS`、`UIApplicationSceneManifest`、`UIApplicationSupportsMultipleScenes`；macOS：`NSPrincipalClass` | 包本身 |
| entitlements：`application-identifier`、`com.apple.application-identifier`、`com.apple.developer.team-identifier` | `id` 和描述文件 |

entitlements：

- **iOS 真机**包用描述文件授予的 entitlements 签名，应用写的每一项替换描述文件里的值。应用列出的每个 entitlement 都必须是描述文件授予的，
  且值在其范围内（描述文件把 Associated Domains 授予为 `*`，把钥匙串分组授予为 `TEAMID.*`）；否则 `nsh package` 停下并指出是哪一项，
  这时为应用的标识符启用对应的 capability，再重新下载描述文件。
- **iOS 模拟器**包直接用应用写的 entitlements 签名。
- **macOS** 包用应用的 entitlements 做 ad hoc 签名。带 `com.apple.developer.*` entitlements 或钥匙串分组的应用，macOS 只在授予它们的描述文件下启动：
  `nsh package` 会对这些项给出警告，应用要先用 Developer ID 和这样的描述文件重新签名才能运行。

### 最低系统版本

打包后的应用运行在 iOS 15.0 和 macOS 14 及以上，即 NSH 运行时支持的系统。应用要用更高版本系统的 API 时（例如通过它自己的
[Rust crate](./rust.md)），用系统读取的键提高最低版本：`ios.infoPlist` 中的 `MinimumOSVersion`，`macos.infoPlist` 中的
`LSMinimumSystemVersion`。

```json
{
  "ios": { "infoPlist": { "MinimumOSVersion": "16.4" } },
  "macos": { "infoPlist": { "LSMinimumSystemVersion": "15.2" } }
}
```

值是由一到三个数字以点连接而成的字符串（`"15"`、`"15.2"`、`"15.2.1"`），不低于 NSH 在该平台的最低版本：iOS 为 `"15.0"`，macOS 为
`"14.0"`。包按应用写的原样声明它，iOS 的应用图标也按它编译。更低的版本或其他形式的值会在读取 `nsh.json` 时报错，错误信息给出 NSH 的最低版本。

## 图标

在 `nsh.json` 中（`"icon": "icon.png"`）或通过 `--icon` 提供一张正方形 PNG，最好是 1024×1024：

- **iOS：** 由 Xcode 的 `actool` 编译进应用的资源目录（`Assets.car`），iOS 所需的各种尺寸都由它生成。
- **Android：** 缩放到 192×192，用作启动器图标（`mipmap-xxxhdpi`）。
- **macOS：** 由 `sips` 转换为 `AppIcon.icns`。
- **Linux：** 复制为 `<id>.png`，`.desktop` 文件以它作为 `Icon`。
- **Windows：** 缩放为 16 到 64 像素以及 256 像素，作为图标嵌入可执行文件，窗口、资源管理器和任务栏都会显示它；同时写到 bundle 旁的 `nsh\icon.ico`，通知会显示它。在 macOS 或 Linux 上打包时，可执行文件在资源管理器里保持默认图标，窗口和任务栏显示 `icon.ico`。`nsh run --target windows` 和 `nsh test --target windows` 也会显示它。
- **Web：** 缩放为 32 像素（favicon）、180 像素（`apple-touch-icon`）以及 192 和 512 像素（Web 应用清单）。

各平台绘制图标的方式不同：macOS 的图案在透明画布上内缩（1024 像素中占 824），Windows、Linux 和 Android 则铺满画布。给 `icon` 一个对象，即可为每个平台使用各自的 PNG；键为 `macos`、`windows`、`linux`、`ios`、`android` 和 `web`，未列出的平台显示系统默认图标：

```json
{
  "icon": {
    "macos": "icon-macos.png",
    "windows": "icon.png",
    "linux": "icon.png"
  }
}
```

`--icon` 会替换它，用于本次打包的目标。

没有图标时，系统显示默认图标。

## 相机、蓝牙和其他硬件

打包后的应用根据 `nsh.json` 声明 NSH 自身功能用到的硬件：

| 功能 | iOS 和 macOS | Android |
|---|---|---|
| [`Speech`](../modules/nsh.md#speech)，应用授予 `speech` 或没有声明 capabilities 时 | `NSMicrophoneUsageDescription`、`NSSpeechRecognitionUsageDescription` | |
| 采集媒体的网页（[`capabilities.webview.media`](./sandbox-and-capabilities.md#webview)） | `NSMicrophoneUsageDescription`、`NSCameraUsageDescription`；macOS 上还有 entitlements `com.apple.security.device.audio-input` 和 `com.apple.security.device.camera` | `RECORD_AUDIO`、`CAMERA` |
| [`Notifications`](../modules/nsh.md#notifications)，应用授予 `notifications` 或没有声明 capabilities 时 | | `POST_NOTIFICATIONS` |

每个 Android 包还声明了 `INTERNET`。权限说明文字是应用第一次请求时系统显示的内容，应用可以在 `infoPlist` 中改用自己的措辞
（见[上文](#infoplist-keys-and-entitlements)）。

在 iOS 和 macOS 上，应用自己的 [Rust crate](./rust.md) 通过系统框架访问其他硬件，所需的权限说明文字写在 `infoPlist` 中，macOS
上的 entitlements 写在 `entitlements` 中：应用访问受保护的硬件而没有相应的权限说明文字时，系统会终止它。

使用其他硬件的 Android 应用把 NSH 嵌入自己的 Gradle 项目（[Android](./android.md#embedding-in-an-android-app)），iOS 应用也可以同样嵌入自己的
Xcode 项目（[iOS](./ios.md#embedding-in-an-ios-app)）。`AndroidManifest.xml` 和 `Info.plist` 归这个项目所有，所以由它在其中声明自己用到的内容，
并自己编写平台代码：相机预览是一个[原生组件](./native-components.md)，其余一切由应用通过 `host.call` 访问（[iOS](./ios.md#talking-to-the-app)、
[Android](./android.md#talking-to-the-app)）。

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
| Web | `nsh.<digest>.wasm`、`nsh.<digest>.js` | `<Name>/app.<digest>.js`、`assets/…`、`index.html` |

打包出的应用不注册任何[原生组件](./native-components.md)；如需使用原生组件，请把 NSH 嵌入你自己的应用。

## 日志

打包后的应用把它的警告、错误以及 `console.log` 和 `console.info` 日志写入平台日志：macOS 和 iOS 上是统一日志，以应用的 id 为子系统（“控制台”
应用，或 `log stream --predicate 'subsystem == "com.example.notes"'`），Android 上是 logcat，Windows 上是调试器输出，Linux
上是标准错误，Web 上是浏览器控制台。参见[打包应用的日志](./dev-server-and-debugging.md#a-packaged-apps-logs)。

## 查找运行时

Rust 应用构建自己的 runner。对 TSX 应用，`nsh package` 会在 CLI 旁边查找预构建运行时（发行包中的 `bin/../runtime`）。在 NSH 的源码仓库中，它使用
`target/<triple>/<profile>` 和 `target/android/<profile>`，profile 与 CLI 自身一致（debug 版 CLI 使用 debug 版运行时）：用
`cargo build -p nsh-ios-app --target aarch64-apple-ios-sim`（真机用 `aarch64-apple-ios`）和 `cargo xtask android`
构建它们（release 版 CLI 需加上 `--release`）；`nsh-macos-app`（在 macOS 上）、`nsh-linux-app`（在 Linux 上）和 `nsh-windows-app`（在 Windows 上）为本机构建，位于 `target/<profile>`（`cargo build -p nsh-macos-app`、`cargo build -p nsh-linux-app`、`cargo build -p nsh-windows-app`）；Web 运行时不论 CLI 的 profile 如何，都以 `web` profile 构建，位于 `target/wasm32-unknown-unknown/web/`。环境变量 `NSH_RUNTIME` 可以让 CLI 改用另一个目录，其结构与发行包的
`runtime/` 相同（`ios/iphoneos`、`ios/iphonesimulator`、`android/release`、`macos`、`linux`、`windows`、`gpui`、`web` 等）。

## 另请参阅

- [CLI](./cli.md)：所有命令
- [应用更新](./app-updates.md)：自我更新的打包应用
- [OTA 更新](./ota-updates.md)：无需新构建，为打包应用（包括 iOS 和 Android）下发新的 TSX
- [签名包](./signed-packages.md)：应用下载的更新
- [项目结构](./project-structure.md)：`nsh.json` 与应用的各个文件
- [原生组件](./native-components.md)：NSH 应用中宿主应用的视图

## 上传到 TestFlight

`nsh publish ios <IPA>` 使用 App Store Connect 的
[构建上传 API](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads)
上传经过 App Store 签名的 IPA。在 macOS 上运行，接收 `nsh package` 生成的 IPA，适用于 Rust、Rust + TSX 和 TSX 应用。

先在 App Store Connect 创建应用记录，准备对应 bundle identifier 的 Apple Distribution 签名证书和
App Store provisioning profile。在 `nsh.json` 中设置 `version`，并在打包前递增 `build`。
在 App Store Connect 创建有构建上传权限的团队 API Key（Developer、App Manager 或 Admin），
将 `.p8` 文件保存在仓库外。通过 shell 或 CI 的秘密环境变量提供凭据，保持 `nsh.json` 和版本控制中没有凭据。

```sh
nsh package --target ios --sign "Apple Distribution: Your Team (TEAMID)" \
  --profile /secure/AppStore.mobileprovision

export NSH_APP_STORE_APP_ID=1234567890
export NSH_APP_STORE_ISSUER_ID=your-issuer-id
export NSH_APP_STORE_KEY_ID=your-key-id
export NSH_APP_STORE_PRIVATE_KEY=/secure/AuthKey_YOURKEY.p8
nsh publish ios .nsh/out/MyApp.ipa
```

| 参数 | 环境变量 | 含义 |
|---|---|---|
| `--app-id <ID>` | `NSH_APP_STORE_APP_ID` | 已创建的 App Store Connect 应用的数字 Apple ID。 |
| `--issuer-id <ID>` | `NSH_APP_STORE_ISSUER_ID` | 团队 API Key 的 issuer ID。 |
| `--key-id <ID>` | `NSH_APP_STORE_KEY_ID` | API Key ID。 |
| `--private-key <PATH>` | `NSH_APP_STORE_PRIVATE_KEY` | `.p8` 私钥文件路径。 |

四项均必填，命令行参数优先于环境变量。CLI 从 IPA 读取 bundle ID、版本和构建号，
核对 bundle ID 与 App Store Connect 应用一致，然后签发短期 ES256 token、按指定分段流式上传，
最后提交 SHA-256 校验和。完成消息包含 upload ID 和应用的 TestFlight 链接。

命令成功表示 Apple 已接受上传，等待处理。在 App Store Connect 查看处理状态、填写出口合规信息、
设置测试组并处理可能需要的 Beta 审核；App Store 提审和正式发布仍由你手动操作。
上传中断时，先根据输出的 upload ID 在 App Store Connect 核实状态，再决定是否重试；每次运行都会创建新上传。
Apple 在处理构建时验证签名和 provisioning profile。

`nsh publish <ENTRY> --key … --cert …` 继续为嵌入场景生成签名 `.nshpkg`。
本地入口目录名为 `ios` 时，写作 `./ios`。
