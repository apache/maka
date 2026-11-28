---
title: 打包
description: 用 nsh package 为 iOS 真机、iOS 模拟器、Android、macOS、Windows、Linux 和 Web 构建可安装的 TSX 和 Rust 应用，包括应用元数据、图标和签名。
order: 19
group: publishing
---

# 打包

`nsh package` 把应用变成可以安装的产物：用于 iOS 模拟器的 `.app`、用于 iOS 真机的已签名 `.ipa`、用于 Android 的已签名
`.apk` 或 `.aab`（Android App Bundle，用于 Google Play）、用于 macOS 的已签名 `.app`（不带 `--sign` 时为 ad hoc 签名）、用于 Linux 的目录和 `.tar.gz`、用于 Windows 的目录、`.zip` 和安装程序（`<Name>-setup.exe`，需 Inno Setup），或用于 Web 的静态站点。它不需要 Xcode 项目，也不需要 Gradle。

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

`nsh.json` 还包含 `rust` 和 `root`（应用的 crate 和根组件，见[用 Rust 开发](./rust.md)）、`theme` 和 `appearance`、`tailwind`（见 [Tailwind](./tailwind.md)）、`capabilities`（见[沙箱与能力](./sandbox-and-capabilities.md)）、`android`（`targetSdk`、`usesCleartextTraffic`、`permissions`、`libraries`、`manifestPlaceholders`、`queries` 和 `application`，见下文“目标 API 级别”“明文 HTTP”“权限”“Java 代码”和“组件与 queries”）、`ios` 和 `macos`（对应包的 `Info.plist` 键和 entitlements，见[下文](#infoplist-键与-entitlements)；`ios.extensions` 和 `macos.extensions` 分别是 [iOS 应用扩展](#应用扩展)和 [macOS 应用扩展](#macos-应用扩展)；`macos.activationPolicy` 用于[菜单栏应用](./macos.md#菜单栏应用)）以及让桌面包自我更新、让所有原生包接收 [OTA 更新](./ota-updates.md)的 `updater`（见[应用更新](./app-updates.md)）；[项目结构](./project-structure.md#nshjson)列出了所有键。NSH 读不懂的键或值会给出警告并被略过：为更新的 NSH 写的应用在较旧的 NSH 上照样能构建，拼写错误也会在警告里看到。

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
| `--sign <identity>` | iOS 和 macOS：代码签名身份（用于 iOS 真机，或启用 Hardened Runtime 和安全时间戳的 macOS 包）。 |
| `--profile <file>` | iOS：用于真机的描述文件（`.mobileprovision`）。可以重复传入，给每个[应用扩展](#应用扩展)各传一个。 |
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

- 检查可执行文件包含 `arm64` 架构。`UIRequiredDeviceCapabilities` 默认为 `["arm64"]`，可通过
  `ios.infoPlist` 替换。签名前，从当前 Xcode 工具链读取 Xcode 和 SDK 构建信息并写入 `Info.plist`。
- 描述文件以 `embedded.mobileprovision` 的名称复制进应用。
- entitlements 取自描述文件，加上 `nsh.json` `ios.entitlements` 中应用自己的项，并对照描述文件检查（见[下文](#infoplist-键与-entitlements)）。NSH 会检查描述文件的 application identifier 是否覆盖应用的 `id`（`TEAMID.*` 或
  `TEAMID.com.example.*` 这样的通配描述文件也可以），不覆盖则报错退出。
- 应用如果带有扩展，先用各自的描述文件签名扩展（见[应用扩展](#应用扩展)）。
- 用 `codesign` 以指定身份签名应用，再压缩成 `.ipa`（`Payload/<Name>.app`）。

查看可用的签名身份：

```sh
security find-identity -v -p codesigning
```

如果没有传 `--sign` 和 `--profile`，NSH 会写出一个未签名的 `.nsh/out/<Name>.app` 并给出提示；它无法直接安装到真机上。

应用支持 iPhone 和 iPad，支持竖屏和横屏（倒置竖屏仅限 iPad），要求 iOS 15.0 或更高版本，或应用指定的更高版本（见[最低系统版本](#最低系统版本)）。

### 应用扩展

小组件、实时活动（Live Activity）、通知服务扩展等应用扩展是独立的 bundle（`.appex`），iOS 在应用的 `PlugIns/`
目录里找到它们。先用 Xcode 或 `swiftc` 构建好，再在应用的 `nsh.json` 里用 `ios.extensions` 列出，路径相对于
`nsh.json`，和 `android.libraries` 列出 Java 库的方式一样：

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

| 键 | 含义 |
|---|---|
| `path` | 为真机构建的扩展。 |
| `simulatorPath` | 为模拟器构建的扩展。不写时，`path` 如果是为模拟器构建的，模拟器包就带上它，否则不带这个扩展（并给出警告）。 |
| `entitlements` | 扩展的 entitlements，和应用的 `ios.entitlements` 一样（见[下文](#infoplist-键与-entitlements)）。 |

每个包都会把扩展复制进 `PlugIns/`，并把它们的版本号设成应用的 `version` 和 `build`：扩展的版本号应当和应用一致（不一致时
App Store Connect 会给出提示）。扩展的
identifier 必须以应用的开头（应用为 `com.example.app` 时，扩展为 `com.example.app.Widget`）。模拟器包用 ad hoc 签名；
真机包先用各扩展 identifier 对应的描述文件给它签名，并把描述文件作为 `embedded.mobileprovision` 放进扩展，再签名应用。
`nsh run --target ios` 也会带上扩展：模拟器里的开发宿主运行所有 TSX 应用，所以每个扩展的 identifier 改用宿主的开头
（`com.longbridge.nsh.host.Widget`）。
给应用传一个 `--profile`，每个扩展再各传一个；写明了 bundle identifier 的描述文件优先于覆盖它的通配描述文件：

```sh
nsh package --target ios \
  --sign "Apple Distribution: Example Inc (ABCDE12345)" \
  --profile AppStore.mobileprovision \
  --profile AppStoreWidget.mobileprovision
```

应用和扩展共用的代码（比如实时活动的 attributes）分别编进两边。它们通过 app group 共享数据，两边的 entitlements
都要列出这个 group。要启动实时活动的应用，还要在自己的 `Info.plist` 里通过 `ios.infoPlist` 声明
`NSSupportsLiveActivities`：

```json
{
  "ios": { "infoPlist": { "NSSupportsLiveActivities": true } }
}
```

## Android

```sh
nsh package --target android --run
```

写出 `.nsh/out/<Name>.apk`。APK 直接用 SDK 的构建工具（`aapt2`、`zipalign`、`apksigner`）组装，不经过 Gradle。要求：

- Android SDK，通过 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`，或 `~/Library/Android/sdk`）查找，需要安装 build tools 和
  `platforms;android-35` 包。缺少时 NSH 会告诉你对应的 `sdkmanager` 命令。
- 一个 JDK，用于首次创建 debug keystore，以及构建应用列出的 [Java 库](#java-代码)。
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

### 权限

manifest 会声明 NSH 自身功能需要的权限：`INTERNET`，[`network()`](./device-and-environment.md#网络) 用的 `ACCESS_NETWORK_STATE`，[通知](./sandbox-and-capabilities.md#notifications)用的 `POST_NOTIFICATIONS`，web view 的 `media`
用的 `RECORD_AUDIO` 和 `CAMERA`，以及在 Android 13 之前让运行时注册的接收器只对应用自己开放的签名级权限
`<package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`（与 androidx 同名）。`android.permissions` 用来添加其他权限，供应用或扩展中直接调用 Android 的代码使用：不带点的名字是
Android 自己的权限（`android.permission.<NAME>`），带点的名字按原样写入。

```json
{
  "android": { "permissions": ["ACCESS_WIFI_STATE", "com.example.permission.READ_ORDERS"] }
}
```

`ACCESS_WIFI_STATE` 这样的普通权限在安装应用时授予。运行时权限（例如 `ACCESS_FINE_LOCATION`）只是被声明：仍需应用自己的代码向用户
申请。TSX 开发宿主（TSX 应用的 `nsh run --target android`）不声明这些权限；Rust 应用的 `nsh run` 会构建它的包，因此会声明。

### Java 代码

Rust 通过 JNI 可以调用大多数 Android API，但有些 API 需要应用自己定义的类（监听器、回调、`PrintDocumentAdapter`），还有些 SDK
以 Java 库的形式提供。`android.libraries` 写在应用的 `nsh.json` 中，列出 jar、Android 库（`.aar`）和 dex 文件，路径相对于 `nsh.json`。nshm 在自己的
`Cargo.toml` 里列出它的库（见[打包的应用需要什么](./nshm.md#打包的应用需要什么)），使用它的应用无需再列：

```json
{
  "android": { "libraries": ["android/libs/vendor-sdk.jar", "java/out/glue.jar"] }
}
```

打包时用 SDK 的 `d8` 把 jar 转换成 dex，把其中的类放在 NSH 运行时之后，应用的类加载器因此能找到它们。jar 里类以外的文件（例如
供 `ServiceLoader` 读取的 `META-INF/services/...`）放到包的根目录；其中 `assets/` 下的文件和 Android 的 Gradle 插件一样作为包的 asset。dex 文件按原样放入，不经过 `d8` 合并，所以它和 jar 里重复定义的类在打包时不会被发现。同一个文件被列出两次或被两个 crate
列出时只放入一次；两个不同的文件定义了同一个类时构建会停止，并指出这两个文件。不列出任何库的应用照旧打包，不会运行 `d8`。

这些库都是本地文件：NSH 不下载它们，也不解析 Maven 依赖，所以 SDK 依赖的库也要一并列出。第三方工具 [nsh-maven](https://github.com/SuperNSH/maven)
会从 Maven 仓库解析一个库及其依赖（`nsh-maven add com.google.firebase:firebase-messaging:26.0.1`），把文件下载到应用中并在这里列出；
加上 `--crate` 时则列在 nshm crate 的 `Cargo.toml` 里。

Android 库（`.aar`）带来的不只是类（类按 jar 的方式处理）：它的原生库（`jni/<abi>/*.so`）按包含的 ABI 放入，和 NSH 自己的一样不压缩存放；
它的 assets 和应用自己的 assets 放在一起；它的资源（`res/`）并入包里的资源，库的代码照它构建时那样通过自己的 `R` 类读取；它 manifest 里的权限、功能、`<queries>` 和组件并入应用的 manifest，相对类名（`.PushService`）
补上它的包名，`${applicationId}` 换成应用的包名。几个库以同一个名字声明的组件（例如各自往同一个启动 provider 里加初始化器）合成一个。
它 manifest 里（或 crate 的 `android.application` 里）的其他占位符取 `android.manifestPlaceholders` 的值，只有应用的 `nsh.json`
能设置：这些值属于应用，例如某个服务的 key。`nsh test --target android` 安装的共用开发宿主不读任何应用的 `nsh.json`，
这些占位符在那里留空，并给出警告。

```json
{
  "android": {
    "libraries": ["android/libs/push-sdk-5.2.0.aar"],
    "manifestPlaceholders": { "PUSH_APP_KEY": "…" }
  }
}
```

每个库按它 manifest 里的包名只放入一次：两个 crate 带了同一个文件时只放一次；同一个库的两个版本会让构建停止并指出两者；应用在自己的
`nsh.json` 里列出的版本就是包里用的版本。库需要 NSH 应用没有的东西时，构建也会停止并指出这个库：最低 API 级别高于 26、平台比
`android.targetSdk` 更新、自己的 `Application` 类、manifest 合并规则（`tools:node="remove"`、`tools:replace`），或包里有某个 ABI、而库带了原生库却缺这个 ABI 的版本，或带了资源却没有 Android 构建一并写出的 `R.txt`。

和所有 Android 应用一样，资源共用一个命名空间。几处为同一配置（密度、夜间模式、语言等）定义了同名资源时，包自己的资源（`android/res/`）
优先，其次是应用 `nsh.json` 列出的库（先列的优先于后列的），再次是各 crate 的库（crate 名排序靠前的优先）。样式整个取自胜出的一方，
不逐条合并。NSH 为包生成的资源（图标、启动画面和通知音）在所有配置下都归包自己：库里同名的资源会被去掉，并给出警告。
库的 `R.txt` 也会列出它构建时所依赖的库的资源；没有任何列出的库定义的那些不会进入它的 `R` 类，只汇总提示一次。库的代码读取了这样的资源时，
构建会停止并指出这个库、读取它的类和资源：把定义它的库也列上。

自己的 Java 源码先针对平台的 `android.jar` 编译，再打成 jar：

```sh
javac --release 11 -classpath "$ANDROID_HOME/platforms/android-35/android.jar" -d java/classes java/src/*.java
jar cf java/out/glue.jar -C java/classes .
```

在 Rust 启动的线程里，JNI 的 `FindClass` 只能找到系统的类；在那里要通过 activity 的类加载器（`Context.getClassLoader()`）加载应用的类。

NSH 应用没有自己的 `Application` 类，所以必须在 `Application` 里初始化、或必须继承它的 SDK 无法使用。随应用启动的 SDK 通过
content provider 初始化：由它的 AAR 自己声明，或由 nshm 在 `android.application` 里声明：

```toml
[package.metadata.nsh.features.push.android]
libraries = ["android/libs/push-sdk.jar", "android/libs/push-glue.jar"]
application = ['<provider android:name="com.example.push.Init" android:authorities="${applicationId}.push-init" android:exported="false"/>']
```

`nsh run --target android` 同样带上这些库：TSX 应用放在开发宿主里，Rust 应用放在它构建的包里。开发宿主对所有应用使用同一个包名，
所以按包名校验应用的 SDK（推送服务的 SDK、地图 SDK）只能在应用自己的包里使用：用 `nsh package --target android --run` 试。
TSX 开发宿主（TSX 应用的 `nsh run --target android`）不包含这些文件；Rust 应用的 `nsh run` 会构建它的包，因此会包含。

### 组件与 queries

由系统启动的类（`<service>`、`<receiver>`、`<provider>`）只有在 manifest 中声明后才能工作；SDK 也可能需要 `<meta-data>`，或者需要
`<queries>` 条目才能看到其他应用。`android.application` 向 manifest 的 `<application>` 添加 `<service>`、`<receiver>`、`<provider>`、
`<activity>` 和 `<meta-data>` 元素；`android.queries` 向 `<queries>` 添加 `<intent>`、`<package>` 和 `<provider>` 元素。每个条目是
一个完整写出的元素，其中的 `${applicationId}` 会被替换为应用的包名，其他 `${name}` 替换为 `android.manifestPlaceholders` 给出的值。
不是这样一个元素、带有 `tools:` 属性（它们属于库的 manifest），
或者用了 NSH 自己声明的名字（它的 `com.longbridge.nsh.*` 类和 meta-data，以及它的文件 provider 所用的 `${applicationId}.files`
authority）的条目，会被略过并给出警告：

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

应用链接的 crate 也用同样的方式添加它们的条目（见[打包的应用需要什么](./nshm.md#打包的应用需要什么)），排在应用的之后。
应用有 Android 库（`.aar`）时，这些条目会与库声明的内容合并：与库中某个元素同名的条目（例如给库声明的 provider 添加的
`<meta-data>`）会并入该元素。`<application>` 元素自身的属性仍由 NSH 设置。开发宿主（TSX 应用的 `nsh run`，以及 `nsh test --target android`）声明 crate 的条目，
但不声明应用自己的；Rust 应用的 `nsh run` 会构建它的包，因此会声明。

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
TSX 应用的 `nsh/bundle.nshc` 位于 `Contents/Resources/`。不传 `--sign` 时应用使用 ad hoc 签名，要求 macOS 14 及以上，或应用指定的更高版本（见[最低系统版本](#最低系统版本)）。见
[macOS](./macos.md#打包)。

要为分发签名，传入 `--sign <identity>`（例如 `"Developer ID Application: …"` 或 `"Apple Development: …"`）：

```sh
nsh package --target macos --sign "Developer ID Application: Example Inc (ABCDE12345)"
```

使用证书签名时，NSH 会按公证要求启用 Hardened Runtime（`--options runtime`）和安全时间戳（`--timestamp`），先由内向外签名所有嵌套扩展及其内嵌框架/动态库，再签名 `.app`，并用 `codesign --verify --deep --strict` 校验结果。

应用运行在本机的处理器上。`--arch` 可以换成别的：`x86_64` 面向 Intel Mac，`arm64` 面向 Apple 芯片，`universal` 把两者合在一个可执行文件里。为另一种处理器编 runner
需要它的 Rust target：

```sh
rustup target add x86_64-apple-darwin
nsh package --target macos --arch universal
```

### macOS 应用扩展

预构建的 macOS 应用扩展（用 Xcode 或 `swiftc` 构建的 `.appex` bundle）可以在应用的 `nsh.json` 中通过 `macos.extensions` 列出，路径相对于 `nsh.json`：

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

| 键 | 含义 |
|---|---|
| `path` | macOS `.appex` bundle 目录，包含 `Contents/Info.plist` 和 `Contents/MacOS/<executable>`。 |
| `entitlements` | 扩展的 entitlements，和应用的 `macos.entitlements` 一样（见[下文](#infoplist-键与-entitlements)）。 |

打包时会把扩展复制进 `Contents/PlugIns/`，并将它们的 `CFBundleShortVersionString` 和 `CFBundleVersion` 同步为应用的 `version` 和 `build`。每个扩展的 bundle identifier 必须以应用的开头（`<app_id>.`），且若存在 `CFBundleSupportedPlatforms` 必须包含 `MacOSX`。在签名 `.app` 之前，NSH 会用本次打包的签名身份（ad hoc 或 `--sign`）由内向外签名每个扩展：先无 entitlements 签名 `Contents/Frameworks/` 下的 `.framework` 和 `.dylib`，再带扩展自身的 entitlements 签名 `.appex`。

### 签名、公证与分发

在 Mac App Store 之外，Mac 应用以已签名并经过公证的 `.app` 分发，用户从你的网站或 GitHub Release 下载。`nsh package --target macos --sign …` 构建应用并用你的 Developer ID 签名；公证、装订（staple）和上传则用 Apple 的命令行工具和你的发布主机完成。之后由[应用更新](./app-updates.md)让已安装的副本保持最新。

`nsh publish` 没有 macOS 商店上传：NSH 目前还不能为 Mac App Store 打包。

#### 首次发布之前

每个开发者账号做一次：

1. **加入 Apple Developer Program。**
2. **创建 Developer ID Application 证书**（“证书、标识符和描述文件”→“证书”；只有账号持有人能创建），安装到负责打包的 Mac（或 CI runner）的登录钥匙串中。`security find-identity -v -p codesigning` 会把它列为 `Developer ID Application: Example Inc (ABCDE12345)`。
3. **为 `notarytool` 设置公证凭据**，以一个配置名称在钥匙串中保存一次。使用 App Store Connect 团队 API 密钥（与 [iOS 上传](./publish.md#before-the-first-release)使用的同一种）：

   ```sh
   xcrun notarytool store-credentials notes-notary \
     --key /secure/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --issuer 69a6de70-0000-0000-0000-000000000000
   ```

   或使用 Apple ID 和 App 专用密码：`xcrun notarytool store-credentials notes-notary --apple-id
   you@example.com --team-id ABCDE12345`。

#### 配置应用

| 键 | 在构建中 | 说明 |
|---|---|---|
| `id` | `CFBundleIdentifier` | 也决定应用[存储](../modules/nsh.md#storage)的位置；保持不变。 |
| `name` | `.app` 名称和 `CFBundleName` | |
| `version`、`build` | `CFBundleShortVersionString`、`CFBundleVersion` | `version` 必须是 semver，并且要递增才能[自我更新](./app-updates.md)。 |
| `icon`（或 `icon.macos`） | `AppIcon.icns` | macOS 图标的图案内缩在透明画布上（[图标](./packaging.md#icons)）。 |
| `macos.infoPlist` | `Info.plist` 键 | 用途说明和其他键（[Info.plist 键](./packaging.md#infoplist-keys-and-entitlements)）。 |
| `macos.entitlements` | 应用的 entitlements | 与 Hardened Runtime 一起签入应用；添加应用需要的例外项，如访问摄像头。 |
| `macos.infoPlist` 中的 `LSMinimumSystemVersion` | 能打开应用的最低 macOS 版本 | 默认 macOS 14（[最低系统版本](./packaging.md#minimum-system-version)）。 |
| `macos.extensions` | `Contents/PlugIns/` | 预先构建的 `.appex` 包，由内向外签名（[macOS 应用扩展](./packaging.md#macos-app-extensions)）。 |

#### 构建并签名

```sh
nsh package --target macos --arch universal \
  --sign "Developer ID Application: Example Inc (ABCDE12345)"
```

这会写出 `.nsh/out/<Name>.app`。有证书时，NSH 先签名内嵌的 framework 和扩展，再签名应用，并按公证的要求启用 Hardened Runtime（`--options runtime`）和安全时间戳（`--timestamp`），最后用 `codesign --verify --deep --strict` 验证结果。`--arch universal` 能同时在 Apple 芯片和 Intel Mac 上运行（Rust 应用需要 `rustup target add x86_64-apple-darwin`）；省略它则只面向本机的处理器。不带 `--sign` 时应用使用 ad hoc 签名，能在构建它的 Mac 上运行，但在其他 Mac 上会被 Gatekeeper 拦下。

#### 公证并装订

Apple 会扫描经过公证的应用是否含有恶意内容并做记录，这样 Gatekeeper 打开它时就不会警告。提交应用的 zip，等待结果，再把票据装订到应用上，让它离线也能打开：

```sh
cd .nsh/out
ditto -c -k --keepParent Notes.app Notes-notarize.zip
xcrun notarytool submit Notes-notarize.zip --keychain-profile notes-notary --wait
xcrun stapler staple Notes.app
spctl --assess --type execute --verbose Notes.app   # "accepted, source=Notarized Developer ID"
```

如果提交结果为 `Invalid`，`xcrun notarytool log <submission-id> --keychain-profile notes-notary` 会列出所有问题。

#### 分发

把装订后的应用打包成归档供下载。用 `ditto` 制作的 zip 会保留签名和扩展属性：

```sh
ditto -c -k --keepParent Notes.app Notes-1.4.0-macos.zip
```

`nsh.json` 中有 [`"updater"`](./app-updates.md#set-the-source) 时，`nsh package` 还会写出用于自我更新的 `<Name>-<version>-macos-<arch>.tar.gz`。它包含的是打包时、公证前的应用：用同样的名称重新归档装订后的应用，再按[应用更新](./app-updates.md#publish-a-release)所述写出清单：

```sh
tar -czf Notes-1.4.0-macos-aarch64.tar.gz Notes.app
nsh update-manifest *.tar.gz --notes CHANGES.md --key keys/update.secret
```

把归档、`latest.json` 及其签名上传到 GitHub Release 或你的主机。已安装的副本会检查清单、下载归档、验证归档和应用的代码签名，然后替换自己。

#### 常见错误

| 问题 | 处理方法 |
|---|---|
| `codesign` 找不到签名身份 | 证书不在构建使用的钥匙串中，或缺少私钥：导入连同私钥一起导出的 `.p12`。 |
| 在 CI 上签名时出现 `errSecInternalComponent` | 钥匙串已锁定：解锁它（`security unlock-keychain`），并允许 `codesign` 使用该密钥（`security set-key-partition-list`）。 |
| 公证 `Invalid`：未使用有效的 Developer ID 证书签名 | 应用使用了 ad hoc 签名或 Apple Development 证书：用 `--sign "Developer ID Application: …"` 打包。 |
| 公证 `Invalid`：签名不包含安全时间戳 | 通过会自动添加时间戳的 `nsh package --sign` 签名；不要在不带 `--timestamp` 的情况下手动重新签名。 |
| 下载后提示“Notes 已损坏，无法打开” | 归档丢失了签名（用会丢弃属性的工具压缩，或签名后被修改）：装订之后用 `ditto` 或 `tar` 归档。 |
| 公证成功了 Gatekeeper 仍然警告 | 票据没有装订而 Mac 处于离线状态，或下载的应用不是经过公证的那个：先装订，再重新归档。 |
| 应用无法使用摄像头、麦克风或其他受保护资源 | 在 `macos.infoPlist` 中添加用途说明，并在 `macos.entitlements` 中添加 Hardened Runtime 例外项。 |

## Linux

```sh
nsh package --target linux --run
```

写出 `.nsh/out/<Name>/`（可执行文件 `<Name>`、`nsh/assets/…`、
包含窗口标题、应用 id 和 nsh.json 中窗口设置的 `nsh/app.json`、TSX 应用的 `nsh/bundle.nshc`、
`<id>.desktop` 和图标 `<id>.png`），以及同样内容的 `.nsh/out/<Name>.tar.gz`。请在 Linux 上打包：运行器是为构建它的机器构建的。运行应用的机器上必须装有
GTK 4（4.14 及以上）、Pango 和 WebKitGTK 6.0（用于 Web 视图）。如何安装应用及其桌面条目：见 [Linux](./linux.md#打包)。

### AppImage 与 Flatpak

`--format appimage` 或 `--format flatpak` 还会根据 `nsh.json` 及其 `store` 部分写出 desktop 文件、256×256 图标和 AppStream
metainfo（`<id>.metainfo.xml`）（见[发布](./publish.md#store-listing)）。

#### AppImage

```sh
nsh package --target linux --format appimage
```

在目录和压缩包之外，再写出 `.nsh/out/<Name>.AppDir` 和 `.nsh/out/<Name>-<arch>.AppImage`。AppImage 带有 desktop 文件、图标和
metainfo，和压缩包一样使用系统的 GTK 4 与 WebKitGTK，所以目标系统需要装有它们。把它附在你的发布里，用户这样运行：

```sh
chmod +x Counter-x86_64.AppImage
./Counter-x86_64.AppImage
```

#### Flatpak

```sh
nsh package --target linux --format flatpak
```

写出 `.nsh/out/flatpak/<id>.yml`：一个把包的压缩包安装到 GNOME runtime（提供 GTK 4 与 WebKitGTK）上的 manifest。装有
`flatpak-builder` 时还会构建它，写出单文件包 `.nsh/out/<Name>.flatpak`，用于测试或分发：

```sh
flatpak install --user .nsh/out/Counter.flatpak
flatpak run io.github.example.Counter
```

依赖：[appimagetool](https://github.com/AppImage/appimagetool/releases) 在 `PATH` 中或由 `NSH_APPIMAGETOOL` 指定（没有 FUSE
时设置 `APPIMAGE_EXTRACT_AND_RUN=1`）；本地构建 Flatpak 需要 `flatpak`、`flatpak-builder` 以及 GNOME runtime 和 SDK。
AppImage 包含 NSH，但不包含 GTK 4 和 WebKitGTK；AppImage 启动后没有窗口，说明系统缺少它们，Flatpak 会自带。发布到
Flathub：见[发布](./publish.md#publish-to-flathub)。

### 分发

`nsh package --target linux` 把应用写成一个目录及其 `.tar.gz`，附带桌面条目和图标。你把归档上传到你的网站或 GitHub Release，用户解压并安装桌面条目；[应用更新](./app-updates.md)让已安装的副本保持最新。

`--format appimage` 和 `--format flatpak` 还会写出 AppImage 和 Flatpak（见[上文](#appimage-and-flatpak)）；`nsh package` 目前还不能写出 `.deb` 或 `.rpm` 包。发布到 Flathub 见[发布](./publish.md#publish-to-flathub)。

#### 首次发布之前

在 Linux 上打包：runner 是为构建它的机器构建的，所以要在你要发布的处理器架构（`x86_64` 或 `aarch64`）上打包，并且使用对你支持的用户来说足够旧的发行版，因为比用户更新的 glibc 会让应用无法启动。Ubuntu 24.04 是面向当前桌面系统的不错选择。构建需要 GTK 4（4.14 或更高）、Pango 和 WebKitGTK 6.0 的开发包（[Linux：环境要求](./linux.md#requirements)）。

#### 配置应用

| 键 | 在包中 | 说明 |
|---|---|---|
| `id` | `<id>.desktop`、`StartupWMClass`、GTK 应用 id、`<id>.png` | 桌面环境靠它把应用的窗口和启动器对应起来；使用反向 DNS 形式，如 `com.example.notes`。保持不变。 |
| `name` | 可执行文件 `<Name>`、目录和桌面条目的 `Name` | |
| `version` | 自我更新归档 | 必须是 semver，并且要递增才能[自我更新](./app-updates.md)。 |
| `icon`（或 `icon.linux`） | `<id>.png`，由桌面条目的 `Icon` 指定 | 一张铺满画布的正方形 PNG（[图标](./packaging.md#icons)）。 |

#### 构建

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

详情见[打包：Linux](./packaging.md#linux)。

#### 分发

把 `<Name>.tar.gz` 上传到你的网站或 GitHub Release，并告诉用户需要安装哪些库。运行时需要 GTK 4、Pango 和 WebKitGTK 6.0：

| 发行版 | 安装 |
|---|---|
| Debian、Ubuntu | `sudo apt install libgtk-4-1 libwebkitgtk-6.0-4` |
| Fedora | `sudo dnf install gtk4 webkitgtk6.0` |
| Arch | `sudo pacman -S gtk4 webkitgtk-6.0` |

为单个用户安装分四步，可以由安装脚本完成：把目录解压到一个固定的位置，把可执行文件链接到 `PATH` 上，再把桌面条目和图标复制到桌面环境查找它们的位置。

```sh
mkdir -p ~/.local/opt ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/256x256/apps
tar -xzf Notes.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/Notes/Notes ~/.local/bin/Notes
cp ~/.local/opt/Notes/com.example.notes.desktop ~/.local/share/applications/
cp ~/.local/opt/Notes/com.example.notes.png ~/.local/share/icons/hicolor/256x256/apps/
```

可执行文件会通过链接找到它的 `nsh/` 目录。发布前用 `desktop-file-validate ~/.local/share/applications/com.example.notes.desktop` 检查桌面条目。

`nsh.json` 中有 [`"updater"`](./app-updates.md#set-the-source) 时，`nsh package` 还会写出用于自我更新的 `<Name>-<version>-linux-<arch>.tar.gz`。把它和清单一起上传（[应用更新](./app-updates.md#publish-a-release)）：

```sh
nsh update-manifest *.tar.gz *.zip --notes CHANGES.md --key keys/update.secret
```

#### 常见错误

| 问题 | 处理方法 |
|---|---|
| `error while loading shared libraries: libgtk-4.so.1`（或 `libwebkitgtk-6.0.so.4`） | 安装上文列出的运行时库。 |
| `version 'GLIBC_2.39' not found` | 应用在比用户更新的发行版上打包：换一个较旧的发行版打包。 |
| 应用没有出现在启动器中 | 桌面条目不在 `~/.local/share/applications` 中，或它的 `Exec` 找不到可执行文件：把可执行文件链接到 `PATH` 上。 |
| 启动器显示通用图标，或应用运行时出现第二个图标 | 图标不在图标主题目录中，或桌面条目被改了名：保持文件名为 `<id>.desktop`，`StartupWMClass` 与它对应。 |
| `exec format error` | 归档是为另一种处理器构建的：在 `x86_64` 和 `aarch64` 上分别打包。 |

## Windows

```sh
nsh package --target windows --run
```

写出 `.nsh\out\<Name>\`（带应用图标的可执行文件 `<Name>.exe`、`nsh\assets\…`、包含窗口标题、应用 id、版本、外观和 nsh.json 中窗口设置的 `nsh\app.json`，以及
TSX 应用的 `nsh\bundle.nshc`），以及同样内容的 `.nsh\out\<Name>.zip`。TSX 应用不需要任何工具；Rust 应用的 runner 用 Visual Studio
Build Tools 构建。请在 Windows 上打包：运行器是为构建它的机器构建的，而且只有
Windows 能嵌入图标。应用可以从目录被复制到的任何位置运行。`nsh package` 还会写出 Inno Setup 脚本 `.nsh\out\<Name>.iss`，装有 Inno Setup 6
时编译成 `.nsh\out\<Name>-setup.exe`：按用户安装（不需要管理员权限），带开始菜单快捷方式和“已安装的应用”条目，并支持原地升级。见 [Windows](./windows.md#打包)。

### MSIX

```sh
nsh package --target windows --format msix                  # .nsh/out/<Name>.msix，用于 Store
nsh package --target windows --format msix --sign cert.pfx  # 签名后可在 Store 之外安装
```

`--format msix` 额外写出 `.nsh\out\<Name>.msix`：打包目录加上 `AppxManifest.xml`（full-trust 桌面应用）、由应用图标生成的 logo 和 block map。不需要 Windows SDK，Linux 和 macOS 的 CI 也能生成。包标识来自 `nsh.json` 的 `windows`：`identityName`、`publisher`、`publisherDisplayName`，前两项从 Partner Center 的 Product identity 复制（默认分别为应用 id 与 `CN=<name>`）。版本号为 `version` 加第四位 0。Store 会自行签名，用 `nsh publish windows` 提交未签名的包即可（见[发布](./publish.md#publish-to-the-microsoft-store)）；Store 之外分发需 `--sign <cert.pfx>`（Windows 上用 `signtool`，其他系统用 `osslsigncode` 2.6+，密码放在 `NSH_WINDOWS_CERT_PASSWORD`），证书主题必须等于 `windows.publisher`。

### 签名与分发

`nsh package --target windows` 写出直接下载发布所需的一切：应用目录、它的 `.zip`，以及用 Inno Setup 构建的按用户安装的安装程序。你用自己的代码签名证书签名可执行文件，再上传到你的网站或 GitHub Release；[应用更新](./app-updates.md)让已安装的副本保持最新。

上架 Microsoft Store 时，打包 [MSIX](#msix) 并用 `nsh publish windows` 提交（见[发布](./publish.md#publish-to-the-microsoft-store)）。

#### 首次发布之前

在负责打包的 Windows 机器（或 CI runner）上：

1. **安装工具。** TSX 应用不需要任何工具；Rust 应用的 runner 用 Visual Studio Build Tools 构建。安装程序需要 Inno Setup 6：`winget install JRSoftware.InnoSetup`。
2. **获取代码签名证书**：从证书颁发机构购买，或使用 Azure Trusted Signing 这样的云签名服务。未签名的可执行文件照样能运行，但 SmartScreen 会提示发布者未知，一些杀毒软件也会对它们抱有怀疑。
3. **安装 Windows SDK** 以获得 `signtool.exe`（它随 Visual Studio 安装程序的 Windows SDK 组件提供）。

#### 配置应用

| 键 | 在构建中 | 说明 |
|---|---|---|
| `id` | 安装程序的 AppId、开始菜单快捷方式的 AppUserModelID | 用于在任务栏中归组应用的窗口，并在通知中标识应用；相同 id 的新版安装程序会升级已安装的应用。保持不变。 |
| `name` | `<Name>.exe`、安装目录和开始菜单项 | |
| `version` | 安装程序的版本和“已安装的应用”中的条目 | 必须是 semver，并且要递增才能[自我更新](./app-updates.md)。 |
| `icon`（或 `icon.windows`） | 嵌入 `<Name>.exe`，并写为 `nsh\icon.ico` | 在 Windows 上打包：只有 Windows 能嵌入图标（[图标](./packaging.md#icons)）。 |

#### 构建

```powershell
nsh package --target windows
```

```text
.nsh\out\<Name>\           the app: <Name>.exe and nsh\
.nsh\out\<Name>.zip        the same, as an archive
.nsh\out\<Name>.iss        the Inno Setup script
.nsh\out\<Name>-setup.exe  the installer, when Inno Setup 6 is installed
```

安装程序不需要管理员权限：它为当前用户安装到 `%LOCALAPPDATA%\Programs\<Name>`，添加开始菜单快捷方式和可用于卸载的“已安装的应用”条目，并在原位升级已安装的副本（会先关闭应用）。无论升级还是卸载，都不会动应用的数据。详情见[打包：Windows](./packaging.md#windows)。

#### 签名

先签名应用的可执行文件，再构建安装程序，这样安装后的应用也是已签名的；然后签名安装程序。证书位于 Windows 证书存储中时：

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /n "Example Inc" .nsh\out\Notes\Notes.exe
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" .nsh\out\Notes.iss
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /n "Example Inc" .nsh\out\Notes-setup.exe
signtool verify /pa .nsh\out\Notes-setup.exe
```

`ISCC.exe` 用 `nsh package` 写出的脚本重新编译安装程序，这次包含已签名的可执行文件；它的路径取决于 Inno Setup 的安装位置（为整台机器安装时是 `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`）。如果你也发布 `.zip`，同样要从已签名的目录重新制作。始终加上时间戳（`/tr`）：这样证书过期后签名仍然有效。

#### 分发

把 `Notes-setup.exe`（以及给偏好便携版的用户准备的 `.zip`）上传到你的网站或 GitHub Release。

`nsh.json` 中有 [`"updater"`](./app-updates.md#set-the-source) 时，`nsh package` 还会写出用于自我更新的 `<Name>-<version>-windows-<arch>.zip`。把已签名的应用放进去，再与其他平台的归档一起写出清单（[应用更新](./app-updates.md#publish-a-release)）：

```powershell
nsh update-manifest *.zip *.tar.gz --notes CHANGES.md --key keys\update.secret
```

#### SmartScreen

SmartScreen 根据信誉做判断，信誉随着人们下载和运行同一证书签名的文件而增长。新证书或新类型的证书，即使文件已签名，也可能在一段时间内显示“Windows 已保护你的电脑”警告。每次发布都用同一个证书签名，信誉才能延续下去。

#### 常见错误

| 问题 | 处理方法 |
|---|---|
| `.nsh\out` 中没有 `<Name>-setup.exe` | 没有安装 Inno Setup 6，或不在 `nsh package` 查找的位置：用 `winget install JRSoftware.InnoSetup` 安装，或用 `ISCC.exe` 编译 `.nsh\out\<Name>.iss`。 |
| 可执行文件显示默认图标 | 它是在 macOS 或 Linux 上打包的：在 Windows 上打包才能嵌入图标。 |
| 无法识别 `signtool` | 在 Developer PowerShell 中运行，或把 Windows SDK 的 `bin\<version>\x64` 目录加入 `PATH`。 |
| `SignTool Error: No certificates were found that met all the given criteria` | 证书不在 `signtool` 搜索的存储中，或 `/n` 与证书的使用者不匹配：用 `certutil -user -store My` 列出证书。 |
| 已签名的安装程序显示“Windows 已保护你的电脑” | 该证书的 SmartScreen 信誉仍在积累中（见上文）。 |
| 安装程序要求关闭应用 | 它在原位升级，会先关闭正在运行的副本；这是预期行为。 |

## Web

```sh
nsh package --target web --run
```

写出 `.nsh/out/<Name>/`，一个静态站点：`index.html`、`manifest.webmanifest`、页面脚本（`nsh.<digest>.js`）和 `nsh.<digest>.wasm`
（Rust 应用的引擎和 crate；TSX 应用则是运行时，旁边是应用的 ES 模块 `app.<digest>.js`）、资源和图标，每个文件都以其内容命名，托管方可以永久缓存它们。把目录部署到任意 Web 服务器或 CDN
即可；`--run` 在 `http://127.0.0.1:4173/` 上提供服务，自行在浏览器中打开即可。缓存头和嵌入方式见 [Web](./web.md#发布应用)。

### 托管站点

在 Web 上，应用就是一个静态站点。`nsh package --target web` 写出它；你把目录复制到任意 Web 服务器、对象存储或静态托管服务上。没有应用商店，不需要签名，也没有审核，部署之后每个用户下次加载时就会更新。这里没有 `nsh publish` 要做的事。

#### 配置应用

| 键 | 在站点中 | 说明 |
|---|---|---|
| `name` | 页面标题和 Web 应用清单的名称 | |
| `id` | Web 应用清单的 id | |
| `icon`（或 `icon.web`） | favicon、`apple-touch-icon` 和清单图标 | 缩放为 32、180、192 和 512 像素（[图标](./packaging.md#icons)）。 |
| `appearance` | 页面加载时的颜色 | |
| `web.base` | 站点所在的路径 | 应用在自己的路径下打开时需要（[链接到应用内](./web.md#links-into-the-app)）。 |
| `web.host` | 页面的宿主脚本 | [宿主的函数](./web.md#the-hosts-functions)。 |

#### 构建

```sh
nsh package --target web            # a Rust app, from its directory
nsh package App.tsx --target web    # a TSX app
nsh package --target web --run      # and serve it on http://127.0.0.1:4173/ to try it
```

这会写出 `.nsh/out/<Name>/`（用 `--out` 指定其他目录）：`index.html`、`manifest.webmanifest`，以及其余所有按内容命名的文件（`nsh.<digest>.wasm`、`app.<digest>.js`、`assets/…`），旁边还有它们的 Brotli 和 gzip 副本。一次发布只会改变 `index.html` 和真正变化了的文件。完整的文件列表和运行时大小见 [Web：发布应用](./web.md#publish-an-app)。

站点默认使用相对 URL，因此放在任何主机的任何目录下都能工作。如果想让文件从 CDN 提供、页面仍留在应用自己的地址，传入 `--asset-url https://cdn.example.com/notes/`。

#### 部署

任何静态托管都可以。遵守两条规则，应用就能快速加载并立即更新：

| 文件 | `Cache-Control` |
|---|---|
| `index.html`、`manifest.webmanifest` | `no-cache` |
| 其他所有文件 | `public, max-age=31536000, immutable` |

以 `application/wasm` 提供 `.wasm`，并向支持的浏览器发送预压缩的 `.br` 和 `.gz` 副本（[部署](./web.md#deploy-it)中有 nginx 和 Caddy 的配置）。先上传带哈希的文件，再上传 `index.html`，这样访客永远不会拿到所引用文件尚未就位的页面。

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

项目站点位于 `/<repo>/` 下；相对 URL 能处理这一点。在自己的路径下打开的应用要设置 `"web": { "base": "/<repo>/" }`，并添加一份 `index.html` 的副本作为 `404.html`（上传前执行 `cp site/index.html site/404.html`），GitHub Pages 会用它响应未知路径。GitHub Pages 不能按文件设置 `Cache-Control`，所以回访的用户也会重新验证带哈希的文件；能自行设置响应头的主机加载更快。

##### 对象存储和 CDN

```sh
nsh package --target web --out site
aws s3 sync site s3://example-notes --exclude index.html --exclude manifest.webmanifest \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp site/index.html s3://example-notes/ --cache-control no-cache
aws s3 cp site/manifest.webmanifest s3://example-notes/ --cache-control no-cache
```

把 CDN 配置为以 `application/wasm` 提供 `.wasm`，并用 Brotli 压缩，或直接提供 `.br` 副本。

#### 支持的浏览器

Safari 16.4（iOS 和 iPadOS 16.4）、Chrome 和 Edge 97、Firefox 108 及更高版本。更早的浏览器会显示空白页面（[支持的浏览器](./web.md#supported-browsers)）。

#### 常见错误

| 问题 | 处理方法 |
|---|---|
| 页面空白，控制台中出现 `Failed to load module script` | 主机以错误的内容类型提供 `.js` 或 `.wasm`，或文件没有上传：查看“网络”面板。 |
| `WebAssembly.instantiateStreaming` 因响应的 MIME 类型不正确而失败 | 以 `application/wasm` 提供 `.wasm`。 |
| 打开应用的某个路径或在该路径上刷新时返回 404 | 用 `index.html` 响应应用下的所有路径，并设置 `web.base`（[链接到应用内](./web.md#links-into-the-app)）。 |
| 部署后用户看到的仍是旧版本 | `index.html` 被缓存了：用 `Cache-Control: no-cache` 提供它。 |
| 来自 CDN 的文件被 CORS 拦截 | `--asset-url` 指向 CDN 时，CDN 必须针对页面的源返回 `Access-Control-Allow-Origin`。 |
| 在较旧的 iPhone 或 Android WebView 上页面空白 | 浏览器版本低于支持的版本。 |

## Info.plist 键与 entitlements

iOS 和 macOS 包的 `Info.plist` 由 NSH 写出，签名也由它完成。应用在 `nsh.json` 的 `ios` 和 `macos` 下添加自己的键（例如出口合规、
App Store 分类、App Transport Security 例外）和 entitlements（例如 Associated Domains）。（打开应用的 Web 链接写在
`links` 中，它会为 iOS 包加上对应的 `applinks:` 条目：参见 [Web 链接](../modules/nsh.md#web-链接)。）

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
| iOS：`UILaunchScreen`（设置了 `ios.launchScreen` 时） | `ios.launchScreen`（[启动画面](#启动画面)） |
| macOS：`LSUIElement` | `macos.activationPolicy`（见[菜单栏应用](./macos.md#菜单栏应用)） |
| `CFBundleExecutable`、`CFBundlePackageType`、`CFBundleSupportedPlatforms`；iOS：`LSRequiresIPhoneOS`、`UIApplicationSceneManifest`、`UIApplicationSupportsMultipleScenes`；macOS：`NSPrincipalClass` | 包本身 |
| entitlements：`application-identifier`、`com.apple.application-identifier`、`com.apple.developer.team-identifier` | `id` 和描述文件 |

entitlements：

- **iOS 真机**包用描述文件授予的 entitlements 签名，应用写的每一项替换描述文件里的值。应用列出的每个 entitlement 都必须是描述文件授予的，
  且值在其范围内（描述文件把 Associated Domains 授予为 `*`，把钥匙串分组授予为 `TEAMID.*`）；否则 `nsh package` 停下并指出是哪一项，
  这时为应用的标识符启用对应的 capability，再重新下载描述文件。
- **iOS 模拟器**包直接用应用写的 entitlements 签名。
- **macOS** 包用应用的 entitlements 签名（默认 ad hoc，传入 `--sign <identity>` 时启用 Hardened Runtime）。带
  `com.apple.developer.*` entitlements 或钥匙串分组的应用，macOS 只在授予它们的描述文件下启动：`nsh package` 会对这些项给出警告，运行前需要先嵌入对应的描述文件（`Contents/embedded.provisionprofile`）并重新签名。

### 其他语言的 Info.plist 文字

`Info.plist` 里的字符串（例如权限弹框中的用途说明、图标下的应用名）在应用提供了翻译时，系统按用户的语言显示。
`ios.infoPlistStrings` 和 `macos.infoPlistStrings` 按语言给出这些翻译：

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

打包时每种语言写成包里的 `<语言>.lproj/InfoPlist.strings`；`nsh run` 也给 iOS 模拟器和 Mac Catalyst 的开发宿主带上同样的文件，
打包前就能看到各语言的弹框文字。系统对每个应用只问一次：再次检查弹框前先重置之前的选择，iOS 模拟器用
`xcrun simctl privacy booted reset camera <id>`，macOS 和 Mac Catalyst 用 `tccutil reset Camera <id>`，`<id>` 是应用的
`id`，在 `nsh run` 下是开发宿主的 id。

- **语言代码**按 Xcode 的写法：语言，需要时再加文字（script）或地区，用 `-` 连接（`en`、`ja`、`zh-Hans`、`zh-Hant`、`pt-BR`）。
  其他写法（`zh-hans`、`zh_TW`、`Chinese`）会报错并指出是哪个键。
- **`Info.plist` 里的值**是所有没有翻译的语言看到的文字，所以每个翻译的键都要有这个值：写在 `infoPlist` 里，或者来自 NSH
  （应用名、NSH 添加的用途说明）或 [crate](./nshm.md#打包的应用需要什么)。包的 `Info.plist` 里没有这个键、或者它不是字符串时，
  `nsh package` 报错并指出这个键：系统永远不会显示这条翻译。
- **可以翻译的键**是应用自己的键，NSH 的键里只有 `CFBundleDisplayName` 和 `CFBundleName`；值都是字符串。翻译了应用名的 macOS
  包还会告诉访达（`LSHasLocalizedDisplayName`）。
- **这些语言会和应用的 [`locales`](./i18n.md) 一起声明给系统**（`CFBundleLocalizations`，英语在前）：没有翻译的语言的用户看到
  `Info.plist` 的文字，系统在应用里显示的界面也会使用这些翻译过的语言。写成空的 `{}` 的语言没有文件，也不会声明；它采用
  [crate](./nshm.md#打包的应用需要什么) 的翻译，应用只采用自己支持的语言的 crate 翻译。

### 隐私清单

上传 iOS 应用时，App Store Connect 会检查它的隐私清单 `PrivacyInfo.xcprivacy`：应用调用 Apple 要求说明使用理由的 API 的原因、
是否进行跟踪以及跟踪所用的域名，以及它收集的数据（见 [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)）。
每个 iOS 包都带有这个文件。NSH 的运行时是应用可执行文件的一部分，所以它调用的 API 也算作应用的；打包时会为每个应用声明它们：

| 类别 | NSH 中调用它的部分 | 理由 |
|---|---|---|
| `NSPrivacyAccessedAPICategoryFileTimestamp` | Rust 标准库读取文件元数据；图片缓存按时间淘汰文件 | `C617.1` |
| `NSPrivacyAccessedAPICategorySystemBootTime` | 渲染器的计时器 | `35F9.1` |

`nsh.json` 的 `ios.privacyManifest` 是应用自己要补充的内容：应用自己的代码和它链接的 SDK 调用的 API、是否跟踪，以及它收集的数据。
iOS 包会在签名前把它写到应用的根目录，并按类别和 NSH 的条目合并：每个类别一个条目，理由取两者之和，不重复（应用扩展在自己的
`.appex` 里带一份自己的）：

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

这样打出的包里，文件时间戳条目的理由是 `3B52.1`（读取用户选择的文件）和 NSH 的 `C617.1`，后面再跟一个理由为 `35F9.1` 的系统启动时间条目。

它接受 Apple 格式的四个键（`NSPrivacyTracking`、`NSPrivacyTrackingDomains`、`NSPrivacyCollectedDataTypes`、
`NSPrivacyAccessedAPITypes`）及其条目里的键。未知的键、类型不对的值或缺少键的条目会被略过并给出警告；App Store Connect
按原样会拒绝的内容（没有理由的条目、开启跟踪却没有域名）也会给出警告。类别和理由代码本身仍由 App Store Connect 检查。

NSH 在 iOS 上不读取用户默认设置（温度单位取自区域设置），所以只有应用自己的代码或它链接的 SDK 调用 `NSUserDefaults` 时，
才需要声明 `NSPrivacyAccessedAPICategoryUserDefaults`。

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
`"14.0"`。包按应用写的原样声明它，应用的 Rust 代码（Rust 与 C 一样）按它构建，iOS 的应用图标也按它编译。环境里设了部署版本
（`IPHONEOS_DEPLOYMENT_TARGET`、`MACOSX_DEPLOYMENT_TARGET`）时按环境里的值构建。更低的版本或其他形式的值会在读取 `nsh.json` 时报错，错误信息给出 NSH 的最低版本。

## 图标

在 `nsh.json` 中（`"icon": "icon.png"`）或通过 `--icon` 提供一张正方形 PNG，最好是 1024×1024：

- **iOS：** 由 Xcode 的 `actool` 编译进应用的资源目录（`Assets.car`），iOS 所需的各种尺寸都由它生成。
- **Android：** 缩放到 192×192，用作启动器图标（`mipmap-xxxhdpi`）；也可以用自适应图标，见下文。
- **macOS：** 由 `sips` 转换为 `AppIcon.icns`。`nsh run --target macos` 和 `nsh test --target macos` 会在程序坞和应用切换器里显示这张 PNG。
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

`icon.android` 也可以是自适应图标，启动器会把它的各层裁成自己的形状（圆形、圆角方形等）。每层 108×108dp，中间 72×72dp 显示在遮罩内，四周各 18dp 留给启动器做视觉效果。图案放在中心直径 66dp 的圆内：约为宽度的 61%，432 像素的图层上是 264 像素。

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

- `foreground`：透明底的正方形 PNG，最好是 432×432 或更大。
- `background`：颜色（`"#rrggbb"`、`"#rrggbbaa"`）或一张正方形 PNG。
- `monochrome`（可选）：透明底上的单色图案，Android 13 及以上的主题图标会给它着色。

只有 `icon.android` 接受这种写法。

`--icon` 会替换它，用于本次打包的目标。

没有图标时，系统显示默认图标。

## 启动画面

从点下图标到应用画出第一帧，iOS 显示应用的启动画面：`nsh.json` 没给时，是系统在应用外观下的背景色。`ios.launchScreen` 设置它的颜色和屏幕中央的一张图，浅色、深色外观可以共用一个，也可以各给一个：

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

- `background` 是 `#rrggbb` 或 `#rrggbbaa`，或带 `light` 和 `dark` 的对象。
- `image` 是相对 `nsh.json` 的 PNG，或带 `light` 和 `dark` 的对象。它按 3 倍屏绘制：系统按像素尺寸的三分之一显示，所以 288×288 的 PNG 是 96×96 点，居中。

两者和图标一起编译进应用的资源目录，并写进 `UILaunchScreen`，应用就不再在 `ios.infoPlist` 里设置它。启动画面与应用第一帧一致（同样的背景、同一张图在同一位置）时，启动看起来没有跳变。系统显示哪一套由 `appearance` 决定。

Android 上 `android.launchScreen` 用同样的键。打包时给应用生成一个主题，窗口背景是 `background`：从点下图标起窗口就和应用第一帧一致，之后也留在应用下面。Android 12 及以上，系统启动屏同样用 `background`（图标后面也是），`image` 在中央，大小与 iOS 相同（288×288 的 PNG 是 96×96 dp）；不给 `image` 时启动屏显示启动器图标。目标 API 级别低于 31 的应用没有系统启动屏，`image` 不显示，但文件仍会检查。深色的值在系统深色模式下生效；`appearance` 固定为 `light` 或 `dark` 时只用那一套。

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

## 相机、蓝牙和其他硬件

打包后的应用根据 `nsh.json` 声明 NSH 自身功能用到的硬件：

| 功能 | iOS 和 macOS | Android |
|---|---|---|
| 采集媒体的网页（[`capabilities.webview.media`](./sandbox-and-capabilities.md#webview)） | `NSMicrophoneUsageDescription`、`NSCameraUsageDescription`；macOS 上还有 entitlements `com.apple.security.device.audio-input` 和 `com.apple.security.device.camera` | `RECORD_AUDIO`、`CAMERA` |
| [`Notifications`](../modules/nsh.md#notifications)，应用授予 `notifications` 或没有声明 capabilities 时 | | `POST_NOTIFICATIONS` |

应用安装的 [nshm](./nshm.md) 会加上它们的 feature 需要的条目：比如 `nsh-extra` 的 `speech` 会加上麦克风和语音识别的用途说明以及 `RECORD_AUDIO`。每个 Android 包还声明了 `INTERNET` 和 `ACCESS_NETWORK_STATE`。权限说明文字是应用第一次请求时系统显示的内容，应用可以在 `infoPlist` 中改用自己的措辞
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

## 发布

`nsh package` 只负责生成可安装的文件。发布到商店见[发布](./publish.md)：[App Store](./publish.md#publish-to-the-app-store)、[Google Play](./publish.md#publish-to-google-play)、[Flathub](./publish.md#publish-to-flathub) 和 [Microsoft Store](./publish.md#publish-to-the-microsoft-store)。不经商店分发的应用按上文处理：[macOS](#sign-notarize-and-distribute)、[Windows](#sign-and-distribute)、[Linux](#distribute) 和 [Web](#host-the-site)。

## 另请参阅

- [发布](./publish.md)：发布到 App Store、Google Play、Flathub 和 Microsoft Store
- [CLI](./cli.md)：所有命令
- [应用更新](./app-updates.md)：自我更新的打包应用
- [OTA 更新](./ota-updates.md)：无需新构建，为打包应用（包括 iOS 和 Android）下发新的 TSX
- [签名包](./signed-packages.md)：应用下载的更新
- [项目结构](./project-structure.md)：`nsh.json` 与应用的各个文件
- [原生组件](./native-components.md)：NSH 应用中宿主应用的视图
