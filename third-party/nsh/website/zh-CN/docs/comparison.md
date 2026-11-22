---
title: 方案对比
description: Native Shell 与 React Native、Flutter、Qt、GPUI、Slint 的比较，与 Electron、Tauri 的比较，以及与 WebView、服务端驱动 UI 等发布后下发界面方案的比较。
order: 2
group: start
---

# 方案对比

NSH 是一个在 iOS、Android、macOS、Windows、Linux 和 Web 上编写完整应用的框架，也是向已发布应用下发界面的运行时。本页先把它与人们编写应用所用的跨平台框架比较，再与应用承载安装包之外的界面的几种做法比较。绿色表示具备该能力，黄色表示需要应用自己做更多工作或依赖独立项目，红色表示不提供；这些标记描述的是能力是否具备，而不是性能。版本号是各框架在撰写时文档写明的最低要求，请以你使用的版本为准。

图例：<span class="status status--yes" role="img" aria-label="支持"></span> 支持 · <span class="status status--partial" role="img" aria-label="部分支持"></span> 部分支持 · <span class="status status--no" role="img" aria-label="不支持"></span> 不支持。

## 跨平台框架

| 能力 | NSH | React Native | Flutter | Qt 6 | GPUI | GPUI Fast | Slint |
|---|---|---|---|---|---|---|---|
| 由什么绘制 | 平台界面 | 平台视图 | 自绘引擎 | 自绘场景图 | GPU 自绘 | GPU 自绘 | 自绘 |
| UI 模型 | Retained | Retained | Retained | Retained | Immediate | Immediate + Retained | 响应式，Retained |
| 语言 | Rust、TSX | JS、TS | Dart | C++、QML | Rust | Rust | Slint + Rust、C++ |
| iOS | <span class="status status--yes" role="img" aria-label="支持"></span> 15+ | <span class="status status--yes" role="img" aria-label="支持"></span> 15.1+ | <span class="status status--yes" role="img" aria-label="支持"></span> 15+ | <span class="status status--yes" role="img" aria-label="支持"></span> 17+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> Rust |
| Android | <span class="status status--yes" role="img" aria-label="支持"></span> 9+ | <span class="status status--yes" role="img" aria-label="支持"></span> 7+ | <span class="status status--yes" role="img" aria-label="支持"></span> 7+ | <span class="status status--yes" role="img" aria-label="支持"></span> 9+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| macOS | <span class="status status--yes" role="img" aria-label="支持"></span> 14+ | <span class="status status--partial" role="img" aria-label="部分支持"></span> 独立项目 | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--yes" role="img" aria-label="支持"></span> 13+ | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--yes" role="img" aria-label="支持"></span> 13+ |
| Windows | <span class="status status--yes" role="img" aria-label="支持"></span> 10 1809+ | <span class="status status--partial" role="img" aria-label="部分支持"></span> 独立项目 | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ |
| Linux | <span class="status status--yes" role="img" aria-label="支持"></span> GTK 4.14+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Debian 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> Debian 11+ | <span class="status status--yes" role="img" aria-label="支持"></span> Vulkan | <span class="status status--yes" role="img" aria-label="支持"></span> Vulkan | <span class="status status--yes" role="img" aria-label="支持"></span> |
| Web | <span class="status status--yes" role="img" aria-label="支持"></span> HTML | <span class="status status--partial" role="img" aria-label="部分支持"></span> 社区方案 | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas |
| 系统文本输入 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 按设备适配 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 无 JS runtime | <span class="status status--yes" role="img" aria-label="支持"></span> Rust 应用 | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> C++ | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| 签名下发界面 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> OTA | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> QML | <span class="status status--partial" role="img" aria-label="部分支持"></span> Shell | <span class="status status--partial" role="img" aria-label="部分支持"></span> Shell | <span class="status status--no" role="img" aria-label="不支持"></span> |
| 许可证 | Apache-2.0 | MIT | BSD-3-Clause | LGPL、GPL、商业 | Apache-2.0 | Apache-2.0 | GPL、商业 |

Immediate Mode 每一帧重新构建界面描述；Retained Mode 保留它，只更新变化的部分。GPUI Fast 在 GPUI 之上把两者结合起来，平台支持与 GPUI 相同。“Shell”指 [GPUI Shell](https://gpui-kit.com/shell)。

在这些框架中，NSH 是唯一把以下几点同时做到的：每个平台自己的界面与文本输入；一套应用覆盖手机、桌面和 Web，而且 Web 输出是 HTML；Rust 应用不带 JavaScript runtime；发布之后还能下发经过签名、运行在沙箱中的界面。

### 各行的含义

- **由什么绘制、UI 模型。** NSH 挂载每个平台自己的视图并保留它们（Retained Mode）：一次变化只更新它改到的视图。React Native 在 iOS 和 Android 上同样挂载平台视图。Flutter、Qt Quick、GPUI 和 Slint 用自己的渲染器绘制；GPUI 每一帧重新构建元素树（Immediate Mode），[GPUI Fast](https://github.com/longbridge/gpui-fast) 复用没有变化的部分。
- **平台。** NSH 的最低版本见[平台](./platforms.md)。其他框架的数据来自 [React Native 0.76](https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture)（iOS 15.1，Android 7 / API 24；macOS 和 Windows 由独立的 react-native-macos、react-native-windows 项目支持，Web 由社区的 react-native-web 支持）、[Flutter 3.47](https://docs.flutter.dev/reference/supported-platforms)、[Qt 6.10](https://doc.qt.io/qt-6.10/supported-platforms.html)、GPUI 参照 [Zed 的系统要求](https://zed.dev/docs/installation)，以及 [Slint 的平台指南](https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/general/)（iOS 仅支持 Rust）。“Canvas”表示框架在页面的画布上自己绘制；NSH 的 Web 应用是用 CSS 设置样式的 HTML 元素，由浏览器滚动、选择和编辑（[Web](./web.md)）。
- **系统文本输入。** NSH 的文本框就是平台的编辑器——`UITextView`、`EditText`、`NSTextView`、GTK 的 `TextView`、浏览器的输入框——带着系统的输入法、选区手柄和编辑菜单；Windows 上是 NSH 自己的编辑器，配合 DirectWrite 和系统输入法（IMM32）。React Native 也使用平台的文本输入框。自绘框架自己实现文本编辑，再接入系统输入法。
- **按设备适配。** NSH 的基础组件随设备而变：同一个 `Menu` 在有指针的设备上贴着触发点弹出，在手机上从底部升起；`ContextMenu` 用右键或长按打开。在其他框架中，按设备适配交互主要是应用自己的工作。
- **无 JS runtime。** Rust 应用的运行器在任何平台上都不链接 JavaScript 引擎；TSX 是第二条路径，运行在同一个引擎上。Qt Quick 的 QML 运行在 Qt 的 JavaScript 引擎上，用 C++ 编写的 Qt Widgets 则不需要。
- **签名下发界面。** NSH 用自己信任的密钥和吊销列表校验签名的 `.nshpkg` 包，并让每个包运行在宿主设定限制和能力的虚拟机里（[签名包](./signed-packages.md)、[沙箱与能力](./sandbox-and-capabilities.md)）。打包的 NSH 应用也以同样的方式 OTA 更新自己的 TSX（包括 iOS 和 Android），启动失败的版本会自动回滚（[OTA 更新](./ota-updates.md)）。React Native 的 OTA 更新下发的是可信的应用代码；Qt 可以加载 QML 文件；GPUI 应用通过 [GPUI Shell](https://gpui-kit.com/shell) 加载 JavaScript 模块。

### NSH 的不同之处

- **两层意义上的 Native，在每个平台上。** 每个后端都建立在平台自己的视图、文本和输入法之上——UIKit、Android 视图、AppKit、用 Direct2D 绘制的 Win32、GTK 4、HTML——平台的交互方式也随之而来。文本选择、输入法和无障碍都是系统的，系统新版本对它们的改进，应用直接获得（[简介](./index.md#native-的含义)）。
- **一套应用覆盖手机、桌面和 Web。** 六个平台都是同一个框架的后端，布局随窗口重组，输入方式随设备变化；在 Web 上，应用是 HTML，发布为静态网站。
- **Rust First，不带 JavaScript runtime。** 整个应用可以从头到尾都是 Rust，编译成 Native 代码，带着 Rust 的类型、线程和 crates。TSX 是第二条路径，运行在同一个引擎上，适合快速编写的界面（[用 Rust 开发](./rust.md)）。
- **面向日常应用的 Retained Mode。** 一次变化只发送它改到的视图，因此聊天、表单、列表和文档在静止时几乎不占 CPU（[简介](./index.md#retained-mode)）。
- **发布之后下发界面，经过签名、运行在沙箱里。** 用 NSH 构建的应用——以及用各平台自己的工具编写的原生应用——都能在运行时接收 TSX 模块，由团队编写或 AI 生成（[动态界面](./index.md#动态界面与-ai-生成的界面)）。
- **一个工具链，人和 AI agent 都能用。** 一个 `nsh` 可执行文件负责创建、运行、在真实平台上测试、打包和签名，覆盖每个目标平台。

### React Native

React Native 在目标上与 NSH 最接近：两者都希望减少重复的客户端开发，并使用平台的视图。React Native 的中心是 JavaScript 或 TypeScript、React 及其包生态，面向 iOS 和 Android，桌面由独立项目支持。NSH 的中心是 Rust：它的运行时、渲染器和模块都是 Rust，Rust 本身就是应用语言，TSX 是两条路径之一；它的六个平台，包括桌面和 Web，都是同一个框架的后端。

### Flutter

Flutter 用自己的引擎绘制每个像素，因此应用在每个平台上看起来都一样。NSH 走的是另一条路：使用每个平台的视图、文本和文本输入，在 Web 上使用 HTML 元素以及浏览器自己的滚动、选择和输入。文本编辑、输入法和选区都是平台的，而不是在每个平台上重新实现。

### Qt

Qt 是成熟的工具包，有 Qt Widgets 和 Qt Quick 两种界面技术，以及长期积累的工具和平台支持。NSH 的不同在于基础和模型：以 Rust 为核心语言并提供 TSX 路径，工具链为自动化（以及 AI 驱动的）开发而设计，Web 渲染为 HTML，并在一套组件模型里适配移动、桌面和 Web 的交互。

### GPUI 与 GPUI Fast

[GPUI](https://gpui-kit.com) 是用 GPU 绘制的 Rust UI 框架，面向要求很高的桌面应用；[GPUI Fast](https://github.com/longbridge/gpui-fast) 是长桥维护的分支，带来 Retained 渲染——复用没有变化的视图、布局和文本测量——以及滚动图层和原生窗口合成。NSH 则建立在每个平台的视图之上，因此文本输入、选区、输入法和系统交互都是平台自己的，并且同样覆盖手机和 Web；NSH 的 GPUI 后端可以把 NSH 应用嵌入 GPUI 和 GPUI Kit 应用（[GPUI](./gpui.md)）。

两者适合不同的负载。在 [NSH 性能基准](https://github.com/longbridge/nsh-perf-bench)中（Linux，500 行行情表，NSH 运行在 GTK 4 后端上），日常负载的开销相同：每秒 1,000 条行情时，NSH Rust 占用 18% 的单核 CPU，GPUI Fast 为 20%。在持续、密集的更新下 GPUI Fast 领先：每秒 20,000 条行情时它占用 25%，NSH 为 73–78%；1,000 个方块逐帧计算的动画，它的 CPU 约为 NSH 的三分之一。

### Slint

Slint 是声明式 UI 工具包，有自己的语言和轻量的渲染器，面向桌面和嵌入式设备，可以从 Rust、C++、JavaScript 或 Python 使用。两者都重视 Native 性能；NSH 的路线是每个平台自己的界面和交互、Web 上的 HTML、Rust 与 TSX 两种应用语言，以及覆盖六个平台的 AI 驱动开发。

### Electron 与 Tauri

Electron 内置 Chromium，Tauri 使用系统的 WebView：两者都用网页内容构建桌面应用（Tauri 也覆盖移动端），文本与输入来自浏览器。NSH 则在每个平台上构建平台自己的视图，只在 Web 上渲染 HTML。

## 发布之后下发的界面

应用想要显示安装包里没有的界面——由模型生成的回答、来自合作方或其他团队的功能、无需发版就能变化的页面——无论在手机还是桌面上，都已有几种成熟的做法。它们的区别在于：界面由什么绘制，下发的代码能做什么，以及宿主应用要为承载它们做多大的改动。

| 能力 | NSH | WebView | 服务端驱动 UI | 小程序容器 | OTA 更新 |
|---|---|---|---|---|---|
| 由什么绘制 | 平台界面 | 浏览器引擎 | 应用自己的视图 | 网页引擎加专有层 | 框架的渲染器 |
| Native 的外观与行为 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| 自己的状态、逻辑和布局 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| 宿主的 Native 组件 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 桥接 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| 宿主配置的沙箱 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 同源策略 | <span class="status status--yes" role="img" aria-label="支持"></span> Schema | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> |
| 签名、可吊销的包 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 适合 AI 生成的界面 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 网页 | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> |
| 宿主应用的成本 | 一个视图和一个库 | 每个视图一个浏览器引擎 | 每个组件一个渲染器 | 一个容器 SDK | 整个应用用该框架编写 |

- **WebView（H5）。** 浏览器引擎里的网页：HTML 能表达的都能做，外观是网页的，访问原生能力靠手写的桥。
- **服务端驱动 UI。** 用 JSON 重新组合应用已经内置的组件和动作：容易生成，但除了 schema 提供的，没有本地状态和逻辑。
- **小程序容器。** 网页引擎之上的平台专有框架和 API，放在一个体积很大的容器 SDK 里。
- **OTA 更新**（例如 React Native 配合代码推送服务）。能用整个框架，但更新是可信的应用代码，应用也必须用该框架编写。
- **NSH。** 一个 TSX 模块，带着自己的状态、逻辑、动画和布局，用平台自己的界面渲染，还能使用宿主注册的 Native 视图。它以签名包的形式到达，由应用校验，运行在有内存、调用时长和节点数限制的独立虚拟机里，只能访问宿主授予的网络主机、网页和系统设置（[沙箱与能力](./sandbox-and-capabilities.md)）。宿主只需在模块出现的位置放一个视图（[平台](./platforms.md#嵌入原生应用)），同一个 bundle 运行在每个平台上。这也是在 [GPUI Shell](./index.md#native-shell-与-gpui-shell) 之外还要做 NSH 的原因。

## 其他方案更合适的情况

- 界面以数千个视图持续、密集的更新为主——每秒推送数万条行情的交易终端、每帧重画的自定义可视化：GPUI Fast 的 Retained GPU 渲染只占用其中一小部分 CPU（见 [GPUI 与 GPUI Fast](#gpui-与-gpui-fast)）。
- 应用必须在每个平台上像素级一致：Flutter、Slint 这类自己绘制一切的框架天生如此。
- 你现在就需要庞大的第三方包生态：React Native、Flutter 和 Qt 积累了多年。
- 界面是一份文档或一个现成的网页：WebView 能原样显示它。
- 页面集合固定且很少，变化的只是内容和顺序：服务端驱动 UI 完全不需要运行时。

## 另请参阅

- [简介](./index.md)：NSH 是什么，以及它所说的 Native 是什么意思。
- [架构](./architecture.md)：NSH 内部什么在哪里运行。
- [性能](./performance.md)：NSH 遵循的规则，以及如何测量一个应用。
