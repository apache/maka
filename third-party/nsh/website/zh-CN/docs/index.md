---
title: 简介
description: Native Shell 是什么：Rust First 的全平台 Native UI 框架，覆盖 iOS、Android、macOS、Windows、Linux 和 Web，每个平台使用系统自己的界面与交互。
order: 1
group: start
---

# 简介

Native Shell（简称 NSH）是一个全平台的 Native UI 框架。你用一套应用模型——组件、signal、样式，以及处处相同的 API——构建一次应用，NSH 就在 **iOS、Android、macOS、Windows、Linux 和 Web** 上运行它，而且每次都是那个平台的应用：由平台自己的视图组成，用平台自己的文本系统编辑，按平台用户的习惯操作。整个应用可以用 **Rust** 编写，也可以用 **TSX** 编写界面，或者两者结合在同一个引擎上。在同一个引擎之上，已经发布的应用还能在运行时接收新界面——由团队编写，或由模型生成——以签名模块的形式，运行在宿主配置的沙箱里。

> [!IMPORTANT]
> NSH 提供原生视图与交互，应用掌握视觉设计。组件、状态和 API 跨平台共享，颜色、字体、间距和形状由应用决定；文本输入、焦点和菜单遵循设备的交互习惯。详见[目标与设计原则](./goals.md)。

## Native 的含义

NSH 所说的 Native 有两层：平台的基础设施，以及平台的交互方式。

**平台的基础设施。** 每个平台都有自己的后端，建立在这个平台已有的界面技术之上：

| 平台 | 视图 | 文本 | 文本输入 |
|---|---|---|---|
| iOS | UIKit | CoreText | 系统的文本框与文本视图 |
| Android | Android 视图 | `StaticLayout` | `EditText` |
| macOS | AppKit、Core Animation | CoreText | `NSTextField`、`NSTextView` |
| Windows | 用 Direct2D 绘制的 Win32 窗口 | DirectWrite | NSH 的编辑器，配合系统输入法（IMM32） |
| Linux | GTK 4 | Pango | GTK 的 `Text` 与 `TextView` |
| Web | 用 CSS 设置样式的 HTML 元素 | 浏览器的字体 | 浏览器的输入框 |

文本选择及其菜单、输入法、无障碍和滚动都来自平台，系统在新版本里对它们的改进，应用直接获得。Native 组件——地图、网页视图、视频播放器，以及宿主注册的任何视图——只是同一层级里的又一个视图，与其他内容一起布局、裁剪和滚动（[原生组件](./native-components.md)）。

**平台的交互方式。** NSH 在 [`nsh/base`](../modules/nsh-base.md) 中提供的组件按每种设备的用户习惯工作，应用只写一次：

| | 桌面（以及桌面浏览器） | 手机和平板 |
|---|---|---|
| `Menu` | 在触发点弹出；子菜单在菜单项旁展开 | 从底部升起的面板；子菜单替换当前菜单项 |
| `ContextMenu` | 右键在指针处打开 | 手指长按触发元素，以面板形式打开 |
| `Tooltip` | 指针停留在触发元素上时显示 | 由应用打开时显示 |
| `Popover` | 点击外部关闭它，并把点击交给指针下的内容 | 点击外部关闭它 |

页面、对话框、键盘和状态栏遵循同样的思路：导航栈按每个平台的动效推入和弹出，返回键、Escape 和侧滑返回的行为与平台一致（[导航](./navigation.md)）。

## 从手机到桌面，再到 Web

NSH 的跨平台，是让每种设备都得到它该有的应用，而不是把同一个界面放大或缩小：

- **一套应用模型。** 应用的组件、状态、业务逻辑和页面是共享的；每个后端把它们映射到自己的平台。
- **布局随窗口重组。** 每个平台上的 Flexbox 和 CSS Grid 都由 [Taffy](https://github.com/DioxusLabs/taffy) 排版，Tailwind 断点（`md:`、`lg:`）和窗口尺寸（Rust 中的 `window()`）改变的是结构，而不只是大小：聊天应用在宽窗口里并排显示侧栏、会话列表和消息，在手机上一次显示一屏（[布局](./layout.md)、[Tailwind](./tailwind.md)）。
- **每种设备的输入方式。** 桌面上是指针、悬停、右键、快捷键和焦点；手机上是触摸、手势、软键盘和页面导航。应用需要按平台做不同处理时，用 `desktop={{…}}` 属性和 `platform.select` 表达（[平台相关代码](./platform-specific.md)）。
- **在每个目标上验证。** `nsh test` 无界面地运行应用的测试，也能在 macOS、Windows、Linux 和 GPUI 窗口、iOS 模拟器、Android 设备或浏览器里，用平台自己的输入运行同样的测试（[测试与 trace](./testing-and-trace.md)）。

以一个聊天客户端为例。开发者用 `nsh run` 在桌面上开发它，用 `nsh run --target ios` 在 iOS 模拟器里检查手机布局，再用 `nsh run --target web` 在浏览器里运行——每次都是同一个工程——最后用 `nsh package` 打出可安装的应用和网站。过去需要每个平台一个团队的工作，一个工程师就能承担，后端开发可以同步进行。

## Rust First

NSH 用 Rust 构建，Rust 也是用它编写应用的一等语言：

- **完整的 Rust 应用。** 界面、逻辑和组件都是 Rust，在每个平台上编译成 Native 代码，带着 Rust 的所有权、类型、线程和 crates.io 生态。计算以 Native 速度运行，大规模数据、解析和系统相关的工作留在最适合它们的语言里（[用 Rust 开发](./rust.md)）。
- **TSX 是第二条路径。** TSX 适合快速编写的界面、插件、小型应用和运行时下发的界面。它和 Rust 运行在同一个引擎上，使用同样的基础元素、基础组件和 signal。
- **两者结合。** Rust 应用可以承载 TSX 页面，TSX 页面也能导入应用的 Rust 组件、模块和类。
- **一个工具链。** 一个 `nsh` 可执行文件负责创建、构建、类型检查、热更新开发、测试、打包和签名，覆盖每个目标平台。它自带 TSX 打包器和 TypeScript 检查器，因此来自 Rust、Swift、Kotlin 或 C++ 的开发者装好 Rust 和 `nsh` 就能开始工作（[安装](./installation.md)、[命令行](./cli.md)）。

## 一个应用

同一个计数器，分别用 Rust 和 TSX 编写：

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn Counter() -> impl IntoElement {
    let count = signal(0);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_3()
        .child(text(move || count.get().to_string()).text_5xl().font_weight(FontWeight::BOLD))
        .child(
            view()
                .rounded_lg()
                .bg(rgb(0x2563eb))
                .px_5()
                .py_3()
                .active(|s| s.opacity(0.6))
                .on_press(move || count.update(|n| *n += 1))
                .child(text("Tap").text_lg().text_color(white())),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function Counter() {
  const count = signal(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 48, fontWeight: "700" }}>{count()}</Text>
      <View
        onPress={() => count.update((n) => n + 1)}
        activeStyle={{ opacity: 0.6 }}
        class="rounded-lg bg-blue-600 px-5 py-3"
      >
        <Text class="text-white text-lg">Tap</Text>
      </View>
    </View>
  );
}

mount(Counter);
```

一个视图（`view()`、`<View>`）在 iOS 上成为 `UIView`，在 Android 上成为 `ViewGroup`，在 macOS 上成为 `NSView`，在 Linux 上成为 GTK 控件，在 Windows 上成为用 Direct2D 绘制的保留视图，在 Web 上成为 HTML 元素；文本成为 Native 文本视图，按钮的按压反馈（`.active(..)`、`activeStyle`）在主线程上运行。点击时，`count.update` 改变一个 signal，只有读取它的那段文本会更新：组件函数不会再次运行。Rust 应用从头到尾都是 Native 代码；在 TSX 应用里，只有模块自己的代码是 JavaScript。

## Retained Mode

NSH 是 Retained Mode 的：每个元素都是平台保留着的视图，一次更新只改变发生变化的部分。

- **细粒度更新。** [Signal](./reactivity.md) 与 Solid 的相同，由 Native 实现：组件只运行一次，一次变化只重新运行读到那个 signal 的表达式。
- **只有变化跨越线程。** 一轮里的变化一起排版，每帧作为一批视图操作交给主线程；没有变化的样式和位置不会发送，没被改到的视图原样不动。
- **动画在 Native 侧运行。** 时间曲线、弹簧和衰减动画、手势以及与滚动联动的值，都在平台的帧时钟上计算，不经过 JS 逐帧调用（[动画](./animation.md)）。

这适合大多数应用由之组成的界面——聊天、邮件、表单、列表、文档、设置、逐步生成的 AI 回复——每次只有少数视图变化，其余都在等待。这类界面在两次更新之间几乎不占 CPU，在 ProMotion 屏幕上滚动和动画稳定在 120 FPS。在 [NSH 性能基准](https://github.com/longbridge/nsh-perf-bench)中，一个每秒更新 1,000 次的 500 行行情表，在 Linux 上用 NSH Rust 编写占用 18% 的单核 CPU，直接用 [GPUI Fast](https://github.com/longbridge/gpui-fast) 编写同样的界面为 20%。繁重的计算应当放在 Rust 里：TSX 运行在解释器 QuickJS 上，而 Rust 模块即使由 TSX 调用，也以 Native 速度运行——这样对 10 万行排序约需 3 ms，与纯 Rust 相当（[性能](./performance.md)）。

## 如何运行

工具链是一个 `nsh` 可执行文件。应用可以用 Rust、TSX 或两者编写，各自经过一条路径，到达同一个 Rust 引擎。

### Rust 应用

Rust 应用是一个 crate，完全用 Rust 与 Native 开发，无 JavaScript runtime：

1. **构建。** `nsh` 为每个目标——iOS、Android、macOS、Windows、Linux 或 Web 应用——构建链接了你的 crate 的运行器。组件、状态、事件处理和引擎一起编译成 Native 代码。
2. **运行。** 应用的根组件以 Rust 形式运行在引擎线程上。运行器里没有 JavaScript 引擎：在任何平台上，Rust 应用都不包含 QuickJS。

### TSX 应用

TSX 应用（一个模块）是一组带入口的 `.tsx` / `.ts` 文件，入口通常是 `App.tsx`：

1. **构建。** `nsh` 打包模块的文件（使用 rolldown 和 Oxc），并用自己的编译器编译 JSX。对 `nsh` 和 `nsh/*` 的导入保持为导入：运行时以 Native 方式提供它们，所以 bundle 里只有你的代码。bundle 会被编译成 QuickJS 字节码。
2. **运行。** 引擎线程在 [QuickJS](https://github.com/quickjs-ng/quickjs) 中运行字节码，每个视图一个虚拟机。编译后的 JSX 直接调用 Native 渲染器，JavaScript 只描述界面和处理事件；解析样式、解析 Tailwind 类、比对差异、布局和文本都在 Rust 中完成。

### 两者的区别

| | Rust 应用 | TSX 应用 |
|---|---|---|
| 编写语言 | Rust | TSX（TypeScript 与 JSX） |
| 构建产物 | Native 代码，链接进每个目标的运行器 | QuickJS 字节码，由运行时加载 |
| JavaScript 引擎 | 无 | QuickJS，每个视图一个虚拟机 |
| 开发时（`nsh run`） | 每次保存后重新构建并重启 | 每次保存后热更新 |
| 发布之后 | 随应用一起发布 | 也可在运行时以签名包下发，运行在沙箱里 |
| 适合 | 完整应用、繁重计算、系统相关的工作 | 快速编写的界面、插件、AI 生成的界面 |

两者可以结合：Rust 应用可以承载 TSX 页面，TSX 页面也能导入它的 Rust 组件、模块和类；这样的应用会为运行这些页面链接 QuickJS（[用 Rust 开发](./rust.md)）。

### 共用的引擎

从引擎开始，两条路径完全相同。每一轮的变化被收集起来，由 Taffy（Flexbox 和 CSS Grid）排版，每帧作为一批视图操作交给主线程，主线程把它应用到 Native 视图上。文本在引擎线程上只测量和排版一次（Apple 平台用 CoreText，Android 用 `StaticLayout`，Windows 用 DirectWrite，Linux 用 Pango，Web 用浏览器的字体度量），主线程只负责绘制。

在 Web 上，同一个引擎运行在页面里：浏览器显示用 CSS 设置样式的 HTML 元素，负责滚动、选择文本和处理输入；`nsh package --target web` 把应用发布成一个按内容命名文件的静态网站，可以直接放进任何 CDN（[Web](./web.md)）。

> [!NOTE]
> 主线程从不等待应用的代码。系统同步提出的问题（这个输入框能否再接受一个字符、用户能否侧滑返回、这个面板能否关闭）都由事先设置的属性在 Native 侧回答，比如 `maxLength`、`popOnBack` 或 `closeOnSwipe`。事件随后才到达应用的处理函数。

## 动态界面与 AI 生成的界面

NSH 最初是为了让 Native 应用在发布之后接收新界面，这仍然是它的主要用途之一。应用在需要显示模块的地方嵌入 `NshAppView`（iOS）、`NshView`（Android）、`AppView`（macOS、Windows、Linux 以及 GPUI 应用）或 `createPlayer`（网页），NSH 就在其中运行 TSX 模块：

- **发布之后下发。** 模块是应用在运行时下载的签名包（`.nshpkg`）。应用在运行它之前，会用自己信任的密钥和吊销列表校验签名（[签名包](./signed-packages.md)）。宿主应用集成运行时，业务团队基于它的 API 开发模块，并按自己的节奏下发。
- **宿主始终掌控。** 每个模块运行在自己的 QuickJS 虚拟机里，内存、调用时长和节点数都有上限，只能使用宿主授予的能力：网络主机、网页、状态栏（[沙箱与能力](./sandbox-and-capabilities.md)）。多个模块可以并排运行。
- **和应用的其他部分一样。** 模块用平台自己的界面渲染，宿主还能注册自己的 Native 视图——地图、播放器、设计系统组件——供模块使用（[原生组件](./native-components.md)）。

同一套机制让应用可以**用界面来回答**。模型写出一个小的 TSX 模块（一个表单、一张图表、一张预订卡片），你的服务器检查、构建并签名，应用以 Native 方式显示它：

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/ai-flow-light.svg" alt="从提示词到 Native 界面：模型写出 TSX 模块；你的服务器构建、检查并签名；越过信任边界后，应用校验包，在它设定的限制和能力下于沙箱中运行，并用平台自己的界面显示。">
<img class="diagram diagram-dark" src="/diagrams/ai-flow-dark.svg" alt="从提示词到 Native 界面：模型写出 TSX 模块；你的服务器构建、检查并签名；越过信任边界后，应用校验包，在它设定的限制和能力下于沙箱中运行，并用平台自己的界面显示。">
</div>

在 iOS 上，宿主只需要几行代码：

```swift
let app = NshAppView()                         // 一个 UIView：放在任意位置
try app.grantCapabilities(#"{ "network": { "hosts": ["api.example.com"] } }"#)
let info = try await app.loadPackage(at: downloadedFile, trust: trust)   // 校验通过后运行
```

## AI-Friendly

NSH 为用 AI 编写的软件而设计，完整的应用和生成的界面都是如此：

- **每个平台一套应用模型。** 模型只需学会一种编写界面的方式，结果就能运行在手机、桌面和 Web 上；NSH 按平台适配交互，不需要把同一个界面生成六遍。
- **按任务选择 Rust 或 TSX。** 完整应用和性能关键的模块用 Rust，界面、插件和按请求生成的界面用 TSX——运行在同一个引擎上。
- **精确、自动生成的契约。** 每个元素、属性、样式键和模块都有从 Rust 源码生成的 TypeScript 声明（`.nsh/types`），Rust API 本身是类型化的，因此生成的代码都由编译器检查。这些文档也以纯文本形式提供给模型（[`llms.txt`](/llms.txt)、[`llms-full.txt`](/llms-full.txt)）。
- **一个命令行覆盖整个循环。** Agent 通过 `nsh` 创建应用、构建、在目标平台上运行、执行测试、读取结果、修复并打包。`nsh test` 无需设备、无界面地运行，并报告错误和生成的视图；编译器还能在进程内（`nsh_bundler::compile_module`）和浏览器里运行（[Playground](/playground)）。
- **不可信也能安全运行。** 运行时下发的生成代码是不可信代码：它带着签名到达，运行在有限制的虚拟机里，只能使用宿主授予的能力。

## 运行平台

| 平台 | 系统要求 | 后端 | 嵌入方式 |
|---|---|---|---|
| [iOS](./ios.md) | iOS 15.0+ | UIKit | `NativeShell.xcframework` |
| [Android](./android.md) | Android 9+ | Android 视图 | `nsh.aar` |
| [macOS](./macos.md) | macOS 14+ | AppKit | `AppView` |
| [Windows](./windows.md) | Windows 10 1809+ | Win32、Direct2D | `AppView` |
| [Linux](./linux.md) | GTK 4.14+ | GTK 4 | `AppView` |
| [Web](./web.md) | 现代浏览器 | HTML | `createPlayer`、iframe |
| [GPUI](./gpui.md) | 桌面平台 | GPUI | `AppView`（GPUI、GPUI Kit 应用） |
| Mac Catalyst | macOS | UIKit | 开发用（`--target catalyst`） |

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/platforms-light.svg" alt="一个模块，多个宿主：同一个 bundle 和 Rust 运行时运行在 iOS、Android、Linux、使用 AppKit 的 macOS 和使用 Win32 / Direct2D 的 Windows 上，GPUI 覆盖三个桌面平台，网页则用 HTML 绘制。">
<img class="diagram diagram-dark" src="/diagrams/platforms-dark.svg" alt="一个模块，多个宿主：同一个 bundle 和 Rust 运行时运行在 iOS、Android、Linux、使用 AppKit 的 macOS 和使用 Win32 / Direct2D 的 Windows 上，GPUI 覆盖三个桌面平台，网页则用 HTML 绘制。">
</div>

## Native Shell 与 GPUI Shell

[长桥（Longbridge）](https://longbridge.com)为自己的客户端构建 NSH。最初的需求是移动客户端的插件层，起点是 [GPUI Shell](https://gpui-kit.com/shell)——它让 [GPUI](https://gpui-kit.com) 桌面应用可以用 JavaScript 扩展。在手机上，由 GPUI 自己绘制的界面将不得不重建平台已有的能力——文本选择及其菜单（拷贝、分享、翻译、查询）、输入法、无障碍、每个 iOS 版本带来的新视觉材质——每个移动团队也都要接手一套新的界面技术栈。因此 NSH 用每个平台自己的界面来渲染，并从那个插件层成长为一个覆盖所有平台、可以编写完整应用的框架。

两者的定位不同。GPUI Shell 用于扩展 GPUI 桌面应用；Native Shell 是面向手机、桌面和 Web Native 应用的框架，它的 GPUI 后端可以把 NSH 应用嵌入 GPUI 和 GPUI Kit 应用（[GPUI](./gpui.md)）。

## 与其他方案的比较

就完整应用而言，NSH 与 React Native、Flutter、Qt、GPUI、Slint、Electron 和 Tauri 等跨平台框架并列；就发布之后下发的界面而言，它与网页视图、服务端驱动 UI 和小程序容器并列。它的选择是：在一套应用模型下使用每个平台自己的界面和交互，以 Rust 作为应用语言，TSX 与之并行。[方案比较](./comparison.md)逐一做了对比。

## 下一步

- [安装](./installation.md)与[快速上手](./getting-started.md)：获取 `nsh`，用 Rust 或 TSX 编写第一个应用，并在各个平台上运行。
- [用 Rust 开发](./rust.md)：用 Rust 编写的应用，以及在其上使用 TSX。
- [平台](./platforms.md)：哪些平台能运行什么，以及如何在每个平台上运行、打包和嵌入。
- [JSX 与组件](./jsx-and-components.md)和[响应式](./reactivity.md)：其他一切都建立在这两个概念之上，Rust 和 TSX 都是如此。
- [签名包](./signed-packages.md)与[沙箱与能力](./sandbox-and-capabilities.md)：下发模块，并决定它们能做什么。
