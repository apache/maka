---
title: 嵌入现有应用
description: "在现有 iOS、Android、macOS、Windows、Linux 或 GPUI 应用的局部界面中显示 NSH 应用：用哪个宿主视图、运行 TSX 还是 Rust 根组件，以及各平台的步骤。"
order: 10.5
group: platforms
---

# 嵌入现有应用

现有原生应用可以在自己界面的一部分里显示 NSH 应用：一个页面、一个标签页，或原生工具栏下方的一块区域。宿主添加一个视图，像自己的其他视图一样决定它的位置和大小，再把应用加载进去。NSH 应用按视图大小布局，用平台自己的视图与宿主的视图并排渲染，视图销毁时应用停止。每个视图是独立的引擎，宿主可以同时显示多个。

## 选择方式

视图能运行什么，取决于宿主用什么语言编写，而不是平台：

| 宿主 | 宿主视图 | 运行 | 获取方式 |
|---|---|---|---|
| Swift / Objective-C 的 iOS 应用 | `NshAppView` （`UIView`） | TSX bundle、签名包 | `NativeShell.xcframework` |
| 链接了 Rust 的 iOS 应用 | `AppView` （`UIView`） | Rust 根组件、TSX bundle | `nsh-platform-ios` crate |
| Java / Kotlin 的 Android 应用 | `NshView` （`FrameLayout`） | TSX bundle、签名包 | `nsh.aar` |
| Rust 编写的 macOS 应用（AppKit） | `AppView` （`NSView`） | Rust 根组件、TSX bundle | `nsh-platform-macos` crate |
| Rust 编写的 Windows 应用（Win32） | `AppView` （子窗口） | Rust 根组件、TSX bundle | `nsh-platform-windows` crate |
| Rust 编写的 Linux 应用（GTK 4） | `AppView` （GTK widget） | Rust 根组件、TSX bundle | `nsh-platform-linux` crate |
| GPUI 应用 | `AppView` （GPUI 视图） | a Rust root, TSX bundle、签名包 | `nsh-platform-gpui` crate |

因此：

- **Swift 或 Java/Kotlin 宿主加载 TSX。** 嵌入部分用 TSX 编写，用 `nsh build` 构建，把 bundle 加载进 `NshAppView` 或 `NshView`；签名包（`nsh publish`）可以不发版更新它。
- **带 Rust 代码的宿主可以挂载 Rust 根组件**，即你的 crate 的根组件，不需要 JavaScript VM；同一个 `AppView` 也能加载 TSX bundle。
- 桌面端的 `AppView` 都是 Rust API。用 Swift、C# 或 C++ 编写的桌面应用目前还没有对应的宿主视图。

## 移动端

### iOS（Swift）

1. 从 `dist/nsh/embed/ios` 获取 `NativeShell.xcframework`（发布用）和 `NativeShellDev.xcframework`（可连接 `nsh dev`），或在 NSH 源码中用 `cargo xtask ios-embed` 构建（[获取 framework](./ios.md#get-the-framework)）。
2. 把 framework 加到应用 target，默认的静态版本选 `Do Not Embed`；Dev framework 只在 Debug 配置中链接（[加入 Xcode 项目](./ios.md#add-it-to-an-xcode-project)）。
3. 把 NSH 应用构建到应用的一个文件夹引用中：

   ```sh
   nsh build App.tsx --release --out MyApp/nsh
   ```

4. 在要显示 NSH 的位置添加 `NshAppView` 并加载 bundle：

   ```swift
   import NativeShell
   import UIKit

   final class EmbedController: UIViewController {
       private let app = NshAppView()

       override func viewDidLoad() {
           super.viewDidLoad()
           app.translatesAutoresizingMaskIntoConstraints = false
           app.onError = { message in print("nsh error: \(message)") }
           view.addSubview(app)
           NSLayoutConstraint.activate([
               app.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
               app.leadingAnchor.constraint(equalTo: view.leadingAnchor),
               app.trailingAnchor.constraint(equalTo: view.trailingAnchor),
               app.bottomAnchor.constraint(equalTo: view.bottomAnchor),
           ])
           guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { return }
           try? app.loadBundle(at: url)
       }
   }
   ```

约束决定显示区域：把视图固定在屏幕的一部分，NSH 应用就只占这一部分。完整示例见 `examples/embed-ios`；视图的全部成员见 [iOS](./ios.md#nshappview)。

### iOS（Rust）

已经链接 Rust 的 iOS 应用，可以用 `nsh_platform_ios::AppView` 显示你的 crate 的根组件：

```rust
use nsh_platform_ios::{set_ui_sets, AppView, Root, SurfaceOptions};
use objc2::MainThreadMarker;
use objc2_ui_kit::UIView;

fn show(container: &UIView) -> AppView {
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = AppView::new(mtm, container.bounds(), SurfaceOptions::default());
    container.addSubview(app.view());
    app.run(Root::of::<my_app::App>());
    app // 保留它：drop 后应用停止
}
```

视图填满 `container` 并随它改变大小，所以由容器决定区域。Swift 通过你的 crate 导出的 C 函数调用它。`AppView::load` 则在同一视图中运行 TSX bundle（[嵌入 Rust 应用](./ios.md#embedding-a-rust-app)）。

### Android

1. 把 `dist/nsh/embed/android` 中的 `nsh.aar`（发布用）和 `nsh-dev.aar`（可连接 `nsh dev`）加到应用模块，或在 NSH 源码中用 `cargo xtask android-embed` 构建（[获取库](./android.md#get-the-library)）：

   ```kotlin
   dependencies {
       debugImplementation(files("libs/nsh-dev.aar"))
       releaseImplementation(files("libs/nsh.aar"))
   }
   ```

2. 把 NSH 应用构建到应用的 assets：

   ```sh
   nsh build App.tsx --release --out app/src/main/assets/nsh
   ```

3. 把 `NshView` 放进任意布局并加载 bundle：

   ```kotlin
   class MainActivity : Activity() {
       private lateinit var nsh: NshView

       override fun onCreate(state: Bundle?) {
           super.onCreate(state)
           nsh = NshView(this)
           nsh.setErrorListener { message -> Log.e("nsh", message) }
           val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
           column.addView(toolbar)
           column.addView(nsh, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
           setContentView(column)
           nsh.loadAssetBundle("nsh")
       }

       override fun onDestroy() {
           nsh.destroy()
           super.onDestroy()
       }
   }
   ```

布局参数决定区域。完整示例见 `examples/embed-android`；视图的全部方法见 [Android](./android.md#nshview)。AAR 运行 TSX；Rust 应用在 Android 上以 `nsh package --target android` 构建的 APK 发布。

## 桌面端

在 macOS、Windows 和 Linux 上，宿主是依赖 NSH 仓库中平台 crate 的 Rust 应用。步骤相同：调用一次 `set_ui_sets`，创建 `AppView`，把它的原生视图放到要显示 NSH 的位置，再加载根组件或 bundle。

### macOS (AppKit)

```rust
use nsh_platform_macos::{objc2::MainThreadMarker, set_ui_sets, AppOptions, AppView, Root};

set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(MainThreadMarker::new().unwrap(), AppOptions::default());
view.load(Root::of::<my_app::App>().into());
split_view.addArrangedSubview(&view.view()); // 任意 NSView 容器
```

`view.view()` 是 `NSView`：可加到任意容器，或设为窗口的 content view（[嵌入 Mac 应用](./macos.md#embedding-in-a-mac-app)）。

### Windows (Win32)

```rust
use nsh_platform_windows::{set_ui_sets, AppOptions, AppView, Root};

unsafe { OleInitialize(None)? }; // 每个 UI 线程一次
set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(Some(parent_hwnd), AppOptions::default())?;
view.load(Root::of::<my_app::App>().into());
// 在父窗口的 WM_SIZE 中摆放：MoveWindow(view.hwnd(), x, y, width, height, true)
```

视图是 `parent_hwnd` 的子窗口，它的位置和大小就是显示区域（[嵌入 Win32 应用](./windows.md#embedding-in-a-win32-app)）。

### Linux (GTK 4)

```rust
use nsh_platform_linux::{set_ui_sets, AppOptions, AppView, Root};

set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(AppOptions::default());
view.load(Root::of::<my_app::App>().into());
paned.set_end_child(Some(&view.widget())); // 任意 GTK 容器
```

`view.widget()` 是 GTK widget；窗口关闭时停止该视图（[嵌入 GTK 应用](./linux.md#embedding-in-a-gtk-app)）。

### GPUI

GPUI 或 GPUI Kit 应用把 `nsh-platform-gpui` 的 `AppView` 作为 GPUI 视图加入，也能加载签名包（[嵌入 GPUI 应用](./gpui.md#embedding-in-a-gpui-app)）。

### 桌面端的 TSX

每个桌面 `AppView` 也能加载 `nsh build` 生成的 TSX bundle，`asset_base` 指向其 `assets` 目录：

```rust
let view = AppView::new(/* … */ AppOptions {
    asset_base: Some(AssetBase::Directory("app/assets".into())),
    ..AppOptions::default()
});
view.load(Bundle::source(std::fs::read_to_string("app/bundle.js")?).into());
```

## 与宿主协作

各宿主视图都提供这些能力：

- **与应用通信**：通过 `nsh/host` 在宿主与应用间传递启动参数、调用和事件（[iOS](./ios.md#talking-to-the-app)、[Android](./android.md#talking-to-the-app)）。
- **原生组件**：宿主注册自己的视图（地图、图表）供应用使用（[原生组件](./native-components.md)）。
- **主题**：宿主用自己的品牌 token 覆盖应用主题（[iOS](./ios.md#theme-overrides)、[Android](./android.md#theme-overrides)）；语言和字号跟随宿主设置（[设备与环境](./device-and-environment.md#in-an-embedding-app)）。
- **限制与能力**：每个视图中的应用能使用什么（[沙箱与能力](./sandbox-and-capabilities.md)）。
- **更新**：Swift、Java/Kotlin 和 GPUI 宿主可以加载下载的[签名包](./signed-packages.md)。
- **开发**：Dev 版 framework 和 AAR 连接 `nsh dev` 进行热更新（[iOS](./ios.md#development)、[Android](./android.md#development)）。

## 另请参阅

- [平台概览](./platforms.md#embed-in-a-native-app)
- [iOS](./ios.md), [Android](./android.md), [macOS](./macos.md), [Windows](./windows.md), [Linux](./linux.md),
  [GPUI](./gpui.md)
