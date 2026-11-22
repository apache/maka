---
title: 架构
description: NSH 应用是如何运行的：构建流程、引擎线程与主线程、从 signal 变化到原生视图的路径、原生响应式图、文本布局以及各个 crate。
order: 63
group: tools
---

# 架构

本页面向想了解从 `count.set(1)` 到屏幕上标签变化之间发生了什么的应用开发者，无论应用用 Rust 还是 TSX 编写。编写应用并不需要读它，但它解释了 NSH
为什么会有现在的行为：为什么组件只运行一次，为什么 JS 繁忙时动画依然流畅，为什么主线程从不等待你的代码。

## 全局概览

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/architecture-light.svg" alt="nsh 应用如何运行：nsh CLI 把 App.tsx 构建为字节码；在引擎线程上，QuickJS 运行事件处理函数，nsh-js 的响应式图把操作排入队列，nsh-core 提交生成一个 MountBatch；它一次跳转到主线程，应用到 UIKit 或 Android 视图上；触摸作为事件传回引擎线程。原生动画在主线程运行，不经过 JavaScript。">
<img class="diagram diagram-dark" src="/diagrams/architecture-dark.svg" alt="nsh 应用如何运行：nsh CLI 把 App.tsx 构建为字节码；在引擎线程上，QuickJS 运行事件处理函数，nsh-js 的响应式图把操作排入队列，nsh-core 提交生成一个 MountBatch；它一次跳转到主线程，应用到 UIKit 或 Android 视图上；触摸作为事件传回引擎线程。原生动画在主线程运行，不经过 JavaScript。">
</div>

## 构建：只有你的代码会成为 JS

`nsh build`、`nsh dev` 以及其他命令使用一套用 Rust 编写的工具链（无需 Node.js）打包你的应用：

1. **Oxc** 去掉 TypeScript 类型。
2. **NSH 的 JSX 编译器**在同一遍处理中把 JSX 转换为对原生渲染器的直接调用。静态的 prop 和子节点只设置一次；可能变化的
   表达式（调用了函数或读取了属性）会成为渲染器跟踪的绑定。组件变成普通的函数调用，传入一个 props 对象，其中会变化的
   prop 是 getter。
3. **rolldown** 把你的模块打包成一个 ES 模块。对 NSH 模块（`nsh`、`nsh/base`、`nsh/mobile` 等）的导入保持为导入：
   这些模块是原生的，由运行时提供。**bundle 只包含你的应用代码**；计数器示例的 JS 不到 1 KB。
4. bundle 被编译为 **字节码**（`bundle.nshc`），加载比源码更快；同时会跨所有步骤合成一份 **source map**，
   让堆栈跟踪指向你的 `.tsx` 代码行。

你导入的图片和字体会作为资源收集起来，供编辑器使用的类型声明则写入 `.nsh/types`。

用 Rust 编写的应用没有 bundle：Cargo 为每个目标构建链接了你的 crate 的运行器，`nsh.json` 指定的根组件以原生方式在引擎上运行。下文的一切同样适用于它，只是你的组件代码在 Rust 中运行，而 TSX 应用的代码在 QuickJS 中运行。

## 运行：每个应用两个线程

每个运行中的应用（iOS 上的一个 `NshAppView`、Android 上的一个 `NshView`、打包应用的窗口）都是一个**引擎**，拥有
自己的**引擎线程**，TSX 应用还拥有自己的 QuickJS 虚拟机。没有任何全局单例，所以一个宿主应用中可以并行运行多个应用。

### 引擎线程

应用逻辑的一切都发生在这里：

- **你的代码**在这里运行：组件、事件处理函数、定时器、effect。Rust 组件以原生方式运行；TSX 运行在 **QuickJS** 中。
- **响应式图**（signal、computed 值、effect、owner、context）是原生的。它的节点是原生类的 QuickJS 对象，因此垃圾回收器
  能通过它们看到引用关系，但依赖追踪和更新调度都由 Rust 完成（遵循 Solid 1.9 的算法）。
- 编译后的 JSX 所调用的**渲染器**是原生的。它创建节点，并把每个变化转换为一个 **op**，直接推入原生队列：没有 JSON，
  也没有每个 prop 一条的消息。
- **core** 维护所有节点的影子树（shadow tree）。一个 JS 轮次结束时，它一次性取出所有排队的 op 并进行 **commit**：
  渲染 Rust 组件（`nsh/base` 的和应用自己的组件），解析内边距和外边距中的 `env()` 边距，重建变化的文本，用 **Taffy** 布局（flexbox 和 grid，默认纵向排列且不收缩），
  对 frame 和样式做 diff，并生成一个 **MountBatch**：原生视图所需的操作列表。

### 主线程

平台的主（UI）线程以一次跳转应用每个 MountBatch：创建视图、插入视图、设置样式和 frame、交付已布局好的文本。除此之外，
它只做必须在主线程上做的事：

- **绘制文本**，这些文本已在引擎线程上布局完成；
- **原生动画**：`nsh` 的动画值逐帧驱动（iOS 上用 `CADisplayLink`，Android 上用 UI 线程动画器），并直接写入视图；
- **手势和滚动**：触摸转换为事件发送到引擎线程；`scrollValue` 和 `pan` 在同一帧内为动画值提供数据。

**主线程从不等待 JS。** 当系统需要立即得到答复时（这段文本能否修改、返回键能否弹出此页面、这个 sheet 能否关闭），答案
早已作为 prop 挂载好了，JS 事后通过事件得知。繁忙的引擎线程可能会延迟更新，但无法冻结滚动、动画或系统手势。

## 从一次点击到屏幕

```text
 main thread               engine thread                                              main thread
 ───────────               ─────────────────────────────────────────────────────      ───────────
 tap on a view ─ event ─▶  handler runs: count.set(count() + 1)
                           reactive graph: the bindings that read count() run again
                           renderer: one op per changed binding → native queue
                           JS turn ends → core commit: render, text, layout, diff
                           → MountBatch (e.g. 1 Text item)                 ─ hop ─▶   apply: draw the new text
```

在计数器示例中，Mac 上的 release 构建里一次点击（JS 加 commit）约耗时 0.12 ms，并产生少量 mount item（参见
[测试](./testing-and-trace.md)）。

在 Rust 应用中，处理函数是一个 Rust 闭包（`count.set(count.get() + 1)`），之后是同样的响应式图、commit 和 batch，中间没有解释器。

这一设计带来三个特性：

- **一个轮次就是一次 commit。** 无论处理函数设置了多少个 signal，视图都只一起变化一次。
- **组件只运行一次。** 只有绑定会重新运行；没有组件重新渲染，也没有虚拟 DOM diff。剩下的 diff 由 core 在 Rust 中对
  frame 和样式进行。
- **只传输变化。** 未变化的样式和 frame 不会发送；新视图不带默认值。

## 文本：在主线程之外只布局一次

文本往往是 UI 中开销最大的部分。NSH 在引擎线程上使用平台自己的文本引擎布局文本，因此它看起来与原生文本完全一致：

1. **prepare**：一个 `<Text>` 及其嵌套的 span 合并成一个属性字符串（Apple 平台上用 CoreText，Android 上用
   `PrecomputedText` / `StaticLayout`）；
2. **measure**：按布局请求的宽度测量；测量结果按内容和宽度缓存，所以仅改变颜色不会重新测量；
3. **layout**：按最终尺寸布局。

主线程接收不可变的结果，只负责绘制。嵌套在 `<Text>` 中的文本是 span，而不是视图；`<Text>` 之外的字符串不会渲染任何内容。

## 列表

`List` 在原生侧虚拟化。core 决定哪些行靠近视口，计算位置、多列布局和吸顶标题，并复用单元格。当一个单元格需要显示另一个
条目时，运行时会重新绑定它（你的行函数中的 `item()` 和 `index()` accessor 会变化）；没有露出新行的帧完全不调用 JS。
参见[列表](./lists.md)。

## 运行时做的其他事情

- **网络**：`fetch` 和其他全局 API 都是原生类。请求交给平台的 HTTP 栈（`NSURLSession`、`HttpURLConnection`），双向流式传输。
- **图片**在主线程之外下载和解码，按视图尺寸处理，并带有内存缓存。
- **限制和能力**由运行时在 Rust 中强制执行：参见[沙箱与能力](./sandbox-and-capabilities.md)。
- **热模块替换**同样是原生的：补丁由运行时在远低于一毫秒的时间内应用（参见[开发服务器与调试](./dev-server-and-debugging.md)）。

<a id="three-layers"></a>

## 三层结构

NSH 的界面分为三层，与 GPUI Kit 的分层相同：

| 层 | NSH | GPUI Kit | 说明 |
|---|---|---|---|
| 基础元素 | `nsh-core` 和运行时（`nsh`、`nsh/mobile`、`nsh/desktop`） | `gpui` | 宿主元素、样式、布局、渲染、响应式、环境 |
| 基础组件 | `nsh-base`（`nsh/base`） | `gpui-base` | 无样式的组件，负责行为、状态、焦点、键盘和无障碍，外观取自应用 |
| 组件库 | 你的应用自己的，或社区的 | `gpui-component` | 带样式的组件：带有外观的按钮、卡片、列表行 |

前两层属于 Native Shell。第三层属于你：应用在 `nsh/base` 和基础元素之上构建自己的组件库，可以用 TSX 编写，也可以写成
[自己 crate](./rust.md) 中的 Rust 组件；也可以使用社区发布的组件库，或者直接在应用中设置界面样式。

## crate 一览

NSH 是一个 Rust workspace。编写应用时你永远不需要构建它（发行版附带 CLI 和预构建的运行时），但这些名字会出现在日志和
文档中：

| Crate | 说明 |
|---|---|
| `nsh-core` | 平台无关的核心：影子树、样式、Taffy 布局、文本合并、列表虚拟化、mount item；CSS 值和 Tailwind；原生动画图（值、插值、timing / spring / decay）；Rust 组件的框架和主题；运行时用 Rust 编写的模块（`nsh/mobile` 的 `BackHandler` 等）。 |
| `nsh-base` | `nsh/base`，无样式的基础组件（NSH 的 `gpui-base`）：导航、对话框、控件和状态栏；Rust 应用以 `nsh_base` 使用它。 |
| `nsh-js` | QuickJS 宿主和 NSH 的运行时：响应式图、渲染器、所有原生模块、全局 API、热模块替换、限制；以及这一切的 TypeScript 声明。 |
| `nsh-engine` | 引擎线程：驱动 `nsh-js` 和 `nsh-core`，每帧向平台交付一个 batch。 |
| `nsh-package` | 签名包：密钥、证书、吊销、信任库。 |
| `nsh-bundler` | 打包器：rolldown、Oxc、NSH 的 JSX 编译器、source map、Tailwind 类名检查。 |
| `nsh-dev` | 开发服务器及其客户端。 |
| `nsh-platform-ios` | UIKit 后端（iOS、模拟器、Mac Catalyst）：视图挂载、CoreText 文本引擎、输入；嵌入 SDK。 |
| `nsh-platform-android` | Android 后端：`libnsh.so` 和 Java 运行时（`NshView`、各类视图、图片、网络）。 |
| `nsh-cli` | `nsh` 命令。 |

依赖方向是 `nsh-core` ← `nsh-js` ← `nsh-engine` ← 各平台；`nsh-base` 构建在 `nsh-core` 之上。core 不依赖任何平台，也不依赖任何 JS 引擎，正因如此
`nsh test` 才能在任何机器上无界面地运行真实的运行时。

## 另请参阅

- [性能](./performance.md)
- [响应式](./reactivity.md)
