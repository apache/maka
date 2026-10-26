---
title: iOS
description: 在 iOS 上用 UIKit 视图运行 Rust 和 TSX 编写的 NSH 应用（模拟器或真机），打包成 .app 和 .ipa，并通过 AppView 或 NativeShell.xcframework 的 NshAppView 嵌入现有 iOS 应用。
order: 11
group: platforms
---

# iOS

NSH 应用在 iOS 上用 UIKit 视图和 CoreText 文本运行，支持真机和模拟器，要求 iOS 15.0 及以上。完整应用的运行和打包方式
与其他平台相同；现有应用也可以在自己的视图中显示 NSH 应用，可以是它链接的 Rust 根组件，也可以是它加载的 TSX，包括它下载的签名包，
并按自己设定的限制和能力运行它们。在 iOS 上，`os()` 是 `Os::Ios`（TSX 中 `platform.os` 是 `"ios"`），TSX 的
`ios={{…}}` 属性生效。

## 环境要求

- Mac 上的 **Xcode**，以及一个 iOS 模拟器运行时（`xcodebuild -downloadPlatform iOS` 可以安装）。见[安装](./installation.md#ios-与-mac-catalyst)。
- 应用需要 **iOS 15.0** 及以上，支持 iPhone 和 iPad。

## 运行应用

Rust 应用在自己的目录里运行，TSX 应用写明入口：

```sh
nsh run --target ios                                  # Rust 应用
nsh run --target ios --device "iPhone 16 Pro"
nsh run App.tsx --target ios                          # TSX 应用
```

`nsh` 会使用已启动的模拟器，或者启动最新的 iPhone。对 Rust 应用，它用你的 crate 构建应用自己的 runner 并安装，在终端显示日志；
修改 crate 的 Rust 代码会重新构建并重启应用。对 TSX 应用，它安装开发宿主，并在你保存时更新应用，日志显示在终端中。`--device`
按名称或 UDID 选择模拟器。想要不用模拟器、更快的开发循环，在 Mac 上运行 `nsh run --target catalyst`，会在一个 iPhone 尺寸的
[Mac Catalyst](./getting-started.md#mac-catalyst) 窗口中打开同一个 UIKit 后端。

## 打包

```sh
nsh package --target ios-simulator --run      # .nsh/out/<Name>.app，安装到模拟器并启动
nsh package --target ios --sign "Apple Distribution: Example Inc (ABCDE12345)" --profile AppStore.mobileprovision
```

在 Rust 应用的目录里，应用是用你的 crate 构建的 iOS runner；TSX 应用需写明入口（`nsh package App.tsx --target ios-simulator --run`）。

`--target ios` 为真机、TestFlight 或 App Store 生成签名的 `.ipa`。签名身份、描述文件和图标见[打包](./packaging.md#ios-真机)。

## 嵌入 iOS 应用

现有的 iOS 应用可以在自己的界面中显示 NSH 应用。带 Rust 代码的 iOS 应用链接你的 crate 和 `nsh-platform-ios` crate，在
`AppView` 中显示你的根组件（[嵌入 Rust 应用](#嵌入-rust-应用)）。Swift 应用链接 `NativeShell.xcframework`，这是一个带 Swift
模块的 framework：创建一个 `NshAppView`（一个 `UIView`），把它加到视图层级的任意位置，再往里加载一个 TSX 应用或签名包即可。
你的原生页面、导航和 NSH 应用共处同一个 UIKit 视图层级。

每个视图都是一个独立的引擎；没有全局单例，所以一个应用可以同时显示多个 NSH 应用，比如每个标签页一个。

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/host-app-light.svg" alt="一个宿主应用里有两个 NshAppView 区域：每个都是独立的引擎，有自己的线程、虚拟机、限制和能力；宿主授予能力、设置限制，并注册地图这样的原生组件。">
<img class="diagram diagram-dark" src="/diagrams/host-app-dark.svg" alt="一个宿主应用里有两个 NshAppView 区域：每个都是独立的引擎，有自己的线程、虚拟机、限制和能力；宿主授予能力、设置限制，并注册地图这样的原生组件。">
</div>

## 嵌入 Rust 应用

`nsh_platform_ios::AppView` 是用 Rust 构建的 iOS 应用里一个以 `UIView` 形式存在的引擎：它挂载你的 crate 的根组件，不涉及
JavaScript 虚拟机。

```rust
use nsh_platform_ios::{set_ui_sets, AppView, Root, SurfaceOptions};
use objc2::MainThreadMarker;
use objc2_ui_kit::UIView;

fn show(container: &UIView) -> AppView {
    // 在第一个视图之前设置一次：应用导入的 UI 集合（NSH 的和你的 crate 的）。
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = AppView::new(mtm, container.bounds(), SurfaceOptions::default());
    container.addSubview(app.view());
    app.run(Root::of::<my_app::App>());
    // 保留 AppView：丢弃它就会停止应用。
    app
}
```

视图随父视图调整大小。`AppView::run` 替换正在运行的内容；`AppView::load` 则运行 TSX bundle（`Bundle::source`，或对应用包内的
`bundle.nshc` 使用 `unsafe { Bundle::bytecode(bytes) }`）。`SurfaceOptions` 包含限制、授予的能力、数据目录和原生组件，与下文
`NshAppView` 的成员对应；`AppView::set_locale`、`set_font_scale` 和 `set_error_handler` 对应 `locale`、`fontScale` 和 `onError`。
`nsh package --target ios` 会为你构建这种应用，并挂载好根组件。

## 获取 framework

发行包中包含两个版本：

```text
dist/nsh/embed/ios/NativeShell.xcframework      release: bundles and signed packages
dist/nsh/embed/ios/NativeShellDev.xcframework   also connects to a `nsh dev` server
```

如果你有 NSH 的源码，可以只构建这两个 framework：

```sh
cargo xtask ios-embed    # writes dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework
```

默认构建生成静态 framework。要构建动态 framework，运行：

```sh
cargo xtask ios-embed --dynamic
```

动态 framework 让运行时拥有独立的库映像和展开表，适合已经链接其他 Rust 运行时的宿主应用。请根据构建类型选择下文的 Xcode 嵌入设置。

默认情况下，每个 XCFramework 包含三个 arm64 切片：iOS 真机、iOS 模拟器（Apple 芯片）和 Mac Catalyst。最低部署目标为 iOS 15.0。Swift
模块启用了 library evolution 编译，因此用其他版本 Swift 编译器构建的应用也能导入它；framework 已链接了它需要的一切，你无需再添加其他东西。

## 加入 Xcode 项目

1. 把 `NativeShell.xcframework`（开发构建则用 `NativeShellDev.xcframework`）拖到应用 target 的
   **Frameworks, Libraries, and Embedded Content** 中。默认的静态 framework 选择 **Do Not Embed**；
   使用 `--dynamic` 构建的动态 framework 选择 **Embed & Sign**。
2. 在 Swift 中 `import NativeShell`。
3. 在应用的 `Info.plist` 中把 `CADisableMinimumFrameDurationOnPhone` 设为 `YES`：在 ProMotion iPhone 上，应用的动画
   就会像滚动一样以 120 Hz 运行（`nsh package` 构建的应用已经设置）。

> [!TIP]
> 在 Debug 配置中链接 `NativeShellDev.xcframework`，在 Release 配置中链接 `NativeShell.xcframework`，这样只有开发构建能连接开发服务器。

## 随应用附带 bundle

Swift 应用以 bundle 的形式附带 TSX 应用。把 NSH 应用构建到一个文件夹里，再以名为 `nsh` 的文件夹引用（folder reference）把它加入应用资源：

```sh
nsh build App.tsx --release --out MyApp/nsh
```

`nsh build` 会写出：

| 文件 | 内容 |
|---|---|
| `bundle.nshc` | 编译后的应用字节码：加载最快。 |
| `bundle.js` | 同一个应用的 JS 源码。 |
| `bundle.js.map` | 它的 source map（堆栈跟踪会指向你的 `.tsx` 文件）。 |
| `capabilities.json` | 应用声明的[能力](./sandbox-and-capabilities.md)，仅当 `nsh.json` 中有声明时生成。 |
| `assets/` | 应用导入的图片和字体，路径相对于入口文件。 |

## 显示应用

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
        do {
            try app.loadBundle(at: url)
        } catch {
            print("cannot load: \(error)")
        }
    }

    // Let the embedded app's pages and dialogs decide the status bar.
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
        NshAppView.preferredStatusBarUpdateAnimation
    }
}
```

视图的尺寸就是应用的窗口：NSH 按视图的 bounds 布局应用，bounds 变化时重新布局。再次加载会替换正在运行的应用；视图被释放时应用随之停止。

完整示例是 `examples/embed-ios/main.swift`：一个在自己的原生标题栏下方显示 NSH 应用的 UIKit 应用。

## `NshAppView`

`NshAppView` 是 `UIView` 的子类，隔离在 main actor 上。

| 成员 | 说明 |
|---|---|
| `init(frame: CGRect = .zero, trace: Bool = false)` | 创建视图。`trace` 会记录每次提交的耗时。`init?(coder:)` 支持 storyboard 和 nib。 |
| `onError: ((String) -> Void)?` | 在主线程上接收应用的致命错误（bundle 加载失败、未捕获的 JS 异常、VM 因触及限制而停止）。错误总会写入日志；开发构建还会把错误显示在应用上方。 |
| `limits: NshLimits` | 此后加载的应用的 VM 限制。 |
| `grantCapabilities(_ json: String?) throws` | 此后加载的应用最多能做什么，JSON 格式与 `nsh.json` 的 `capabilities` 相同；`nil` 表示授予每个应用所声明的能力。JSON 无效时抛出 `NshError`。 |
| `locale: Locale?` | 代替用户设置的语言和地区：`Intl`、`locale()` 和组件立即跟随，此后加载的应用也从它开始。`nil` 跟随系统。 |
| `fontScale: CGFloat?` | 代替动态字体的文字大小（1 为默认）：文字和输入框按它重新排版，`fontScale()` 读到它，立即生效，此后加载的应用也一样；长度保持原样。`nil` 跟随系统。 |
| `setThemeOverrides(_ json: String?) throws` | 把宿主的品牌加在应用的[主题](./tailwind.md#主题-token)之上：格式与 `nsh.json` 的 `"theme"` 相同的主题文件。其中的 token 在浅色和深色模式下都覆盖应用的同名 token，应用的其他 token 保持不变。立即生效，并作用于之后加载的应用；`nil` 恢复应用自己的主题。文件无法解析时抛出 `NshError`。 |
| `storageDirectory: URL?` | 此后加载的应用保存其[存储](../modules/nsh-storage.md)的目录；`nil`：`Library/Application Support/nsh/<app id>`，按应用自己的 id。 |
| `cacheOptions: NshCacheOptions` | 此后加载的应用保存缓存（[下载的图片](./images-and-assets.md#磁盘缓存)）的位置和每种缓存的大小：`location` 为 `.system`（`Library/Caches/nsh`，每个应用在 `<app id>`）、`.directory(URL)` 或 `.off`；`images` 为 `.default`（256 MB）、`.maxSize(megabytes:)` 或 `.off`。 |
| `loadBundle(at url: URL) throws` | 运行 `nsh build` 写出的 bundle。资源取自同目录下的 `assets/`；同目录下的 `bundle.js.map` 和 `capabilities.json` 也会被读取。 |
| `run(_ package: NshPackage)` | 运行一个已验证的签名包（见下文）。一个包只能运行一次。 |
| `loadPackage(at:trust:) async throws -> NshPackage.Info` | 在主线程之外验证指定 URL 的包，然后运行它。被拒绝时抛出原因；正在运行的应用保持不变。 |
| `connectDevServer(_ url: URL) throws` | 开发用：从 `nsh dev` 服务器加载，每次修改后重新加载。使用不含开发支持的 `NativeShell.xcframework` 时会抛出错误。 |
| `register(component:_:)` | 注册一个[原生组件](./native-components.md)。 |
| `params: [String: Any]` | 之后加载的应用的启动参数：应用在启动时以 `host.params` 读取（[`nsh/host`](../modules/nsh-host.md)）。 |
| `send(_ name: String, _ data: Any? = nil)` | 向应用发送一个事件（`host.on(name, …)`）；应用开始监听前会一直保留，没有应用运行时留给下一个应用。 |
| `handle(_ name: String, _ handler:)` | 在主线程处理应用对 `name` 的调用（`host.call`）和投递（`host.post`）：`{ data, reply in … }`，或一个 `async throws` 函数 `{ data in … }`，其结果即调用的回答。 |
| `removeHandler(_ name: String)` | 移除 `name` 的处理函数：应用对它的调用随即失败。 |
| `static preferredStatusBarStyle`、`prefersStatusBarHidden`、`preferredStatusBarUpdateAnimation` | 正在运行的应用请求的状态栏设置（其页面和对话框的 `statusBar`、`nsh.json` 的默认值）：在宿主视图控制器的对应重写中返回它们。 |

> [!IMPORTANT]
> `bundle.nshc`（字节码）只能从应用包内部加载。QuickJS 不校验字节码，其他来源的字节码可能破坏内存：对于应用包之外的文件，请加载
> `bundle.js`（JS 源码），更好的做法是使用[签名包](./signed-packages.md)。

`limits`、`grantCapabilities`、`storageDirectory` 和 `cacheOptions` 从下一次加载开始生效：请在 `loadBundle` / `run` 之前设置。

每个应用无需任何设置就按自己的 id 保存存储：签名包使用其发布密钥证书担保的 id，bundle 使用其 `nsh.json` 中的 `id`（`nsh build` 写在它旁边的 `app.json`）。如果宿主想把应用的数据放到自己选择的位置，设置 `storageDirectory`：

```swift
app.storageDirectory = FileManager.default
    .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("nsh/com.example.orders")
try app.loadBundle(at: url)
```

## 与应用通信

视图与它运行的应用通过一条专属通道通信（[`nsh/host`](../modules/nsh-host.md)）：应用在启动时读取的启动参数、宿主应用发来的事件，以及应用发出的调用和投递，数据都是 JSON（在这一侧是 Foundation 对象）。应用里不需要任何视图，也不需要原生组件。

```swift
// 加载之前：应用首先打开的内容（TSX 中的 `host.params`）。
app.params = ["conversation": notification.conversationID]
try app.loadBundle(at: url)

// 应用的 `await host.call("user.profile", { id })`：返回回答，或抛出错误让调用失败。
app.handle("user.profile") { data in
    let id = (data as? [String: Any])?["id"] as? Int ?? 0
    let profile = try await api.profile(id: id)
    return ["id": id, "name": profile.name]
}

// 稍后在任意线程用 reply 回答的处理函数。
app.handle("photo.pick") { _, reply in
    picker.present { url in
        if let url { reply.resolve(url.absoluteString) } else { reply.reject("cancelled") }
    }
}

// 应用的 `host.post("analytics", …)`：没有回答。
app.handle("analytics") { data, _ in analytics.log(data) }

// 之后：应用通过 `host.on("conversation.open", …)` 收到它。
app.send("conversation.open", ["id": tapped.conversationID])
```

处理函数在主线程运行；调用在应用中等待回答，不会阻塞任何一方。未回答就被释放的 reply 会让调用失败，没有处理函数的名称的调用会立即失败。应用尚未监听的名称的事件会保留到它开始监听，没有应用运行时（`loadBundle` 之前、重新加载期间）发送的事件交给下一个应用，因此应用启动期间点开的通知照样能送到。
## 主题覆盖

嵌入在多个品牌宿主应用中的同一个应用会采用各个宿主的品牌：宿主给出其品牌要改的 token，格式与 `nsh.json` 的 `"theme"` 相同的主题文件（shadcn/ui 的 `cssVars`，值按 CSS 的写法）。它们覆盖应用的同名 token，应用的其他 token 保持不变。在 `dark` 下给出 token 的深色模式值（只在 `light` 或 `theme` 下设置的 token 在两种模式下都是这个颜色）：

```swift
try app.setThemeOverrides("""
{ "cssVars": {
    "theme": { "radius": "0.75rem" },
    "light": { "primary": "#e11d48", "primary-foreground": "#ffffff" },
    "dark": { "primary": "#fb7185", "primary-foreground": "#1c1917" }
} }
""")
try app.loadBundle(at: url)
```

在加载之前或之后调用都可以：`bg-primary`、`rounded-(--radius)` 等类名立即更新样式，之后加载的每个应用在第一帧就带有这些覆盖。`setThemeOverrides(nil)` 恢复应用自己的主题。

## 应用打开的链接

应用打开的 URL（[`openUrl`](../modules/nsh-device.md#openurl)，以及 `links="open"` 的 `TextView` 中的链接）先交给 `onOpenURL`，在主线程调用：宿主应用自己处理了这个 URL（例如交给自己的路由）时返回 `true`，返回 `false` 则由系统用 `UIApplication.open` 打开。没有设置 `onOpenURL` 时，所有 URL 都由系统打开。到达这里的 URL 都已通过应用的 `openUrl` 能力检查。

```swift
app.onOpenURL = { url in
    // 宿主应用自己的链接在宿主应用里打开。
    if url.scheme == "lb" || url.host == "longbridge.com" {
        router.open(url)
        return true
    }
    return false
}
```

## 限制

```swift
app.limits = NshLimits(memoryMB: 128, callBudget: 1, maxNodes: 50_000)
```

| `NshLimits` 字段 | 默认值 | 含义 |
|---|---|---|
| `memoryMB: UInt32?` | 256 | JS 堆大小（MB）。耗尽时应用停止。 |
| `stackKB: UInt32?` | 4096（也是上限） | 解释器栈大小（KB）。递归更深会抛出 `RangeError`。 |
| `loadBudget: TimeInterval?` | 10 s | 执行 bundle 的时间。 |
| `callBudget: TimeInterval?` | 2 s | 其他每次 JS 调用（一个事件、一个定时器、一帧）的时间。超时的调用会被中断。 |
| `maxNodes: UInt32?` | 200 000 | 应用可保留的节点数。 |

`nil` 表示使用默认值。各项限制触发时会发生什么，见[沙箱与能力](./sandbox-and-capabilities.md)。

## 能力

应用在 `nsh.json` 中声明它可以访问什么；嵌入方应用可以授予更少的能力。一个请求必须同时被两者允许：

```swift
try app.grantCapabilities("""
{
  "network": { "hosts": ["api.example.com", "*.cdn.example.com"] },
  "webview": { "hosts": ["help.example.com"] }
}
""")
try app.loadBundle(at: url)
```

这里应用不能设置状态栏（没有 `statusBar`），即使它的 `nsh.json` 申请了也不行。详见[沙箱与能力](./sandbox-and-capabilities.md)。

## 签名包

要运行应用下载的代码（更新、第三方小程序），请使用[签名包](./signed-packages.md)：`nsh publish` 会写出一个
`.nshpkg`，由经你的根密钥认证的发布密钥签名，应用在运行前对它进行验证。

```swift
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
let trust = try NshTrust(stateDirectory: support.appendingPathComponent("nsh"))
try trust.addRoot(rootPublicKey)   // the contents of root.pub from `nsh keygen`

Task {
    do {
        let info = try await app.loadPackage(at: downloadedFile, trust: trust)
        print("running \(info.id) \(info.version) (build \(info.build))")
    } catch {
        print("refused: \(error)")   // the running app stays
    }
}
```

如果想先验证、稍后再运行，可以把两步拆开：

```swift
let package = try await trust.openPackage(at: downloadedFile)   // verifies off the main thread
// ... decide, ask the user, ...
app.run(package)
```

| API | 说明 |
|---|---|
| `NshTrust(stateDirectory: URL) throws` | 打开或创建信任库。它的状态（最新的吊销列表、每个应用已接受的最高构建号）持久化在该目录中，包的资源也解压到其下。在调用 `addRoot` 之前不信任任何密钥。线程安全。 |
| `addRoot(_ publicKey: String) throws` | 信任一个根公钥（base64，即 `.pub` 文件的内容）。可以信任多个根。 |
| `updateRevocations(_ json: String) throws` | 应用 `nsh revoke` 写出的吊销列表；该列表须由受信任的根签名，且比信任库现有的更新。 |
| `openPackage(at: URL) async throws -> NshPackage` | 验证包、解压资源并接受该包（此后该应用更旧的构建都会被拒绝）。 |
| `NshPackage.info` | 包内应用的 `id`、`name`、`version`、`build`。 |
| `NshError` | 所有会抛出错误的调用抛出的错误类型；`message` 说明原因。 |

## 开发

使用 `NativeShellDev.xcframework` 时，可以让视图连接开发服务器，而不是加载 bundle：

```swift
#if DEBUG
try app.connectDevServer(URL(string: "ws://127.0.0.1:8790/ws")!)
#else
try app.loadBundle(at: bundledURL)
#endif
```

在 Mac 上运行 `nsh dev App.tsx`。模拟器与 Mac 共享网络，所以 `127.0.0.1` 就能访问服务器；真机则使用 `nsh dev`
打印的局域网地址（`devices on this network: ws://192.168.1.20:8790/ws`）。每次保存都会就地更新应用，日志显示在 `nsh dev`
终端中，错误显示在应用上方。参见[开发服务器与调试](./dev-server-and-debugging.md)。

> [!NOTE]
> 在真机上，与 Mac 的连接是普通的本地网络流量，使用明文的 `ws://` 和 `http://`（资源）。iOS 可能会请求用户授予本地网络访问权限，应用的
> App Transport Security 设置也必须允许这种连接。

## 注意事项

- **线程。** `NshAppView` 隔离在 main actor 上。`NshTrust`、`NshPackage` 和 `NshComponentContext` 是线程安全的。JS
  引擎运行在自己的线程上；主线程从不等待它。
- **状态栏。** 嵌入应用的页面和对话框（`statusBar`）会改变 `NshAppView.preferredStatusBarStyle` 等属性的返回值；宿主视图控制器必须像上面的示例那样转发它们。
- **安全区域。** 应用照常在 Rust 中使用 `safe_area()`，在 TSX 中使用 [`nsh/base`](../modules/nsh-base.md#safeareaview) 中的
  `SafeAreaView` 或 `safeAreaInsets()`。放在你自己标题栏下方的 `NshAppView` 拿到的是适用于它自身的 insets，而不是整个窗口的。
- **Mac Catalyst。** 同一个 framework 也可用于 Catalyst 应用。

## 另请参阅

- [用 Rust 开发](./rust.md)
- [嵌入 Android 应用](./android.md)
- [原生组件](./native-components.md)
- [签名包](./signed-packages.md)
- [沙箱与能力](./sandbox-and-capabilities.md)
