---
title: 快速开始
description: 用 nsh init 以 Rust 或 TSX 创建应用，在 iOS、Android、macOS、Windows、Linux 或 Web 上运行；把 TSX 模块承载到你的应用里并以签名包下发，或者把应用单独打包。
order: 4
group: start
demo: guide-getting-started
---

# 快速开始

本指南创建一个 NSH 应用，在你面向的平台上运行它，再把它发布出去。NSH 应用用 Rust 或 TSX 编写，运行在同一个引擎上：Rust
把你的应用编译成原生代码，不带 JavaScript 虚拟机；TSX 运行在 QuickJS 上，支持热更新，也可以作为模块由原生应用在运行时加载。本指南先走一遍
Rust 应用，再看同一个应用的 TSX 写法。前提是已经安装 `nsh` 并加入 `PATH`（[安装](./installation.md)）；在源码仓库中请改用
`./target/debug/nsh`。

> [!TIP]
> 手头没有应用工程？前两节都不需要：`nsh run` 会把应用显示在你电脑上的一个窗口、iOS 模拟器、Android 设备或浏览器里。你可以到此为止，或者把它[打包成独立应用](#或者作为独立应用发布)。

## 创建应用

在终端中，`nsh init` 会询问应用用什么编写：`rust`、`ts` 或 `mixed`（带有自己 Rust crate 的 TSX）。用 `--template`
可以直接选择，不再询问。

### 用 Rust

```sh
nsh init my-app --template rust
```

`nsh init` 会创建目录，并写入一个 Cargo 项目：

| 文件 | 作用 |
|---|---|
| `src/lib.rs` | 应用本身：根组件、状态和事件处理 |
| `src/main.rs` | 为 `cargo run` 在 macOS、Windows 或 Linux 上直接挂载同一个根组件 |
| `Cargo.toml` | crate 清单，依赖与 CLI 同版本的 `nsh-core` 和 `nsh-base` |
| `nsh.json` | 应用的名称、id、版本和构建号，它的 crate（`"rust": "."`）和根组件（`"root": "App"`）（[项目结构](./project-structure.md#nshjson)） |
| `App.test.tsx` | 根组件的测试，用 TypeScript 编写（`nsh test`），附带供编辑器使用的 `tsconfig.json` 和 `.nsh/types` |
| `README.md` | 如何运行、测试和打包应用，以及之后如何添加 TSX 入口 |
| `.gitignore` | 忽略 `.nsh/` 和 `target/` |

Rust 开发需要 Rust 工具链（[rustup](https://rustup.rs)）；`nsh` 命令使用 crates.io 上与 CLI 同版本的 NSH crate 构建应用的运行器。

### 用 TSX

```sh
nsh init my-app --template ts
```

TSX 应用是一个或多个带入口的 `.tsx` 文件：它是 `nsh run` 运行的东西，也是宿主应用作为模块加载的东西。

| 文件 | 作用 |
|---|---|
| `App.tsx` | 入口模块：用 `mount` 渲染应用 |
| `App.test.tsx` | 它的测试（`nsh test`） |
| `nsh.json` | 应用的名称、id、版本和构建号（[项目结构](./project-structure.md#nshjson)） |
| `tsconfig.json` | 继承 `.nsh/tsconfig.json`，即 NSH 的 TypeScript 设置，它把 `nsh` 解析到 `.nsh/types` 中的声明 |
| `.gitignore` | 忽略 `.nsh/` 和 `target/` |
| `.nsh/types/` | 生成的所有 NSH 模块的声明，供编辑器使用 |

已存在的文件会被保留，所以你可以在已经有部分文件的目录里运行它；Rust 应用则在一个新目录中创建。

两者的显示名称都默认是目录名；可以用 `--name "My App"` 指定其他名称。id 会是 `com.example.<name>`：发布前请在 `nsh.json`
中修改。`nsh init my-app --template mixed` 创建一个同时也是 Rust crate 的 TSX 应用（`Cargo.toml` 和 `src/lib.rs` 与 `App.tsx` 并列），`App.tsx` 导入它的组件、模块和类（[用 Rust 开发](./rust.md)）。

### 根组件

两个模板生成的是同一个应用，一个计数器：

```rust tabs
// src/lib.rs
use nsh_base::theme;
use nsh_core::prelude::*;

/// crate 的 UI 集合：TSX 入口可以从 `my-app/native` 导入的内容。
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// 应用的根组件。
#[component]
pub fn App() -> impl IntoElement {
    let count = signal(0_u32);
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(
            view()
                .flex_1()
                .p_safe_area()
                .child(
                    view()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_4()
                        .child(text(move || format!("Count: {}", count.get())).text_size(px(28.0)))
                        .child(
                            view()
                                .px_5()
                                .py_3()
                                .rounded(px(10.0))
                                .bg(move || theme().primary)
                                .active(|s| s.opacity(0.6))
                                .on_press(move || count.update(|value| *value += 1))
                                .child(
                                    text("Tap")
                                        .text_size(px(17.0))
                                        .text_color(move || theme().primary_foreground),
                                ),
                        ),
                ),
        )
}
```

```tsx tabs
// App.tsx
import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View class="flex-1 items-center justify-center gap-4 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <Text class="text-3xl font-semibold text-foreground">{count()}</Text>
      <View
        onPress={() => count.update((c) => c + 1)}
        role="button"
        class="rounded-(--radius) bg-primary px-5 py-3 active:bg-primary/90"
      >
        <Text class="text-lg text-primary-foreground">Tap</Text>
      </View>
    </View>
  );
}

mount(App);
```

Rust 版：

- **`use nsh_core::prelude::*`** 引入基本元素（`view()`、`text()`、`scroll()`、`input()`、`image()` 等）、[signal](./reactivity.md)
  和带类型的样式方法（`.p_safe_area()` 按[安全区域](../elements/safe-area.md)为视图加内边距）；**`nsh_base`** 提供无样式的基础组件（`button()`、键盘、对话框）以及
  `theme()`，即应用组件绘制时使用的颜色和圆角（[主题](./rust.md#主题)）。
- **`#[component] pub fn App()`** 是一个组件：只运行**一次**、返回自己元素的函数。`nsh.json` 中的 `"root": "App"` 指向它，`nsh run`
  挂载它。`signal(0_u32)` 创建一个会随时间变化的值。
- **`text(move || format!(…, count.get()))`** 把文本绑定到 signal：`count` 变化时，NSH 重新运行这个闭包，只更新这一段文本，其他什么都不动。样式同样接受闭包：
  `.bg(move || theme().primary)` 会随主题进入深色模式。
- **`.on_press(..)`** 让视图响应按压；`.active(|s| s.opacity(0.6))` 是它按下时的样式，由原生应用。这个按钮属于应用自己：NSH
  提供基本元素和各项能力，应用用它们绘制自己的界面。
- **`.px_5()`、`.rounded(px(10.0))`、`.gap_4()`** 是带类型的样式方法，与 Tailwind 的工具类同名，单位是点（`px`）。布局是
  flexbox，子元素默认按列排列（[布局](./layout.md)）。
- **`#[native_module("my-app/native")]`** 指定 TSX 入口可以从这个 crate 导入什么，供你之后在上面添加 TSX 页面（[用 Rust 开发](./rust.md#用-tsx-扩展-rust-应用)）。

TSX 版：

- **`import { mount, signal, Text, View } from "nsh"`**：`nsh` 是核心模块，提供 signal、`mount`、其他响应式原语以及宿主元素。它由原生运行时提供，不会被打包。**`nsh/base`**
  提供基础组件，相当于 Rust 中的 `nsh_base`。
- **`function App()`** 是一个只运行**一次**的组件。**`{count()}`** 在 JSX 中读取 signal：编译器看到这是一次调用，就让这段文本跟随该 signal。
- **`<View onPress>`** 是一个响应按压的原生视图；`active:` 类是它按下时的样式。`View`、`Text`、`Image`、`Scroll`
  等[宿主元素](../elements/index.md)都从 `nsh` 导入（`Input` 从 `nsh/base` 导入）；只有 `If` 和 `Each` 无需导入。
- **`class`** 接受 [Tailwind](./tailwind.md) 类；`style={{ … }}` 接受由 camelCase 样式属性组成的对象，数字的单位是点。
  `bg-background`、`bg-primary`、`text-primary-foreground` 和 `rounded-(--radius)` 引用应用主题的令牌（[主题 token](./tailwind.md#主题-token)）：
  它们自动跟随深色模式，`nsh.json` 中的 `"theme"` 可以改变它们的样式。
- **`mount(App)`** 把组件渲染到应用的界面上。

> [!IMPORTANT]
> 文字显示在文本元素中：Rust 中是 `text(..)`，TSX 中是 `<Text>`。在 TSX 中，直接写在 `<View>` 里的文字（`<View>Hello</View>`）会在构建时报错并指出位置；由表达式放进去的字符串（`<View>{name}</View>`）会在日志中提示。

## 开发

### 运行

`nsh run` 构建应用、启动它，并在你编辑时重新构建；应用的日志显示在终端中。把应用目录交给它：它运行 Rust 应用的根组件，或 TSX
应用的 `App.tsx`（`nsh run my-app/App.tsx` 可以指定其他入口）。

对 Rust 应用，`nsh run` 为目标平台构建应用自己的运行器，链接你的 crate、挂载根组件，不带 QuickJS，然后启动它；Rust
代码变化时重新构建并重启应用。在应用目录中运行 `cargo run` 会直接在桌面后端上启动同一个根组件。对 TSX 应用，`nsh run`
启动开发服务器和从中加载应用的开发宿主，每次保存都给运行中的应用打补丁。

不传 `--target` 时，`nsh run` 使用你所在的机器：macOS 上是一个 AppKit 窗口，Windows 上是一个 Win32 窗口，Linux 上是一个 GTK
窗口。用 `--target` 选择其他平台：

| 目标 | 命令 | 在哪里运行 |
|---|---|---|
| iOS 模拟器 | `nsh run my-app --target ios` | 装有 Xcode 的 macOS |
| Android | `nsh run my-app --target android` | macOS、Windows、Linux |
| macOS（AppKit） | `nsh run my-app` | macOS（默认） |
| Windows | `nsh run my-app` | Windows（默认） |
| Linux（GTK 4） | `nsh run my-app` | Linux（默认） |
| Web | `nsh run my-app --target web` | macOS、Windows、Linux |
| Mac Catalyst | `nsh run my-app --target catalyst` | macOS |

#### iOS 模拟器

```sh
nsh run my-app --target ios
nsh run my-app --target ios --device "iPhone 16 Pro"
```

`nsh` 会使用已启动的模拟器；如果没有正在运行的模拟器，就启动最新的 iPhone，并把应用（Rust 应用的运行器，或开发宿主）安装进去。`--device`
按名称或 UDID 选择模拟器。

#### Android

```sh
nsh run my-app --target android
```

先启动模拟器或连接设备（`adb devices` 会列出它们；NSH 使用第一个）。`nsh` 会把应用安装到上面：Rust 应用自己的
`libnsh.so`，或者一个开发宿主 APK（只在运行时变化时重新构建），开发服务器的端口通过 `adb reverse` 转发到设备上，因此通过 USB
即可工作，无需共享网络。

#### macOS（AppKit）

```sh
nsh run my-app --target macos
```

应用会作为桌面 Mac 应用打开（AppKit，窗口可调整大小），使用鼠标、触控板和键盘输入而不是触摸。需要 macOS 14 及以上；见
[macOS](./macos.md)。

#### Windows（Windows 上默认）

```sh
nsh run my-app
```

应用会在一个桌面窗口（1200×800 点）中打开，使用鼠标、触控板、触摸和键盘输入。需要 Windows 10 1809 及以上；见
[Windows](./windows.md)。

#### Linux（Linux 上默认）

```sh
nsh run my-app
```

应用会在一个 GTK 窗口（390×844 点）中打开。需要 GTK 4.14 及以上；见 [Linux](./linux.md)。

#### Web

```sh
nsh run my-app --target web
```

`nsh` 会打印页面地址，在浏览器中打开即可。Rust 应用以带有你的 crate 的 WebAssembly 运行，变化之后，打开的页面会自行加载新的构建；见 [Web](./web.md)。

#### Mac Catalyst

```sh
nsh run my-app --target catalyst
```

应用会在 Mac 上一个 iPhone 尺寸（390×844 点）的窗口中打开。这是查看应用在手机上效果最快的方式：不需要启动模拟器。它和 iOS
一样使用 UIKit，所以看到的效果就是 iPhone 上的效果，只有 Mac 特有的行为除外，例如用鼠标滚轮滚动。要运行 Mac 应用本身，请用
`--target macos`。

### 编辑

保持 `nsh run` 运行，修改按钮的文字：

```rust tabs
text("Add one")
    .text_size(px(17.0))
    .text_color(move || theme().primary_foreground)
```

```tsx tabs
<Text style={{ color: "white", fontSize: 17 }}>Add one</Text>
```

保存。Rust 应用会重新构建，并带着新文字重启；计数从头开始。TSX 应用得到一次热更新：CLI
重新构建并发送补丁，宿主重新运行变化的模块，并只重新渲染代码有变化的组件。这里变化的是持有 `count` signal 的 `App`，所以计数同样归零。

一段界面可以移到单独的组件里，或者一个返回元素的普通函数里：

```rust tabs
/// 应用的按钮：一个响应按压的视图。
fn tap_button(on_press: impl Fn() + 'static) -> impl IntoElement {
    view()
        .p_3()
        .rounded(px(10.0))
        .bg(move || theme().primary)
        .active(|s| s.opacity(0.6))
        .on_press(on_press)
        .child(text("Tap").text_size(px(17.0)).text_color(move || theme().primary_foreground))
}

// 在 App 中：.child(tap_button(move || count.update(|value| *value += 1)))
```

```tsx tabs
function TapButton(props: { onPress: () => void }) {
  return (
    <View onPress={props.onPress} activeStyle={{ opacity: 0.6 }} style={{ padding: 12, borderRadius: 10, backgroundColor: "#0969da" }}>
      <Text style={{ color: "white", fontSize: 17 }}>Tap</Text>
    </View>
  );
}

// 在 App 中：<TapButton onPress={() => count.update((c) => c + 1)} />
```

在 TSX 中，当你编辑的组件并不持有状态时，状态会被保留：点几下，然后修改 `TapButton` 的颜色，按钮会更新，计数保持不变。热替换以顶层组件为单位：名称首字母大写、函数体中包含
JSX 的函数。组件在自身代码变化时，或模块中组件之外的代码（它用到的常量、辅助函数）变化时重新渲染。如果某次编辑无法原地应用（例如导入了运行中的应用尚未导入的
NSH 模块，或修改了 `nsh.json` 中的 capabilities），宿主会重新加载整个应用。

#### 错误

Rust 编译错误会连同 cargo 的输出一起打印在终端中，`nsh run` 在下一次保存时重新构建。TSX
构建错误会打印在终端中，并在设备上以红色浮层显示文件、行号和列号；应用继续运行上一次成功的构建。下次构建成功后浮层会消失（也可以点击提前关闭）。运行时抛出的异常以同样方式显示，调用栈会映射回你的
`.tsx` 源码。

## 承载到你的应用里

原生应用用一个专门的视图显示 NSH：iOS 上是 `NshAppView`（一个 `UIView`），Android 上是 `NshView`（一个 Android `View`），macOS、Windows、Linux
和 GPUI 应用中是 `AppView`。像其他视图一样摆放即可，可以放在任何页面，数量不限。

Rust 根组件是应用构建的一部分：应用链接你的 crate，在 macOS、Windows、Linux、GPUI 和 iOS 的 `AppView` 上用 `AppSource::Rust`
挂载根组件（[用 Rust 开发](./rust.md#完全用-rust-编写的应用)）。TSX 应用则是视图加载的模块：开发时来自开发服务器，发布时来自构建好的
bundle 或下载的签名包。下面几节加载的是 TSX 模块。

### iOS

在 Debug 配置中链接 `NativeShellDev.xcframework`，在 Release 中链接 `NativeShell.xcframework`（[在 iOS 应用中嵌入](./ios.md)），然后：

```swift
import NativeShell

let app = NshAppView()
app.onError = { message in print("nsh error: \(message)") }
view.addSubview(app)   // 再像普通视图一样设置约束

#if DEBUG
try app.connectDevServer(URL(string: "ws://127.0.0.1:8790/ws")!)   // 在 Mac 上运行 `nsh dev my-app`
#else
try app.loadBundle(at: Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")!)
#endif
```

`nsh dev my-app` 把模块提供给应用，并在每次保存后推送更新，就像 `nsh run` 对它自带的宿主所做的那样。发布版用 `nsh build my-app --release --out MyApp/nsh`
把 bundle 写进一个文件夹，再把它加入应用的资源。

### Android

调试版添加 `nsh-dev.aar`，发布版添加 `nsh.aar`（[在 Android 应用中嵌入](./android.md)），然后：

```kotlin
val nsh = NshView(this)
nsh.setErrorListener { message -> Log.e("nsh", message) }
setContentView(nsh)   // 或者加入任意布局

if (BuildConfig.DEBUG) {
    nsh.connectDevServer("ws://127.0.0.1:8790/ws")   // 配合 `adb reverse tcp:8790 tcp:8790`
} else {
    nsh.loadAssetBundle("nsh")   // assets/nsh，由 `nsh build my-app --release --out app/src/main/assets/nsh` 生成
}
```

### macOS、Windows 和 Linux

用 Rust 编写的桌面应用通过 `AppView` 嵌入 NSH，它来自 `nsh-platform-macos`、`nsh-platform-windows`、`nsh-platform-linux` 和
`nsh-platform-gpui` 这几个 crate：一个 `NSView`、一个子窗口、一个 GTK 控件或一个 GPUI 视图，挂载 Rust 根组件或加载构建好的 bundle。见
[macOS](./macos.md#嵌入-mac-应用)、[Windows](./windows.md#嵌入-win32-应用)、[Linux](./linux.md#嵌入-gtk-应用) 和
[GPUI](./gpui.md)；各平台宿主的对照见[平台](./platforms.md#嵌入原生应用)。

### 模块能做什么

在 iOS 和 Android 上，由宿主在加载之前决定模块能做什么：`grantCapabilities` 设置它能访问的网络主机和其他能力，各项限制约束它的内存、调用时长和节点数（[沙箱与能力](./sandbox-and-capabilities.md)）。要让模块使用你自己的原生视图（地图、图表、设计系统组件），把它们注册为[原生组件](./native-components.md)。

## 以签名包下发更新

应用在发布之后下载的 TSX 模块，以签名包的形式提供。先创建一个根密钥并离线保管，用它认证一个发布密钥，然后发布：

```sh
nsh keygen keys/root && nsh keygen keys/release
nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
nsh publish my-app --key keys/release.secret --cert keys/release.cert --build 2
```

应用信任根公钥，并加载下载到的包；NSH 在运行任何代码之前校验签名、证书和吊销列表：

```swift
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
let trust = try NshTrust(stateDirectory: support.appendingPathComponent("nsh"))
try trust.addRoot(rootPublicKey)   // keys/root.pub 的内容
let info = try await app.loadPackage(at: downloadedFile, trust: trust)
```

Android 上用 `NshTrust` 和 `NshPackage`，流程相同。承载、下发和吊销的细节见[签名包](./signed-packages.md)。

## 或者作为独立应用发布

`nsh package` 把应用（Rust 或 TSX）打成可安装的应用，不需要你自己的 Xcode 工程或 Gradle 构建：

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target android
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target web
```

Rust 应用用它自己的运行器打包，由你的 crate 和 NSH 的 crate 构建，挂载根组件；TSX 应用使用预编译的运行时。选项、签名和图标见[打包](./packaging.md)。

## 在终端中试运行

`nsh test` 以无界面方式运行应用，不需要设备或窗口。给它 Rust 应用的 `nsh.json` 或 TSX 应用的入口，它会打开应用、让它运行，并打印它挂载的内容；加上
`--trace` 时，还会打印原生视图操作以及每次提交的耗时（[测试](./testing-and-trace.md)）：

```sh
nsh test my-app/nsh.json --trace     # Rust 应用的根组件
nsh test my-app/App.tsx --trace      # TSX 应用的入口
```

给它一个目录时，它运行应用的测试：每个模板的 `App.test.tsx` 都会打开应用、按下按钮并检查显示的内容（`nsh test my-app`）。Rust
应用的测试用 `open(".")` 打开它的根组件；它也可以在 `cargo test` 中用 `nsh_testing::Headless` 测试（[用 Rust 开发](./rust.md#测试)）。

## 下一步

- [用 Rust 开发](./rust.md)：Rust 应用、它的主题，以及在 Rust crate 之上使用 TSX。
- [JSX 与组件](./jsx-and-components.md)和[响应式](./reactivity.md)：Rust 与 TSX 中的组件和 signal。
- [平台](./platforms.md)：每个平台支持什么，以及各平台自己的页面（[iOS](./ios.md)、[Android](./android.md)、[macOS](./macos.md)、[Windows](./windows.md)、[Linux](./linux.md)）。
- [签名包](./signed-packages.md)和[沙箱与能力](./sandbox-and-capabilities.md)：下发方式，以及模块能做什么。
- [项目结构](./project-structure.md)：`nsh.json`、资源和文件。
