---
title: 开发服务器与调试
description: 用 nsh run 和 nsh dev 运行 Rust 和 TSX 应用，连接模拟器、Android 模拟器和真机，并使用重新构建、模块热替换、日志、错误浮层和经 source map 映射的调用栈。
order: 60
group: tools
---

# 开发服务器与调试

开发期间，NSH 会在每次保存时构建应用。Rust 应用（`nsh.json` 写明 `"root"`）构建成它自己的 runner，由 `nsh run` 启动；修改它的
crate 会重新构建并重启应用。TSX 应用则推送给所有已连接的宿主，宿主就地更新。有两条命令可以做到这一点：

- `nsh run` 构建应用 **并且** 启动它：Mac Catalyst 或 AppKit 窗口、Linux 上的 GTK 窗口、Windows 上的 Win32 窗口、iOS 模拟器、
  Android 真机或模拟器，或者一个浏览器页面。对 TSX，它还会启动开发服务器，由开发宿主连接。
- `nsh dev --server-only` 为 TSX 启动开发服务器，宿主由你自己启动：集成了开发版 SDK 的自有应用、网络中的某台设备，或同时连接多个宿主。

```sh
# Rust 应用，在它的目录里
nsh run                             # AppKit window (macOS); GTK window (Linux); Win32 window (Windows)
nsh run --target ios                # iOS simulator
nsh run --target android            # Android device or emulator

# TSX 应用
nsh run App.tsx                     # AppKit window (macOS); GTK window (Linux); Win32 window (Windows)
nsh run App.tsx --target macos      # AppKit window (macOS)
nsh run App.tsx --target ios        # iOS simulator
nsh run App.tsx --target android    # Android device or emulator
nsh dev App.tsx --server-only       # server only
```

`nsh dev` 默认也打开原生宿主；移动端需要指定 `--target ios` 或 `--target android`。

## `nsh run`

| 参数 | 说明 |
|---|---|
| `--target <catalyst \| ios \| android \| macos \| linux \| windows \| gpui \| web>` | 在哪里运行。macOS 上默认 `macos`（AppKit 窗口），Linux 上默认 `linux`，Windows 上默认 `windows`。Rust 应用可以在除 `gpui` 之外的所有目标上运行；GPUI 应用嵌入它的根组件（[GPUI](./gpui.md)）。 |
| `--device <name or UDID>` | 要使用的 iOS 模拟器。默认：已启动的那个，否则使用最新的 iPhone（会自动为你启动）。 |
| `--port <port>` | 开发服务器端口。默认 8790；如被占用，则使用下一个空闲端口。 |
| `--release` | 提供 TSX 的 release 构建（压缩、无调试信息、无热更新）。 |
| `--trace` | 在宿主上记录每次提交（commit）的耗时（TSX 应用）。 |

各个目标的行为：

- **`catalyst`**（macOS）以 Mac 应用的形式运行开发宿主。停止 `nsh run`（Ctrl-C）会关闭它，关闭窗口也会结束 `nsh run`。
- **`macos`**（macOS）在一个 1200×800 的窗口中以桌面应用的形式运行 AppKit 开发宿主，行为相同；Cmd+R 重新加载最新构建。
  需要 macOS 14 及以上（[macOS](./macos.md)）。
- **`linux`**（Linux）在一个 390×844 的窗口中运行 GTK 开发宿主，行为相同：Ctrl-C 会关闭它，关闭窗口也会结束 `nsh run`。
  需要 GTK 4.14 及以上（[Linux](./linux.md)）。
- **`windows`**（Windows）在一个 1200×800 的窗口中运行 Win32 开发宿主，行为相同；即使关闭控制台，宿主也不会比 `nsh run`
  活得更久。需要 Windows 10 1809 及以上（[Windows](./windows.md)）。
- **`ios`** 将开发宿主安装到模拟器中，启动它并指向开发服务器，然后持续监听。模拟器与 Mac 共享网络，因此宿主通过
  `127.0.0.1` 即可访问服务器。停止 `nsh run`（Ctrl-C）会关闭宿主，否则它会接入下一次会话。需要 Xcode。
- **`android`** 安装开发宿主 APK（同样只在运行时有变化时才安装），执行 `adb reverse tcp:<port> tcp:<port>`，使设备
  自己的 `127.0.0.1` 能访问到服务器，然后启动它。支持模拟器或 USB 连接的设备。需要 Android SDK（`ANDROID_HOME`）。
  `nsh run` 结束时（包括 Ctrl-C）会停止宿主并移除这条端口转发，因此该宿主不会接入下一次会话。

对 Rust 应用，每个目标都运行应用自己的、用它的 crate 构建的 runner：桌面平台直接运行 debug 构建，输出显示在终端；iOS 和 Android
安装它的一个包。对 TSX，这些宿主是通用的：服务器发来的任何 NSH 应用都能运行，因此不需要为每个应用单独构建宿主（带有自己 crate
的应用会得到用它构建的宿主）。

## `nsh dev`

```sh
nsh dev App.tsx
```

```text
✓ built App.tsx (3.2 KB js, 9.8 KB bytecode, 21ms)
→ dev server ws://127.0.0.1:8790/ws
  devices on this network: ws://192.168.1.20:8790/ws
```

| 参数 | 说明 |
|---|---|
| `--port <port>` | 开发服务器端口。默认 8790（如被占用则使用下一个空闲端口）。 |
| `--release` | 提供 release 构建。 |

将宿主连接到打印出的 URL：

- **你自己的 iOS 应用**，链接 `NativeShellDev.xcframework`：
  `try app.connectDevServer(URL(string: "ws://192.168.1.20:8790/ws")!)`。参见[嵌入 iOS 应用](./ios.md)。
- **你自己的 Android 应用**，使用 `nsh-dev.aar`：`nsh.connectDevServer("ws://192.168.1.20:8790/ws")`，或者执行
  `adb reverse tcp:8790 tcp:8790` 后使用 `ws://127.0.0.1:8790/ws`。参见[嵌入 Android 应用](./android.md)。

可以同时连接任意数量的宿主；每次构建都会发给所有宿主。后连接的宿主会立即收到当前构建。无法运行该应用的宿主（缺少应用导入的某个
UI 集，例如为另一个应用构建的开发宿主）不会收到构建：它会在屏幕上说明原因，终端也会打印一行 `warn`，给出安装该应用宿主的命令。

> [!NOTE]
> 局域网中的设备需要能通过开发服务器端口访问你的电脑：处于同一网络，中间没有防火墙。资源（图片、字体）也通过同一端口
> 以普通 HTTP 提供。

## 修改 Rust 代码

Rust 需要编译：修改应用的 crate，或它以路径依赖的 crate，会重新构建应用，`nsh run` 用新代码重启它。应用的状态从头开始；需要在重启后
保留的内容请放进[存储](../modules/nsh.md#storage)。构建错误会打印在终端，下一次能编译通过的保存会重新运行。在同时有 Rust 和 TSX
的应用中，修改 TSX 仍是热更新（见下文），修改 Rust 会重启应用。

## 模块热替换

TSX 的开发构建为每个源文件保留一个模块。保存时，NSH 重新构建，把各模块与上一次成功的构建比较，然后只发送包含变更模块的
**补丁**。宿主在远不到一毫秒的时间内就地应用补丁；从保存文件到看到变化大约需要 120 ms。

对你的应用来说，会发生这些事：

- **只有你编辑过的组件会重新渲染。** 每个顶层组件（返回 JSX 的首字母大写函数）都被包裹在一个稳定的代理中。当它的代码
  （或它可能用到的、所在模块的其余代码）发生变化时，它的实例会用新代码重新渲染；代码没有变化的组件则保留其实例，以及
  其中的 signal 和状态。修改一个按钮的样式，屏幕会停留在原处，输入框文本和滚动位置都不变。
- **变化的模块会重新运行**，导入了变化模块且自身无法接收该更新的模块也会重新运行，一直到入口为止。因此模块级代码会
  重新运行：在被编辑模块顶层创建的 `signal` 会从初始值重新开始。
- **顶层的 `context()` 对象保持同一身份**，只采用新的默认值，因此位于不同模块的 provider 和 consumer 依然能对应上。
- **模块重新运行时，其中的 `mount` 调用会被撤销**，因此入口模块重新 mount 不会叠加出多个应用。
- **抛出异常的组件** 会报告错误，并在你修复之前不渲染任何内容；应用的其余部分继续运行。下一次成功的保存即可恢复。

在以下情况下，宿主会 **重新加载整个应用**，而不是打补丁：

- 变更导入了正在运行的应用此前未导入过的 NSH 模块（例如第一次 `import … from "nsh"`）；
- `nsh.json` 中应用的 `capabilities` 发生变化；
- 宿主运行的不是补丁所基于的那个构建（它刚刚连接，或者上一次加载失败）；
- 补丁无法应用。

> [!TIP]
> 希望在编辑后保留的状态，请放在组件内部（或放在你没有在编辑的模块中），而不是放在你正在修改的模块顶层。

`--release` 提供 release 构建，没有热更新：每次保存都会重新加载应用。可用它检查压缩后的构建。从开发服务器加载的任何
代码，无论是否带 `--release`，都会跳过运行时的加固（`eval` 仍然可用）；参见
[沙箱与能力](./sandbox-and-capabilities.md)。

## 日志

Rust 应用用 `log` crate 记录日志（`log::info!`、`log::warn!`、`log::error!`）：在桌面平台和 iOS 模拟器上，`nsh run` 把这些日志行和应用的
输出一起显示在终端。

在 TSX 中，`console.log`、`console.info`、`console.debug`、`console.warn` 和 `console.error` 会以 target `js` 输出到原生日志。
宿主连接期间，它的日志行会转发到运行 `nsh run` / `nsh dev` 的终端：你的 `console.log` 原样输出（连接了多台设备时前面加上
设备名），警告和错误写在设备名之后：

```text
• iPhone 16 Pro connected, build 1
loading more after 1000
warn iPhone 16 Pro: deprecated option
error iPhone 16 Pro: uncaught exception: TypeError: cannot read property 'id' of undefined
          at Row (demos/Photos.tsx:18:22)
```

`console.log` 像浏览器控制台一样格式化值：字符串原样输出，错误附带调用栈，函数显示名称，对象和数组输出为 JSON。宿主
未连接时，日志会写入平台日志（iOS 上是 Xcode 控制台 / 统一日志，Android 上是 `adb logcat`）。

被 reject 的 Promise，如果在引起它的那段工作结束（它的微任务都已运行）时仍然没有处理函数，也会像浏览器那样记录为一条错误：
没人 await 的 `async` 函数抛出了异常、没人 catch 的 `Promise.reject(…)`、没有人等待结果的 Rust 调用失败了。这一行和
`console.error` 去往同样的地方（终端、平台日志，Web 上是浏览器控制台），调用栈指向你的源码：

```text
error iPhone 16 Pro: unhandled rejection: Error: HTTP 404
          at loadProfile (App.tsx:12:11)
```

在同一轮中稍后附加的处理函数（`const p = load(); …; p.catch(…)`）也算作处理了它。失败需要处理的地方，请 await 这个
Promise 或给它加上 `.catch`。

终端里的其余内容是每个步骤一行（`✓` 完成，`→` 连接地址，`•` 设备的动态）；NSH 调用的工具（cargo、宿主本身）的输出
只在出错时打印。`nsh run -v`（或 `NSH_VERBOSE=1`）打印全部内容：每条日志及其级别和来源、cargo 的输出以及宿主自己的输出。

`--trace` 会额外输出每次提交的开销：

```text
perf commit: 10 ops, 151µs (list js 2µs), 8 mount items, 27 nodes
```

这些数字的含义参见[测试](./testing-and-trace.md)。

## 错误浮层

以下错误会在宿主上的应用上方显示红色浮层，包含错误信息和调用栈：

- 构建失败（语法错误、未知元素、缺失的导入），并附带指向出错行的代码片段；
- 执行 bundle 时出错；
- 事件处理函数、定时器或 effect 中未捕获的异常。

点击浮层即可关闭，下一次成功重新加载时它也会消失。构建失败也会打印到终端：

```text
error building App.tsx failed
App.tsx

  x <Buton> names nothing in scope
   ,-[3:11]
 2 | function App() {
 3 |   return <Buton />;
   :           ^^^^^
 4 | }
```

打包器只会移除 TypeScript 类型，不做类型检查；类型错误请运行 `tsc`（使用 `nsh init` 生成的 `tsconfig.json`）或依靠
编辑器发现。

在 release 构建中（使用 release 版 SDK 的嵌入式应用、打包后的应用），错误会被记录并传给宿主应用的错误处理器
（`NshAppView.onError`、`NshView.setErrorListener`），但不会显示在应用上方。

## Source map 与调用栈

打包会生成一份串联了每个步骤（TypeScript → JSX → bundle）的 source map，并随每次构建一起发送。在打印或显示调用栈之前，
运行时会把 bundle 中的位置改写为你的源码位置，因此调用栈指向 `App.tsx:2:28`，而不是 bundle：

```text
error Mac Catalyst: uncaught exception: Error: tap boom
          at <anonymous> (App.tsx:2:58)
```

`nsh build` 把 source map 写为 `bundle.js.map`；从文件夹加载 bundle 的嵌入式应用会从 bundle 旁边读取它，
[签名包](./signed-packages.md)中也带有它，除非把它放在包旁边、再用 `nsh symbolicate` 映射（[已发布包的报错](./signed-packages.md#已发布包的报错)）。

## 调试技巧

- **编辑后没有任何更新**：查看终端是否有构建错误；宿主上的浮层也会显示它。
- **应用保留了你以为会重置的旧状态**：热替换会刻意保留未变化组件的状态。用 Ctrl-C 后重新 `nsh run` 重启，或者修改入口
  模块。
- **请求只在打包或嵌入的构建中失败**：检查应用的[能力](./sandbox-and-capabilities.md)；被拒绝时日志会写明需要添加的键。
- **某些操作很慢**：用 [`nsh test --trace`](./testing-and-trace.md) 以无界面方式复现，它会打印每一个原生视图操作；
  或者给 TSX 应用加上 `--trace` 运行。
- **编辑器中出现类型错误**：`nsh run` 和 `nsh dev` 会保持 `.nsh/types` 为最新；参见[项目结构](./project-structure.md)。

## 另请参阅

- [CLI](./cli.md)
- [测试](./testing-and-trace.md)
- [嵌入 iOS 应用](./ios.md)、[嵌入 Android 应用](./android.md)
