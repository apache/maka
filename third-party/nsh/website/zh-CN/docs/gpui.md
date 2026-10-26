---
title: GPUI
description: 用 AppView 把 Rust 和 TSX 编写的 NSH 应用嵌入 GPUI 或 GPUI Kit 应用，在 macOS、Windows 和 Linux 上由 GPUI 绘制，在 GPUI 开发宿主中试用 TSX 应用，以及 GPUI 后端的不同之处。
order: 15.5
group: platforms
---

# GPUI

GPUI 后端用 [GPUI](https://gpui-kit.com)（GPUI Fast）绘制 NSH 应用。GPUI 是 GPUI Kit 所基于的 GPU 加速 UI 框架，在 macOS、
Windows 和 Linux 上表现一致。它是嵌入 GPUI 和 GPUI Kit 应用的后端：`AppView` 是一个 GPUI 视图，GPUI 或 GPUI Kit 应用可以在
自己元素树的任意位置显示 NSH 应用：它自己的 Rust 根组件，或它加载的 TSX。独立应用用各桌面系统自己的后端运行和打包：[macOS](./macos.md)（AppKit）、
[Windows](./windows.md)（Win32）和 [Linux](./linux.md)（GTK）。核心、响应式图、渲染器、Taffy 布局以及原生模块与其他所有平台完全相同，因此同一个应用可以在所有
平台上运行。`os()`（TSX 中的 `platform.os`）是它所运行的操作系统（macOS、Windows 或 Linux），并会应用 TSX 的 `desktop={{…}}` 属性。

[macOS](./macos.md)（AppKit）、[Windows](./windows.md)（Win32）和 [Linux](./linux.md)（GTK）后端的元素和模块它都具备；
GPUI 用自己方式绘制的地方，见[差异](#差异)。

## 工作方式

- **每个界面一个元素。** 一个界面（surface）是一个 GPUI 元素，它填满父元素给它的空间，用 GPUI 的图元（矩形、阴影、路径、字形和
  图片）绘制整棵视图树。与 Windows 后端一样，NSH 为每个节点保留一个视图，只在提交改变了内容时才重绘。
- **文字在引擎线程上排版**，使用 GPUI 的文字系统（应用自己的字体），由 NSH 断行；主线程只绘制字形。
- **每次提交一次跳转。** 引擎运行在自己的线程上；每次提交是发往 GPUI 主线程的一个闭包，由它通知视图重绘。
- **输入**来自 GPUI 的鼠标、滚动、按键和输入法事件；命中测试、按压、响应者系统、滚动和文本编辑与 Windows 后端是同一套逻辑。
- **滚动条**在静止时保持低对比度可见，在滚动或悬停时变亮，方便找到可拖动的滑块。

## 环境要求

- macOS、Windows 或 Linux，以及 GPUI 能使用的 GPU（macOS 上是 Metal，Windows 上是 DirectX，Linux 上是 Vulkan）。
- macOS 上：构建你的 GPUI 应用或从源码构建运行时会用到 Xcode 的 Metal Toolchain（`xcodebuild -downloadComponent MetalToolchain`），由它提前编译
  GPUI 的着色器。在没有它的 Mac 上，`nsh run` 会打开 GPUI 的 `runtime-shaders` feature 构建运行时并给出提示：
  着色器在应用启动时编译（第一次不到一秒，之后由 macOS 缓存）。
- Linux 上：Vulkan 驱动、带 `libxkbcommon` 的 Wayland 或 X11、GTK 3 和 WebKitGTK 4.1（Web 视图），以及 GStreamer 1.20
  或更新版本及其 base 和 good 插件（视频）。Web 视图需要 X11：在 Wayland 桌面上请让应用运行在 Xwayland 下（把
  `WAYLAND_DISPLAY=` 设为空），否则显示占位内容。从源码构建运行时还需要开发包；在 Debian 和 Ubuntu 上：

  ```sh
  sudo apt-get install clang libclang-dev pkg-config libfontconfig-dev libfreetype-dev libwayland-dev libx11-xcb-dev \
    libxcb1-dev libxkbcommon-dev libxkbcommon-x11-dev libzstd-dev libvulkan1 libgtk-3-dev libwebkit2gtk-4.1-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-good
  ```

## 运行应用

Rust 应用运行在你的 GPUI 应用里：用 `AppView` 嵌入它的根组件（[嵌入 GPUI 应用](#嵌入-gpui-应用)），然后 `cargo run` 这个 GPUI
应用；你的 crate 和这个应用是同一次 Cargo 构建。单独运行时，Rust 应用使用本机操作系统自己的后端（`nsh run --target macos`、
`windows` 或 `linux`）。

TSX 应用在 GPUI 开发宿主中运行：

```sh
nsh run App.tsx --target gpui
```

它在一个 GPUI 窗口（默认 1200×800）中打开应用，显示效果与嵌入它的 GPUI 应用相同，和其他目标一样支持热重载、在终端显示日志并提供错误浮层。开发宿主
（`nsh-gpui-host`）在每个操作系统上都直接运行，不需要外面包一层应用包。在源码仓库中，`nsh run` 会先构建它；发行版把它放在
`runtime/gpui/` 中。宿主也可以单独运行一个构建好的 bundle：

```sh
nsh build my-app --release -o build
dist/nsh/runtime/gpui/nsh-gpui-host --bundle build/bundle.nshc --window-size 390x844   # 源码仓库中：target/debug/nsh-gpui-host
```

`--window-size` 是窗口的尺寸，单位为点（`<宽>x<高>`）。

## 打包

GPUI 应用把 NSH 放在自己的可执行文件里：它用 `AppView` 嵌入应用的 Rust 根组件或 TSX bundle（[嵌入 GPUI 应用](#嵌入-gpui-应用)），并作为
GPUI 应用本身构建和分发。独立的 NSH 应用用本机操作系统自己的目标打包：[`--target macos`](./macos.md#打包)、
[`--target windows`](./windows.md#打包) 或 [`--target linux`](./linux.md#打包)（[打包](./packaging.md)）。

在 Linux 上，带 Web 视图和视频的 GPUI 应用动态链接 WebKitGTK 4.1 和 GStreamer，因此运行它的机器需要安装它们，以及 GTK 3 和
GStreamer 的 base、good 插件（Debian / Ubuntu：`libwebkit2gtk-4.1-0`、`libgstreamer1.0-0`、`libgstreamer-plugins-base1.0-0`、
`gstreamer1.0-plugins-good`），此外还需要 Vulkan 驱动和 `libxkbcommon`。

## 嵌入 GPUI 应用

`nsh-platform-gpui` crate（来自 NSH 仓库）为 Rust GPUI 应用提供 `AppView`：一个以 GPUI 视图（`Entity<AppView>`）形式存在的
NSH 引擎，填满父元素给它的空间。每个 `AppView` 相互独立，可以同时运行多个。它运行一个 Rust 根组件，即你的 crate 的根组件：

```rust
use gpui::{AppContext, WindowOptions};
use nsh_platform_gpui::{set_ui_sets, App, AppOptions, AppView, Root};

// 在第一个视图之前设置一次：应用导入的 UI 集合（NSH 的和你的 crate 的）。
set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
gpui_platform::application().run(|cx| {
    cx.open_window(WindowOptions::default(), |window, cx| {
        cx.new(|cx| {
            let view = AppView::new(AppOptions::default(), window, cx);
            view.load(App::Rust(Root::of::<my_app::App>()));
            view
        })
    })
    .unwrap();
});
```

`Root::tokens` 为根组件设置[主题](./rust.md#主题)（`nsh_base::Theme::from_json(json)?.into_tokens()`，这里也重新导出了
`Theme`），`Root::app_id` 设置保存其数据所用的 id。`nsh build` 写出的 TSX bundle 也加载到同一种视图中：

```rust
use nsh_platform_gpui::{App, Bundle};

let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(App::Js(Bundle::source(code)));
```

像其他视图一样把这个 entity 放进元素树（GPUI Kit 的 `Root`、一个面板、一个停靠区）。`AppView::load` 替换正在运行的内容；
`stop`（或丢弃视图）结束应用。`AppOptions::asset_base` 指定 `asset:/` URI 的解析位置（`AssetBase::Directory` 或
`AssetBase::Http`）。字节码 bundle（`bundle.nshc`）用 `unsafe { Bundle::bytecode(bytes) }`（或同样是 unsafe 的
`Bundle::read_trusted(path)`）加载：QuickJS 字节码是受信任的输入，只应从你自己应用的文件中加载。

- `open_app_window(source, options, cx)` 在运行中的 GPUI 应用里打开一个带 `AppView` 的窗口。
- `run_app(source, options)` 启动 GPUI，在一个窗口中运行一个应用直到窗口关闭（开发宿主就是这样做的）。
- `AppView::register_component(name, factory)` 在加载前注册你自己的原生组件（[原生组件](./native-components.md)）。
- `AppOptions::cache`（或 `AppView::set_cache`，作用于之后加载的应用）设置应用保存缓存（[下载的图片](./images-and-assets.md#磁盘缓存)）的位置和每种缓存的大小：`CacheOptions { location, images }`，`CacheLocation::System`（默认）、`Dir(path)` 或 `Off`，`CachePolicy::Default`（256 MiB）、`MaxSize(ByteSize::mib(n))` 或 `Off`。
- `AppView::host()` 是视图与它运行的应用之间的通道（[`nsh/host`](../modules/nsh-host.md)），一个可在任意线程使用的 `HostChannel`：加载前用 `set_params(map)` 给应用启动参数（`host.params`），用 `send(name, data)` 发送事件（`host.on`），用 `handle(name, |call| …)` 回答应用的 `host.call(name, data)` 并接收它的 `host.post`（`call.resolve(json)`、`call.reject(message)`，可以立即回答，也可以稍后在任意线程回答）。处理函数在引擎线程运行：把调用交给你的 GPUI entity（例如通过一个由 `cx.spawn` 任务读取的 channel），在那里回答。macOS、Windows 和 Linux 的 `AppView` 也有同样的 `host()`。它的 `handle_open_url(|request| …)` 在系统之前看到应用打开的 URL（[`openUrl`](../modules/nsh-device.md#openurl)）：你的应用自己处理了这个 URL 时调用 `request.handled()`，调用 `request.decline()`（或直接丢弃 request）则由系统用 GPUI 的 `open_url` 打开。
- `AppOptions::limits`（或 `AppView::set_limits`，作用于之后加载的应用）设置 VM 限制：JS 堆、栈、时间预算和节点配额（[沙箱与能力](./sandbox-and-capabilities.md)）。嵌入的应用默认是 `Limits::default()`（256 MB 堆）；开发宿主把应用作为独立应用运行，使用 `Limits::standalone()`。
- `AppView::connect_dev_server(url, cx)`（feature `dev`）从 `nsh dev` 加载应用，边改边重新加载，错误浮层显示在视图上；`AppView::on_error` 照样收到应用的错误。
- `AppView::on_app_error(|error| …)` 接收应用的错误：`error.kind`（应用加载失败、未捕获的异常、VM 已停止），`error.is_fatal()` 表示该应用不会再执行任何 JS，`error.message`、`error.stack`，以及 `error.package`（它来自的签名包的 id 和 build 号）。`AppView::on_error` 以文本形式收到同样的错误。
- `AppView::set_locale(locale, cx)` 和 `AppView::set_font_scale(scale, cx)` 用你的应用的语言和文字大小代替系统的设置（`None` 恢复跟随系统）：`locale()`、`Intl`、`fontScale()` 和文字立即跟随（[设备与环境](./device-and-environment.md#在嵌入它的应用中)）。
- `AppView::run_package(&package)` 运行来自 `verify_package` 或 `load_package` 的[签名包](./signed-packages.md)；你的应用判定它健康之后，用 `accept_package` 记录它。
- `set_ui_sets(sets)` 设置每个引擎提供的 UI 套件：NSH 的（`nsh_base::registry()`）和你的 crate 的（`my_app::registry()`，由
  `#[native_module]` 生成；[用 Rust 开发](./rust.md)），也用来提供你的应用自己的套件：应用通过
  [`nativeModule`](../modules/nsh-native.md#nativemodule) 按名称使用其中的函数和类，并用标准的 `nsh build` 构建。仓库中的
  `examples/embed-gpui` 就这样在宿主中维护一个交易台，由两个嵌入的下单面板和宿主自己的控件共享。

## 差异

与原生桌面后端在绘制或行为上的不同之处：

- **变换**：旋转、斜切和透视的视图，其背景、边框和阴影会随之变换，但文字保持直立，图片、视频和画布按其边界绘制。
- **不透明度**作用于每种颜色而不是整组，因此半透明视图中相互重叠的子视图会彼此透出；图片的不透明度（淡入、半透明视图）以
  十六分之一为级变化。
- **圆角裁剪**（带圆角的 `overflow: "hidden"`）会让子视图的背景和图片跟随圆角，但文字、边框、视频和原生组件按矩形裁剪。
- **不绘制**：`filter: blur()`、`backdropFilter` 和 `mixBlendMode`；阴影会透过半透明填充显示；`borderCurve: "continuous"`
  绘制为圆形圆角。
- **画布文字**是近似的：旋转时保持直立，`maxWidth` 下缩小字号而不是压窄，渐变以单一颜色绘制，`strokeText` 绘制为填充，阴影
  不模糊，合成操作和 `clearRect` 对它不起作用。
- **滚动视图**不支持缩放（`zoomTo` 和缩放相关属性被忽略）。
- **视频**在 Linux 上播放（GStreamer）；在 macOS 和 Windows 上显示占位内容并报告 `onError`。
- **Web 视图**是位于 NSH 在该位置所绘制一切内容之上的原生视图。Linux 上需要 X11（见[环境要求](#环境要求)）；在 Xwayland
  下页面一直是黑的（日志中有 "Failed to create GBM buffer"）时，请用 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 运行应用。macOS 和
  Windows 上裁剪祖先不会裁剪它们，加载失败也不会报告 `onError`。不支持 `baseUrl`、`scrollable` 和
  `allowsBackForwardNavigationGestures`。
- **无障碍**通过 AccessKit 实现：读屏软件在所有平台上都能激活、聚焦、设置值并把元素滚动到可见；自定义操作和上下文菜单操作
  尚未传递。

可对照各原生后端自己的列表：[macOS](./macos.md#macos-上的差异)、[Windows](./windows.md#windows-上的差异)、
[Linux](./linux.md#linux-上的差异)。

## 另见

- [用 Rust 开发](./rust.md)：GPUI 应用嵌入其根组件的 crate
- [命令行](./cli.md)：`nsh run --target gpui`
- [打包](./packaging.md)：独立应用，用各操作系统自己的目标
- [平台概览](./platforms.md)
