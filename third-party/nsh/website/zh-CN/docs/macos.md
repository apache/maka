---
title: macOS
description: 在 macOS 上用 AppKit 窗口运行 Rust 和 TSX 编写的 NSH 应用、打包为 .app、用 AppView 嵌入 Mac 应用，以及 macOS 上的差异。
order: 13
group: platforms
---

# macOS

NSH 应用也能作为原生 Mac 应用运行。macOS 后端用 AppKit 视图和 Core Animation 渲染应用，用 CoreText 排版文字；核心、响应式图、
渲染器、Taffy 布局以及原生模块与 iOS、Android 上完全相同，因此同一个应用可以在所有平台上运行。在 macOS 上，
`os()` 为 `Os::MacOs`（TSX 中 `platform.os` 为 `"macos"`），并会应用 TSX 的 `desktop={{…}}` 属性。窗口标题、自定义标题栏、
菜单栏和右键菜单在 Rust 中由 `nsh_core::element::desktop` 提供（[桌面标题栏](./rust.md#桌面标题栏)），在 TSX 中由
[`nsh/desktop`](../modules/nsh-desktop.md) 提供。

macOS 后端的行为是桌面应用：鼠标、触控板和键盘输入，可调整大小的窗口，覆盖窗口的对话框和菜单栏。

## 环境要求

- 运行应用的机器需要 **macOS 14** 及以上。
- Xcode 命令行工具（`xcode-select --install`），用于构建 Rust 应用的 runner、从源码构建 NSH 的 macOS 运行时以及打包应用
  （`codesign`、`sips`）。在 Mac 上用 `cargo xtask dist` 制作的发行版把 TSX 应用的运行时放在 `runtime/macos/` 中。

## 运行应用

Rust 应用在自己的目录里运行：

```sh
nsh run --target macos         # Mac 上的默认目标
```

`nsh` 用你的 crate 构建一个 debug runner，在窗口中打开应用，并在终端显示它的日志（`log::info!` 等）；修改 crate 的 Rust 代码会重新构建
runner 并重启应用。`cargo run` 从 crate 的 `src/main.rs`（由 `nsh init --template rust` 生成）启动同一个根组件：用
`AppSource::Rust` 调用 [`run_app`](#嵌入-mac-应用)。

TSX 应用需写明入口：

```sh
nsh run App.tsx --target macos
```

应用会在一个 AppKit 窗口（默认 1200×800）中打开，和其他目标一样支持热重载、在终端显示日志并提供错误浮层；Cmd+R 重新加载最新构建。
菜单栏和窗口显示应用的名称（nsh.json 的 `"name"`，否则是应用目录的名称）。在源码仓库中，`nsh run` 会先构建开发宿主（`nsh-macos-host`）。停止 `nsh run` 会关闭窗口，关闭窗口也会结束 `nsh run`。
宿主也可以单独运行一个构建好的 bundle：

```sh
nsh build my-app --release -o build
dist/nsh/runtime/macos/nsh-macos-host --bundle build/bundle.nshc --window-size 1200x800   # 源码仓库中：target/debug/nsh-macos-host
```

`--window-size` 是窗口的初始尺寸（TSX 应用）；窗口可以调整大小。`--display <n>`（`nsh run` / `nsh test --target macos --display <n>`）让窗口在第 `n` 个显示器上居中打开：`1` 是主显示器，即带菜单栏的那个。

`nsh test --target macos` 在 macOS 窗口中运行 TSX 应用的测试，有副显示器时窗口开在副显示器上（主屏留给你用；`--display <n>` 可以另选）：测试打开的每个应用都有自己的窗口，尺寸就是测试要求的尺寸，显示器比窗口矮时也一样；步骤用系统的输入在选择器指向的视图上点击、输入和滚动（[测试](./testing-and-trace.md#在真实平台上运行)）。

### 性能监视器

`--fps`（Rust 应用在 `run_app` 中用 `AppOptions { fps: true, .. }`，嵌入时用 `AppView::set_fps_monitor(true)`，
以及 `nsh run App.tsx --target macos --fps`、宿主的 `--fps`、打包后 TSX 应用的 `open -a MyApp --args --fps`）会在应用右上角显示一个每秒刷新两次的面板：

| 行 | 测量内容 |
|---|---|
| `FPS` | 最近一秒显示的帧数：应用有变化的屏幕刷新次数（空闲的应用读数低，这不代表慢）。`max` 是主线程能跟上的帧率，之后是显示器的刷新率（ProMotion 屏幕为 120 Hz）。 |
| `TICK` | 屏幕刷新实际到达的间隔（均值、p95），以及 `gap`：显示帧之间间隔的 p95。没有迟到时为一次刷新的时长（120 Hz 下 8.3 ms）。 |
| `MAIN` | 每帧的主线程耗时（应用引擎的变更、绘制文本和画布、动画、输入）、它的 95 分位数，以及 `drop`：超过一次刷新时长的帧所占比例。 |
| `JS` / `CORE` | 每次 commit：你的代码（事件处理、定时器、列表行）和 NSH 核心（布局、文本、diff）的耗时；每秒 commit 数、每次 commit 的原生视图变更数。 |
| `HOP` | 变更在引擎线程和主线程之间等待的时间；引擎线程的繁忙程度。 |
| `CPU` / `GPU` / `MEM` | 进程：CPU（100% 为一个核心）、它占用的 GPU 比例、内存占用（活动监视器中的数值）。 |

下方的柱状图是最近 120 帧的主线程耗时，与一次刷新的时长（横线）对比：在一半以内为绿色，在其以内为琥珀色，超过为红色。
面板显示时，读数也会每秒记录到日志一次（target `nsh::perf`，格式与 Linux 后端相同，帧阶段为 macOS 的 `tick`、`drain` 和 `canvas`；毫秒，依次为 mean/p50/p95/max），`nsh test --fps -v` 会显示这些日志，`examples/gallery/tools/perf.py` 会读取它们。请测量 release 构建；监视器关闭时没有任何开销。

## 打包

```sh
nsh package --target macos [--run]           # Rust 应用，在它的目录里
nsh package App.tsx --target macos [--run]   # TSX 应用
```

会写出一个应用包：

```text
.nsh/out/<Name>.app/Contents/
  Info.plist
  MacOS/<Name>               可执行文件：Rust 应用是用它的 crate 构建的自有 runner；TSX 应用是 nsh 的发布版运行器
  Resources/nsh/bundle.nshc  编译后的 TSX 应用
  Resources/nsh/assets/…     应用导入的资源（也包括 Rust crate 的 `assets!()`）
  Resources/nsh/app.json     窗口标题和应用的外观
  Resources/AppIcon.icns     图标（nsh.json 指定了图标时，用 sips 转换）
```

`.app` 使用 ad hoc 签名，因此可以在构建它的 Mac 上运行。要分发它，请用 Developer ID 签名并进行公证。`--run` 会在打包后打开应用。

## 嵌入 Mac 应用

`nsh-platform-macos` crate（位于 NSH 仓库中）为 Rust 编写的 Mac 应用提供 `AppView`：一个作为 `NSView` 的 NSH 引擎。每个
`AppView` 相互独立，可以同时运行多个。它运行一个 Rust 根组件，即你的 crate 的根组件：

```rust
use std::rc::Rc;
use nsh_platform_macos::{
    objc2::MainThreadMarker, objc2_app_kit::NSWindow, set_ui_sets, AppOptions, AppView, Root,
};

fn show(window: &NSWindow) -> Rc<AppView> {
    // 在第一个视图之前设置一次：应用导入的 UI 集合（NSH 的和你的 crate 的）。
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let mtm = MainThreadMarker::new().expect("main thread");
    let view = AppView::new(mtm, AppOptions::default());
    // 在加载之前注册原生组件
    view.load(Root::of::<my_app::App>().into());
    window.setContentView(Some(&view.view()));
    // 窗口显示视图期间保留它；窗口关闭时调用 `stop`。
    view
}
```

`Root::tokens` 为根组件设置[主题](./rust.md#主题)（`nsh_base::Theme::from_json(json)?.into_tokens()`），`Root::app_id`
设置保存其数据所用的 id。`nsh build` 写出的 TSX bundle 也加载到同一种视图中：

```rust
use nsh_platform_macos::{AppOptions, AppView, AssetBase, Bundle};

let view = AppView::new(mtm, AppOptions {
    asset_base: Some(AssetBase::Directory("app/assets".into())),
    ..AppOptions::default()
});
let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(Bundle::source(code).into());
```

`AppView::load` 会替换正在运行的内容；`stop` 结束应用。`asset_base` 指定 `asset:/` URI 从哪里解析（`AssetBase::Directory`
或 `AssetBase::Http`）。字节码 bundle（`bundle.nshc`）用 `unsafe { Bundle::bytecode(bytes) }` 加载：字节码是受信任的输入，
只能从你自己应用的文件中加载。如果应用只是一个 NSH 应用，`run_app(source, options)`（`AppSource::Rust(root)` 或 `AppSource::Bundle(bundle)`）会在窗口中打开一个 `AppView`，带有标准菜单
（关于、隐藏、退出、编辑、最小化、缩放、进入全屏、关闭），应用可以用 `Menu.setApplicationMenu`
（[`nsh/desktop`](../modules/nsh-desktop.md)）替换它，并运行到窗口关闭为止。

`AppOptions::cache`（或 `AppView::set_cache`，作用于之后加载的应用）设置应用保存缓存（[下载的图片](./images-and-assets.md#磁盘缓存)）的位置和每种缓存的大小（`CacheOptions`：默认为系统的缓存目录和 256 MiB 图片）。

`AppView::set_locale(Some(locale))` 和 `AppView::set_font_scale(Some(scale))` 用你的应用的语言和文字大小代替系统的设置（`None` 恢复跟随系统）：`locale()`、`Intl`、`fontScale()` 和文字立即跟随（[设备与环境](./device-and-environment.md#在嵌入它的应用中)）。

`AppView::set_theme_overrides(Some(json))` 把你的应用的品牌加在应用的[主题](./tailwind.md#主题-token)之上：格式与 `nsh.json` 的 `"theme"` 相同的主题文件，其中的 token 在浅色和深色模式下都覆盖应用的同名 token，应用的其他 token 保持不变；`bg-primary` 等类名立即更新样式，之后加载的应用一开始就使用它（`None` 恢复应用自己的主题；无法解析的文件返回错误，不做任何改动）。

原生组件通过 `AppView::register_component` 注册，见[原生组件](./native-components.md#在-macos-上注册rust)。
`set_ui_sets(sets)` 设置每个引擎提供的 UI 集合：NSH 的（`nsh_base::registry()`）和你的 crate 的（`my_app::registry()`，
由 `#[native_module]` 生成），这样视图加载的 TSX 也能导入你的 Rust 组件和模块。

默认情况下，关闭窗口或选择退出会停止引擎，并从 `run_app` 返回；调用方可以继续完成清理或重新启动可执行文件。

设置 `AppOptions { keep_alive_on_close: true, ..Default::default() }` 可以在关闭窗口后保留独立应用的会话。
关闭操作会隐藏窗口，从 Dock 重开时会显示同一个窗口和引擎。明确退出或更新重启时，可以从任意线程调用
`nsh_platform_macos::quit_app()`；它会关闭保留的窗口、停止引擎，并从 `run_app` 返回。
`nsh_core::element::desktop::close_window()` 遵循所选的窗口关闭策略。

## macOS 上的差异

运行环境是桌面环境：安全区和键盘高度为 0，`idiom()` 是桌面（`platform.idiom` 为 `"desktop"`），`os_version()`（`platform.version`）为 macOS 的版本号，
深色模式实时跟随系统外观。见[设备与环境](./device-and-environment.md)。

输入是桌面输入：鼠标、触控板（带惯性的滚动、捏合和旋转）和键盘。`selectable` 文本通过拖动、双击和三击选择，用 Cmd+C 复制。
Escape、Option+Left、Cmd+[ 和鼠标的后退键会关闭最新的对话框或在栈中返回（焦点在输入框或网页中时，Escape 只会离开它；
网页先收到这些按键，它自己用掉的不会触发返回）；`Dialog` 是覆盖整个窗口的一层，显示应用的弹出层和背景。页面在顶部显示它的 `header`。
点击 `Input` 的任意位置（包括内边距）都会把光标放到最近的位置。
`AlertDialog` 以 `NSAlert` 表单的形式显示在窗口上：不超过两个操作的提示框操作排成一行（取消操作在最左边，最后一个普通操作是
Return 的默认操作）；更多操作以及操作表的操作按顺序竖排，取消操作在最后，没有默认操作；Escape 选择取消操作。

### 键盘

| 按键 | 作用 |
|---|---|
| Return | 在 `Input` 中按 `submitBehavior` 的设定：提交（`onSubmit`）、提交并离开输入框，或换行（多行输入框） |
| Shift+Return、Option+Return、Ctrl+Return | 在 Return 用于提交的多行输入框中换行 |
| Tab、Shift+Tab（加 Ctrl 亦可） | 按屏幕顺序切换到下一个 / 上一个输入框或可按压视图，限于最新的对话框内；Option+Tab 在多行输入框中输入制表符 |
| Escape | 离开有焦点的输入框；否则清除文本选区，再关闭最新的对话框或返回 |
| Option+Left、Cmd+[、鼠标后退键 | 返回（输入框有焦点时不会：此时 Option+Left 移动光标） |
| Option / Cmd + 方向键（可加 Shift）；Option+Delete、Cmd+Delete；Ctrl+A / E / K | 在输入框中按词和按行移动、选择和删除，与所有 Mac 应用一致 |
| Cmd+Z、Shift+Cmd+Z、Cmd+X / C / V / A | 撤销、重做、剪切、复制、粘贴、全选（`masked` 输入框拒绝剪切和复制）；Cmd+A / Cmd+C 选择并复制 `selectable` 文本 |
| 方向键；Page Up / Down、Space、Shift+Space、Option+Up / Down；Home / End、Cmd+Up / Down | 滚动有焦点的视图所在或鼠标下方的滚动视图：一行、一页、到开头 / 结尾（输入框有焦点时不滚动） |
| Cmd+W、Cmd+M、Ctrl+Cmd+F、Cmd+H、Option+Cmd+H、Cmd+Q | 关闭、最小化、全屏、隐藏、隐藏其他、退出（`nsh package` 和 `nsh run` 应用的菜单） |
| Cmd+R | 重新加载最新的构建（`nsh run`） |

应用自己的快捷键（[`keymap`](../modules/nsh.md#keymap)）先于以上按键处理，但聚焦的可按压视图优先接收其激活键；退出、隐藏、最小化和全屏不能被绑定。

快捷键在任何键盘布局下都可用（在西里尔或希腊字母布局下，Cmd+C 是美式布局中输入 C 的那个键）。确认输入法组字（中文、日文等）的
Return 不会提交。`onKeyPress` 报告的内容与 React Native 一致：输入的文本、`"Enter"`、`"Backspace"` 以及 `"Escape"`。

不支持或有所不同：

- **可缩放的滚动视图**（`zoomTo`、缩放相关属性）。
- **`mixBlendMode`**，以及大于 1 的 `brightness()`。
- **输入框**：内容类型与自动填充、键盘类型、自动大写、字间距；输入辅助视图从不显示（没有软键盘），`keyboardShouldPersistTaps` 被忽略。
- **`WebView` 的 `scrollable={false}`** 让鼠标滚轮和触控板不再滚动页面，而是像 iOS 上一样滚动它外面的应用滚动视图。
  页面仍可用键盘（空格、方向键）和它自己的脚本滚动，触控板在页面之间的轻扫（`allowsBackForwardNavigationGestures`）也会停用。
- **无障碍**：自定义 `accessibilityActions`。
- **状态栏**和**触感反馈**（桌面上没有对应物）。

带有 `onPress` 的已启用普通视图与输入框一起参与 Tab/Shift+Tab 焦点导航，范围限制在最上层对话框中。
聚焦的可按压视图会在 Return、数字键盘 Enter 或 Space 按下时触发一次按压事件；长按重复和按键抬起不会再次触发。
这些激活键优先交给聚焦的控件，带修饰键的快捷键沿用原有优先级。`focus:` 样式和无障碍焦点会同步键盘焦点。

## 另见

- [CLI](./cli.md)：`nsh run --target macos`、`nsh package --target macos`
- [打包](./packaging.md)
- [平台特定代码](./platform-specific.md)
