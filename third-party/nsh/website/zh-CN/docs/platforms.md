---
title: 平台概览
description: "NSH 在哪些平台上运行：iOS、Android、macOS、Windows、Linux、GPUI、终端和 Web，每个平台都有自己的后端；在各平台上如何运行、打包和嵌入 Rust 或 TSX 应用，以及各自需要什么。"
order: 10
group: platforms
---

# 平台概览

NSH 运行在手机、桌面、终端和网页上：iOS、Android、macOS、Windows、Linux、GPUI、终端单元格和 Web。每个平台都有自己的后端，用平台自己的界面技术绘制：同一个应用在 iPhone 上是 UIKit 视图，在 Mac 上是 AppKit 视图，在 Linux 上是 GTK 4 控件，在 GPUI 应用里是 GPUI 元素，在终端里是 Ratatui 单元格，在浏览器里是 HTML，文本、输入、无障碍和深色模式都是平台自己的。后端之上的部分全部共享：响应式图、渲染器、Taffy 布局、组件和原生模块在每个平台上都是同一份 Rust 代码，所以一个应用可以在所有平台上运行。用 Rust 编写的应用就是这份代码加上你的 crate，不带 JavaScript 虚拟机；TSX 应用则在它之上用 QuickJS 运行自己的模块（[用 Rust 开发](./rust.md)）。

在每个平台上，应用都有同样的两种用法：打包成该平台可安装的应用（`nsh package`），或嵌入你自己的原生应用——宿主可以链接一个 Rust 根组件，也可以在运行时加载 TSX。开发时用 `nsh run`（改动 Rust 会重新构建并重启应用，改动 TSX 是热更新）。

## 一览

| 平台 | 后端；文本 | 运行环境 | 开发 | 打包 |
|---|---|---|---|---|
| [iOS](./ios.md) | UIKit；CoreText | iOS 15.0+，真机和模拟器 | `nsh run --target ios` | `.app`（模拟器）、签名的 `.ipa` |
| [Android](./android.md) | Android 视图；`StaticLayout` | Android 9（API 28）+，`arm64-v8a`、`armeabi-v7a` 和 `x86_64` | `nsh run --target android` | 签名的 `.apk` |
| [macOS](./macos.md) | AppKit 与 Core Animation；CoreText | macOS 14+ | `nsh run --target macos` | ad hoc 签名的 `.app` |
| [Windows](./windows.md) | 用 Direct2D 绘制的 Win32 窗口；DirectWrite | Windows 10 1809+、Windows 11 | `nsh run`（Windows 上的默认目标） | 一个目录和一个 `.zip` |
| [Linux](./linux.md) | GTK 4 控件；Pango | GTK 4.14+ | `nsh run`（Linux 上的默认目标） | 一个目录和一个 `.tar.gz` |
| [GPUI](./gpui.md) | GPUI；GPUI 的文字系统 | macOS、Windows、Linux（Vulkan） | 在你的 GPUI 应用里；TSX 也可用 `nsh run --target gpui` | 随嵌入它的 GPUI 应用发布 |
| [终端](./tui.md) | Ratatui；终端字素 | macOS、Windows、Linux | `nsh run --target tui` | 控制台程序与资源，以及本机系统格式的归档 |
| [Web](./web.md) | HTML 与 CSS；浏览器的字体 | 现代浏览器，桌面和手机 | `nsh run --target web` | 一个静态网站 |

- **[GPUI](./gpui.md)** 用姊妹项目 GPUI Kit 所基于的 [GPUI](https://gpui-kit.com) 绘制应用，在 macOS、Windows 和 Linux 上表现一致：它是嵌入 GPUI 和 GPUI Kit 应用的后端，这些应用把 `AppView` 放进自己的元素树。独立的桌面应用用各操作系统自己的后端（AppKit、Win32、GTK 4）运行和打包。
- **[终端](./tui.md)** 在 macOS、Windows 和 Linux 上绘制 Ratatui 区域，复用 NSH 布局与组件，提供键盘焦点、Unicode 编辑、鼠标输入和半块图形。终端宿主应用可嵌入多个独立的 `AppView` 区域。
- **[Web](./web.md)** 把应用渲染成浏览器页面里的 HTML：`nsh package --target web` 发布一个静态网站，可部署到任意 Web 服务器或 CDN，Rust 应用的引擎和 crate 编译为 WebAssembly；你自己的网页可以用 `createPlayer` 或 iframe 嵌入应用。本站的在线示例和 [Playground](/playground) 也由它运行。
- **Mac Catalyst** 在 Mac 上用 iPhone 尺寸的窗口（390×844）运行 iOS 后端，用于开发。用 `--target catalyst` 选择它，快速查看应用在手机上的样子。

## 开发与打包

不传 `--target` 时，`nsh run` 选择本机的平台：macOS 上是 AppKit，Linux 上是 GTK 窗口，Windows 上是 Win32 窗口。手机要从电脑上连接：iOS 需要装有 Xcode 的 Mac，Android 可以在装有 Android SDK 的 macOS、Linux 或 Windows 上开发（[安装](./installation.md#各平台可用的命令)）。

Rust 应用（`nsh.json` 写明 `"root"` 根组件）在自己的目录里运行和打包：`nsh` 为目标构建应用自己的 runner，包含你的 crate，不带 QuickJS。TSX 应用则写明入口：

```sh
# Rust 应用，在它的目录里
nsh run --target macos             # 或 ios、android、windows、linux、tui、web、catalyst
nsh package --target macos         # 或 ios、ios-simulator、android、windows、linux、tui、web

# TSX 应用
nsh run App.tsx --target macos     # 或 ios、android、windows、linux、gpui、tui、web、catalyst
nsh package App.tsx --target macos
```

每个桌面操作系统用自己的后端打包应用，后端只为运行它的机器构建：Mac 应用在 Mac 上打包，Windows 应用在 Windows 上打包，Linux 应用在 Linux 上打包。各目标的输出、签名和图标见[打包](./packaging.md)。

## 嵌入原生应用

| 平台 | 宿主视图 | 运行 | 发布形式 | 宿主语言 |
|---|---|---|---|---|
| macOS | `AppView`（一个 `NSView`） | Rust 根组件、TSX bundle | `nsh-platform-macos` crate | Rust |
| Windows | `AppView`（一个子窗口） | Rust 根组件、TSX bundle | `nsh-platform-windows` crate | Rust |
| Linux | `AppView`（一个 GTK 控件） | Rust 根组件、TSX bundle | `nsh-platform-linux` crate | Rust |
| GPUI（macOS、Windows、Linux） | `AppView`（一个 GPUI 视图） | Rust 根组件、TSX bundle、签名包 | `nsh-platform-gpui` crate | Rust |
| iOS | `AppView`（一个 `UIView`） | Rust 根组件、TSX bundle | `nsh-platform-ios` crate | Rust |
| iOS | `NshAppView`（一个 `UIView`） | TSX bundle、签名包 | `NativeShell.xcframework` | Swift |
| Android | `NshView`（一个 `FrameLayout`） | TSX bundle、签名包 | `nsh.aar` | Java 或 Kotlin |
| 终端（macOS、Windows、Linux） | `AppView`（一个 Ratatui 区域） | Rust 根组件、TSX bundle | `nsh-platform-tui` crate | Rust |
| Web | `createPlayer`（一个页面元素）或 iframe | TSX bundle；Rust 应用以发布的网站嵌入 | `nsh package --target web` 生成的运行时文件 | JavaScript 或 HTML |

Rust 宿主以 `AppSource::Rust` 或 `App::Rust` 挂载 Rust 根组件（`Root::of::<App>()`），并用 `set_ui_sets` 把应用的 UI 集合交给它的引擎，这样它加载的 TSX 就能导入应用自己的组件和模块。每个视图都是一个引擎，一个应用可以同时显示多个。在每个平台上，宿主都可以注册自己的原生视图给应用使用（[原生组件](./native-components.md)）。

> [!NOTE]
> Rust 宿主通过 NSH 仓库里的平台 crate 嵌入 NSH；macOS、Windows 和 Linux 的 `AppView` 从应用自己的文件（或源代码）加载 bundle，使用默认限制。GPUI crate 以及 iOS 和 Android SDK 还能加载[签名包](./signed-packages.md)，并为每个视图设置限制和能力（[沙箱与能力](./sandbox-and-capabilities.md)）。

## 为每个平台编写

应用的大部分代码不需要判断平台：元素、样式、布局和模块在各处行为一致。平台确实不同的地方，NSH 给它一个固定的位置（[平台特定代码](./platform-specific.md)）：

- **环境说明应用运行在哪里**：Rust 里是 `os()`、`idiom()` 和 `is_desktop()`（`nsh_core::prelude`），TSX 里是 `nsh` 的 `platform.os`、`platform.idiom` 和 `platform.select`。操作系统是 iOS、Android、macOS、Windows、Linux 或 Web。
- **平台专属属性**在 TSX 里放在 `ios={{…}}`、`android={{…}}`、`web={{…}}` 或 `desktop={{…}}` 里（`desktop`：macOS、Windows、Linux 和桌面浏览器）。
- **渲染器**由 `platform.renderer` 标识（`"native"`、`"web"` 或 `"terminal"`）；终端保持实际的 `platform.os`。选择终端呈现时使用 `platform.isTerminal`。
- **输入跟随平台。** 手机上是触摸和软键盘；桌面上是鼠标、触控板和键盘。

应用的组件用 NSH 的基础元素绘制，所以在桌面上和在手机上一样运行，样子也相同。桌面布局用基础元素（`view`、`text`、`scroll`、`virtual_list` 等；TSX 里是 `View`、`Text`、`Scroll`、`List` 等）加上对桌面的判断搭建，示例应用 gallery 的桌面布局就是这样做的：

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn Shell() -> impl IntoElement {
    // macOS、Windows、Linux 和桌面浏览器用侧边栏；手机用标签页。
    view()
        .flex_1()
        .child(if is_desktop() { sidebar_layout() } else { tab_layout() })
}

fn sidebar_layout() -> AnyElement {
    view().flex_1().flex_row().into_element()
}

fn tab_layout() -> AnyElement {
    view().flex_1().flex_col().into_element()
}
```

```tsx tabs
import { View } from "nsh";
import { platform } from "nsh";

export function Shell() {
  // macOS、Windows、Linux 和桌面浏览器用侧边栏；手机用标签页。
  return <View class="flex-1">{platform.idiom === "desktop" ? <SidebarLayout /> : <TabLayout />}</View>;
}

function SidebarLayout() {
  return <View class="flex-1 flex-row" />;
}

function TabLayout() {
  return <View class="flex-1 flex-col" />;
}
```

每个后端都列出了它以自己的方式处理的内容：[macOS](./macos.md#macos-上的差异)、[Windows](./windows.md#windows-上的差异)、[Linux](./linux.md#linux-上的差异)、[GPUI](./gpui.md#差异)。

## 另请参阅

- [快速开始](./getting-started.md)：第一个应用，在每个平台上运行。
- [用 Rust 开发](./rust.md)：完全用 Rust 编写的应用，以及 Rust 加 TSX。
- [安装](./installation.md)：每个平台需要的工具。
- [架构](./architecture.md)：哪些部分共享，每个后端做什么。
