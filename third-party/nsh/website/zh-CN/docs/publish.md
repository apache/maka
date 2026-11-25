---
title: 发布
description: "把 NSH 应用发布到应用商店：iOS 的 App Store Connect 和 TestFlight、Android 的 Google Play、Linux 的 Flathub 和 Windows 的 Microsoft Store，应用标识与商店文案来自 nsh.json，以及商店凭据与发布 CI。"
order: 18.5
group: publishing
---

# 发布

发布指把打包好的应用发布到应用商店：iOS 发布到 App Store Connect，Android 发布到 Google Play，Linux 发布到 Flathub，Windows 发布到 Microsoft Store，都用 `nsh publish <platform>`。每个商店都从 `nsh.json` 读取应用标识和商店文案，所以一次发布只需要打包好的文件。[打包](./packaging.md)先生成这个文件，也介绍不经商店的交付方式：压缩包、安装程序、AppImage、Flatpak 和 MSIX 文件，签名与公证，以及 Web 应用的托管。

- [iOS](#publish-to-the-app-store)：App Store Connect 和 TestFlight
- [Android](#publish-to-google-play)：Google Play
- [Linux](#publish-to-flathub)：Flathub
- [Windows](#publish-to-the-microsoft-store)：Microsoft Store

## 各商店支持什么

| 平台 | `nsh package` 写出什么 | 商店 | `nsh publish` 做什么 |
|---|---|---|---|
| iOS | 已签名的 `.ipa` | App Store Connect：先 TestFlight，再 App Store | 上传 IPA，等待处理完成，分发给 TestFlight 群组，填写 App Store 版本和商店文案，带 `--submit` 时提交审核（`nsh publish ios`） |
| Android | 已签名的 `.aab`（或 `.apk`） | Google Play | 上传 bundle 并发布到某个轨道，未用 `--track` 指定时为内部测试，支持分阶段发布、推广和商店文案（`nsh publish android`） |
| Linux | `.tar.gz`（也可以是 AppImage、Flatpak） | Flathub | 为发布压缩包写出 Flathub manifest；Pull Request 由你提交（`nsh publish linux`） |
| Windows | `.msix`（也可以是 `.zip` 和安装程序） | Microsoft Store | 把包提交认证（`nsh publish windows`） |

`nsh publish status <platform>` 报告商店中的现状，`nsh publish doctor <platform>` 检查配置和凭据，不做任何改动。首个版本的商店审核，以及只能在控制台设置的内容（定价、年龄分级、隐私详情），仍在各商店的控制台中完成。macOS 和 Web 目前在 NSH 中没有商店上传，以直接下载或静态站点的方式交付，见打包中的 [macOS](./packaging.md#sign-notarize-and-distribute) 和 [Web](./packaging.md#host-the-site)；不经商店的 Windows 和 Linux 应用也一样（[Windows](./packaging.md#sign-and-distribute)、[Linux](./packaging.md#distribute)）。

不带平台的 `nsh publish <ENTRY> --key … --cert …` 生成的是用于 [OTA 更新](./ota-updates.md)和[签名包](./signed-packages.md)的签名包，不是商店上传。

## 一次发布，逐步进行

1. **在 `nsh.json` 中设置版本。** `version` 是用户看到的版本号（`1.4.0`）；`build` 是一个整数，在每个平台上每次上传到商店都必须递增（Apple 平台上是 `CFBundleVersion`，Android 上是 `versionCode`）。两者也都可以在命令行上传入（`--app-version`、`--build`），在 CI 给构建编号时很方便。
2. **打包。** iOS 需要装有 Xcode 的 Mac；Android 在哪里都可以打包。见[打包](./packaging.md)。
3. **签名。** 提供 Apple Distribution 签名身份和描述文件，或上传 keystore，打包时即完成签名。
4. **发布。** 用 `nsh publish <platform>` 发布到商店；应用在商店中的标识来自 `nsh.json`。
5. **后续跟进。** `nsh publish status <platform>` 告诉你版本何时上线；审核以及命令未覆盖的内容在商店的控制台中进行。

```json
{
  "name": "Notes",
  "id": "com.example.notes",
  "version": "1.4.0",
  "build": 42,
  "icon": "icon.png"
}
```

`id` 在 Apple 平台上是 bundle identifier，在 Android 上是包名；商店中的应用记录必须使用同一个值。应用一旦以某个 id 上架，就不能再更改。

## 凭据

商店凭据（App Store Connect API 密钥、Google Play 服务账号密钥、签名 keystore 和证书、密码）永远不要放进 `nsh.json` 或仓库。`nsh` 从参数或环境变量读取它们，发布 CI 从自己的 secrets 中填入：

| 平台 | 需要什么 | `nsh` 如何获取 |
|---|---|---|
| iOS | Apple Distribution 证书和 App Store 描述文件 | `nsh package --sign … --profile …`；证书放在钥匙串中 |
| iOS | App Store Connect 团队 API 密钥：issuer ID、key ID、`.p8` 文件 | `NSH_APP_STORE_ISSUER_ID`、`NSH_APP_STORE_KEY_ID`、`NSH_APP_STORE_PRIVATE_KEY` |
| Android | 上传 keystore 及其密码 | `nsh package --keystore … --key-alias …`、`NSH_KEYSTORE_PASSWORD` |
| Android | Google Cloud 服务账号 JSON 密钥 | `NSH_PLAY_CREDENTIALS` 或 `--credentials` |
| Linux | 不需要：Flathub 根据 manifest 构建，Pull Request 由你提交 | |
| Windows | 关联到 Partner Center 的 Azure AD 应用 | `NSH_MS_TENANT_ID`、`NSH_MS_CLIENT_ID`、`NSH_MS_CLIENT_SECRET` |

应用自身在商店中的标识不是机密，放在 `nsh.json` 的 `store` 中（见下文）：App Store 应用 ID、Microsoft Store 产品 ID、Flathub 压缩包地址。

## 商店文案

每个 `nsh publish <store>` 都读取同一份文案。可写在 `nsh.json` 的 `"store"`、与 `nsh.json` 同级的 `store/` 目录，或两者都用；`nsh.json` 中的值优先于文件。

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "store": {
    "locales": {
      "en-US": {
        "name": "My App",
        "subtitle": "Notes that sync",
        "shortDescription": "Write notes on every device and keep them in sync.",
        "description": "My App keeps your notes in sync.\n\nWrite once, read anywhere.",
        "keywords": "notes,sync",
        "releaseNotes": "Faster sync.",
        "supportUrl": "https://example.com/support",
        "marketingUrl": "https://example.com",
        "screenshots": { "phone": ["store/en-US/phone-1.png"] }
      }
    },
    "ios": {
      "appId": "6835723652",
      "usesNonExemptEncryption": false,
      "betaGroups": ["QA"],
      "release": "phased"
    },
    "linux": {
      "license": "MIT",
      "developer": "Example Inc.",
      "categories": ["Office"],
      "screenshots": ["https://example.com/screenshot.png"],
      "archiveUrl": "https://github.com/example/notes/releases/download/v{version}/MyApp.tar.gz"
    },
    "windows": { "productId": "9NBLGGH4R315" }
  }
}
```

```text
store/en-US/description.txt        # also name, subtitle, keywords, promotional_text,
store/en-US/release_notes.txt      # release_notes, support_url, marketing_url, privacy_policy_url
store/en-US/screenshots/phone/01.png
store/en-US/screenshots/tablet/01.png
store/en-US/short_description.txt  # Google Play
store/en-US/android/phoneScreenshots/1.png   # a store's own image types, by platform
```

每个商店的应用标识都从这里或应用的 `id` 读取，配置好的应用发布时只需给出产物，凭据来自环境变量或默认的密钥路径：

| 商店 | 标识 | 发布 |
|---|---|---|
| App Store | `store.ios.appId` | `nsh publish ios <App.ipa>` |
| Google Play | `id`（包名） | `nsh publish android <App.aab>` |
| Flathub | `id`；压缩包下载地址 `store.linux.archiveUrl` | `nsh publish linux <App.tar.gz>` |
| Microsoft Store | `store.windows.productId`（包标识在 `windows`） | `nsh publish windows <App.msix>` |

`nsh publish status <store>` 与 `nsh publish doctor <store>` 读取同一份配置。Google Play 使用 `shortDescription` 和 `store/<locale>/android/<type>/` 中的图片；Flathub 以 `en-US` 文案的 `subtitle` 作为 AppStream 摘要。

语言使用 App Store Connect 的 BCP 47 标签（`en-US`、`zh-Hans`）。截图按设备类别分组、按显示顺序排列：`phone` 对应 6.9 英寸 iPhone（`APP_IPHONE_67`），`tablet` 对应 13 英寸 iPad（`APP_IPAD_PRO_3GEN_129`）；`APP_IPHONE_65` 等 App Store Connect 尺寸名原样使用。截图集只在图片变化时替换。未给出的字段保持商店中的现值。`releaseNotes`（`release_notes.txt`）是所有商店共用的更新说明，也接受 `whatsNew` 和 `whats_new.txt`。App Store Connect 不接受应用首个版本的更新说明。`nsh.json` 不认识的键会被忽略。

## 自动化

商店上传就是普通命令，发布 CI 可以像其他步骤一样运行它们：打 tag 触发工作流，各平台在各自系统的 runner 上打包，最后执行上传。下面是 GitHub Actions 的示意：

```yaml
on:
  push:
    tags: ["v*"]

jobs:
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Install nsh, the Android SDK and a JDK, and write the keystore from a secret, then:
      - run: nsh package --target android --format aab --keystore release.jks --key-alias upload --build ${{ github.run_number }}
        env:
          NSH_KEYSTORE_PASSWORD: ${{ secrets.KEYSTORE_PASSWORD }}
      - run: nsh publish android .nsh/out/Notes.aab
        env:
          NSH_PLAY_CREDENTIALS: ${{ runner.temp }}/play.json

  ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      # Install nsh, import the certificate into a keychain and write the profile and .p8 key from secrets, then:
      - run: nsh package --target ios --sign "Apple Distribution: Example Inc (ABCDE12345)" --profile AppStore.mobileprovision --build ${{ github.run_number }}
      - run: nsh publish ios .nsh/out/Notes.ipa
        env:
          NSH_APP_STORE_APP_ID: ${{ vars.APP_STORE_APP_ID }}
          NSH_APP_STORE_ISSUER_ID: ${{ secrets.APP_STORE_ISSUER_ID }}
          NSH_APP_STORE_KEY_ID: ${{ secrets.APP_STORE_KEY_ID }}
          NSH_APP_STORE_PRIVATE_KEY: ${{ runner.temp }}/AuthKey.p8
```

用 run number 作为 `build`，无需每次发布都修改 `nsh.json` 就能让它保持递增。固定工作流安装的 NSH 版本，让每次发布都用同一个 NSH 构建。

## 发布到 App Store

iOS 应用通过 App Store Connect 到达用户：你上传一个构建版本，测试员在 TestFlight 中拿到它，Apple 审核通过后，App Store 就会提供它。`nsh package --target ios` 构建并签名 IPA；`nsh publish ios` 把它上传到 App Store Connect，等待处理完成，把构建分发给 TestFlight 群组，填写 App Store 版本及其商店文案，需要时提交审核。创建应用记录、定价、隐私详情和年龄分级在 App Store Connect 中完成。

两个命令都在装有 Xcode 的 macOS 上运行，Rust、Rust + TSX 和 TSX 应用都一样。

### 首次发布之前

每个应用做一次：

1. **加入 Apple Developer Program**，使用将要发布该应用的账号（个人或组织）。
2. **注册 bundle ID。** 在“证书、标识符和描述文件”（Certificates, Identifiers & Profiles）中添加一个 App ID，其 bundle ID 是 `nsh.json` 中应用的 `id`（`com.example.notes`），并勾选应用用到的功能（推送通知、App Groups 等）。
3. **创建分发证书。** 即 *Apple Distribution* 证书，安装到负责打包的 Mac（或 CI runner）的登录钥匙串中。`security find-identity -v -p codesigning` 会把它列为 `Apple Distribution: Example Inc (ABCDE12345)`。
4. **创建 App Store 描述文件**，对应该 App ID 和证书，并下载 `.mobileprovision` 文件。把它放在仓库之外。
5. **在 App Store Connect 中创建应用**（“我的 App”→“新建 App”），使用同一个 bundle ID。“App 信息”下显示的数字 **Apple ID** 就是 `nsh publish ios` 需要的应用 id：把它写在 `nsh.json` 的 `store.ios.appId`。
6. **创建团队 API 密钥**：在 App Store Connect 的“用户和访问”→“集成”→“App Store Connect API”中创建，角色为“开发者”“App 管理”或“管理”（Developer、App Manager 或 Admin）。记下它的 **Key ID** 和列表上方显示的 **Issuer ID**，并下载 `.p8` 私钥；Apple 只允许下载一次。

### 配置应用

`nsh.json` 中会进入 iOS 构建的键：

```json
{
  "name": "Notes",
  "id": "com.example.notes",
  "version": "1.4.0",
  "build": 42,
  "icon": "icon.png",
  "ios": {
    "infoPlist": {
      "NSCameraUsageDescription": "Notes uses the camera to scan documents.",
      "ITSAppUsesNonExemptEncryption": false
    },
    "entitlements": {
      "com.apple.security.application-groups": ["group.com.example.notes"]
    }
  }
}
```

| 键 | 在构建中 | 说明 |
|---|---|---|
| `id` | `CFBundleIdentifier` | 必须与 App ID、描述文件和 App Store Connect 中的应用一致。 |
| `name` | `CFBundleDisplayName` | 图标下方显示的名称。商店中的名称在 App Store Connect 中设置。 |
| `version` | `CFBundleShortVersionString` | 用户看到的版本号。新版本要先在 App Store Connect 中创建版本记录，才能提交审核。 |
| `build` | `CFBundleVersion` | 必须大于该版本已上传的所有构建号。 |
| `icon` | 应用图标 | App Store 要求的 1024×1024 正方形、无透明的 PNG（[图标](./packaging.md#icons)）。 |
| `ios.infoPlist` | `Info.plist` 键 | 应用访问的每种受保护资源的用途说明、出口合规等（[Info.plist 键](./packaging.md#infoplist-keys-and-entitlements)）。 |
| `ios.entitlements` | 应用的 entitlements | 打包时会对照描述文件检查。 |
| `ios.privacyManifest` | `PrivacyInfo.xcprivacy` | App Store Connect 检查的隐私清单（[隐私清单](./packaging.md#privacy-manifest)）。 |
| `ios.extensions` | 内嵌的应用扩展 | 各自用自己的描述文件签名（[应用扩展](./packaging.md#app-extensions)）。 |

把 `ITSAppUsesNonExemptEncryption` 设为 `false`（应用只使用系统内置的加密，如 HTTPS 时），TestFlight 的出口合规问题就只需回答一次，而不必每个构建都回答。

### 构建 IPA

```sh
nsh package --target ios \
  --sign "Apple Distribution: Example Inc (ABCDE12345)" \
  --profile /secure/AppStore.mobileprovision
```

这会写出 `.nsh/out/<Name>.ipa`。NSH 会检查可执行文件包含 `arm64` 架构，把 Xcode 和 SDK 构建信息写入 `Info.plist`，嵌入描述文件，检查描述文件覆盖应用的 `id` 及其 entitlements，先签名扩展、再用 `codesign` 签名应用，最后压缩为 `Payload/<Name>.app`。不带 `--sign` 和 `--profile` 时，写出的是无法上传的未签名 `.app`。详情见[打包：iOS 真机](./packaging.md#ios-devices)。

上传前检查结果：

```sh
unzip -q -o .nsh/out/Notes.ipa -d /tmp/notes-ipa
codesign --verify --strict --verbose=2 /tmp/notes-ipa/Payload/Notes.app
codesign -d --entitlements - /tmp/notes-ipa/Payload/Notes.app
```

### 上传到 TestFlight

`nsh publish ios <IPA>` 通过 Apple 的 [build uploads API](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads) 把 IPA 上传到 App Store Connect：

应用的 Apple ID 写在 `nsh.json` 中（`{ "store": { "ios": { "appId": "1234567890" } } }`）。把 `.p8` 密钥放在 Apple 工具也会查找的 `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`，并在 shell 配置文件中导出一次 issuer ID 和 key ID；之后配置好的应用只需给出 IPA 即可发布：

```sh
export NSH_APP_STORE_ISSUER_ID=69a6de70-0000-0000-0000-000000000000
export NSH_APP_STORE_KEY_ID=ABC123DEFG
nsh publish ios .nsh/out/Notes.ipa
```

| 参数 | 环境变量 | 含义 |
|---|---|---|
| `--app-id <ID>` | `NSH_APP_STORE_APP_ID` | App Store Connect 中应用的数字 Apple ID。默认：`store.ios.appId`。 |
| `--issuer-id <ID>` | `NSH_APP_STORE_ISSUER_ID` | 团队 API 密钥的 issuer ID。 |
| `--key-id <ID>` | `NSH_APP_STORE_KEY_ID` | API 密钥的 ID。 |
| `--private-key <PATH>` | `NSH_APP_STORE_PRIVATE_KEY` | `.p8` 私钥文件。默认：`./private_keys`、`~/.appstoreconnect/private_keys`、`~/.private_keys` 或 `~/private_keys` 中的 `AuthKey_<KEY_ID>.p8`。 |

参数覆盖环境变量，环境变量覆盖 `nsh.json`。把密钥和 ID 放在 shell 配置文件或 CI 的 secrets 中，不要放进 `nsh.json` 或仓库。

这个命令做的事：

1. 从 IPA 的 `Info.plist` 读取 bundle ID、版本号和构建号，并检查 IPA 的目标是 iOS 真机。
2. 用 API 密钥签发一个短期有效的 ES256 令牌，并检查 IPA 的 bundle ID 与 App Store Connect 中的应用一致。
3. 创建一个构建上传，按 Apple 要求的分片流式上传 IPA，并提交它的 MD5 校验和。
4. 打印上传 ID 和应用的 TestFlight 页面。
5. 等待 Apple 处理构建（`--timeout` 分钟，默认 60），按 `store.ios.usesNonExemptEncryption` 回答出口合规问题，并把构建分发给 `store.ios.betaGroups`（或 `--beta-group`）中的 TestFlight 群组。
6. 创建或复用以 IPA 版本号命名的 App Store 版本，关联该构建，设置发布方式，并写入[商店文案](#store-listing)和截图。**只有**带 `--submit` 时才提交 App 审核。

| 参数 | 含义 |
|---|---|
| `--entry <DIR>` | 其 `nsh.json` 含有商店文案的应用（默认：`.`）。 |
| `--no-wait` | Apple 接收上传后即停止。 |
| `--testflight-only` | 完成处理、出口合规和 TestFlight 群组后停止。 |
| `--beta-group <NAME>` | 要加入该构建的 TestFlight 群组（可重复）。 |
| `--release manual\|auto\|phased` | 审核通过的版本如何上线（默认：`store.ios.release`，否则 `manual`）。 |
| `--submit` | 提交该版本供 App 审核。 |

已在审核中或已上线的版本不会被修改：在 `nsh.json` 中提高 `version`。处理需要几分钟到一小时；Apple 会检查签名、描述文件、图标和 `Info.plist`，有任何问题都会发邮件给账号持有人。

### 上传之后

```sh
nsh publish status ios --json   # exit 0 live, 10 processing/in review, 11 draft, 12 action needed
nsh publish doctor ios          # read-only: credentials, nsh.json, listing, app access
```

`doctor` 只发只读请求（`--offline` 不发请求），任一检查失败时以非零退出。两者可在任意系统上运行。

在 App Store Connect 中：

- **TestFlight**：处理完成后，构建版本会立即提供给内部测试员（你团队的成员）。外部测试员需要一个群组，并且每个版本的第一个构建都要经过 Beta 版 App 审核（Beta App Review）。
- **只能在 App Store Connect 中设置的内容**：隐私详情（App 隐私）、年龄分级和定价。Apple 不允许通过 API 创建应用记录，需先在那里创建一次。
- **审核**：`--submit` 提交该版本供审核；审核通过后，按 `--release`（或 `store.ios.release`）手动发布、自动发布或分阶段发布。

### 常见错误

| 消息 | 处理方法 |
|---|---|
| `nsh publish ios runs on macOS` | 在 Mac 或 macOS CI runner 上上传。 |
| `IPA must contain exactly one Payload/*.app/Info.plist` | 传入 `nsh package --target ios --sign … --profile …` 写出的 `.ipa`，而不是 `.app` 或模拟器构建。 |
| `IPA must target iOS devices` | 这个 IPA 是模拟器构建：用 `--target ios` 打包，而不是 `--target ios-simulator`。 |
| `IPA bundle identifier does not match --app-id` | 这个应用 id 属于 App Store Connect 中的另一个应用，或 `nsh.json` 的 `id` 与应用的 bundle ID 不同。 |
| `expected a PKCS#8 App Store Connect private key (.p8)` | `--private-key` 指向了错误的文件：使用从 App Store Connect 下载的 `AuthKey_<KEY_ID>.p8`。 |
| `App Store Connect HTTP 401: …` | issuer ID、key ID 和密钥不匹配，或密钥已被吊销。 |
| `App Store Connect HTTP 403: …` | 该密钥的角色无权上传构建：使用“开发者”“App 管理”或“管理”角色。 |
| `App Store Connect HTTP …` 提示构建已存在 | 已经上传过相同版本号和构建号的构建：在 `nsh.json` 中提高 `build` 并重新打包。 |
| `upload … did not finish; check App Store Connect before retrying` | 连接中断。每次运行都会开始一次新的上传；先在 App Store Connect 中查看打印出的上传 ID，再重新运行。 |
| `Apple rejected the uploaded file; check App Store Connect` | 文件上传后被 Apple 拒绝；原因见 App Store Connect 和 Apple 的邮件。 |
| 描述文件不覆盖应用的 id（打包时） | 为应用的 bundle ID 或覆盖它的通配 ID 创建 App Store 描述文件。 |

Apple 在处理时发现的问题（缺少用途说明、图标带透明、描述文件缺少某项 entitlement）会通过邮件通知，并显示在 App Store Connect 的构建版本上；在 `nsh.json` 中修正，提高 `build`，再重新打包上传。

## 发布到 Google Play

Google Play 接收 Android App Bundle（`.aab`）。`nsh package --target android --format aab` 不借助 Gradle 构建一个 bundle 并用你的上传密钥签名；`nsh publish android` 通过 Google Play Developer API 上传它并发布到某个轨道：未用 `--track` 指定其他轨道时为**内部测试**。它还能在轨道之间推广版本、进行分阶段发布并更新商品详情。应用内容声明和审核在 Play Console 中完成。

两个命令都可以在 macOS、Linux 和 Windows 上运行。

### 首次发布之前

每个应用做一次：

1. **注册 Google Play 开发者账号**，并在 Play Console 中**创建应用**（“创建应用”）。应用的包名由你上传的第一个 bundle 确定，必须是 `nsh.json` 中应用的 `id`。
2. **创建上传密钥**，用于签名你上传的每个 bundle：

   ```sh
   keytool -genkeypair -v -keystore release.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

   把 `release.jks` 及其密码放在仓库之外并做好备份。启用 Play 应用签名（新应用的默认设置）时，设备安装的内容由 Google 用它自己的应用签名密钥签名；上传密钥丢失后可以通过 Play Console 支持重置。
3. **创建用于上传的服务账号**：在 Google Cloud 中选择或创建一个项目，启用 **Google Play Android Developer API**，创建服务账号并为它下载 JSON 密钥。
4. **给服务账号授权**：在 Play Console 的“用户和权限”→“邀请新用户”中填入服务账号的邮箱，授予它该应用的访问权限，以及发布到测试轨道的权限。
5. **在 Play Console 中完成首次发布。** 在应用于 Play Console 中发布过一次之前，Google Play 只接受通过 API 创建的草稿版本：用 `nsh publish android --draft` 上传第一个 bundle，再在 Play Console 中发布这个草稿。

### 配置应用

```json
{
  "name": "Notes",
  "id": "com.example.notes",
  "version": "1.4.0",
  "build": 42,
  "icon": {
    "android": {
      "foreground": "icon-foreground.png",
      "background": "#1F6FEB",
      "monochrome": "icon-monochrome.png"
    }
  },
  "android": {
    "targetSdk": 35,
    "permissions": ["android.permission.CAMERA"]
  }
}
```

| 键 | 在构建中 | 说明 |
|---|---|---|
| `id` | 包名 | 应用在 Google Play 上的身份；上传后不能更改。 |
| `name` | `android:label` | 图标下方显示的名称。商店中的名称在 Play Console 中设置。 |
| `version` | `versionName` | 用户看到的版本号。 |
| `build` | `versionCode` | 必须大于该应用在任何轨道上已上传的所有版本代码。 |
| `icon` | 启动器图标 | 一张 PNG，或带单色图层（用于主题图标）的自适应图标（[图标](./packaging.md#icons)）。 |
| `android.targetSdk` | `targetSdkVersion` | 默认 35。Google Play 要求新应用和更新使用较新的级别（[目标 API 级别](./packaging.md#target-api-level)）。 |
| `android.permissions` | `<uses-permission>` | 声明的权限；其中一些需要在 Play Console 中填写声明（[权限](./packaging.md#permissions)）。 |

### 构建 bundle

```sh
NSH_KEYSTORE_PASSWORD=… nsh package --target android --format aab \
  --keystore release.jks --key-alias upload
```

这会写出 `.nsh/out/<Name>.aab`，由 JDK 中的 `jarsigner` 签名。它包含 `arm64-v8a` 和 `armeabi-v7a` 的原生代码；Google Play 据此构建每台设备安装的 APK。`NSH_KEYSTORE_PASSWORD` 能让密码不进入 shell 历史（`--keystore-password` 也可以）。不带 `--keystore` 时，bundle 用 debug 密钥签名，Google Play 会拒绝。环境要求（Android SDK、Rust 应用需要的 NDK、JDK）见[打包：Android](./packaging.md#android)。

release bundle 中的 `libnsh.so` 不带符号；完整的库写在运行时旁的 `symbols/<abi>/libnsh.so`。在 Play Console 中上传它们（该 bundle 的“下载内容”→原生调试符号），就能在 Android Vitals 中看懂原生崩溃堆栈。

上传前想在设备上试用 bundle，可以用 [bundletool](https://github.com/google/bundletool)：先 `bundletool build-apks --bundle .nsh/out/Notes.aab --output notes.apks --connected-device`，再 `bundletool install-apks --apks notes.apks`。

### 上传与发布

```sh
export NSH_PLAY_CREDENTIALS=/secure/play-service-account.json
nsh publish android .nsh/out/Notes.aab
```

```sh
nsh publish android <BUNDLE.aab> [--track <TRACK>] [--rollout <FRACTION>] [--status <STATUS>] [--listing] [--draft]
nsh publish android --from <TRACK> --track <TRACK> [--rollout <FRACTION>]
```

| 参数 | 默认值 | 含义 |
|---|---|---|
| `--entry <DIR>` | `.` | 应用的目录或入口，其 `nsh.json` 的 `id` 即包名。 |
| `--package <NAME>` | `nsh.json` `id` | Google Play 上的包名。 |
| `--credentials <KEY.json>` | `NSH_PLAY_CREDENTIALS` | 服务账号的 JSON 密钥。 |
| `--track <TRACK>` | `internal` | `internal`、`alpha`、`beta`、`production` 或自定义轨道名。发布给内部测试之外的测试员或公众，始终需要显式给出 `--track`。 |
| `--from <TRACK>` | | 推广：把该轨道最新版本的版本代码发布到 `--track`，不上传任何内容。 |
| `--rollout <FRACTION>` | | 分阶段发布给该轨道用户的这一比例，大于 0 且小于 1，例如 `0.1`。 |
| `--status <STATUS>` | `completed` | `completed`、`in-progress`（带 `--rollout` 时的默认值）、`halted`（停止分阶段发布）或 `draft`。 |
| `--draft` | 关闭 | 以草稿发布；在应用于 Play Console 中完成首次发布之前，Google Play 要求这样做。 |
| `--store <DIR>` | `store` | [商店文案](#store-listing)所在的商店目录。 |
| `--listing` | 关闭 | 同时按商店文案更新 Play 上的名称、描述和图片，覆盖 Play 上这些语言已有的内容。 |

这个命令在 Google Play 上对应用做一次编辑（edit），步骤如下：

1. 以服务账号身份登录。
2. 打开一个编辑，上传 bundle，并读取 Google Play 从中识别出的版本代码。
3. 把该轨道的版本设为该版本代码，附上各语言的更新说明（已完成、分阶段或草稿）。
4. 带 `--listing` 时，写入商店文案的文字，并对存在的每种图片类型，替换 Play 上该类型的图片。
5. 提交编辑。任何一步失败都会删除这次编辑，不会出现发布了一半的情况。

它会打印现在位于该轨道上的版本代码。内部测试员（最多 100 人，来自 Play Console 中的测试员列表）几分钟内就能从 Google Play 收到更新。要提高分阶段发布的比例，用更大的 `--rollout` 再次发布同一版本；要完成分阶段发布，不带 `--rollout` 发布它：

```sh
nsh publish android --from internal --track production --rollout 0.1
nsh publish android --from internal --track production
```

图片类型沿用 Google Play 的名称，作为 `store/<locale>/android/` 下的目录：`phoneScreenshots`、`sevenInchScreenshots`、`tenInchScreenshots`、`tvScreenshots`、`wearScreenshots`、`icon`、`featureGraphic` 和 `tvBanner`。

```sh
nsh publish status android --json   # every track's releases: status, version codes, rollout fraction
nsh publish doctor android          # read-only: the key, the package name, the store directory, access to the app
```

### 上传之后

在 Play Console 中：

- **正式版访问权限**：新注册的个人开发者账号必须先进行封闭测试，才能获得正式版访问权限。
- **应用内容**：隐私权政策、数据安全、广告、内容分级和目标受众，在首次发布正式版之前必须填写。
- **审核**：发布到封闭测试、开放测试和正式版轨道的版本在到达用户之前都要经过审核。

### 常见错误

| 消息 | 处理方法 |
|---|---|
| `nsh.json has no \`id\`: give the app's package name with --package` | 在应用目录中运行命令，传入 `--entry`，或提供 `--package`。 |
| `the service account key …` | JSON 密钥文件不存在或无法读取：检查 `NSH_PLAY_CREDENTIALS` 或 `--credentials`。 |
| `Invalid JWT Signature.` | 服务账号密钥已在 Google Cloud 中被删除或轮换：下载新的 JSON 密钥。 |
| `could not open an edit on Google Play`，HTTP 403 | 服务账号在 Play Console 中没有该应用的访问权限，或其项目未启用 Google Play Android Developer API。 |
| `could not open an edit on Google Play`，HTTP 404 | Play Console 中没有这个包名的应用：创建它，或修正 `id`/`--package`。 |
| `Google Play refused the bundle` … `version code that has already been used` | 在 `nsh.json` 中提高 `build` 并重新打包。 |
| `Google Play refused the bundle` … 用错误的密钥签名 | bundle 用了 debug 密钥或其他上传密钥签名：用为该应用登记的上传 keystore 打包。 |
| `Google Play refused the … release` … draft | 应用还没有在 Play Console 中发布过：传入 `--draft`，然后在 Play Console 中发布。 |

## 发布到 Flathub

Linux 上的商店是 Flathub：用户通过 GNOME Software、KDE Discover 或 `flatpak install flathub <id>` 安装。Flathub 根据 manifest 自行构建并签名应用；NSH 根据发布压缩包生成 manifest，由你提交 Pull Request。压缩包、AppImage 和本地 Flatpak 包属于打包，不是商店发布，见[打包](./packaging.md#appimage-and-flatpak)。

### 首次发布之前

- 应用能在 Linux 上打包：`nsh package --target linux` 可以正常运行（见 [Linux](./linux.md#packaging)）。
- `nsh.json` 有反向域名形式的 `id`。在 Flathub 上它必须是你控制的域名，GitHub 项目可用 `io.github.<user>.<App>`。
- `nsh.json` 的 `icon` 是正方形图标，最好不小于 256×256：NSH 按 256×256 写出，需要放大时 `doctor` 会给出警告。
- 可选，供 `doctor` 使用：`appstreamcli` 和 `desktop-file-validate`（软件包 `appstream` 与 `desktop-file-utils`）。

`nsh publish doctor linux` 会逐项报告以上内容。

### 配置应用

```json
{
  "name": "Counter",
  "id": "io.github.example.Counter",
  "version": "1.2.0",
  "icon": "icon.png",
  "store": {
    "locales": {
      "en-US": {
        "subtitle": "Count things up and down",
        "description": "A small counter.\n\nParagraphs are separated by blank lines.",
        "keywords": "count,tally",
        "marketingUrl": "https://example.com"
      }
    },
    "linux": {
      "license": "MIT",
      "developer": "Example",
      "categories": ["Utility"],
      "screenshots": ["https://example.com/counter.png"],
      "archiveUrl": "https://github.com/example/counter/releases/download/v{version}/Counter.tar.gz"
    }
  },
  "linux": {
    "flatpak": {
      "runtimeVersion": "49",
      "finishArgs": ["--share=ipc", "--socket=wayland", "--socket=fallback-x11", "--device=dri"]
    }
  }
}
```

| 字段 | 用途 |
|---|---|
| `name` | 可执行文件、desktop 文件的 `Name` 以及各文件名 |
| `id` | desktop、metainfo 与 manifest 的文件名（`<id>.desktop`、`<id>.metainfo.xml`、`<id>.yml`）以及 `StartupWMClass` |
| `version` | metainfo 中的版本，也是 `status` 与 Flathub 比较的版本 |
| `icon` | 256×256 的 `<id>.png` |
| `store.locales.en-US.subtitle` | 一行 AppStream 摘要。Flathub 要求不超过 35 个字符、结尾不带句号 |
| `store.locales.en-US.description` | 详细描述，空行分段 |
| `store.locales.en-US.keywords` | 搜索关键词，逗号分隔（也可写成数组） |
| `store.locales.en-US.marketingUrl` | metainfo 的 `homepage` 链接，除非设置了 `store.linux.homepage` |
| `store.linux.license` | `project_license`，SPDX 表达式 |
| `store.linux.developer` | 软件中心显示的开发者名称 |
| `store.linux.categories` | desktop 文件与 metainfo 的 freedesktop 分类，默认 `Utility` |
| `store.linux.screenshots` | 截图 URL，第一张为默认截图。Flathub 至少需要一张 |
| `store.linux.archiveUrl` | 每个版本压缩包的下载地址，`{version}` 替换为 `nsh.json` 的 `version` |
| `linux.flatpak.runtimeVersion` | GNOME runtime 版本，默认为 NSH 测试所用的版本 |
| `linux.flatpak.finishArgs` | 替换沙盒权限。默认：Wayland（X11 兜底）、IPC、GPU 和网络 |

`store` 由 `nsh publish` 的所有商店共用，只需填写一次（见[商店文案](#store-listing)）。文案取 `en-US`（没有时取第一个语言），也可以写在 `store/en-US/` 下的文件里（`subtitle.txt`、`description.txt`、`keywords.txt`）。Flathub 用 `id` 命名应用。

### 发布

Flathub 不接受上传。每个应用是一个 GitHub 仓库 `flathub/<id>`，其中的 manifest 写明发布压缩包的 URL 与 SHA-256；合入该仓库的每次改动都由 Flathub 构建并发布。

#### 首次发布

1. 运行 `nsh publish doctor linux`，直到全部通过。
2. 运行 `nsh package --target linux`，把 `.nsh/out/<Name>.tar.gz` 上传到地址固定的位置，例如 GitHub Release 的附件。
3. 写出 manifest：

   ```sh
   nsh publish linux .nsh/out/Counter.tar.gz
   ```

   压缩包地址为填入版本号后的 `store.linux.archiveUrl`（或 `--url`），输出 `.nsh/out/flathub/<id>/<id>.yml`；其架构取自压缩包中可执行文件的处理器（`x86_64` 或 `aarch64`），与运行命令的机器无关。
4. 按 [Flathub 提交指南](https://docs.flathub.org/docs/for-app-authors/submission)向 `flathub/flathub` 提交带 manifest 的 Pull Request。Flathub 审核后会创建 `flathub/<id>`。

#### 后续版本

提高 `version`、重新打包并上传新压缩包，然后用 `--out` 指向你检出的 `flathub/<id>`：

```sh
nsh publish linux .nsh/out/Counter.tar.gz --out ../flathub-io.github.example.Counter
```

manifest 已存在时，只更新标记为 `# nsh: release archive` 的压缩包来源（`url`、`sha256` 与 `only-arches`），其余内容保持你或 Flathub 审核者修改后的样子。之后自行提交并在 `flathub/<id>` 上开 Pull Request，NSH 不会替你开 Pull Request。

### 状态与检查

```sh
nsh publish status linux [--json]
```

显示 Flathub 上列出的版本，与 `nsh.json` 的 `version` 一致前退出码为 1，CI 可以据此等待版本上线。尚未上架 Flathub 的应用会如实报告。

```sh
nsh publish doctor linux
```

检查 `id`、Flathub 要求的商店字段（摘要长度、许可证、截图）、图标是否为正方形（小于 256×256 时警告）；安装了相应工具时，用 `appstreamcli` 校验生成的 metainfo，用 `desktop-file-validate` 校验 desktop 文件。缺少 Flathub 必需的内容时以非零退出。

### 命令

```sh
nsh publish linux <ARCHIVE.tar.gz> [--url <URL>] [--entry <DIR>] [--out <DIR>]
nsh publish status linux [--entry <DIR>] [--json]
nsh publish doctor linux [--entry <DIR>]
```

| 参数 | 说明 |
|---|---|
| `--url <URL>` | 压缩包的下载地址（HTTPS）。默认：`store.linux.archiveUrl` |
| `--entry <DIR>` | 应用目录或入口，默认 `.` |
| `--out <DIR>` | `<id>.yml` 的输出目录，默认 `.nsh/out/flathub/<id>` |
| `--json` | 仅 `status`：输出机器可读格式 |

### 常见错误

| 现象 | 原因与解决 |
|---|---|
| `doctor`：摘要太长 | Flathub 允许 35 个字符，缩短 `en-US` 文案的 `subtitle` |
| `doctor`：没有截图 | 在 `store.linux.screenshots` 中至少加一个 URL |
| Flathub 构建因架构失败 | 压缩包是为本机处理器构建的（`only-arches`），需为每种架构构建并加入压缩包 |
| `nsh publish linux` 要求 `--url` | 设置 `store.linux.archiveUrl` |
| `status` 显示未上架 Flathub | 首次提交尚未合入，或 `id` 与 Flathub 仓库名不一致 |

### 未覆盖的内容

- 不支持发布到 Snap Store 或 AUR。
- 不会上传到 Flathub 或开 Pull Request：Flathub 根据你提交的 manifest 构建。

## 发布到 Microsoft Store

Windows 上的商店是 Microsoft Store。`nsh publish windows` 通过 Store 提交 API 把 MSIX 包提交到 Store，由 Store 认证、签名并发布。

### 首次发布之前

- 已在 [Partner Center](https://partner.microsoft.com/dashboard) 保留应用名，并在那里完成首次提交（定价、年龄分级、商店文案）。之后的版本通过 `nsh publish windows` 发布。
- 一个 MSIX 包：`nsh package --target windows --format msix`，不签名（见[打包](./packaging.md#msix)）。Linux 和 macOS 上也能生成。
- 一个关联到 Partner Center 的 Azure AD 应用（Account settings → User management → Azure AD applications，角色 Manager）。凭据只从环境变量读取：`NSH_MS_TENANT_ID`、`NSH_MS_CLIENT_ID` 和 `NSH_MS_CLIENT_SECRET`。

### 配置应用

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "windows": {
    "identityName": "12345Example.MyApp",
    "publisher": "CN=0A1B2C3D-1234-5678-9ABC-0123456789AB",
    "publisherDisplayName": "Example Inc."
  },
  "store": {
    "locales": { "en-US": { "releaseNotes": "Faster sync." } },
    "windows": { "productId": "9NBLGGH4R315" }
  }
}
```

| 字段 | 用途 |
|---|---|
| `store.windows.productId` | 应用的 Store ID（Partner Center → 应用 → Product identity），也接受 `storeId` |
| `windows.identityName`、`windows.publisher` | 包标识，从同一页面复制；包标识不一致时 Store 会拒绝 |
| `version` | 包版本，第四位为 0 |
| `store.locales.<tag>.releaseNotes` | 该语言商店页面的更新说明（或 `store/<tag>/release_notes.txt`） |

### 发布

```sh
nsh package --target windows --format msix
nsh publish windows .nsh/out/MyApp.msix --wait
```

以最近一次已发布的提交为基础新建提交，替换其中的包，设置各语言的更新说明，上传包并提交认证。提交认证前失败的提交会被删除。应用有待处理的提交（Partner Center 中的草稿）时会拒绝执行，不会覆盖别人已开始的工作。`--wait` 会一直轮询到认证结束，Store 拒绝时以失败退出。

### 状态与检查

```sh
nsh publish status windows [--json]   # exit 0 published, 2 in progress, 1 failed
nsh publish doctor windows            # read-only: nsh.json, credentials, the Store ID
```

### 命令

```sh
nsh publish windows <APP.msix> [--entry <DIR>] [--product-id <ID>] [--notes <FILE>|<LANG>=<FILE>]... [--wait]
nsh publish status windows [--entry <DIR>] [--product-id <ID>] [--submission <ID>] [--json]
nsh publish doctor windows [--entry <DIR>] [--product-id <ID>]
```

| 参数 | 说明 |
|---|---|
| `--product-id <ID>` | Store ID。默认：`store.windows.productId` |
| `--notes <FILE>` 或 `<LANG>=<FILE>` | 所有语言或某个语言的更新说明。默认：商店文案中的 `releaseNotes` |
| `--wait` | 等到认证结束 |
| `--submission <ID>` | 仅 `status`：查看最近一次之外的某个提交 |
| `--entry <DIR>` | 应用目录或入口，默认 `.` |

### 常见错误

| 现象 | 原因与解决 |
|---|---|
| `doctor`：缺少凭据 | 设置 `NSH_MS_TENANT_ID`、`NSH_MS_CLIENT_ID` 和 `NSH_MS_CLIENT_SECRET` |
| 被拒绝：存在待处理的提交 | 在 Partner Center 完成或删除草稿后再发布 |
| 认证因包标识失败 | 从 Partner Center 的 Product identity 复制 `identityName` 和 `publisher` |
| 认证因版本失败 | 提高 `version`：每次提交都需要更高的版本 |

## 另请参阅

- [打包](./packaging.md)：各平台的 `nsh package`，AppImage、Flatpak 和 MSIX 文件，以及不经商店的应用分发
- [CLI](./cli.md)：所有命令和参数
- [应用更新](./app-updates.md)：自我更新的应用
- [OTA 更新](./ota-updates.md)：无需发布商店版本即可更新 TSX
