---
title: 模块
description: NSH 应用可以导入的模块、各模块导出的内容以及它们的组织方式。
order: 1
---

# 模块

NSH 应用用到的一切都从一小组模块导入。这些模块全部是原生的：响应式图、渲染器和每个模块都在运行时内部用 Rust 实现，打包器会把 `import ... from "nsh/..."` 原样保留为导入，而不会把代码复制进你的 bundle。你的 bundle 里只有你自己的代码。

```tsx
import { createAnimatedValue, mount, signal, windowSize } from "nsh";
import { Button } from "nsh/base";
import { TabBar } from "nsh/mobile";
```

<a id="three-layers"></a>

## 三层结构

NSH 的界面分为三层，与 GPUI Kit 的分层（`gpui`、`gpui-base`、`gpui-component`）相同：

| 层 | 模块 | 为应用提供什么 |
|---|---|---|
| 基础元素 | `nsh`、`nsh/mobile`、`nsh/desktop` | 响应式、宿主元素、布局、列表、画布、动画、手势、设备信息以及各平台自己的 API |
| 基础组件 | [`nsh/base`](./nsh-base.md) | 无样式的组件，负责行为、状态、焦点和无障碍：按钮、Markdown 与 HTML 文档、导航栈与对话框和系统对话框，各平台通用 |
| 组件库 | 你的应用自己的，或社区提供的 | 带有外观的按钮、卡片、列表行和页面 |

应用的外观由应用自己决定。它的组件库就是第三层：用[宿主元素](../elements/index.md)和 `nsh/base` 写成的组件，通过 `style`、[Tailwind](../docs/tailwind.md) 类和主题设置样式；或者是它在[自己的 crate](../docs/rust.md) 中提供的 Rust 组件；也可以是社区基于同一基础发布的组件库。

NSH 没有“大而全”的汇总模块：每个 API 只存在于一个地方。移动平台的 API 位于 `nsh/mobile`（iOS 和 Android），桌面的 API 位于 `nsh/desktop`（macOS、Windows、Linux）；两者在所有平台上都可以导入，因此同一个 bundle 可以在所有平台运行（在其他平台上调用它们会立即返回，`platform.os` 告诉你当前在哪个平台上）。

类型声明由运行时生成：`nsh init`、`nsh build`、`nsh dev` 和 `nsh test` 会在应用旁边写出 `.nsh/types`，所以 TypeScript 声明始终与你所用的运行时一致（见[项目结构](../docs/project-structure.md)）。

## 全部模块

| 模块 | 导出 | 页面 |
|---|---|---|
| `nsh` | `signal`、`computed`、`effect`、`batch`、`untracked`、`cleanup`、`context`、`split`、`mount`、`ErrorBoundary`；原语 `View`、`Text`、`Scroll`、[`List`](./nsh-list.md)、[`Image`](./nsh-image.md)（以及 `Image.getSize`、`Image.prefetch`）、[`Canvas`](./nsh-canvas.md)（以及 `Path2D`、`CanvasRenderingContext2D`、`CanvasGradient`）、[`WebView`](./nsh-webview.md)、[`Video`](./nsh-video.md)；`safeArea`、`safeAreaInsets`；`Keyboard`、`keyboardFrame`；元素、样式、事件和 JSX 的类型（`YNode`、`ViewStyle` 等）；[动画](./nsh.md#animation)（`createAnimatedValue`、`AnimatedValue`、`AnimatedNode`、`Animated`、`Easing`、`LayoutAnimation`）；[环境](./nsh.md#device)（`windowSize`、`colorScheme`、`setColorScheme`、`fontScale`、`pixelRatio`、`locale`、`platform`、`openUrl`）；[`PanResponder`](./nsh.md#panresponder)；[`Clipboard`](./nsh.md#clipboard)；[`Picker`](./nsh.md#picker)；[`Storage`](./nsh.md#storage)；[`host`](./nsh.md#host)（`available`、`call`、`on`，以及原生 SDK 的 `params`、`post`）；[`keymap`](./nsh.md#keymap)（键盘快捷键）；[`nativeComponent`、`nativeModule`](./nsh.md#nativecomponent-and-nativemodule)（宿主应用注册的原生组件和函数）；[无障碍](./nsh.md#accessibility)（`announce`、`setAccessibilityFocus`、`screenReaderEnabled`、`reduceMotion`） | [nsh](./nsh.md) |
| `nsh/base` | `Button`、`Input`；`TextView`；`createNavStack`、`NavStack`、`NavPage`、`Dialog`；`AlertDialog` | [nsh/base](./nsh-base.md) |
| `nsh/mobile` | `isAvailable`、`TabBar`（系统标签栏，iOS 和 Android）、`InputAccessoryView`（iOS）、`BackHandler`（Android） | [nsh/mobile](./nsh-mobile.md) |
| `nsh/desktop` | `isAvailable`、`Window`（标题、标题栏、最大化、全屏）、`titleBar`、`Menu`（应用菜单、右键菜单） | [nsh/desktop](./nsh-desktop.md) |
| Standard modules | `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib` | [标准模块](./standard-modules.md) |
| 全局对象 | `fetch`、`URL`、`TextEncoder`、`Blob`、`FormData`、`AbortController`、`Intl`、定时器、`console`、`requestAnimationFrame` 等（无需导入） | [全局 API](./globals.md) |

以下参考页面不对应模块：

| 页面 | 内容 |
|---|---|
| [样式参考](./style-reference.md) | 每个样式键的类型和含义 |
| [Tailwind 参考](./tailwind-reference.md) | `class` 支持的 Tailwind 工具类和变体 |

## 宿主元素

宿主元素和其他一切一样是需要导入的组件：`View`、`Text`、`Scroll`、`Image`、`List`、`Canvas`、`WebView`、`Video` 和 `Overlay` 来自 `nsh`，基础组件（`Button`、`Input`、`Dialog`、`NavStack`、`NavPage`）来自 `nsh/base`，`InputAccessoryView` 来自 `nsh/mobile`。只有 `If` 和 `Each` 是全局组件。编译器会就地创建这些元素，所以导入在运行时没有任何开销。它们的属性见[元素](../elements/index.md)。
