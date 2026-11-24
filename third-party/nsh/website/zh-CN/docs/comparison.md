---
title: 方案对比
description: 写给 Electron、Tauri、React Native、Flutter、GPUI、Qt 和 Slint 团队：Native Shell 的来历、与各框架的能力对比和实测数字、迁移的得失与试点方法，以及与 WebView、服务端驱动 UI 等发布后下发界面方案的比较。
order: 2
group: start
---

# 方案对比

NSH 是一个在 iOS、Android、macOS、Windows、Linux 和 Web 上编写完整应用的框架，也是向已发布应用下发界面的运行时。本页先把它与人们编写应用所用的跨平台框架比较，再与应用承载安装包之外的界面的几种做法比较。绿色表示具备该能力，黄色表示需要应用自己做更多工作或依赖独立项目，红色表示不提供；这些标记描述的是能力是否具备，而不是性能。版本号是各框架在撰写时文档写明的最低要求，请以你使用的版本为准。

本页写给正在用 Electron、Tauri、React Native、Flutter、GPUI、Qt 或 Slint 的团队：NSH 从哪里来，比较表里每一格的依据，NSH 向每个框架提出的挑战，换到 NSH 能得到什么、要付出什么，以及哪些情况下其他方案更合适。

**Native UI、Web 风格的开发体验、Rust 的性能、低资源开销，以及桌面、手机、Web 和终端的统一支持。**

跨平台 UI 框架长期面对同一道选择题：开发体验、原生交互、平台覆盖、性能和资源开销，究竟先要哪一项？Electron 选择了浏览器；Tauri 保留 Web 界面、改用系统 Web View；React Native 把 React 带到原生视图；Flutter 用自己的渲染体系换取一致性；GPUI 用 Rust 和 GPU 为桌面应用提供高性能界面；Qt 积累了成熟的专业桌面与嵌入式体系；Slint 在轻量、嵌入式和声明式界面上持续探索。它们都有值得肯定的能力，也都有明确的架构取舍。**NSH 要回答的问题是：能不能不再让开发者在这些核心需求之间反复二选一？**

## NSH 从哪里来

[长桥（Longbridge）](https://longbridge.com)先有桌面客户端的需求。为了摆脱 Electron 在桌面上的问题——内存高、启动慢、帧率不稳、和系统交互脱节——长桥用 [GPUI](https://gpui-kit.com)（[Zed](https://zed.dev) 编辑器所用的 Rust GPU UI 框架）构建 [Longbridge Pro](https://longbridge.com/desktop)，并在其上发展出 [GPUI Kit](https://gpui-kit.com) 组件库和 [GPUI Fast](https://github.com/longbridge/gpui-fast) 分支。金融客户端对性能的要求很苛刻：高频行情、盘口、K 线、多图联动要长时间驻留，不能掉帧，也不能明显占用 CPU；桌面上还要有可靠的窗口、文本输入和系统交互。

NSH 起步于移动客户端的插件层（[GPUI Shell](https://gpui-kit.com/shell) 的思路延伸到手机），随后把同一套应用模型——组件、signal、布局、模块——推广到 iOS、Android、macOS、Windows、Linux 和 Web（[简介](./index.md#native-shell-与-gpui-shell)）。因此：

- **桌面不是后补的。** macOS（AppKit）、Windows（Win32 与 Direct2D）、Linux（GTK 4）和手机、Web 一样，都是同一个框架的后端，由同一个仓库、同一套测试和同一个版本发布。
- **性能是架构约束，而不是之后的优化。** 渲染器、布局、动画、列表虚拟化都在 Rust 里运行；Rust 应用不带 JavaScript 引擎，TSX 应用的主线程也从不等待 JS（[架构](./architecture.md)）。
- **下发界面从第一天就要求安全。** 插件层要运行别人写的代码，所以签名包、吊销列表、沙箱虚拟机和能力授权是最初的设计目标（[签名包](./signed-packages.md)、[沙箱与能力](./sandbox-and-capabilities.md)）。

图例：<span class="status status--yes" role="img" aria-label="支持"></span> 支持 · <span class="status status--partial" role="img" aria-label="部分支持"></span> 部分支持 · <span class="status status--no" role="img" aria-label="不支持"></span> 不支持。

## 跨平台框架

| 能力 | NSH | Electron | React Native | Flutter | Qt 6 | GPUI / GPUI Fast | Slint |
|---|---|---|---|---|---|---|---|
| **平台** | | | | | | | |
| iOS | <span class="status status--yes" role="img" aria-label="支持"></span> 15+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> 15.1+ | <span class="status status--yes" role="img" aria-label="支持"></span> 15+ | <span class="status status--yes" role="img" aria-label="支持"></span> 17+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> Rust |
| Android | <span class="status status--yes" role="img" aria-label="支持"></span> 9+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> 7+ | <span class="status status--yes" role="img" aria-label="支持"></span> 7+ | <span class="status status--yes" role="img" aria-label="支持"></span> 9+ | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| macOS | <span class="status status--yes" role="img" aria-label="支持"></span> 14+ | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--partial" role="img" aria-label="部分支持"></span> 独立项目 | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--yes" role="img" aria-label="支持"></span> 13+ | <span class="status status--yes" role="img" aria-label="支持"></span> 12+ | <span class="status status--yes" role="img" aria-label="支持"></span> 13+ |
| Windows | <span class="status status--yes" role="img" aria-label="支持"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--partial" role="img" aria-label="部分支持"></span> 独立项目 | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10 1809+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ | <span class="status status--yes" role="img" aria-label="支持"></span> 10+ |
| Linux | <span class="status status--yes" role="img" aria-label="支持"></span> GTK 4.14+ | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Vulkan | <span class="status status--yes" role="img" aria-label="支持"></span> |
| Web | <span class="status status--yes" role="img" aria-label="支持"></span> HTML | <span class="status status--partial" role="img" aria-label="部分支持"></span> 另做 Web 应用 | <span class="status status--partial" role="img" aria-label="部分支持"></span> 社区库 | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Canvas |
| 终端（TUI） | <span class="status status--yes" role="img" aria-label="支持"></span> ratatui | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> |
| **渲染与运行时** | | | | | | | |
| 由什么绘制 | 平台 UI | Chromium | 平台视图 | 自有引擎 | 自绘（Widgets、Quick） | 自绘，GPU | 自有渲染器 |
| 更新模型 | 细粒度 signal，保留视图 | DOM 上的 Web 框架 | React 重新渲染后 diff | Widget 重建后 diff | 属性绑定 | 每帧重建；Fast 复用未变部分 | 属性绑定 |
| 布局、动画、列表在哪里运行 | Rust | JS 与 Chromium | Yoga（C++），列表逻辑在 JS | Dart | C++ | Rust | Rust |
| 应用语言 | Rust, TSX | JS, TS | JS, TS | Dart | C++, QML, Python | Rust | Slint + Rust, C++, JS, Python |
| 无 JS runtime | <span class="status status--yes" role="img" aria-label="支持"></span> Rust 应用 | <span class="status status--no" role="img" aria-label="不支持"></span> Node + Chromium | <span class="status status--no" role="img" aria-label="不支持"></span> Hermes | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> C++ Widgets | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
| **文本、输入与无障碍** | | | | | | | |
| 系统文本编辑 | <span class="status status--yes" role="img" aria-label="支持"></span> 平台编辑器 | <span class="status status--partial" role="img" aria-label="部分支持"></span> Chromium 的 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 自实现 | <span class="status status--partial" role="img" aria-label="部分支持"></span> 自实现 | <span class="status status--partial" role="img" aria-label="部分支持"></span> 自实现 | <span class="status status--partial" role="img" aria-label="部分支持"></span> 自实现 |
| 系统无障碍树 | <span class="status status--yes" role="img" aria-label="支持"></span> 原生视图 | <span class="status status--yes" role="img" aria-label="支持"></span> Chromium | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Semantics 树 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 有限 | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 按设备适配交互 | <span class="status status--yes" role="img" aria-label="支持"></span> 基础组件内置 | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| **桌面与嵌入** | | | | | | | |
| 窗口、菜单、托盘 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 独立项目 | <span class="status status--partial" role="img" aria-label="部分支持"></span> 插件 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 无托盘 | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 嵌入现有原生应用 | <span class="status status--yes" role="img" aria-label="支持"></span> 一个视图 | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Brownfield | <span class="status status--yes" role="img" aria-label="支持"></span> Add-to-app | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> |
| 嵌入 GPUI 应用 | <span class="status status--yes" role="img" aria-label="支持"></span> GPUI 后端 | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> 原生 | <span class="status status--no" role="img" aria-label="不支持"></span> |
| **工具链与下发** | | | | | | | |
| 工具链 | 一个 nsh 可执行文件，无需 Node | Node、npm、打包工具 | Node、Metro、CocoaPods、Gradle | flutter CLI、Xcode、Gradle | CMake、Qt Creator | cargo | cargo、CMake |
| 热重载 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> Fast Refresh | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> QML | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 实时预览 |
| 签名、沙箱化的下发界面 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> OTA 可信代码 | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> 加载 QML | <span class="status status--partial" role="img" aria-label="部分支持"></span> GPUI Shell | <span class="status status--no" role="img" aria-label="不支持"></span> |
| 许可证 | Apache-2.0 | MIT | MIT | BSD-3-Clause | LGPL、GPL、商业 | Apache-2.0 | GPL、免版税、商业 |

GPUI 与 GPUI Fast 合为一列：两者运行的平台相同，GPUI Fast 在 GPUI 之上增加了 Retained 渲染。“GPUI Shell”指 [GPUI Shell](https://gpui-kit.com/shell)。

沿 NSH 一列往下看：它是唯一在每一组都全绿的。具体来说，表中没有其他框架同时做到：

- **一套应用覆盖七个目标**——iOS、Android、macOS、Windows、Linux、以 HTML 输出的 Web，以及终端——同一个仓库、同一次发布；
- **平台自己的视图、文本编辑器和无障碍树**，并且 Rust 应用**不带 JavaScript runtime**；
- **按设备适配的交互内置在基础组件里**，而不是由每个应用自己处理；
- **作为一个视图嵌入**现有的 iOS、Android、桌面和 GPUI 应用；
- **发布之后下发签名、沙箱化的界面**，支持吊销和回滚；
- **整个工具链只有一个可执行文件**。

### 各行的含义

- **Electron。** 每个应用都带 Chromium 和 Node：桌面上覆盖最广的 Web 内容路线，不支持手机。最低版本参照 [Electron 支持的平台](https://www.electronjs.org/docs/latest/tutorial/support#supported-platforms)；它的 Web 版本是把同一份代码另行部署成网站。
- **由什么绘制、更新模型。** NSH 挂载每个平台自己的视图并保留它们（Retained Mode）：一次变化只更新它改到的视图。React Native 在 iOS 和 Android 上同样挂载平台视图。Flutter、Qt Quick、GPUI 和 Slint 用自己的渲染器绘制；GPUI 每一帧重新构建元素树（Immediate Mode），[GPUI Fast](https://github.com/longbridge/gpui-fast) 复用没有变化的部分。
- **平台。** NSH 的最低版本见[平台](./platforms.md)。其他框架的数据来自 [React Native 0.76](https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture)（iOS 15.1，Android 7 / API 24；macOS 和 Windows 由独立的 react-native-macos、react-native-windows 项目支持，Web 由社区的 react-native-web 支持）、[Flutter 3.47](https://docs.flutter.dev/reference/supported-platforms)、[Qt 6.10](https://doc.qt.io/qt-6.10/supported-platforms.html)、GPUI 参照 [Zed 的系统要求](https://zed.dev/docs/installation)，以及 [Slint 的平台指南](https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/general/)（iOS 仅支持 Rust）。“Canvas”表示框架在页面的画布上自己绘制；NSH 的 Web 应用是用 CSS 设置样式的 HTML 元素，由浏览器滚动、选择和编辑（[Web](./web.md)）。布局由 Rust 中的 Taffy 计算，并不等于完整的浏览器 CSS 排版。
- **系统文本输入。** NSH 的文本框就是平台的编辑器——`UITextView`、`EditText`、`NSTextView`、GTK 的 `TextView`、浏览器的输入框——带着系统的输入法、选区手柄和编辑菜单；Windows 上是 NSH 自己的编辑器，配合 DirectWrite 和系统输入法（IMM32）。React Native 也使用平台的文本输入框。自绘框架自己实现文本编辑，再接入系统输入法。
- **按设备适配。** NSH 的基础组件随设备而变：同一个 `Menu` 在有指针的设备上贴着触发点弹出，在手机上从底部升起；`ContextMenu` 用右键或长按打开。在其他框架中，按设备适配交互主要是应用自己的工作。
- **布局、动画和列表在哪里运行。** NSH 中它们在 Rust 里运行，不经过 JavaScript：TSX 处理函数忙碌时，滚动和动画不会卡住（[架构](./architecture.md)）。React Native 用 C++ 的 Yoga 布局，但列表窗口化和大部分动画逻辑仍在 JS 中，除非借助第三方库移出。
- **无障碍。** NSH 的元素就是原生视图，VoiceOver、TalkBack 和桌面读屏软件读到的是真实的视图层级；应用补充标签、角色和动作即可（[无障碍](./accessibility.md)）。GPUI 目前对辅助技术暴露的信息很少。
- **窗口、菜单、托盘。** `nsh/desktop` 在 macOS、Windows 和 Linux 上提供窗口、菜单、托盘和 Dock 角标（[nsh/desktop](../modules/nsh-desktop.md)）。GPUI 有窗口和菜单，但没有托盘；Flutter 依靠插件。
- **嵌入。** NSH 应用可以作为一个视图嵌入现有的 iOS、Android 或桌面应用（[嵌入](./embedding.md)），也能通过 GPUI 后端作为视图嵌入 GPUI 和 GPUI Kit 应用（[GPUI](./gpui.md)）。React Native（brownfield）和 Flutter（add-to-app）也能嵌入，但各自带上自己的 runtime。
- **终端。** 同一套组件模型通过 ratatui 渲染终端应用（[TUI](./tui.md)）。
- **工具链、热重载。** 一个 `nsh` 可执行文件负责创建、热重载运行、在真实平台上测试、为每个目标打包和签名，TSX 不需要 Node 或 npm（[CLI](./cli.md)）。
- **无 JS runtime。** Rust 应用的运行器在任何平台上都不链接 JavaScript 引擎；TSX 是第二条路径，运行在同一个引擎上。Qt Quick 的 QML 运行在 Qt 的 JavaScript 引擎上，用 C++ 编写的 Qt Widgets 则不需要。
- **签名下发界面。** NSH 用自己信任的密钥和吊销列表校验签名的 `.nshpkg` 包，并让每个包运行在宿主设定限制和能力的虚拟机里（[签名包](./signed-packages.md)、[沙箱与能力](./sandbox-and-capabilities.md)）。打包的 NSH 应用也以同样的方式 OTA 更新自己的 TSX（包括 iOS 和 Android），启动失败的版本会自动回滚（[OTA 更新](./ota-updates.md)）。React Native 的 OTA 更新下发的是可信的应用代码；Qt 可以加载 QML 文件；GPUI 应用通过 [GPUI Shell](https://gpui-kit.com/shell) 加载 JavaScript 模块。

### NSH 的不同之处

- **两层意义上的 Native，在每个平台上。** 每个后端都建立在平台自己的视图、文本和输入法之上——UIKit、Android 视图、AppKit、用 Direct2D 绘制的 Win32、GTK 4、HTML——平台的交互方式也随之而来。文本选择、输入法和无障碍都是系统的，系统新版本对它们的改进，应用直接获得（[简介](./index.md#native-的含义)）。
- **一套应用覆盖手机、桌面和 Web。** 六个平台都是同一个框架的后端，共享同一套响应式图、渲染器、Taffy 布局和模块；布局随窗口重组，输入方式随设备变化；在 Web 上，应用是 HTML，发布为静态网站。
- **Rust First，不带 JavaScript runtime。** 整个应用可以从头到尾都是 Rust，编译成 Native 代码，带着 Rust 的类型、线程和 crates。TSX 是第二条路径，运行在同一个引擎上，适合快速编写的界面（[用 Rust 开发](./rust.md)）。
- **面向日常应用的 Retained Mode。** 组件只运行一次，细粒度的 signal 只把变化的属性发给视图，因此聊天、表单、列表和文档在静止时几乎不占 CPU（[简介](./index.md#retained-mode)、[响应式](./reactivity.md)）。
- **发布之后下发界面，经过签名、运行在沙箱里。** 用 NSH 构建的应用——以及用各平台自己的工具编写的原生应用——都能在运行时接收 TSX 模块，由团队编写或 AI 生成（[动态界面](./index.md#动态界面与-ai-生成的界面)）。
- **一个工具链，人和 AI agent 都能用。** 一个 `nsh` 可执行文件负责创建、运行、热更新、在真实平台上测试、打包和签名，覆盖每个目标平台；TSX 不需要 Node 或 npm（[CLI](./cli.md)、[安装](./installation.md)）。

### 专业应用的组件基础

以行情研究工作台为例：主表要在报价更新时保持选区，研究报告要边接收边排版，拖动面板之后还要保留正在编辑的内容。这些都是产品需要长期维护的交互。NSH 把 GPUI Kit 在桌面应用上积累的分层方式带到各端：[NSH Base](../modules/nsh-base.md) 负责行为、状态、焦点和无障碍，产品团队在自己的 UI 层定义外观。由此，同一套组件可以成为团队内多个产品共同遵循的交互标准。

| 基础组件 | 应用可直接复用的能力 |
|---|---|
| [DataTable](../elements/data-table.md) | 行列双向虚拟化只创建可见单元格；冻结价格列、按页供数和键盘选区可组合在同一张行情表中。 |
| [Editor](../elements/editor.md) | 只创建可见行，按编辑位置增量高亮；查找替换、多光标、折叠和诊断可直接用于策略编辑器。 |
| [TextView](../elements/text-view.md) | Rust 解析流式 Markdown，用文本和视图呈现表格、代码和链接，研究助手可直接显示分段到达的回复。 |
| [RichEditor](../elements/rich-editor.md) | 文档结构由 schema 约束，编辑通过事务更新；团队可以添加提及或快捷命令，并沿用历史记录。 |
| [DiffView](../elements/diff-view.md) | 可直接显示补丁或比较两段文本，支持并排与统一视图、词级高亮及逐处审阅批注。 |
| [Dock](../elements/dock.md) | 拆分、调整大小和移动标签页由组件处理；移动时保留面板内容，布局数据由应用保存。 |

这也给性能、稳定性和扩展划出了具体边界：大表只创建可见单元格，文档模型检查编辑结果，面板移动保留内容。应用可以扩展单元格、文档 schema 和面板，而不必接管滚动、撤销或拖动逻辑。下表的行情负载提供运行时性能参考；组件行为则可以在各自文档的示例里单独验证。

### 实测数字

以下数字来自[性能报告](./performance-report.md)和 [NSH 性能基准](https://github.com/longbridge/nsh-perf-bench)，都是 release 构建；在你自己的设备上用 `nsh` 的 trace 复现它们（[测量应用](./performance-report.md#测量应用)）。

| 测量 | 结果 |
|---|---|
| 引擎启动 | ~75–155 µs |
| 计数器应用首帧（Mac Catalyst） | ~1.05–1.15 ms |
| 一次点击（JS 加 commit） | ~0.12 ms |
| Rust 应用在 macOS 上的内存 | ~19 MB，只有一个 label 的 AppKit 窗口为 ~17 MB |
| Rust 模块对 10 万行排序（由 TSX 调用） | ~3 ms，与纯 Rust 相当 |
| 500 行行情表，每秒 1,000 条更新（Linux） | NSH Rust 18% 单核 CPU，GPUI Fast 20% |
| Stocks 演示：22 条实时走势线、分时图、盘口、逐笔成交（Linux） | 117–120 FPS，25–29% CPU |

## 挑战主流 UI 框架

下面逐个向主流框架提问：它在哪里做得好，代价在哪里，NSH 如何处理同一问题，迁移时能沿用什么、要付出什么。性能数据见上文的[实测数字](#实测数字)。

> 这里比较的是架构选择和典型应用的适配度，不是宣称任何框架在所有负载下都落后。性能数字来自 NSH 项目已有的测试或开发实践；只有在同一设备、同一应用、同一负载和同一测量口径下，才构成严格的横向基准。

## 挑战 Electron：开发原生应用，为什么要带上整个浏览器？

Electron 的成功毋庸置疑：HTML、CSS、JavaScript、React 和成熟的 Web 生态，让桌面应用开发变得非常高效。但它的代价同样明显。


**Electron 应用自带 Chromium 和 Node.js。** Electron 的多进程架构“继承自 Chromium”：每个应用有一个运行 Node.js 的主进程，并且“为每个打开的 `BrowserWindow` 启动一个独立的渲染进程”（[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)）。也就是说，每个 Electron 应用都自带一份 Chromium 和 Node.js。

代价在这里：

- **体积和内存。** 应用还没画任何东西，浏览器引擎和 JavaScript 运行时就已经随每个应用、每个窗口带上了。实际中，一个典型的 Electron 应用安装包起步就在 150 MB 左右，用起来内存常常到 1 GB 甚至更多（典型情况的经验数字，不是基准测试）；桌面上开着几个 Electron 应用，就是开着几个浏览器。作为对比，NSH 在 Linux 上实测的发布包只有 9.7–11.7 MB（hello world 以及 sysmon、Omasend 等真实应用），macOS 上 Rust 应用内存约 19 MB（[应用体积](./performance-report.md#应用体积)）。
- **关掉标签页后，内存还在增长。** 例如，行情面板关闭后，全局行情订阅仍持有回调，回调又引用了已经移出页面的 DOM 节点。只要这条引用链还在，垃圾回收器就无法释放整棵子树。反复开关面板可能留下多份旧界面，旧回调还会处理每一笔行情；用户看到的就是内存持续上涨、操作越来越慢。[Chrome DevTools 内存诊断](https://developer.chrome.com/docs/devtools/memory-problems)
- **启动。** 要等 Chromium 和 Node.js 启动，再等 JavaScript 加载、解析、执行，才有第一帧。
- **常态 CPU。** 实时数据要更新 DOM，经过页面里的样式重算、布局和绘制；长列表和高频更新恰好是网页最不擅长的。
- **页面不是系统。** 输入框、选择、右键菜单、滚动和无障碍都是浏览器在窗口里的实现，不是操作系统的控件。原生菜单、对话框和托盘虽然有，但只能经主进程调用，和界面隔着 IPC。
- **没有手机。** Electron 只做桌面，移动端是另一个项目。
- **安全靠应用自己。** 渲染进程可以被给予 Node.js 权限，Electron 官方的安全清单（上下文隔离、沙箱、不让远程内容获得 Node 集成）要每个应用自己逐条做对。

NSH 怎么解决：

| Electron 的代价 | NSH |
|---|---|
| 每个应用带 Chromium + Node.js | 没有浏览器引擎。Rust 应用完全不链接 JavaScript 引擎；TSX 应用只在 QuickJS 里跑应用代码，渲染、布局和动画在 Rust 里（[架构](./architecture.md)） |
| 安装包约 150 MB、内存常达 1 GB 以上（典型情况） | Linux 发布包 9.7–11.7 MB（hello world、sysmon、Omasend，[应用体积](./performance-report.md#应用体积)）；macOS 上 Rust 应用约 19 MB，只放一个标签的 AppKit 窗口约 17 MB（[性能报告](./performance-report.md)） |
| 关闭面板后仍被引用的 DOM 子树 | NSH 原生控件由 Rust 运行时驱动，无需创建 DOM 子树。纯 Rust 应用也无需 JS 垃圾回收；TSX 应用仍需清理业务代码持有的回调。 |
| 启动慢 | 引擎启动约 75–155 µs；计数器应用首帧约 1.05–1.15 ms |
| 实时数据下的 DOM 布局 | 细粒度 signal 只把变化的属性推给平台视图；Linux 上 500 行行情表每秒 1,000 次更新占单核 18% |
| 浏览器的文本、菜单和无障碍 | AppKit、Win32 + Direct2D 和 GTK 4 的控件、输入法和无障碍（[简介](./index.md#native-的含义)） |
| 只有桌面 | 同一个应用跑在 iOS、Android 和 Web 上（[平台](./platforms.md)） |
| 安全由应用自管 | 下发的界面跑在沙箱虚拟机里，能力由宿主授予，包经过签名并可吊销（[沙箱与能力](./sandbox-and-capabilities.md)） |

**能沿用的。** TSX 读起来像 JSX，样式读起来像 CSS 和 [Tailwind](./tailwind.md)，Web 团队的经验大部分用得上；已有页面仍可放进 [Web View](./web-view-and-video.md)。**要付出的。** 依赖浏览器的 DOM 代码和 npm 组件库带不过来，界面要用 NSH 元素重写。

聊天和 AI 应用收益最大。很多 AI 产品用网页渲染对话，长会话里会出现滚动掉帧、输入法和选择别扭、与系统无障碍和手势脱节。NSH 用平台的文本视图和编辑器渲染富文本、代码块、表格、图片和流式输出（[文本](./text.md)、[列表](./lists.md)）。

迁移多面板审阅工具时，可以先列出现有的 Web 表格、停靠布局和差异视图，分别映射到 DataTable、Dock 和 DiffView，再移植业务单元格和审阅动作。已有 DOM 控件需要替换或放进 WebView。

**挑战宣言：The Web development experience. Without the browser.**

## 挑战 Tauri：去掉了自带的 Chromium，为什么界面仍然是 Web View？

Tauri 用系统 Web View 和 Rust 后端，显著改变了 Electron 的运行时成本结构，适合已经有 Web 应用、想快速交付轻量桌面或手机客户端的团队。但界面仍然是网页。


**Tauri 使用系统提供的 Web View。** Tauri 不打包 Chromium，而是用操作系统提供的：Windows 上是 WebView2（Chromium），macOS 和 iOS 上是 WKWebView（WebKit），Linux 上是 `webkit2gtk`（WebKit），Android 上是设备的 Android WebView（[Tauri webview 版本](https://v2.tauri.app/reference/webview-versions/)）。应用变小了，界面仍然是网页。

代价在这里：

- **三种引擎，版本众多。** 同一个应用在 Windows 和 Android 上跑 Chromium，在 Apple 平台和 Linux 上跑 WebKit。Tauri 自己的文档写明：Android 上“运行时版本取决于设备当前选择的 WebView 提供者”，“不再受支持的 macOS 版本**不会**收到 WebKit 更新”，Linux 上“很难整理出各发行版 WebKitGTK 的准确信息”（[出处](https://v2.tauri.app/reference/webview-versions/)）。渲染问题和缺失的 Web 特性要按引擎、按系统版本逐一测。
- **仍然是网页。** 文本、滚动、选择和无障碍是 Web View 的，不是系统控件；实时数据下的性能取决于 DOM。
- **Rust 后端管不到页面里的引用。** 例如，切走图表后，WebView 里仍在运行的定时器可以通过闭包持有旧图表和历史数据。每次切换都留下一个定时器，内存和后台刷新工作就会一起累积；即便 Rust 端已经释放对应资源，页面仍要取消定时器并释放引用。[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)
- **两种语言隔着桥。** 界面用 JavaScript，逻辑用 Rust，靠 IPC 调用和序列化连接。

NSH 怎么解决：界面是平台自己的视图，在平台支持的每个系统版本上都一样，中间没有 Web 引擎；Rust 和 TSX 在同一个进程、同一张响应式图上运行，TSX 界面直接调用 Rust 模块——从 TSX 排序 100,000 行约 3 ms，与纯 Rust 持平（[性能报告](./performance-report.md)）。Tauri 最好的想法——核心用 Rust——是 NSH 的默认做法，而且 Rust 不只是后端，而是整个界面的核心：复杂计算、文件索引、音视频处理和系统 API 通过 [nshm](./nshm.md) 扩展接入。需要显示真实网页时，NSH 仍可嵌入 [Web View](./web-view-and-video.md)，而不必让整个应用成为 Web View。

**要付出的。** 已有 Web 项目的界面要用 NSH 元素重写；如果目标是尽快把现成网站包成客户端，Tauri 的复用优势依然成立。NSH 更适合从一开始就要原生界面的产品。

在 NSH 原生界面上，图表可以用原生 Canvas 绘制，更新逻辑可以绑定到响应式作用域。释放作用域时，运行时会清理归属于它的计算和已登记的清理函数。应用仍须为自行创建的定时器、外部行情订阅登记取消操作；选择嵌入 WebView 的页面仍按浏览器的生命周期管理资源。[响应式运行时实现](https://github.com/longbridge/nsh/blob/d2c6e800dac5985c112e61626b89e30ace2d2f83/crates/nsh-core/src/reactive.rs#L1169)

可沿用 Rust 后端生成的报告数据，先把一个 Markdown 网页面板换成 TextView，再用同一份报告逐端核对链接、表格和流式更新。

**挑战宣言：Rust at the core. Native UI, not a WebView.**

## 挑战 React Native：同样是原生框架，为什么桌面、手机和 Web 仍然分散？

React Native 是 NSH 最直接的竞争对手之一。它已经证明 TypeScript/JavaScript 可以和平台原生视图很好地结合，iOS 和 Android 生态也非常成熟。问题不在于它不够原生，而在于它的平台组织方式和默认的更新模型。


**React Native 用 JavaScript 驱动原生视图。** React Native 的目标和 NSH 最接近：都想减少重复的客户端工作，都使用平台视图。但应用逻辑和 React 协调始终跑在 JavaScript 引擎里，新架构（Fabric、TurboModules、JSI）让桥更快，并没有改变这一点（[React Native 架构](https://reactnative.dev/architecture/landing-page)）。

代价在这里：

- **JS 线程就是帧预算。** React Native 自己的性能指南把 JavaScript 线程在一帧内无响应视为掉帧（[Performance](https://reactnative.dev/docs/performance)）。每次状态变化都要在 JavaScript 里重新渲染组件并做 diff，所以高频更新——行情、聊天流、计时器——要和输入处理争同一个线程。团队只能靠 `memo`、`useMemo`、`useCallback` 和依赖数组去压。
- **桌面和 Web 是别人的项目。** macOS 和 Windows 是微软维护的 `react-native-macos`、`react-native-windows`；Web 是社区的 `react-native-web`；Linux 没有独立平台，只能经社区的 React Native Skia 渲染器（[Out-of-tree platforms](https://reactnative.dev/docs/out-of-tree-platforms)）。每个项目各有发布节奏、缺口和相对核心的滞后。
- **不同设备的交互由应用自理。** 手机和桌面需要不同的菜单、悬停、键盘和指针行为，React Native 的组件把这些留给应用。
- **OTA 下发的是受信任代码。** CodePush 式更新替换的是应用自己的 JavaScript，没有给别人写的代码准备的沙箱。
- **工具链很长。** Node、npm、Metro、CocoaPods、Gradle 和原生构建工具，各自的版本都要对齐。

NSH 怎么解决：

| | React Native | NSH |
|---|---|---|
| 运行时 | 始终有 JS 引擎（Hermes），应用逻辑和协调都在 JS 里 | Rust 应用没有 JS 引擎；TSX 应用只在 QuickJS 里跑应用代码，响应式图、渲染、布局、动画和列表虚拟化都在 Rust 里 |
| 更新模型 | 状态变化后重新渲染，再 diff | 细粒度 signal（类似 Solid）：组件只运行一次，只推送变化的属性；不需要 memo，也没有依赖数组（[响应式](./reactivity.md)） |
| 一次点击 | — | 约 0.12 ms，含 JS 和提交（[性能报告](./performance-report.md)） |
| 桌面 | 微软维护的独立项目，没有 Linux | AppKit、Win32 + Direct2D 和 GTK 4，与手机同框架、同测试、同发布 |
| Web | 社区的 react-native-web | 框架自带后端，输出 HTML 和 CSS |
| 按设备适配交互 | 交给应用 | 基础组件自动适配：`Menu` 在桌面从指针处弹出，在手机从底部升起 |
| 重计算 | 原生模块加桥接代码 | 在同一个应用里用 Rust 写，从 TSX 调用：排序 100,000 行约 3 ms |
| 发布后更新 | OTA 下发受信任的 JS bundle | 签名的 `.nshpkg`、吊销列表、宿主设定能力和限额的沙箱虚拟机、启动失败自动回滚（[OTA 更新](./ota-updates.md)） |
| 工具链 | Node、Metro、CocoaPods、Gradle 等 | 一个 `nsh` 可执行文件；TSX 不需要 Node 或 npm（[CLI](./cli.md)） |

Fabric、JSI、TurboModules 和 Reanimated 已经消除了不少瓶颈，React Native 也能通过原生模块接入 Rust。区别不在于“只有 NSH 能调用 Rust”，而在于 Rust 在框架中的地位：NSH 可以用纯 Rust 编写完整应用、完全不带 JavaScript VM；TSX 应用的响应式图、调度和挂载批次（MountBatch）也都在 Rust 里。对于同时需要专业桌面窗口、实时行情表格、手机和 HTML Web 的产品，这些都是同一个框架的正式后端，不需要拼接几个项目。

**能沿用的。** TSX 和 JSX 很像，组件、props、事件的思路不变；hooks 换成 signal。**要付出的。** NSH 刻意不做 React Native 兼容层：它用更高效的模型取代了 React 协调，所以 React Native 的包不能在 NSH 上运行。列表、导航、动画、手势、文本、画布、Web View 和视频由框架原生提供，视觉组件由应用自己定义（[设计指南](./design-guides.md)），已有的原生 SDK 可以做成[原生组件](./native-components.md)或 Rust [模块](./platform-extensions.md)。

[React Native 核心组件](https://reactnative.dev/docs/components-and-apis)包括列表和文本输入。要做可冻结列的双向虚拟行情表，或带撤销的结构化编辑器，还需要选库或自行组合。NSH 可直接从 DataTable 和 RichEditor 开始，迁移数据源、文档结构和产品样式，再到目标设备上验收选区与撤销。

**挑战宣言：Beyond React Native. One framework for desktop, mobile, and Web.**

## 挑战 Flutter：为什么要重新实现操作系统已经做好的界面？

Flutter 用自己的渲染引擎实现高度可控、跨平台一致的视觉，这是它的长处，尤其适合高度定制的界面。但自绘也意味着许多系统行为要由框架自己适配。


**Flutter 使用自己的渲染引擎绘制控件。** Flutter 自己渲染整个界面，所以应用在哪里看起来都一样——也因此没有一处是平台自己的。

代价在这里：

- **文本和输入是重新实现的。** 文本编辑、输入法、选择菜单、焦点、键盘导航和无障碍语义都是 Flutter 对各平台行为的重写。Flutter 在这些方面已有大量成熟实现，问题不在于支不支持，而在于由谁长期维护：新系统版本带来的改进，要等 Flutter 再实现一遍。
- **原生视图是昂贵的客人。** Flutter 官方文档写明“Flutter 中的平台视图有性能取舍”：Android 上用 hybrid composition 时，Flutter“把光栅线程合并到平台线程”，“可能导致帧率下降和掉帧”；texture layer 模式可能造成“快速滚动时卡顿（例如 Web View）”和“`SurfaceView` 的无障碍失效”（[在 Android 上嵌入原生视图](https://docs.flutter.dev/platform-integration/android/platform-views)）。地图、Web View、视频和支付 SDK 正是这类视图。
- **Web 不是真正的 Web。** Flutter“不适合以文本为主、流式排版的静态网站”，其输出“与搜索引擎正确索引所需的内容不一致”；Flutter 团队自己建议文档类内容用 Jaspr 或普通 HTML，并把自己的文档站迁到了 Jaspr（[Flutter Web FAQ](https://docs.flutter.dev/platform-integration/web/faq)）。
- **只有 Dart。** 逻辑和界面都是 Dart，系统级代码和已有原生库要走 platform channel 或 FFI。

NSH 怎么解决：每个后端用的都是平台自己的视图——UIKit、Android View、AppKit、Win32、GTK 4——地图或 Web View 只是视图树里的又一个视图，不是被合成进来的客人；文本编辑、输入法、选择和无障碍都是系统的（[简介](./index.md#native-的含义)）；Web 产物是真正的 HTML，可选择、可被索引、可被读屏软件朗读，并能使用语义化标记、链接和 ARIA；语言是 Rust（有 crates 生态和原生线程）加上用于快速写界面的 TSX。**要付出的。** 应用可以跨平台复用同一套品牌样式；系统字体和材质的渲染细节仍会因平台而异。Windows 后端的部分控件由 NSH 用 Direct2D 绘制，需要按具体控件评估；Web 上布局由 Taffy 计算，不等于完整的浏览器 CSS 排版。

Flutter 已有表格和输入控件。迁移代码审阅页时，值得比较的是上层工作量：Editor 提供诊断与折叠，DiffView 提供差异对齐与批注，现有 Dart 控件实现仍需移植。

**挑战宣言：Why recreate what the operating system already does best?**

## 挑战 GPUI：高性能的界面，为什么还要持续消耗 CPU 和 GPU？

GPUI 证明了 Rust 和 GPU 能构建 Zed 这样复杂的专业桌面应用，在高性能自绘、复杂编辑器界面和 GPU 控制上都有重要价值。但真正的高性能不只是高帧率，还包括静止时的低开销、低功耗和更长的电池续航。


**GPUI 为 Zed 桌面编辑器提供 GPU 渲染。** [GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui) 是 Zed 编辑器的 Rust UI 框架；[GPUI Fast](https://github.com/longbridge/gpui-fast) 是 Longbridge 的分支，加入了保留式渲染、滚动图层和原生窗口合成，NSH 出自同一个团队。

对通用应用来说，代价在这里：

- **只有桌面。** GPUI 的 README 只涵盖 macOS、Linux/FreeBSD 和 Windows，手机和 Web 不是目标平台（[GPUI README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)）。
- **编辑器的框架，跟着编辑器走。** GPUI“仍处于 1.0 之前”，“版本之间经常会有破坏性变更”；README 给出的学习方式是“阅读 Zed 源码或到 Zed Discord 提问”（[同一出处](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)）。
- **一切都是画出来的。** 输入框、选择和菜单由框架绘制，不是平台控件，系统文本行为要像 Flutter 一样重新实现。
- **只有 Rust，不能下发。** 没有用于快速写界面的脚本路径，也没有给发布后下发界面准备的沙箱（GPUI Kit 通过 [GPUI Shell](https://gpui-kit.com/shell) 加入了 JavaScript 模块，NSH 正是从这个想法长出来的）。

- **高帧率不等于低开销。** 每帧重建元素树，意味着内容没变时也可能重复构建和绘制。这不只消耗 CPU，GPU 的绘制、合成和唤醒同样耗电。对日常应用来说，性能还包括静止时的开销、功耗和电池续航。
- **没有终端。** 自绘架构理论上可以扩展到更多平台，但目前没有 NSH 这样的 iOS、Android、HTML Web 和 TUI 后端。

NSH 怎么解决：同样以 Rust 为先的模型覆盖 iOS、Android、Web 和终端；Retained Mode 加细粒度 signal，界面变化少时不重新计算和绘制无关部分，减少 CPU 和不必要的 GPU 工作；Tab 焦点、键盘导航和无障碍尽可能交给平台；文本输入、选择和输入法是平台的；内置 TSX 路径和签名、沙箱化的下发。NSH 的 GPUI 后端可以把 NSH 应用嵌进现有的 GPUI 和 GPUI Kit 应用，界面可以一个个迁移，不必整体重写（[GPUI](./gpui.md)）。

**数字如实写。** 在 [NSH 性能基准](https://github.com/longbridge/nsh-perf-bench)中（Linux，500 行行情表，NSH 用 GTK 4 后端），日常负载开销相同：每秒 1,000 条行情时 NSH Rust 占单核 18%，GPUI Fast 20%。持续高强度更新时 GPUI Fast 领先：每秒 20,000 条行情时它占 25%，NSH 为 73–78%；每帧计算 1,000 个方块的动画，它的 CPU 约为 NSH 的三分之一。开发中我们还观察到下面这些特定场景的 CPU 占用。它们来自不同场景和既有经验，没有统一设备、负载和统计口径，**不能当作同一负载下的逐项对照**：

| 场景 | CPU 占用（开发观察） |
|---|---:|
| 原版 GPUI，部分持续更新场景 | 40%–60% |
| GPUI Fast（Retained 等优化之后） | 约 20% |
| NSH，相关更新场景 | 低于 15% |
| 原版 GPUI，部分低频更新场景 | 约 20%–40% |
| NSH，部分低频更新场景 | 约 5%–10% 以下 |

GPU 功耗还没有单独测量，CPU 的下降比例不能直接当作 GPU 功耗的下降比例。我们开发 GPUI Fast 正是为了缓解原版 GPUI 的这类成本，它不是这里比较的对象。

只做桌面、由每帧更新的成千上万个视图主导的交易终端，留在 GPUI Fast；要覆盖手机、Web、日常界面或下发界面，用 NSH。

GPUI Kit 用户在桌面上已经拥有成熟组件。迁移的收益在于把熟悉的交互模型带到更多平台。可先嵌入一个 NSH 面板，验证文档状态和键盘操作，再迁移外围工作区。

**挑战宣言：Less CPU. Less GPU work. More Native. Desktop, Mobile, Web, and TUI.**

## 挑战 Qt：成熟的专业桌面能力，能不能真正延伸到手机和 Web？


**Qt 提供 Widgets 和 Qt Quick 两套 UI 技术。** Qt Widgets 和 Qt Quick 自己绘制控件，并按各平台风格做样式，工具链积累多年。NSH 的根基和模型不同：用平台控件而不是仿制样式；核心是 Rust 并提供 TSX 路径，而不是 C++ 和 QML；Web 上输出 HTML；一套组件模型在手机、桌面和 Web 上自动适配交互；工具链为自动化和 AI 驱动的开发设计；任何用途都是 Apache-2.0 许可。

Qt 是最成熟、最完整的 UI 框架之一，在专业桌面软件、工业应用和嵌入式领域有丰富的组件、系统集成和数十年的工程积累。代价在这里：

- **重心不在消费级手机和 Web。** Qt 支持 iOS、Android 和 WebAssembly，但移动端并没有成为与原生开发、React Native、Flutter 同等普遍的选择；它的主要 UI 路线也不是以 UIKit 和 Android 视图为基础。Qt 的 WebAssembly 输出在画布上绘制，而不是 HTML。
- **许可证要逐项评估。** Qt 采用 LGPL、GPL 和商业许可的组合，团队要按用到的模块、链接方式和分发方式评估义务；部分模块只有 GPL 或商业许可（[Qt 许可](https://www.qt.io/licensing)）。
- **分发要带运行库。** 常见的动态链接部署要随应用附带 Qt 动态库、平台插件和资源，Windows 上还要处理 DLL、插件目录和版本兼容。静态链接可行，但有相应的构建与许可条件。
- **工具链要自己组装。** Qt SDK、CMake、编译器、平台插件、运行库和各平台部署配置都要维护。

NSH 的做法：桌面上提供多窗口、Dock、DataTable、Editor、RichEditor、DiffView 等基础设施；手机上基于 UIKit 和 Android 视图；Web 输出真实 HTML 和 CSS；还有终端。NSH 核心采用 Apache-2.0，可用于闭源商业应用，无需购买框架商业许可，也没有 LGPL 的重新链接要求——第三方 nshm 模块仍按各自许可证。一个 `nsh` 可执行文件负责创建、运行、测试、打包和签名，TSX 不需要 Node 或 npm，纯 Rust 应用不带 JavaScript VM；目标平台自身的 Xcode、Android SDK 仍然需要。

**数字如实写。** Qt 的桌面生态成熟度仍然领先，NSH 并不替代每个 Qt 组件；NSH 有约 10 MB 的 Linux 发布包和约 19 MB 的 macOS Rust 应用内存，但与 Qt Widgets 或 Qt Quick 的体积、内存和 CPU 差异，要在同功能、同平台的实测里才能量化。

迁移 Qt Widgets 工作区时，可将停靠窗口映射到 Dock，优先验证布局恢复与面板状态；已有 Qt 控件代码仍需适配或重写。

**挑战宣言：Professional Desktop. Native Mobile. Real HTML Web. Apache 2.0.**

## 挑战 Slint：轻量之外，谁来支撑一款完整的跨平台产品？


**Slint 提供自己的声明式语言和渲染器**，面向桌面和嵌入式设备，可从 Rust、C++、JavaScript 或 Python 使用。两者都重视原生性能；NSH 的路线是每个平台自己的 UI 和交互、Web 上的 HTML、用 Rust 和 TSX 写应用而不是另一门标记语言，并且手机是一等目标。

Slint 的专用 DSL 不是缺陷，而是为了得到可分析、可优化的界面；对于仪表盘、设备控制界面和资源受限的终端，它有自己的竞争力。差别在于从“做一个界面”到“交付一款完整应用”：

- **专业组件的深度。** 设想一个跨平台代码审查工具：可拖拽的多栏 Dock、数万行 Diff、带语法高亮和撤销历史的编辑器、键盘在表格和面板间切换、多窗口和系统菜单。NSH 直接提供 Dock、DiffView、Editor、RichEditor 和 DataTable；Slint 有标准控件、列表和模型机制，值得比较的是还要自己建设多少编辑器、表格、停靠布局和桌面交互。
- **手机上的原生交互。** Slint 的移动端界面由自己的渲染器绘制；输入法、文本选择、触摸手势、系统无障碍和平台习惯要由框架长期跟进。NSH 在 iOS 和 Android 上以 UIKit 和 Android 视图为基础，聊天、表单、文档编辑这类日常应用直接受益。
- **Web 是 HTML，不是画布。** Slint 的 Web 路线是 WebAssembly 加自己的渲染；NSH Web 输出 HTML 元素和 CSS，DOM、语义结构、原生输入、文本选择和 Web API 都能直接参与。
- **布局模型。** NSH 提供 Flexbox、Grid、百分比、响应式状态和 Tailwind 风格样式，熟悉 Web 布局的团队可以复用设计与排版思路。Slint 的布局和属性绑定同样成熟，只是不以 CSS 布局为目标。

在嵌入式和极低资源设备上，Slint 的优势仍然成立；NSH 的主战场是需要复杂交互和多端交付的应用。

对于以表格为主的 Slint 工具，可用同一数据模型对照 DataTable，先验证分页、冻结列和键盘选区，再移植自定义单元格。

**挑战宣言：从轻量界面走向完整的应用平台——专业桌面组件、系统原生的手机交互、真正的 HTML Web，以及统一的布局与开发体系。**

## 小结：每个框架一行

| 框架 | 结构性短板 | NSH 的做法 |
|---|---|---|
| Electron | 每个应用带浏览器和 Node.js；只有桌面 | 平台视图，没有浏览器；Rust 应用约 19 MB；同一份代码覆盖手机和 Web |
| Tauri | 每个系统、每个版本是不同的 Web 引擎 | 平台视图，在支持的系统上表现一致；Rust 和 TSX 同进程 |
| React Native | 每次更新都过 JS 线程和协调；桌面和 Web 是独立项目 | Rust 核心加细粒度 signal；六个平台同一框架、同一发布 |
| Flutter | 自绘文本和输入；原生视图代价高；Web 接近画布 | 系统的文本、输入和无障碍；原生视图就在视图树里；Web 是 HTML |
| GPUI | 只有桌面、1.0 之前、随编辑器演进；文本、焦点和无障碍要自行实现 | 同样的 Rust 模型覆盖手机、Web 和终端；可嵌入 GPUI 应用 |
| Qt | 重心在桌面和嵌入式；许可证与运行库分发要逐项评估 | 原生手机和 HTML Web；Apache-2.0；一个 `nsh` 工具链 |
| Slint | 专业应用组件要自己建设；手机和 Web 由自绘承担 | 内置专业组件；原生手机视图；Web 是 HTML |

## 一个框架，覆盖更多场景

每一种主流框架都证明了一种重要的能力：

- **Electron**：Web 开发体验能大幅降低桌面应用的开发门槛。
- **Tauri**：Rust 加系统 Web View 能减少 Electron 的运行时成本。
- **React Native**：TSX/JavaScript 能和原生界面结合。
- **Flutter**：统一的渲染体系能带来高度一致的视觉。
- **GPUI**：Rust 和 GPU 能构建复杂的高性能桌面应用。
- **Qt**：专业桌面应用能拥有极其成熟的组件与工程体系。
- **Slint**：轻量的声明式界面能覆盖嵌入式和资源受限的设备。

但真正做产品时，需求不会按框架边界出现。产品会上常有这样一份清单：

- 要 macOS、Windows、Linux，也要 iOS、Android，还要 Web，甚至终端。
- 要一份代码，尽可能共享组件、布局、业务逻辑和开发工具。
- 要原生界面，而不是把整个应用做成网页套壳。
- 要 TSX 和 CSS 风格的开发体验，也要 Rust 的性能和系统能力。
- 要低 CPU、低 GPU 开销、低功耗、启动快、体积小。
- 要专业桌面应用的 Dock、表格、编辑器、复杂布局和多窗口，也要手机上自然的触摸、输入法、焦点和无障碍。
- 要用 Rust 扩展文件索引、音视频处理、复杂计算和系统 API。
- 要能嵌入现有应用，也要可签名、可授权、可吊销的受控动态界面。

NSH 的目标，是让这些需求不再迫使团队同时维护几套互不兼容的 UI 框架。它不是把现有框架拼在一起，而是在同一个 Rust 核心上，把原生界面、Web 风格的开发体验、细粒度的 Retained Mode、专业组件、跨平台后端和模块扩展组织成一个完整的应用体系：

| 你想要 | NSH 的做法 |
|---|---|
| 专业桌面 | macOS、Windows、Linux；多窗口、Dock、编辑器、表格 |
| 原生手机 | iOS 的 UIKit、Android 视图 |
| 真正的 Web | HTML 元素、CSS、浏览器 DOM 与 Web API |
| 终端 | [TUI](./tui.md) 后端 |
| 一份代码 | 共享组件、布局、响应式模型和业务逻辑 |
| Web 风格的开发体验 | TSX、Flexbox、Grid、[Tailwind](./tailwind.md) 风格样式 |
| Rust 的性能 | Rust 核心、纯 Rust 应用、[nshm](./nshm.md) 扩展 |
| 低资源开销 | Retained Mode、细粒度更新、原生界面不带 Chromium |
| 完整的原生交互 | 尽可能复用系统视图、输入、焦点和无障碍 |
| 简单的工程体系 | 一个 `nsh` CLI，Apache-2.0 核心许可 |
| 发布后下发界面 | 签名包、能力授权、沙箱与吊销（受平台和应用商店规则约束） |

这些需求不是彼此独立的清单，而是一个真实产品可能同时面对的约束。

**Build once, native everywhere.**

## 如何评估：先做一个试点

不需要一次重写。NSH 应用可以独立打包，也可以作为一个视图嵌入现有的 iOS、Android 或桌面应用（[嵌入现有应用](./embedding.md)），所以可以从一个界面开始：

1. **选一个对你们最敏感的场景**：实时数据和图表、复杂富文本或 AI 聊天页、需要动态下发的模块，或者一个桌面客户端里的模块。
2. **用 NSH 并行实现它**：界面可以先用 TSX，关键逻辑和计算放进 Rust。
3. **用你们自己的数据对比**：启动时间与内存；高频更新时的 CPU 与帧率；长内容的滚动流畅度、文本选择与输入法是否自然；菜单、窗口和文本输入在各平台上是否一致；如果有动态下发，再看签名校验、能力限制与回滚。

`nsh` 的 trace 和[性能报告](./performance-report.md)里的测量方法可以直接用于这些对比。
## 发布之后下发的界面

应用想要显示安装包里没有的界面——由模型生成的回答、来自合作方或其他团队的功能、无需发版就能变化的页面——无论在手机还是桌面上，都已有几种成熟的做法。它们的区别在于：界面由什么绘制，下发的代码能做什么，以及宿主应用要为承载它们做多大的改动。

NSH 的界面以自定义外观为主。应用决定组件的样式，也可以在支持的平台上使用 Liquid Glass 等系统材质。文本编辑、输入法和选择等交互沿用平台行为。

| 能力 | NSH | WebView | 服务端驱动 UI | 小程序容器 | OTA 更新 |
|---|---|---|---|---|---|
| 由什么绘制 | 平台界面 | 浏览器引擎 | 应用自己的视图 | 网页引擎加专有层 | 框架的渲染器 |
| 原生交互行为 | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--no" role="img" aria-label="不支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> | <span class="status status--partial" role="img" aria-label="部分支持"></span> | <span class="status status--yes" role="img" aria-label="支持"></span> |
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

- 界面以数千个视图持续、密集的更新为主——每秒推送数万条行情的交易终端、每帧重画的自定义可视化：GPUI Fast 的 Retained GPU 渲染只占用其中一小部分 CPU（见上文“挑战 GPUI”一节）。
- 应用必须在每个平台上像素级一致：Flutter、Slint 这类自己绘制一切的框架天生如此。
- 你现在就需要庞大的第三方包生态：React Native、Flutter 和 Qt 积累了多年。
- 界面是一份文档或一个现成的网页：WebView 能原样显示它。
- 页面集合固定且很少，变化的只是内容和顺序：服务端驱动 UI 完全不需要运行时。

## 另请参阅

- [简介](./index.md)：NSH 是什么，以及它所说的 Native 是什么意思。
- [架构](./architecture.md)：NSH 内部什么在哪里运行。
- [性能](./performance.md)：NSH 遵循的规则，以及如何测量一个应用。
