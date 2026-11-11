---
title: 构建平台
description: 把 Native Shell 应用带到你自己的平台：后端要实现的引擎、挂载批次、文本与输入，nsh 命令行的外部 target，以及作为完整案例的微信小程序平台。
order: 17
group: platforms
---

# 构建平台

Native Shell 的 iOS、Android、macOS、Windows、Linux、GPUI、终端和 Web 后端都构建在一个公开的引擎之上，其他平台也一样。在 NSH 之外构建的平台放在自己的仓库里，使用的正是 NSH 自己的后端所用的 API：引擎运行应用（组件、布局、响应式和文本测量），后端用平台自己的界面显示引擎提交的内容，并把用户的输入送回引擎。`nsh` 命令行按名字运行这样的平台：`nsh package --target miniprogram` 会运行程序 `nsh-platform-miniprogram`。

本页借一个完整的例子逐一讲解后端的各个部分：[`nsh-platform-miniprogram`](https://github.com/huacnlee/nsh-platform-miniprogram)。它在微信小程序中运行用 Rust 编写的 NSH 应用，用于演示这些扩展能力；有意继续发展它的维护者可以按其 README 联系作者接手。

## 使用在 NSH 之外构建的平台

平台以名为 `nsh-platform-<name>` 的程序发布。安装它并确保它在 `PATH` 上，然后把它的名字当作 target 使用：

```sh
cargo install --git https://github.com/huacnlee/nsh-platform-miniprogram nsh-platform-miniprogram-cli
rustup target add wasm32-unknown-unknown

nsh package my-app --target miniprogram --out dist   # 生成一个可以用微信开发者工具打开的项目
nsh run my-app --target miniprogram                  # 构建后在微信开发者工具中打开
```

应用判断平台的方式与其他平台相同：在 TSX 中 `platform.name` 是 `"miniprogram"`，在 Rust 中是 `platform_name()`。`platform.os`（Rust 中是 `os()`）是设备的操作系统 iOS 或 Android，因此应用的 `ios={{…}}` 和 `android={{…}}` 属性在小程序中照常生效。平台自己的 README 列出了它能显示的内容和支持的命令。

## 平台的组成

```
你的应用             组件、布局、状态：在所有平台上是同一份代码
nsh-engine          运行应用；每一轮提交一个变更批次
你的后端             把每个批次应用到平台的视图上；测量文本；把输入送回引擎
nsh-platform-<name> 命令行的 target：为该平台构建、运行和打包应用
```

后端有四项工作，每项在 NSH 中对应一个接口：

| 工作 | 接口 | 小程序平台的做法 |
|---|---|---|
| 运行应用 | `nsh_engine::Engine` 或 `LocalEngine` | 在小程序逻辑层的 WebAssembly 中运行 `LocalEngine` |
| 显示提交的内容 | `nsh_engine::MountSink`、`nsh_core::MountItem` | 编码成 JSON 操作，用 `setData` 应用到页面 |
| 测量文本 | `nsh_core::TextEngine` | 用逻辑层的 `measureText` 测量，在引擎一侧断行 |
| 送回输入 | `nsh_engine::EngineControl` | 点击作为 `onPress`，以及滚动位置、尺寸和外观的变化 |

## 1. 启动引擎

引擎在平台的线程上运行应用：`Engine` 有自己的线程，`LocalEngine` 则由平台的事件循环驱动（适用于没有可阻塞线程的 WebAssembly）。用一个说明应用运行环境的 `EngineConfig` 启动它。在 NSH 之外构建的平台把自己的名字放在 `platform` 中，把设备的操作系统放在 `os` 中：小程序是运行在 iOS 或 Android 上的平台。小程序平台从 `wx.getDeviceInfo().platform` 读取操作系统，在微信开发者工具中则读取模拟设备的 `system`。

```rust
use nsh_core::{Points, Size, platform::{Idiom, Os}};
use nsh_engine::{App, EngineConfig, Environment, LocalEngine};

let config = EngineConfig {
    viewport: Size::new(Points(375.0), Points(667.0)),
    environment: Environment {
        os: Os::Ios,                    // 设备的操作系统：应用中的 platform.os
        platform: Some("miniprogram"),  // 应用中的 platform.name
        idiom: Idiom::Phone,
        ..Environment::default()
    },
    header_heights: nsh_core::NO_NATIVE_HEADER, // 页面自己放置 header
    ui_sets,
    ..EngineConfig::new(App::Rust(root))
};
let mut engine = LocalEngine::start(config, text_engine, sink).expect("the app starts");
```

`LocalEngine::pump()` 运行到期的工作，并返回下次到期的时间：平台在那个时间以及每次输入之后调用它。对用 Rust 编写的应用，以 `default-features = false` 依赖 `nsh-engine`，引擎就能构建到 `wasm32-unknown-unknown`。

## 2. 显示引擎提交的内容

引擎每次提交通过 `MountSink::submit` 交给后端一个 `MountBatch`。其中的条目创建视图、把视图插入父视图、设置它们的 frame、装饰、文本、图片和要上报的事件，以及移除视图。每个 frame 都是最终结果，由引擎以 point 为单位、相对父视图布局好，后端只需把每个视图放到 frame 指定的位置：

```rust
impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        for item in &batch.items {
            match item {
                MountItem::Create { id, kind } => { /* 创建 `kind` 类型的视图 */ }
                MountItem::Insert { parent, child, before } => { /* 放在 `before` 之下，或放在最上层 */ }
                MountItem::Frame { id, frame } => { /* 放到 `frame` */ }
                MountItem::ViewStyle { id, style } => { /* 背景、圆角、边框、不透明度 */ }
                MountItem::Text { id, layout, content, .. } => { /* 在 `content` 处绘制文本布局 */ }
                MountItem::Events { id, events } => { /* 上报 mask 中的事件 */ }
                _ => {}
            }
        }
    }
}
```

按顺序应用这些条目；平台不显示的类型直接跳过。小程序平台把每个批次编码成一个 JSON 数组（`["c", 2, "view"]`、`["f", 2, 0, 0, 100, 40]`……），在逻辑层把视图保存为一棵普通对象树，并用尽量少的 `setData` 路径更新页面；页面中一个递归的自定义组件把每个视图绘制在它的 frame 上。

## 3. 测量文本

文本在引擎一侧只布局一次：每段内容调用一次 `TextEngine::prepare`，布局尝试不同宽度时调用 `measure`，最终尺寸确定后调用 `layout`。布局结果是平台自己的对象，`MountItem::Text` 会把它带回后端用于绘制：

```rust
impl TextEngine for MiniProgramTextEngine {
    type Prepared = Prepared;
    fn prepare(&self, text: &AttributedText) -> Prepared { /* 字体，以及可断行的片段 */ }
    fn measure(&self, p: &Prepared, max_width: Option<Points>) -> Size<Points> { /* 最宽一行的宽度与各行总高度 */ }
    fn layout(&self, p: &Prepared, size: Size<Points>) -> TextLayout { /* 每一行的文本和位置 */ }
}
```

小程序平台用逻辑层的 canvas 测量，在空格处和 CJK 字符之间断行，并把每一行绘制在测量时的位置上，因此页面显示的文本与引擎的布局完全一致。

## 4. 送回输入

`EngineControl` 发送用户的操作：视图上报按下事件时，点击用 `dispatch_event(id, EventKind::Press, EventPayload::None)`；滚动视图移动时用 `scroll(id, offset, 0)`；窗口或外观变化时用 `resize(size)` 和 `set_environment(environment)`；引擎请求的显示帧（`MountSink::request_frame`）到来时用 `frame()`。

## 5. 加入命令行 target

`nsh dev`、`nsh run`、`nsh test` 和 `nsh package` 的 `--target` 不是 NSH 自带的 target 时，会运行 `PATH` 上的 `nsh-platform-<name>`。它收到命令和其余所有参数，以及环境变量 `NSH`（`nsh` 可执行文件，用于回调）、`NSH_VERSION` 和 `NSH_TARGET`；它的退出码就是命令的退出码：

```sh
nsh package my-app --target miniprogram --out dist
# 运行：nsh-platform-miniprogram package my-app --out dist
```

对用 Rust 编写的应用，`$NSH build <app>` 会写出 crate `.nsh/rust/rust-app`（`nsh_rust_app`），以函数的形式提供应用的根组件和 UI set：平台的 runner 按路径依赖它，并用它们启动应用。小程序平台的 runner 只有一行：

```rust
nsh_platform_miniprogram::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root());
```

`app_ui_sets()` 提供应用自己 crate 的 UI set（包括它们附带的字体和文件），不含 `nsh/base` 面向 TSX 的注册表，因此模块只链接应用用到的组件；`ui_sets()` 两者都提供。

## 测试平台

后端的每个部分都可以脱离平台自己的工具来测试：

- **后端**：在你的电脑上用平台的 sink 和一个确定性的文本引擎，在 `LocalEngine` 上启动应用，检查一次按下所提交的内容。
- **平台一侧**：用平台的运行时或它的替身，测试它如何应用一个批次。
- **完整应用**：用平台 API 的替身运行打包好的应用。小程序平台在 Node 上通过真实的运行时加载打包后的模块，点击按钮并检查显示的计数。

然后在平台上打开应用：`nsh run my-app --target miniprogram` 会在微信开发者工具中打开小程序。

## 跟随 NSH

平台针对某个 NSH 版本构建：挂载条目、文本引擎和事件是 NSH 的协议，会随每次发布扩展。请固定平台构建所用的 NSH 版本，并为每个 NSH 版本重新发布平台。在 WebAssembly 中，NSH 的 crate 会从宿主导入几个函数（模块 `nsh`：`now_ms`、`date_now_ms`、`local_offset`）；平台在打包应用时检查模块的导入，因此新增的导入会在构建时显现。

## 另请参阅

- [平台概览](./platforms.md)：NSH 自带的平台。
- [架构](./architecture.md)：引擎、挂载批次和文本在各平台上的工作方式。
- [用 Rust 开发](./rust.md)：用 Rust 编写的应用及其根组件。
- [nsh-platform-miniprogram](https://github.com/huacnlee/nsh-platform-miniprogram)：微信小程序平台的源码和 README。
