---
title: 项目结构
description: 用 TSX 或 Rust 编写的 NSH 应用包含的文件、nsh.json 的每个键、.nsh/types 中的 TypeScript 配置、资源，以及模块和包的导入方式。
order: 5
group: start
---

# 项目结构

一个 NSH 应用就是一个目录，包含一个 `nsh.json` 和它的代码：一个 TSX 入口模块（有 Rust 时，再加上 `ext/` 里的 Rust crate），或一个由 `nsh.json` 指定根组件的 Rust crate。其他一切（更多模块、图片、字体、JSON 文件）都从这里找到：TSX 入口导入的文件，或者 crate 的模块和它的 `assets/` 目录，因此不需要维护文件清单。

TSX 应用是一个入口及它导入的模块：

```text
my-app/
├── App.tsx            the entry module: calls mount()
├── App.test.tsx       its tests (nsh test)
├── nsh.json           name, id, version, icon, Tailwind theme, capabilities
├── tsconfig.json      TypeScript settings for editors
├── .gitignore         .nsh/ and target/
├── src/               your own modules (any layout you like)
│   └── Header.tsx
├── ext/               the app's Rust, when it has any: one nshm crate per directory (nshm)
├── assets/
│   ├── logo@2x.png    imported images
│   └── Inter.ttf      imported fonts
├── locales/           translations, rust-i18n's files: t("hello") (I18n)
└── .nsh/              generated: type declarations, development host builds, test entries, build output (.nsh/out)
```

完全用 Rust 编写的应用是一个 Cargo 项目：

```text
my-app/
├── nsh.json           name, id, version, icon, the crate ("rust") and its root component ("root"), theme
├── Cargo.toml         the crate: nsh-core, nsh-base and your dependencies
├── src/
│   ├── lib.rs         the root component and the crate's UI set (#[native_module])
│   ├── main.rs        cargo run: the root on this machine's desktop backend
│   └── screens/       your own modules (any layout you like)
├── assets/            files the crate ships: asset!("logo@2x.png"), fonts
├── locales/           translations, rust-i18n's files: t!("hello") (I18n)
├── .gitignore         .nsh/ and target/
├── .nsh/              generated: the runners' sources, test entries, build output (.nsh/out)
└── target/            Cargo's build directory
```

TSX 应用通过 `ext/` 里自己的 nshm crate 用 Rust 扩展自己，在 `"dependencies"` 中按路径列出（[应用自己的 Rust：ext/](./nshm.md#应用自己的-rustext)）；`src/` 放 TSX，`ext/` 放 Rust。Rust 应用也可以在 `"rust"` 中列出它的 crate，再加一个导入它们的 TSX 入口（[用 Rust 开发](./rust.md#用-tsx-扩展-rust-应用)）。

每个命令都以应用目录或它的入口作为参数（`nsh run my-app`、`nsh run my-app/App.tsx`）。`nsh.json` 所在的目录就是应用的根目录：`nsh.json` 从这里读取，它写的路径和资源路径都相对于它，`.nsh/` 也写在这里。入口默认是它旁边的 `App.tsx`，`nsh.json` 也可以用 `"entry"` 指定别的入口。在 Rust 应用中（`nsh.json` 带 `"root"`），目录运行根组件；指定 TSX 入口则运行该入口。

### 放在更大项目里的应用

同时包含其他代码（服务端、网站）的项目，可以把 `nsh.json` 放在项目根目录，与 `package.json` 或 `Cargo.toml` 同级，应用代码放在单独的目录里，由 `"entry"` 指定：

```text
my-project/
├── nsh.json           { "name": "…", "entry": "app/App.tsx", "theme": "app/theme.json", … }
├── package.json       服务端的
├── server/
└── app/
    ├── App.tsx        入口
    ├── App.test.tsx   它的测试
    ├── tsconfig.json  应用模块的 TypeScript 设置
    └── theme.json
```

这样 `nsh run`、`nsh test` 等命令在项目根目录执行，和在应用目录执行一样：根目录就是应用的根目录（`.nsh/`、`locales/` 以及 `nsh.json` 写的 `theme`、`icon`、`web.host` 等路径都相对于它）；`nsh test` 只在入口所在目录（`app/`）里找测试文件，不会扫到服务端的测试；`nsh check` 和 `.nsh/types` 跟随入口目录的 `tsconfig.json`。

## 根组件

TSX 入口是一个普通模块，最后渲染根组件。Rust 应用的根是它的 crate 中的一个组件，`nsh.json` 的 `"root"` 用它在 crate 中的路径指定（`App`、`shell::Gallery`）：

```tsx tabs
// App.tsx
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Home } from "./components/Home";

function App() {
  return <Home />;
}

mount(() => <Window id="main"><App /></Window>);
```

```rust tabs
// src/lib.rs; nsh.json: { "rust": ".", "root": "App" }
mod screens;

use nsh_core::{element::desktop::window as app_window, prelude::*};

/// What a TSX entry may import from the crate.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>().assets(assets!());
}

#[component]
pub fn App() -> impl IntoElement {
    // 桌面平台上这是应用的窗口；其他平台上它显示自己的内容。
    app_window().id("main").content(screens::home)
}
```

在 TSX 中，`mount(component, props?)` 把组件渲染为应用根，并返回一个用于移除它的函数；应用只调用它一次。在桌面平台上，应用根用 `<Window>` 声明自己的窗口（声明窗口的应用也要声明第一个；裸 root 渲染在隐式首窗口中）；其他平台上 `<Window>` 在唯一界面中显示它的内容。入口顶层的代码在 bundle 加载时、第一帧之前运行。`nsh run` 和 `nsh package` 在所有平台上挂载 Rust 根组件，不带 QuickJS。

## nsh.json

`nsh.json` 位于应用的根目录。`nsh init` 会写入 `name`、`id`、`version` 和 `build`，Rust 应用还会写入 crate 及其根组件：

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "rust": ".",
  "root": "App",
  "theme": "theme.json"
}
```

其他键都是可选的；TSX 应用也可以省略这四个。TSX 应用的 `nsh.json` 可以是这样：

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "icon": "icon.png",
  "tailwind": {
    "colors": { "brand": { "500": "#7c3aed", "600": "#6d28d9" } },
    "radius": { "card": 14 }
  },
  "capabilities": {
    "network": { "hosts": ["api.example.com", "*.cdn.example.com"] }
  }
}
```

| 键 | 类型 | 使用者 | 说明 |
|---|---|---|---|
| `name` | string | `package` | 应用图标下显示的名称。默认：`nsh.json` 所在目录的名称。 |
| `entry` | string | 每个命令 | TSX 入口模块，路径相对于 `nsh.json` 且在它的目录之内，例如 `"app/App.tsx"`（[放在更大项目里的应用](#放在更大项目里的应用)）。默认：`nsh.json` 旁边的 `App.tsx`。命令行上指定的入口（`nsh run app/Other.tsx`）优先。 |
| `id` | string | `package`, `publish`, `Storage` | Bundle identifier / application id，反向 DNS 形式，例如 `com.yourcompany.app`；`package` 和 `publish` 必须提供。没有时 `nsh run` 使用 `com.example.<name>`。 |
| `version` | string | `package`, `publish` | 用户可见的版本号，例如 `1.2.0`（`CFBundleShortVersionString`，Android 的 `versionName`）。 |
| `build` | number | `package`, `publish` | 构建号（`CFBundleVersion`，Android 的 `versionCode`）。签名包要求它在每次发布时递增。 |
| `nsh` | string | 所有命令 | 应用适用的 NSH 版本，写法同 Cargo 的版本要求，例如 `">=0.5"` 或 `">=0.5, <0.7"`。处理该应用的每个命令都会先用它检查 CLI 版本，不满足时只给出一条提示 `this app requires nsh >=0.5; this is nsh 0.4.0`，而不是另一个版本带来的类型或编译错误。nightly 按其正式版本号计算。 |
| `minRuntime` | string | `publish` | 能运行该签名包的最低 NSH 运行时版本，例如 `0.2.0`。默认：CLI 的版本（[签名包](./signed-packages.md#哪些运行时能运行包)）。 |
| `schemes` | string[] | `package`、`run` | 打开应用的 URL scheme，例如 `["myapp"]` 对应 `myapp://…` 链接，由 [`UrlScheme`](../modules/nsh.md#urlscheme) 接收。只含小写字母、数字、`+`、`-` 和 `.`；不能是系统或浏览器占用的（`https`、`file` 等）。 |
| `links` | object[] | `package`、`run` | 打开应用的 Web 链接（Universal Links、App Links）：`[{ "host": "example.com", "paths": ["/orders/*"] }]`，`host` 是域名，或用 `*.` 加域名表示子域名；`paths` 是完整路径或以 `*` 结尾的路径开头（省略：所有路径）。它们的 `https` 链接和 scheme 的链接一样由 [`UrlScheme`](../modules/nsh.md#web-链接) 接收。iOS 包在 Associated Domains entitlement 中声明主机，Android 包为每个链接写一个经过验证的 intent filter。 |
| `fileTypes` | object[] | `package`、`run` | 应用打开的文件类型，`[{ "name": "Video", "extensions": ["mp4"], "mimeTypes": ["video/mp4"] }]`，由包声明给系统（Android 经由 `mimeTypes`，进入分享面板）；文件送到 [`Application.on("openFiles")`](../modules/nsh-desktop.md#打开文件)。 |
| `handoff` | boolean | `package` | `true`：在 iOS 和 macOS 上，应用用 [`UrlScheme.setUrl`](../modules/nsh.md#handoff) 设置的地址交给系统，Handoff 可以在用户的其他设备上接着打开它；打包时在 `NSUserActivityTypes` 中声明它的活动类型 `<id>.url`。 |
| `singleInstance` | boolean | `package` | `true`：应用在 Windows 和 Linux 上只运行一份；第二次启动把参数和工作目录交给正在运行的应用后退出（[单实例](../modules/nsh-desktop.md#单实例)）。 |
| `logDir` | string | `package` | 打包后的桌面应用（macOS、Windows、Linux）写日志文件（`app.log`、`app.1.log` 等）的目录，`log_file()` 和 `process.logFile` 也指向这里。写法与 `dataDir` 相同：绝对路径或 `"${homeDir}/.myapp/logs/ui"`（不能包含 `..` 或其他 `${...}`），其他值会给出警告并被忽略。不设置时，日志在数据目录（`dataDir`，或系统应用数据目录下以应用 id 命名的目录）的 `logs` 中；设置 `logDir` 后不会创建这个 `logs` 目录。iOS、Android、Web 和嵌入的应用没有日志文件，会忽略它。 |
| `dataDir` | string | `package` | 应用在桌面（macOS、Windows、Linux）上的数据目录：存储（`nsh/storage`）、日志、`process.dataDir` 以及 `${dataDir}` 中的文件都在这里。取值为绝对路径或 `"${homeDir}/.myapp"`（不能包含 `..` 或其他 `${...}`），其他值会给出警告并被忽略。不设置时为系统应用数据目录下以应用 id 命名的目录：macOS 为 `~/Library/Application Support/<id>`，Windows 为 `%APPDATA%\<id>`，Linux 为 `$XDG_DATA_HOME/<id>`（`~/.local/share/<id>`）。在这里设置的目录不随应用 id 改变。缓存和下载的更新各有自己的位置；iOS、Android、Web 和嵌入的应用使用平台的目录。 |
| `features` | string[] | `package` | 打包时 release runner 始终保留的原生功能（应用带 Rust crate，或本机装有 `cargo` 且打包目标是本机系统时，在本地构建 runner），如 `["plot"]`：只有 Rust 代码或动态 import 才用到的功能写在这里。其余功能中，bundle 用不到的（`shader`、`editor`、`plot` 等）`package` 会去掉，并输出原因。 |
| `icon` | string \| object | `package`、`run` | 一张正方形 PNG，最好是 1024×1024，路径相对于 `nsh.json`；也可按平台分别提供（`{ "macos": "…", "windows": "…" }`，[打包](./packaging.md#图标)）。Android 的可以是自适应图标（`{ "foreground": "…", "background": "…", "monochrome": "…" }`，[打包](./packaging.md#图标)）。 |
| `tailwind` | object | 每次构建 | 扩展 `class` 字符串所依据的 Tailwind 主题（[Tailwind](./tailwind.md)）。 |
| `locales` | string[] | 每次构建 | 应用除英语外格式化数字和日期所用的语言（`["de", "zh-CN"]`），bundle 会携带它们的数据。默认：`locales/` 中翻译所包含的语言（[I18n](./i18n.md#数字和日期)）。 |
| `timeZones` | string[] | 每次构建 | 除设备时区、`UTC` 和偏移量外，`Intl` 还能使用的时区名（`["America/New_York"]`），bundle 会携带它们的规则。默认：无（[时区](./i18n.md#时区)）。 |
| `theme` | string 或 object | 每次构建 | 应用的设计令牌（shadcn/ui 的 `cssVars`，叠加在默认的 `neutral` 主题之上），供 token 类名、`token()` 和 Rust 组件绘制时使用：相对于 `nsh.json` 的主题文件路径，或直接内联的主题（[用 Rust 开发](./rust.md#主题)、[主题 token](./tailwind.md#主题-token)）。 |
| `statusBar` | object | 每次构建、`package` | 所有页面和对话框之下的状态栏默认值（iOS 和 Android）：`{ "foreground": "auto" \| "light" \| "dark", "hidden": boolean }`，两个字段都可省略。打包的 iOS 应用从启动屏起就使用它（[状态栏](../modules/nsh-base.md#status-bar)）。 |
| `capabilities` | object | 每次构建 | 应用可以访问 VM 之外的哪些资源：网络主机、网页视图主机、状态栏、应用自己的窗口（[沙箱与权限](./sandbox-and-capabilities.md)）。 |
| `window` | object | 每次构建、`package` | 桌面平台上应用声明的第一个窗口的启动设置，从第一帧起生效：`title`、`defaultSize`、`minSize`、`titleBar`、`backdrop` 以及窗口的其他选项和属性，写法与 `nsh/desktop` 的 `WindowOptions` 相同（`{ "defaultSize": { "width": 1100, "height": 720 }, "titleBar": { "style": "hidden" } }`）（[应用宿主与第一个窗口](../modules/nsh-desktop.md#应用宿主与第一个窗口)）。`defaultVisible` 不再适用：应用宿主永远不会显示；以无窗口状态启动的应用不打开窗口即可。 |
| `application` | object | 每次构建、`package` | 应用的生命周期：`"quitMode": "platform" \| "lastWindowClosed" \| "explicit"`。`"platform"`（`<Window>` 应用的默认）让 macOS 应用在没有窗口时继续运行，并在 Windows 和 Linux 上于最后一个窗口关闭时退出；`"lastWindowClosed"` 在所有平台上最后一个窗口关闭时退出；`"explicit"` 在没有窗口时继续运行。未声明 `<Window>` 的裸 `mount(App)` 隐式主窗口在关闭时默认在所有平台退出，除非在此或通过 `Application.setQuitMode` 显式配置（[退出](../modules/nsh-desktop.md#退出)）。 |
| `resolve` | object | 每次构建 | 裸导入如何解析：npm 包的导出条件和别名（[npm 包](#npm-包)）。 |
| `rust` | string 或 string[] | 每个命令 | 应用的 Rust crate 或 crate 列表，路径相对于 `nsh.json`：其中的组件和模块，TSX 按每个 crate 的 `#[native_module]` 名称导入（[用 Rust 开发](./rust.md#多个-crate)）。 |
| `dependencies` | object | 每个命令 | 应用使用的 [nshm](./nshm.md)，以包名为键，由 `nsh add` 记录在这里并由 NSH 锁定在 `nsh.lock`：来自 crates.io 时写版本要求（`"acme-gauge": "^1.0"`），否则写带 `"github"`、`"git"` 或 `"path"` 的对象，可加 `"version"`、`"tag"` 或 `"rev"`，`"features"`，即要开启的 Rust nshm 的 Cargo feature（`"nsh-extra": { "version": "^0.6", "features": ["camera"] }`），以及 `"targets"`，即按 `platform.os` 名字列出的、要链接 Rust nshm 的 target（默认所有 target；[nshm](./nshm.md#使用-nshm)）（[CLI：nsh add](./cli.md#nsh-add)）。 |
| `web` | object | `package` | Web 包给页面添加的内容。`web.host`：一个 JS 模块，路径相对于 `nsh.json`，导出 `createHost(player)`，应答应用的 [`host`](../modules/nsh.md#host) 调用；`web.connect`：该模块自己的请求访问的主机，写法同 `capabilities.network.hosts` 的模式，页面的 Content-Security-Policy 允许它们（[Web](./web.md#宿主的函数)）；`web.base`：站点所在的路径（`"/apps/counter/"`），即页面的 `<base href>`，使页面在应用自己的路径上也能加载（[Web](./web.md#部署)）；`web.history`：压入的页面和打开的对话框是否作为浏览器历史记录（默认在应用占据整个页面时是，在 iframe 里不是）。 |
| `updater` | object | `package` | 打包后的应用从哪里获取更新：`{ "github": "owner/repo" }` 或 `{ "url": "https://…/latest.json", "publicKey": "…" }`，配 `github` 时 `publicKey` 可选；[OTA 更新](./ota-updates.md)另需 `"packages": { "roots": [...] }`（[应用更新](./app-updates.md)、[nsh/updater](../modules/nsh-updater.md#nshjson)）。 |
| `ios` | object | `package` | iOS 包添加的内容：`infoPlist` 是应用 `Info.plist` 的键，`infoPlistStrings` 是这些键在其他语言下的文字，按语言给出（`{ "zh-Hans": { "NSCameraUsageDescription": "…" } }`），`nsh run` 的模拟器宿主也会带上（[其他语言的 Info.plist 文字](./packaging.md#其他语言的-infoplist-文字)），`entitlements` 在真机构建时对照描述文件检查，`launchScreen` 是应用启动时系统显示的颜色和图（[启动画面](./packaging.md#启动画面)），`extensions` 是应用自己构建的应用扩展（`.appex`），由打包放进包里并签名（[应用扩展](./packaging.md#应用扩展)），`privacyManifest` 是应用在 `PrivacyInfo.xcprivacy` 里补充的内容，打包时会和 NSH 自己的条目合并（[隐私清单](./packaging.md#隐私清单)）。NSH 自己的键会被拒绝（[打包](./packaging.md#infoplist-键与-entitlements)）；`infoPlist` 的 `MinimumOSVersion` 提高应用所需的 iOS 版本（[最低系统版本](./packaging.md#最低系统版本)）。 |
| `android` | object | `package` | Android 包的设置：`targetSdk`，应用的目标 API 级别，也是编译所用的级别（默认 35）（[打包](./packaging.md#目标-api-级别)）；`usesCleartextTraffic`，是否允许普通的 `http://` 请求（默认 `false`）（[打包](./packaging.md#明文-http)）；`permissions`，除 NSH 自身声明的权限外 manifest 还要声明的权限（默认无）（[打包](./packaging.md#权限)）；`launchScreen`，应用启动时窗口的颜色和启动屏的图，键同 `ios.launchScreen`（[启动画面](./packaging.md#启动画面)）；`libraries`，应用随包附带的 Java 库的 jar、Android 库（`.aar`）和 dex 文件，路径相对于 `nsh.json`，排在应用的 crate 列出的库之前（默认无）（[打包](./packaging.md#java-代码)）；`manifestPlaceholders`，库的 manifest 以及应用和 crate 的 manifest 条目里 `${name}` 占位符的值，只有应用能设置（默认无）（[打包](./packaging.md#java-代码)）；`queries` 和 `application`，除 NSH 自己的之外 manifest 的 `<queries>` 和 `<application>` 还要声明的元素（默认无）（[打包](./packaging.md#组件与-queries)）。 |
| `macos` | object | `package`、`run`、`test` | macOS 包添加的内容：`infoPlist`、`infoPlistStrings` 和 `entitlements`，与 `ios` 的相同（[打包](./packaging.md#infoplist-键与-entitlements)），`infoPlist` 的 `LSMinimumSystemVersion` 提高应用所需的 macOS 版本（[最低系统版本](./packaging.md#最低系统版本)）；`extensions` 是应用自己构建的应用扩展（`.appex`），由打包放进 `Contents/PlugIns/` 并签名（[macOS 应用扩展](./packaging.md#macos-应用扩展)）；以及 `activationPolicy`，即无论 NSH 以哪种方式启动应用，它如何参与系统界面：`"regular"`（默认），有 Dock 图标和菜单栏；或 `"accessory"`，即菜单栏应用（[macOS](./macos.md#菜单栏应用)）。 |
| `root` | string | `run`, `package` | Rust 应用的根组件，即它在 `rust` crate（列表时为第一个）中的路径（`App`、`shell::Gallery`）：对应用目录执行 `nsh run` 和 `nsh package` 时，在所有平台上直接挂载它，不使用 QuickJS；`nsh run App.tsx` 仍然运行 TSX 入口（[用 Rust 开发](./rust.md)）。 |
| `watch` | object | `run`、`dev` | 开发监视器跳过的内容：`"ignore"` 是一个目录列表，其中的文件变化不会触发重建或重启——相对 `nsh.json` 的路径（`"vendor"`、`"third/jpeg-turbo"`）或绝对路径，用于应用目录内放置的生成代码和其他 checkout（监视器本就跳过 `.nsh`、`node_modules` 和嵌套的 Git checkout）。 |

`nsh package` 和 `nsh publish` 的参数（`--name`、`--id`、`--app-version`、`--build`、`--icon`、`--min-runtime`）会覆盖文件中的值（[CLI](./cli.md)）。

构建应用时会校验每个键。NSH 读不懂的内容（不认识的键，或形式不认识的值）会给出警告并逐项略过，文件的其余部分照常生效。因此为更新的 NSH 写的应用在较旧的 NSH 上照样能构建和运行，拼写错误也会出现在构建输出里：

```text
warn nsh.json: tailwind: unknown key `colours`, ignored (one of a newer NSH, or a typo)
```

NSH 读不懂的能力不会被授予，因此略过的内容永远不会扩大应用的权限。


### capabilities

没有 `capabilities` 键时，应用可以自由使用网络、网页视图和状态栏：独立应用归开发者自己所有。设置了该键后，未列出的一切都会被拒绝，无论是开发中还是打包后的应用：

```json
"capabilities": {
  "network": {
    "hosts": ["api.example.com", "*.cdn.example.com"],
    "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }]
  },
  "webview": { "hosts": ["*.example.com"] },
  "statusBar": true
}
```

`network` 涵盖 `fetch`、远程图片和视频源；本地资源始终允许访问。嵌入 NSH 的应用可以授予比应用声明更少的权限。详情见 [沙箱与权限](./sandbox-and-capabilities.md)。

## tsconfig.json 与 .nsh/types

NSH 不需要 `node_modules`。取而代之的是，每个构建应用的命令（`init`、`build`、`test`、`dev`、`run`、`package`、`publish`、`check`）都会把 NSH 提供的所有内容的 TypeScript 声明写入 `.nsh/types`，并把 NSH 的 TypeScript 设置写入 `.nsh/tsconfig.json`。应用的 `tsconfig.json` 继承它：

```json
{
  "extends": "./.nsh/tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`.nsh/tsconfig.json` 把 `nsh` 的导入和应用自己的 crate 指向 `.nsh/types`，包含全局声明、资源声明和令牌声明，并设置 NSH 应用使用的编译选项（`lib`、`jsx`、`strict` 等）。NSH 会让它保持最新：新版本增加了库或路径时，应用在下一次构建时就会得到，而你的 `tsconfig.json` 保持你写的样子。你在 `tsconfig.json` 中添加的选项会覆盖 NSH 的设置。

| `.nsh/types/nsh/` 中的文件 | 声明的内容 |
|---|---|
| `index.d.ts` | `nsh`：`signal`、`computed`、`effect`、`mount`、`View`、`Text` 等，并重新导出下列类型 |
| `types.d.ts` | 样式（`ViewStyle`、`TextStyle` 等）、每个元素的 props 和事件、各个 ref（`ViewRef`、`InputRef` 等：`ref` 接收到的对象） |
| `jsx-runtime.d.ts` | TypeScript 通过 `jsxImportSource` 解析的 JSX 运行时（`JSX` 命名空间） |
| `globals.d.ts` | `If` 和 `Each`；`console`、定时器、`requestAnimationFrame`、`fetch` 及其他[全局 API](../modules/globals.md) |
| `assets.d.ts` | 导入图片或字体得到的值 |
| `tokens.d.ts` | `Tokens`：应用的设计令牌，来自它的 `"theme"`，为 [`token()`](../modules/nsh.md#token) 提供类型 |
| `mobile.d.ts`、`desktop.d.ts` | 每个模块一个文件（`nsh/mobile`、`nsh/desktop`） |
| `base.d.ts` | `nsh/base` |

`lib` 是不含 `DOM` 的 `ES2023`：没有 `document` 或 `window`。`.nsh` 中的文件会被重新生成（只在内容变化时），所以不要编辑，也不要提交；`.gitignore` 已经排除了 `.nsh/`。如果克隆项目后编辑器提示找不到 `nsh`，运行任意一个构建命令即可，例如 `nsh check`。

`.nsh/tsconfig.json` 加入了 `"ESNext.Disposable"`，它声明了运行时提供的 `using` 声明和 `Symbol.dispose`：`using account = new Account()` 在块结束时释放一个 [Rust 类](./rust.md)的值。其中的 `jsxImportSource: "nsh"` 和 `jsx: "preserve"` 只对编辑器有意义：无论 `tsconfig.json` 怎么写，NSH 都用自己的编译器编译 JSX。TypeScript 类型由编辑器检查（如果装了 `tsc` 也可以用它）；`nsh` 只剥离类型，不做检查。

由较早的 `nsh init` 创建的应用，如果它的 `tsconfig.json` 是 NSH 的模板且没有改动过，会在下一次构建时换成新的 `tsconfig.json`，NSH 会打印一行说明。你改过的 `tsconfig.json` 归你所有：它没有继承 `./.nsh/tsconfig.json` 时，`nsh check` 会指出来，你加上 `extends` 这一行并删掉它已经设置的选项即可。

## 模块

Rust 应用的代码就是它的 crate 的模块（`mod screens;`），依赖和任何 crate 一样来自 crates.io；NSH 自己的 crate 是 `nsh-core`（基础元素、signal 和带类型的样式，`use nsh_core::prelude::*`）和 `nsh-base`（基础组件和主题）。

在 TSX 中，可以把应用拆成任意多个 `.ts` 和 `.tsx` 模块，用相对路径导入；扩展名可以省略：

```tsx
import { Header } from "./components/Header";
import { formatPrice } from "./lib/format";
import strings from "./strings.json";
```

它们都会被打包进同一个脚本。JSON 文件导入后就是解析后的值。

### 从二进制中去掉部分功能

平台 crate 默认开启全部可选功能：`js`、`shader`、`editor`（含 `DiffView`）、`rich-editor`、`plot`、`term`、`highlight`、`math`、`emoji-picker`（`EmojiPicker`）、`zlib`、`crypto`、`websocket` 和 `updater`，以及平台自己的功能：Linux 上的 `net` 和 `sound`，Windows 上的 `net`、`webview` 和 `media`。SVG 图片始终包含在内。`nsh run` 和开发宿主带有全部功能。

`nsh package` 在本机构建 release runner 时（应用带 Rust crate，或本机装有 `cargo` 且打包目标是本机系统或 Android），只保留应用 bundle 用得到的功能，并输出每项保留或去掉的原因。用到 `TextView` 时保留 `highlight` 和 `math`，因为它显示的文本可能含有代码和公式。Linux 的 runner 只在应用导入 `Sound` 时包含声音（`sound`，它会加载 GStreamer），Windows 的 runner 只在应用导入 `Sound` 或 `AudioPlayer`、或显示 `Video` 时链接 Media Foundation（`media`），因此不播放声音和视频的应用不带任何媒体代码。它看不到应用的 Rust 代码用了什么，也看不到动态 `import()` 加载什么：这些功能写在 [`nsh.json` 的 `features`](#nshjson) 中，例如 `"features": ["shader"]`。依赖 `nsh-base` 默认功能的 Rust crate 会通过 Cargo 保留 `editor`、`rich-editor`、`plot`、`term` 和 `highlight`；但 Rust 代码绘制 `Shader` 仍需写上 `"shader"`，否则着色器视图不绘制任何内容。`nsh-base` 默认不开启的功能（`math`、`emoji-picker`）写在 crate 自己的依赖中：`nsh-base = { version = "0.6", features = ["emoji-picker"] }`。

如果你用 Cargo 自己构建可执行文件（嵌入 NSH，或自己写 `main`），由你自己选择功能：在平台 crate 和 `nsh-base` 上都设置 `default-features = false`（任何一个保留默认功能，都会把它们重新开启），再列出要保留的项：

```toml
nsh-base = { version = "0.6", default-features = false, features = ["editor"] }
nsh-platform-macos = { version = "0.6", default-features = false, features = ["js", "editor", "highlight", "shader"] }
```

Rust 代码用到构建时去掉的功能会无法编译；TSX 导入它会在加载时报错（`Could not find export 'Editor' in module 'nsh/base'`）。去掉 `shader` 时着色器视图不绘制任何内容；去掉 `highlight` 和 `math` 时代码和公式显示为纯文本。

### 按需加载代码

对应用自己的模块调用 `import()`，会得到一个兑现为其导出的 promise，和浏览器里一样：

```tsx
const open = async () => {
  const { Settings } = await import("./screens/Settings");
  screen.set(() => Settings);
};
```

设备上的应用只分发一个 bundle，模块已经在里面，promise 会立即兑现。以拆分方式发布的 Web 应用（`nsh build --split`）会把这个模块以及只有它用到的代码放进单独的文件，在 `import()` 第一次请求时才下载（[Web](./web.md#拆分-bundle)）。参数必须是字面量相对路径：打包器需要知道导入的是哪个模块。

### NSH 的模块

对 `nsh` 和 `nsh/...` 的导入不会被打包：运行时以原生方式提供它们。

| 模块 | 内容 |
|---|---|
| `nsh` | 响应式（`signal`、`computed`、`effect` 等）、`mount`、`split`、`context`；基础元素 `View`、`Text`、`Scroll`、`Image`、`List`、`Canvas`、`WebView`、`Video`（`View` 的 `selectable` 用于文本选择）；安全区域边距（`safeArea`、`safeAreaInsets`）和软键盘（`Keyboard`、`keyboardFrame`）；原生动画；`PanResponder`；环境（`platform`、`windowSize`、`colorScheme`、`fontScale`、`pixelRatio`、`locale`）；读屏与减少动态效果的状态、朗读通知；剪贴板、照片选择器、存储、宿主通道、键盘快捷键；嵌入应用注册的组件和函数（[参考](../modules/nsh.md)） |
| `nsh/base` | 应用界面的无样式基础：导航栈及其页面（`NavStack`、`NavPage`、`createNavStack`）、对话框（`Dialog`）、按压目标（`Button`）、文本输入框（`Input`）和系统警告对话框（`AlertDialog`）；页面和对话框设置状态栏（`statusBar`）（[参考](../modules/nsh-base.md)） |
| `nsh/mobile` | iOS 和 Android 的 API：`TabBar`、`InputAccessoryView`（iOS）、`BackHandler`（Android）（[参考](../modules/nsh-mobile.md)） |
| `nsh/desktop` | macOS、Windows 和 Linux 的 API：窗口（`Window`、`currentWindow`、`windows`）、`titleBar`、`displays`、`Menu`、`Tray`、`GlobalShortcut`（[参考](../modules/nsh-desktop.md)） |
| `nsh/i18n` | 应用的翻译（它的 `locales/` 文件或运行时加载的翻译）和它显示的语言：`t`、`setLocale`、`availableLocales`、`addTranslations`（[I18n](./i18n.md)、[参考](../modules/nsh-i18n.md)） |
| `nsh/updater` | 打包后的应用自我更新：`checkForUpdate`、`downloadUpdate`、`installAndRestart`、`installOnQuit`（[参考](../modules/nsh-updater.md)） |

[模块参考](../modules/index.md) 逐一介绍了它们。导入 NSH 没有的模块（`nsh/foo`）会导致构建错误。代码用到、但模块没有导出的名字（`import { Buton } from "nsh/base"`）同样是构建错误：错误指向这条导入，并给出最接近的导出名（``did you mean `Button`?``）。只当作类型用的名字由 `nsh check` 检查。

### npm 包

NSH 本身不依赖 npm 上的任何东西，但如果你用包管理器安装了包，打包器会从 `node_modules` 目录解析裸导入。包会解析到它们的浏览器版本，因为运行时提供的是 Web API（`fetch`、streams、`URL`、`TextEncoder` 等），而不是 Node 的 API（`fs`、`Buffer`、`process`）。依赖 DOM 的包无法工作：这里没有 DOM。

打包器从导入它的文件所在目录逐级向上查找 `node_modules`。解析不到的导入会让构建失败，错误里写明是哪个文件导入的。TSX [nshm](./nshm.md) 安装在应用之外的 `~/.nsh/nshms`，它导入的包在那里找不到。做法是在应用里安装这个包，再用 `resolve.alias` 把导入指向包里的文件；包自己的导入随后从应用的 `node_modules` 解析：

```json
"resolve": { "alias": { "@internationalized/date": "./node_modules/@internationalized/date/dist/import.mjs" } }
```

别名要指向文件，不能指向包目录；nshm 导入的每个子路径都要单独写一项。

浏览器版本依赖 DOM 的包，往往另有面向 worker 或 React Native 的版本。`resolve.conditions` 指定解析包时使用的导出条件，取代默认的 `["browser"]`：`import`、`require`、`module` 和 `default` 始终生效；不含 `browser` 时，包通过 `module` 和 `main` 字段解析。`resolve.alias` 替换一个导入：换成相对 `nsh.json` 的路径（`./` 或 `../`）、另一个包，或用 `false` 换成空模块。TypeScript（`nsh check` 和编辑器）按导入原本的写法做类型检查：不是已安装包的名称，其类型由应用里的 `.d.ts` 文件声明。

```json
"resolve": {
  "conditions": ["worker"],
  "alias": { "dom-only-helper": "./shims/helper.ts", "node-polyfill": false }
}
```

```ts
// shims/aliases.d.ts
declare module "node-polyfill";
```

`solid-js` 不能被导入：打包器会拒绝它，并提示改用 `nsh` 自己的 `signal`、`computed` 和 `effect`，它们取代了 Solid。

## 资源

图片和字体随应用一起发布。Rust crate 在编译时用 `asset!` 读取它的 `assets/` 目录中的每个文件，并在它的 `#[native_module]` 函数中用 `registry.assets(assets!())` 把它们全部发布；TSX 像模块一样导入它们，打包器会记录每个被导入的文件（以及图片的像素密度变体）。`nsh build` 把它们复制到 `.nsh/out/assets/`，`nsh package` 把它们放进应用，开发期间则提供给应用。

```tsx tabs
import { Image, Text } from "nsh";
import logo from "./assets/logo@2x.png";   // { url: "asset:/assets/logo@2x.png", size: { width: 64, height: 64 } }
import Inter from "./assets/Inter.ttf";     // "Inter"

<Image src={logo} />
<Text style={{ fontFamily: Inter }}>Hello</Text>
```

```rust tabs
use nsh_core::element::{FontAsset, ImageAsset, asset};

const LOGO: ImageAsset = asset!("logo@2x.png");      // its url, and its size: 64×64 points
const INTER: FontAsset = asset!("Inter.ttf");        // its uri, and its family: "Inter"

image(LOGO)
text("Hello").font_family(INTER.family)
```

| 扩展名 | 导入得到 |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic` | 一个 `ImageAsset`：`{ url, size, scales? }`，单位为点。文件名带 `@2x` / `@3x` 后缀时，像素尺寸除以 2 / 3。不带后缀的文件还会发布它的 `@1.5x`–`@4x` 同名文件（列在 `scales` 中），并加载适合屏幕的变体（[像素密度](./images-and-assets.md#像素密度)）。 |
| `.svg` | 一个 `ImageAsset`，尺寸取自 SVG 的 `width` 和 `height`（或 `viewBox`），单位为点。 |
| `.ttf`, `.otf`, `.woff`, `.woff2` | 字体的族名，一个字符串。字体会在第一帧之前注册。 |
| `.json` | 解析后的 JSON |

参见 [图片与资源](./images-and-assets.md) 和 [字体](./fonts.md)。

## 生成的目录

- **`.nsh/`**：NSH 生成的一切：类型声明（`.nsh/types`）、Rust 应用运行器的源码（`.nsh/rust`）、`nsh run` 安装到模拟器和设备上的内容（Catalyst 宿主应用、Android 开发 APK），以及 `.nsh/out`，即 `nsh build` 的默认输出（`bundle.js`、`bundle.js.map`、`bundle.nshc`、`capabilities.json`、`assets/`；Rust 应用是 `app.json` 和 `assets/`）和 `nsh package` 的输出（`.app`、`.ipa`、`.apk`、网站）；用 `-o` 写到别处。可以放心删除，会被重新生成。
- **`target/`**：应用的 crate 和运行器的 Cargo 构建目录（或 `CARGO_TARGET_DIR`）。使用我们推荐的 [huacnlee/cargo](https://github.com/huacnlee/cargo) 时，这里只放可执行文件，构建产物放在 `~/.cargo/targets/` 下。
