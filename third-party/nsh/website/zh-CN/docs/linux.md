---
title: Linux
description: 在 Linux 上用 GTK 4 窗口运行 Rust 和 TSX 编写的 NSH 应用、打包应用、用 AppView 嵌入 GTK 应用，以及 Linux 上的差异。
order: 15
group: platforms
---

# Linux

NSH 应用也能在 Linux 上运行。Linux 后端用 GTK 4 控件渲染应用，用 Pango 排版文字；核心、响应式图、渲染器、Taffy 布局以及
原生模块与 iOS、Android 上完全相同，因此同一个应用可以在所有平台上运行。在 Linux 上，`os()` 为 `Os::Linux`（TSX 中
`platform.os` 为 `"linux"`），并会应用 TSX 的 `desktop={{…}}` 属性。窗口标题、自定义标题栏、
菜单栏和右键菜单在 Rust 中由 `nsh_core::ui::desktop` 提供（[桌面标题栏](./rust.md#桌面标题栏)），在 TSX 中由
[`nsh/desktop`](../modules/nsh-desktop.md) 提供。

## 环境要求

- **GTK 4.14** 及以上。构建 Rust 应用的 runner 或 NSH 的 Linux 运行时（从源码构建，或在 Linux 上运行 `cargo xtask dist`）
  还需要它们的开发包和 clang：Debian 与 Ubuntu（24.04 及以上）为 `libgtk-4-dev clang`，Arch 为 `gtk4 clang`，Fedora 为
  `gtk4-devel clang`。
- Web 视图需要 **WebKitGTK 6.0**（2.40 及以上）：构建运行时需要 Debian 与 Ubuntu 上的 `libwebkitgtk-6.0-dev`、Arch 上的
  `webkitgtk-6.0`、Fedora 上的 `webkitgtk6.0-devel`。开发宿主和发布运行器默认使用它，因此打包后的应用运行的机器上需要装有
  WebKitGTK 6.0（Debian 与 Ubuntu 上为 `libwebkitgtk-6.0-4`；GNOME 桌面自带）。在没有它的开发包的机器上，`cargo xtask dist`
  构建的运行时中 Web 视图为占位视图，其应用只需要 GTK。
- 应用要播放的视频格式对应的 **GStreamer** 插件（GTK 通过 GStreamer 播放视频）。

## 运行应用

在 Linux 上，`nsh run` 会在一个 GTK 窗口中打开应用。Rust 应用在自己的目录里运行：

```sh
nsh run                        # 在 Linux 上默认就是 --target linux
```

`nsh` 用你的 crate 构建一个 debug runner 并打开应用，在终端显示它的日志（`log::info!` 等）；修改 crate 的 Rust 代码会重新构建
runner 并重启应用。`cargo run` 从 crate 的 `src/main.rs`（由 `nsh init --template rust` 生成）启动同一个根组件：用
`AppSource::Rust` 调用 [`run_app`](#嵌入-gtk-应用)。

TSX 应用需写明入口，默认在 390×844 的窗口中打开，和其他目标一样支持热重载、在终端显示日志并提供错误浮层：

```sh
nsh run App.tsx
```

在源码仓库中，`nsh run` 会先构建开发宿主（`nsh-linux-host`）；在 Linux 上制作的发行版把它放在 `runtime/linux/` 中。
Ctrl-C 会关闭窗口，关闭窗口也会结束 `nsh run`。宿主也可以单独运行一个构建好的 bundle：

```sh
nsh build my-app --release -o build
dist/nsh/runtime/linux/nsh-linux-host --bundle build/bundle.nshc --window-size 1024x768   # 源码仓库中：target/debug/nsh-linux-host
```

`--window-size` 是窗口的默认尺寸（TSX 应用）；平铺式窗口管理器可能会给窗口另一个尺寸。

## 打包

```sh
nsh package --target linux [--run]           # Rust 应用，在它的目录里
nsh package App.tsx --target linux [--run]   # TSX 应用
```

会写出一个目录，以及同样内容的压缩包：

```text
.nsh/out/<Name>/
  <Name>                 可执行文件：Rust 应用是用它的 crate 构建的自有 runner；TSX 应用是 nsh 的发布版运行器
  nsh/bundle.nshc        编译后的 TSX 应用
  nsh/assets/…           应用导入的资源（也包括 Rust crate 的 `assets!()`）
  nsh/app.json           窗口标题和应用 id
  <id>.desktop           桌面条目（StartupWMClass 为应用 id）
  <id>.png               图标（nsh.json 指定了图标时）
.nsh/out/<Name>.tar.gz
```

可执行文件会在自身旁边找到 `nsh/`（指向它的符号链接也可以，例如放在 `~/.local/bin` 中）。运行应用的机器上必须装有 GTK 4、
Pango 和 WebKitGTK 6.0。要让应用出现在桌面的启动器中，把可执行文件（或其链接）放到 `PATH` 中，把 `.desktop` 文件放到
`~/.local/share/applications`，把图标放到图标主题目录中。`--run` 会在打包后启动应用。

## 嵌入 GTK 应用

`nsh-platform-linux` crate（位于 NSH 仓库中）为 Rust 编写的 GTK 应用提供 `AppView`：一个作为 GTK 控件的 NSH 引擎。每个
`AppView` 相互独立，可以同时运行多个。它运行一个 Rust 根组件，即你的 crate 的根组件：

```rust
use std::rc::Rc;
use nsh_platform_linux::{gtk4 as gtk, set_ui_sets, AppOptions, AppView, Root};
use gtk::prelude::*;

fn main() -> gtk::glib::ExitCode {
    // 在第一个视图之前设置一次：应用导入的 UI 集合（NSH 的和你的 crate 的）。
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let app = gtk::Application::builder().application_id("com.example.host").build();
    app.connect_activate(|app| {
        let window = gtk::ApplicationWindow::builder().application(app).default_width(390).default_height(844).build();
        let view = AppView::new(AppOptions::default());
        // 在加载之前注册原生组件
        view.load(Root::of::<my_app::App>().into());
        window.set_child(Some(&view.widget()));
        // 窗口持有视图；关闭窗口即停止应用。
        let keep = std::cell::RefCell::new(Some(Rc::clone(&view)));
        window.connect_destroy(move |_| if let Some(view) = keep.take() { view.stop() });
        window.present();
    });
    app.run()
}
```

`Root::tokens` 为根组件设置[主题](./rust.md#主题)，`Root::app_id` 设置保存其数据所用的 id。`nsh build` 写出的 TSX bundle
也加载到同一种视图中，`asset_base` 设为它的 `assets` 目录：

```rust
use nsh_platform_linux::{AppOptions, AppView, AssetBase, Bundle};

let view = AppView::new(AppOptions {
    asset_base: Some(AssetBase::Directory("app/assets".into())),
    ..AppOptions::default()
});
let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(Bundle::source(code).into());
```

`AppView::load` 会替换正在运行的内容；`stop` 结束应用。`asset_base` 指定 `asset:/` URI 从哪里解析（`AssetBase::Directory`
或 `AssetBase::Http`）。字节码 bundle（`bundle.nshc`）用 `unsafe { Bundle::bytecode(bytes) }` 加载：字节码是受信任的输入，
只能从你自己应用的文件中加载。独立窗口用 `nsh_platform_linux::run_app(source, options)`，传入 `AppSource::Rust(root)` 或
`AppSource::Bundle(bundle)`。

`AppOptions::cache`（或 `AppView::set_cache`，作用于之后加载的应用）设置应用保存缓存（[下载的图片](./images-and-assets.md#磁盘缓存)）的位置和每种缓存的大小（`CacheOptions`：默认为系统的缓存目录和 256 MiB 图片）。

`AppView::set_locale(Some(locale))` 和 `AppView::set_font_scale(Some(scale))` 用你的应用的语言和文字大小代替系统的设置（`None` 恢复跟随系统）：`locale()`、`Intl`、`fontScale()` 和文字立即跟随（[设备与环境](./device-and-environment.md#在嵌入它的应用中)）。

`AppView::set_theme_overrides(Some(json))` 把你的应用的品牌加在应用的[主题](./tailwind.md#主题-token)之上：格式与 `nsh.json` 的 `"theme"` 相同的主题文件，其中的 token 在浅色和深色模式下都覆盖应用的同名 token，应用的其他 token 保持不变；`bg-primary` 等类名立即更新样式，之后加载的应用一开始就使用它（`None` 恢复应用自己的主题；无法解析的文件返回错误，不做任何改动）。

原生组件通过 `AppView::register_component` 注册，见[原生组件](./native-components.md#在-linux-上注册rust)。
`set_ui_sets(sets)` 设置每个引擎提供的 UI 集合：NSH 的（`nsh_base::registry()`）和你的 crate 的（`my_app::registry()`，
由 `#[native_module]` 生成），这样视图加载的 TSX 也能导入你的 Rust 组件和模块。

## Linux 上的差异

运行环境是桌面环境：安全区和键盘高度为 0，`idiom()` 是桌面（`platform.idiom` 为 `"desktop"`），`os_version()`（`platform.version`）为内核的主、次版本号，
深色模式实时跟随桌面的设置（通过 XDG 设置门户）。见[设备与环境](./device-and-environment.md)。

### 键盘

| 按键 | 作用 |
|---|---|
| Return | 在 `Input` 中按 `submitBehavior` 行事：提交（`onSubmit`）、提交并离开输入框，或换行（多行输入框） |
| Shift+Return、Alt+Return | 在回车即提交的多行输入框中换行（Ctrl+Return 提交） |
| Tab、Shift+Tab | 按屏幕顺序移到下一个 / 上一个输入框，只在最上层的对话框之内 |
| Escape | 离开有焦点的输入框；否则清除文本选区，再关闭最上层的对话框或返回上一页 |
| Alt+Left、Back 键、鼠标的后退键 | 返回上一页（在输入框中也是） |
| Ctrl+方向键、Home / End，加 Shift；Ctrl+Backspace / Delete | 在输入框中按词和行移动、选择、删除，与其他 GTK 应用一致 |
| Ctrl+Z、Ctrl+Shift+Z、Ctrl+X / C / V / A | 撤销、重做、剪切、复制、粘贴、全选（`masked` 输入框拒绝剪切和复制）；Ctrl+A / Ctrl+C 选择并复制 `selectable` 文本 |
| 方向键；Page Up / Down、Space、Shift+Space；Home / End | 滚动有焦点的视图所在或鼠标下方的滚动视图：一行、一页、到开头 / 结尾（输入框有焦点时不滚动） |
| Ctrl+W、F11、Ctrl+Q | 关闭窗口、全屏、退出（`nsh package` 和 `nsh run` 的应用） |
| Ctrl+R | 重新加载最新的构建（`nsh run`） |

应用自己的快捷键（[`nsh/keymap`](../modules/nsh-keymap.md)）是一个窗口范围的快捷键控制器；Ctrl+Q 和 F11 不能被绑定。

快捷键适用于任何键盘布局（在西里尔或希腊字母布局下，Ctrl+C 是美式布局中输入 C 的那个键）。确认输入法组合文字（中文、日文等）的回车
不会提交。`onKeyPress` 报告的与 React Native 一致：输入的文字、`"Enter"`、`"Backspace"` 和 `"Escape"`；粘贴的文字不报告。

Web 视图是绘制在 NSH 视图之内的 WebKitGTK 页面：sheet、对话框、toast 以及排在它后面的视图会绘制在页面之上，父视图会裁剪它、改变它的透明度。
它的网站数据（cookie、存储、缓存）按应用分别保存在 `~/.local/share/<app id>/webkit` 和 `~/.cache/<app id>/webkit` 下。
`webview` 权限同样作用于框架中的页面：应用未获授权的主机的 `iframe` 保持空白。在页面中按 Escape 会离开页面，与文本框中一样
（除非页面自己用了它）；页面有历史记录时，Alt+Left 和鼠标的后退键在页面中后退。

不支持：

- **视频的 `rate`**：GTK 只能以正常速度播放。`onEnd` 只对不循环的视频触发。
- **可缩放的滚动视图**（`zoomTo`、缩放相关属性）。
- **`mixBlendMode` 和 `backdropFilter`**（背景色仍会绘制）；`borderCurve: "continuous"` 绘制为圆形圆角。
- **输入辅助视图**和**状态栏**（桌面上没有对应物）。
- **无障碍**：`accessible` 分组、自定义 `accessibilityActions`；实时区域改为播报。

## 另见

- [CLI](./cli.md)：`nsh run --target linux`、`nsh package --target linux`
- [打包](./packaging.md)
- [平台特定代码](./platform-specific.md)
