---
title: 命令行
description: NSH 的全部子命令与参数：init、build、test、dev、run、package，以及签名相关的 keygen、certify、publish、verify、symbolicate 和 revoke。
order: 6
group: start
---

# 命令行

`nsh` 是构建 NSH 应用的工具，无论用 Rust 还是 TSX 编写。所有构建应用的子命令都接受 `[ENTRY]`：应用目录（默认为当前目录，所以 `cd my-app && nsh run` 即可），它运行 Rust 应用的根组件（`nsh.json` 的 `"root"`）或 TSX 应用的 `App.tsx`；也可以是一个 TSX 入口模块。命令会读取应用根目录中的 `nsh.json`，并刷新 `.nsh/types` 中的类型声明。

```text
nsh <COMMAND>

  init         Create an app in Rust or TSX
  build        Build an app: describe a Rust app's crates, or bundle a TSX app and compile it to QuickJS bytecode
  test         Run an app's tests headless, and its Rust crates' with cargo test
  check        Type check an app with TypeScript's native compiler, and its Rust crates with cargo check
  dev          Serve an app to dev hosts (simulators, devices) and push rebuilds
  run          Like dev, and also run the app in a development host
  package      Package an installable app from the prebuilt runtime
  keygen       Create a signing key
  certify      Certify a release key with a root key
  publish      Build an app in release mode and sign it into a package (.nshpkg)
  verify       Verify a package
  symbolicate  Map the positions in a reported error stack to the app's sources
  revoke       Sign a revocation list
```

`nsh <command> --help` 打印某个命令的参数；`nsh -V`（`--version`）打印版本号和构建它的 Git 提交。

## 输出

每个命令每个步骤打印一行，只在出错时打印细节：

```text
✓ built the Rust crate gallery-native (5.0s)
✓ built App.tsx (500 B js, 809 B bytecode, 21ms)
✓ built the development host for the iOS simulator (12.7s)
• iOS Simulator (iPhone 16 Plus) connected, build 1
warn iOS Simulator: image failed: An SSL error has occurred and a secure connection to the server cannot be made.
✓ rebuilt App.tsx (18ms), 1 device
```

`✓` 表示完成的步骤，`→` 是连接地址，`•` 是设备的动态；`warn` 和 `error` 行是问题，不带符号的行是应用自己的输出
（`console.log`）。在终端里，正在进行的步骤会显示一个转动的指示符，各行带颜色（设置了 `NO_COLOR` 时不带）；重定向到
文件时只写入结果行，不带颜色。NSH 调用的工具（应用 Rust crate 的 cargo 构建、开发宿主）出错时，它们的输出打印在
`error` 行下面。

`-v, --verbose`（所有命令都可用；也可以设置 `NSH_VERBOSE=1`）原样打印全部内容：每条日志及其级别和来源、cargo 的
输出以及宿主自己的输出。

## nsh init

```sh
nsh init [DIR] [--name <NAME>] [--template <ts|rust|mixed>] [--nsh-source <DIR>]
```

按模板在 `DIR`（默认为当前目录，不存在时会创建）中创建应用。不带 `--template` 时，`nsh init` 在终端中会询问使用哪个模板（直接回车选择 `ts`），在其他环境（脚本、CI）中使用 `ts`。

| 模板 | 创建的内容 |
|---|---|
| `rust` | 用 Rust 编写的应用：一个 Cargo 项目（`Cargo.toml`、包含根组件的 `src/lib.rs`、供 `cargo run` 使用的 `src/main.rs`），设置了 `"rust": "."` 和 `"root": "App"` 的 `nsh.json`、根组件的测试 `App.test.tsx`（以及 `tsconfig.json` 和 `.nsh/types`）、`.gitignore` 和 README（其中也说明了之后如何添加 TSX 入口）。`nsh run` 和 `nsh package` 在所有目标（包括浏览器）上挂载根组件，不使用 QuickJS（`nsh test` 为 TypeScript 测试打开它）（见[用 Rust 开发](./rust.md)）；`cargo run` 直接在 macOS、Windows 或 Linux 上启动它。 |
| `ts` | TSX 应用：`App.tsx`、它的测试 `App.test.tsx`（`nsh test`）、`nsh.json`、`tsconfig.json`、`.gitignore` 和 `.nsh/types`。已存在的文件会保留；只有当这些文件全部已存在时才会失败。 |
| `mixed` | 用 `ext/` 里的 Rust 扩展的 TSX 应用：`App.tsx`、它的测试 `App.test.tsx`、`tsconfig.json`、`.gitignore`、`.nsh/types`、README，以及 `ext/<name>-native/` 里应用自己的 nshm crate（`Cargo.toml`、`src/lib.rs`），`nsh.json` 在 `"dependencies"` 中按路径列出它，它的 `#[native_module("<name>-native")]` 导出一个组件、一个模块和一个类，供 `App.tsx` 使用（[应用自己的 Rust：ext/](./nshm.md#应用自己的-rustext)）。 |

| 参数 | 说明 |
|---|---|
| `--name <NAME>` | 写入 `nsh.json` 的显示名称。默认为目录名。id 会是 `com.example.<name>`（只保留字母和数字，转为小写），crate 的导入说明符是 `<name>/native`（小写，单词以 `-` 连接）。 |
| `--template <TEMPLATE>` | `rust`、`ts` 或 `mixed`（见上表）。`rust` 和 `mixed` 需要 Rust 工具链；`cargo run` 还需要原生桌面后端的开发库。 |
| `--nsh-source <DIR>` | 与 `rust` 或 `mixed` 一起使用：crate 按路径依赖 `DIR` 中 NSH 源码仓库的 crate，基于 NSH 源码构建应用。 |

`rust` 和 `mixed` 的 crate 依赖 crates.io 上与 CLI 同版本的 NSH crate（使用 `--nsh-source` 时依赖该源码仓库中的 crate），`nsh` 命令用同样的 crate 构建应用的运行器和宿主。对这样的应用，`nsh` 在每条命令之前构建一个由应用 crate 和 NSH 核心组成的小程序，用它描述这些 crate 的组件、模块和类（crate 有改动时才重新运行）；有了这份描述，CLI 自己完成打包、编译、类型检查、开发服务和打包发布。Rust 应用的构建只编译它的 crate 和 NSH 的核心。请在新的应用目录中创建它们：只要其中任何一个文件已存在，就会在写入之前报告为冲突。

当应用的 Rust crate 通过 Git 依赖 NSH 时，CLI 使用 Cargo 根据应用锁文件解析的 checkout。生成的宿主使用同一份源码，并统一应用通过 Cargo patch 重定向的 NSH 依赖。

## nsh run

```sh
nsh run [ENTRY] [--target macos|linux|windows|ios|android|gpui|tui|web|catalyst] [--device <DEVICE>] [--port <PORT>] [--release] [--limits [<LIMITS>]] [--trace] [--fps] [--name <NAME>] [--points-per-cell <WIDTHxHEIGHT>] [--window-size <WIDTHxHEIGHT>] [--display <N>] [--background] [--sign <IDENTITY>]
```

```sh
nsh run my-app                     # Rust 应用的根组件，或 TSX 应用的 App.tsx，在本机的后端上运行
nsh run my-app --target ios        # 在 iOS 模拟器中
nsh run my-app/App.tsx --target web
```

对 TSX 入口，`nsh run` 启动开发服务器（同 `nsh dev`），启动一个从它加载应用的开发宿主，并在每次保存时重新构建。热模块替换会就地修补正在运行的应用；应用的日志和错误会打印在终端里。用 Ctrl-C 停止（或关闭 Catalyst、macOS、Linux、Windows 或 GPUI 窗口）。

在原生窗口和移动端目标上，Rust 应用（`nsh.json` 中有 `"root"`，见[用 Rust 开发](./rust.md)）运行时不需要开发服务器，也没有 QuickJS：`nsh run` 为目标平台构建挂载了根组件的应用运行器并启动它（桌面上是 debug 构建，日志打印在终端；模拟器和 Android 上会安装应用），修改 crate 的 Rust 代码后重新构建并重启。使用 `--target web` 时会打印页面地址，已打开的页面会自动加载新的运行时。指定 TSX 入口（`nsh run App.tsx`）则运行 TSX 入口。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--target <TARGET>` | macOS 上为 `macos`，Linux 上为 `linux`，Windows 上为 `windows` | `ios`：iOS 模拟器中的宿主。`android`：Android 设备或模拟器上的宿主。`macos`：AppKit 宿主，一个 1200×800 的窗口（[macOS](./macos.md)）。`linux`：GTK 宿主，一个 390×844 的窗口（[Linux](./linux.md)）。`windows`：Win32 宿主，一个 1200×800 的窗口（[Windows](./windows.md)）。`gpui`：GPUI 宿主，一个 1200×800 的窗口，可在 macOS、Windows 或 Linux 上运行，以嵌入它的 GPUI 应用的方式显示 TSX 应用（[GPUI](./gpui.md)）。`tui`：当前终端中的宿主（[TUI](./tui.md)）。`web`：开发服务器的页面，地址会打印出来（[Web](./web.md#在浏览器里开发)）。开发工具 `catalyst`：Mac Catalyst 宿主，一个 iPhone 大小的窗口（390×844），仅在确有需要时使用：检查 Catalyst 特有的行为，或在 Mac Catalyst 应用中嵌入 NSH。Mac 应用请用默认的 `macos`；要看应用在手机上的效果，请用 `--target ios`。其他名字运行在 NSH 之外构建的同名平台（[外部 target](#外部-target)）。 |
| `--device <DEVICE>` | | 要使用的 iOS 模拟器，按名称（`"iPhone 16 Pro"`）或 UDID 指定。默认：已启动的模拟器，否则启动最新的 iPhone。配合 `--target android`：要使用的设备或模拟器，按序列号（`emulator-5554`，即 `adb devices` 列出的）指定。默认：`ANDROID_SERIAL` 指定的那台，否则第一台。 |
| `--port <PORT>` | 此应用上次的端口，否则从 `8790` 起第一个空闲端口 | 开发服务器端口。等待此端口上的旧 NSH 开发会话清理完成后接管。 |
| `--release` | | 压缩代码并去掉调试信息。release 包没有热模块替换：每次保存都会重新加载应用。 |
| `--limits [<LIMITS>]` | | 按嵌入在其他应用中的方式运行应用，使用宿主应用设置的限制：`memory` 和 `stack`（单位为 `KB`、`MB` 或 `GB`）、`load` 和 `call`（单位为 `ms` 或 `s`）以及 `nodes`，例如 `--limits memory=128MB,call=500ms`。没写的项保持嵌入时的默认值，只写 `--limits` 就全部使用默认值（[沙箱与能力](./sandbox-and-capabilities.md#限制)）。不带它时，应用像打包后的应用一样独立运行。仅 TSX 入口。 |
| `--trace` | | 宿主把每次 commit 的耗时（JS、布局、挂载项）记录到终端。 |
| `--fps` | | 性能监视器：帧率、每帧和每次 commit 的开销、CPU、GPU 和内存；macOS 上显示在应用上方（[macOS](./macos.md#性能监视器)）；macOS、Linux、Windows 和 iOS 上每秒输出一行日志，用 `-v` 显示。`tui` 在角落显示 FPS/idle、帧 p95、应用批次/绘制/刷新耗时、字节数和变化的 Cell 数，`C-h p` 切换显示。 |
| `--name <NAME>` | `nsh.json` 的 name | 菜单栏中的应用显示名称及初始窗口标题（`--target macos`，TSX 入口）。 |
| `--points-per-cell <WIDTHxHEIGHT>` | `nsh.json` 的 `tui.pointsPerCell`，否则 `8x16` | 终端单元格的宽高，单位为点（`--target tui`）。 |
| `--window-size <WIDTHxHEIGHT>` | 宿主默认值 | 初始窗口尺寸，单位为点，例如 `800x600`（`--target macos`、`linux`、`windows` 和 `gpui`，TSX 入口）。 |
| `--display <N>` | 主显示器 | 窗口在哪个显示器上居中打开：`1` 是主显示器（带菜单栏的那个），`2` 是下一个，依此类推；没有这个编号的显示器时在主显示器上打开（`--target macos`，TSX 入口）。 |
| `--background` | | 应用不会成为当前活跃的应用，和 `nsh test` 运行应用的方式一样：窗口照常显示，键盘留在你正在输入的应用里，发给它窗口的输入（驱动它的 agent、UI 测试）照样能到达。在 macOS 上它运行时没有 Dock 图标和菜单栏。用于不需要你盯着的运行，比如你工作时 agent 在检查一处改动（`--target macos`、`linux`、`windows` 和 `gpui`，TSX 入口）。 |
| `--sign <IDENTITY>` | ad hoc 签名 | 给 macOS 宿主签名的代码签名身份，与 `nsh package --sign` 取值相同，比如 `"Apple Development: …"`。宿主的签名从此每次构建都保持不变，应用的 Rust 代码重新编译后仍能访问它的钥匙串项（[macOS](./macos.md#为开发宿主签名)）（`--target macos`）。 |

使用 `--target android` 时，会选用 `--device` 或 `ANDROID_SERIAL` 指定的设备，否则选用 `adb devices` 列出的第一台（连着多台时 `nsh` 会提示用的是哪一台）；开发服务器的端口通过 `adb reverse` 转发到设备上。参见[快速开始](./getting-started.md)和[开发服务器与调试](./dev-server-and-debugging.md)。

新会话最多等待十秒，让旧会话完成清理。多个应用可同时运行，各用自己的端口，再次运行同一应用会替换它之前的会话。`--port` 指定的端口被其他程序或旧版 NSH CLI 占用时，会报错并指出端口；`--port 0` 由操作系统分配空闲端口。`nsh run` 只服务本机，使用 `--target ios`、`android` 或 `web` 时也服务局域网。
使用 `--target tui` 时，应用在当前终端中运行，保存源文件时热更新。CLI 和宿主的诊断日志写入应用的 `.nsh/tui.log`；按 `C-h e` 查看日志与错误，按 Escape 或 `C-g` 关闭面板，按 `r` 重新加载。应用错误会自动打开面板，更新后恢复应用画面。每个单元格默认是 8×16 点；`--points-per-cell 10x20` 优先于 `nsh.json` 中的 `"tui": { "pointsPerCell": "10x20" }`，宽高均须是有限正数，重启运行后生效。Rust 应用在为它生成的终端开发宿主中运行根组件，Rust 代码保存后重新构建并重启。

在 Unix 上，终端宿主收到 SIGHUP、SIGTERM、SIGINT 或终端断开时退出，并恢复仍可访问的终端设置。应用空闲时在输入检查之间休眠；交互运行使用有效的终端输入，测试使用 `--headless` 接受重定向输入。

## nsh dev

```sh
nsh dev [ENTRY] [--target macos|linux|windows|ios|android|gpui|tui|web|catalyst] [--device <DEVICE>] [--server-only] [--port <PORT>] [--host <HOST>] [--release] [--limits [<LIMITS>]]
```

启动开发服务器并打开当前系统的原生宿主：macOS 使用 AppKit，Linux 使用 GTK，Windows 使用 Win32。开发 iOS 或 Android 应用时显式指定 `--target ios` 或 `--target android`。用 `--server-only` 为自己启动的宿主提供服务。服务器构建应用、监视入口所在目录以及应用的 `nsh.json`、主题和翻译文件，并把每次重新构建推送给连接到它的宿主。使用 `--server-only` 时，它会打印本机宿主使用的 URL，未绑定回环地址时还会打印每个局域网地址对应的设备 URL，以及在 Web 运行时存在时，浏览器运行应用要打开的页面（[Web](./web.md#在浏览器里开发)）：

```text
✓ built App.tsx (3.2 KB js, 9.8 KB bytecode, 21ms)
→ dev server ws://127.0.0.1:8790/ws
  browsers: http://127.0.0.1:8790/
  devices on this network: ws://192.168.1.20:8790/ws
  browsers on this network: http://192.168.1.20:8790/
```

用 `nsh dev --server-only` 连接嵌入了开发版 SDK（`NativeShellDev.xcframework`、`nsh-dev.aar`）的应用。`--target`、`--device`、`--port`、`--release` 和 `--limits` 的含义与 `nsh run` 相同。`--host <HOST>` 用于将开发服务器绑定到指定的 IPv4 地址，覆盖默认行为（`--server-only` 以及 `--target ios`、`android`、`web` 默认绑定 `0.0.0.0`；本机目标默认绑定 `127.0.0.1`），例如用 `nsh dev App.tsx --server-only --host 127.0.0.1` 仅监听本机回环地址。使用 `--target android` 时，由于 `adb reverse` 将设备的 `127.0.0.1` 转发到本机的 `127.0.0.1`，`--host` 只能指定为 `127.0.0.1` 或 `0.0.0.0`。

## nsh test

```sh
nsh test [PATH] [--filter <NAME>] [--release] [--trace] [--fps] [--junit <FILE>] [--jobs <N>] [--target <TARGET>] [--browser <PATH>] [--web-host <JS>] [--device <DEVICE>] [--display <N>] [--foreground]
```

以无界面方式运行应用的测试（[测试](./testing-and-trace.md)）：运行目录 `PATH`（默认为当前目录；跳过隐藏目录、`node_modules` 和 `target`）中的测试文件（`*.test.tsx`、`*.test.ts`，导入 `nsh/test`），或者测试文件 `PATH` 本身。如果传入的是带有自己 Rust crate 的应用（`nsh.json` `"rust"`：Rust 应用，或带 crate 的 TSX 应用）的目录，它会先在目录中每个 crate 自己的目录下运行 `cargo test`，并把每个 Rust 测试与 TypeScript 测试一起显示和计数，归在其测试目标的文件下（`src/lib.rs › tests::adds`）；只有 Rust 测试的 Rust 应用也这样测试。每个测试文件在各自的引擎上运行，测试打开的每个应用又在另一个全新的引擎上运行。它为每个测试打印一行；失败时还会打印抛出的内容、它在测试文件中的位置和屏幕上的文字。只要有失败，就以非零退出码结束。如果传入的是应用入口（`nsh test App.tsx`；Rust 应用为 `nsh test nsh.json`），它会在真实网络下打开应用，让它运行 1.2 s，然后执行标准输入给出的步骤（`await app.press("Add")`，其中 `app` 就是这个应用）。TSX 应用在 CLI 自己的进程里运行；带有自己 Rust crate 的应用在用这些 crate 构建的无界面运行器中运行，由 CLI 为它构建入口。除非测试以 Android 打开应用（`open` 的 `platform`），无界面运行按 iOS 处理：`platform.os` 为 `"ios"`，`ios:` 类和 `ios={{…}}` 属性都会生效。

```text
✓ App.test.tsx › counts taps (321ms)
✓ 1 test: 1 passed, 0 failed (343ms)
```

| 参数 | 说明 |
|---|---|
| `--filter <NAME>` | 只运行名称（前面带上所在 `describe` 块的名称）包含 `NAME` 的测试；对 crate 则是 `cargo test <NAME>`。 |
| `--release` | 对被测应用 bundle 压缩代码并去掉调试信息。对带有 Rust crate（`nsh.json` `"rust"` 或 Rust nshm）的应用，还会以 `cargo test --release` 运行其 crate 测试，并以优化模式（`--release`）构建其无界面运行器和开发宿主，与打包时一致。 |
| `--trace` | 打印测试所打开应用的每个挂载批次，标注它所属的步骤（`── press(Add): 7 items`），以及每次 commit 的耗时：首帧、一个步骤或一帧滚动的开销。加上 `--target` 时，是 host 的批次和耗时。 |
| `--fps` | 配合 `--target linux`、`macos`、`windows` 或 `ios`：host 每秒输出一行性能监视器读数（帧率、帧各阶段、commit、CPU、内存），用 `-v` 显示。 |
| `--junit <FILE>` | 同时把结果以 JUnit XML 报告写入 `FILE`，CI 服务按这种格式展示测试结果：每个测试文件一个 `testsuite`，每个测试一个 `testcase`。 |
| `-j, --jobs <N>` | 同时运行的测试文件数，每个文件用自己的引擎（默认等于 CPU 核数）。结果仍按文件顺序逐个显示。仅限无界面运行：带 `--target` 或 `--trace` 时逐个运行。 |
| `--target <TARGET>` | 在该平台的开发 host 上运行测试打开的应用，而不是 headless（`macos`、`linux`、`windows`、`gpui`、`tui`、`web`、`ios` 和 `android`；`tui` 在内存终端里运行，`web` 在 headless 的 Chrome、Edge 或 Chromium 里运行）：步骤用平台自己的输入执行（[测试](./testing-and-trace.md#在真实平台上运行)），`open` 会按该平台检查它的选项，平台无法满足的选项会被拒绝（`ERR_NSH_TEST_UNSUPPORTED`：iOS 和 Android 上的 `width` 与 `height`、属于另一类设备的 `platform`）。crate 的 Rust 测试在本机运行，属于不带 `--target` 的运行。 |
| `--browser <PATH>` | `--target web` 运行应用所用的 Chrome、Edge 或 Chromium 可执行文件（默认：本机安装的那个）。 |
| `--device <DEVICE>` | 配合 `--target ios`：应用在哪个模拟器里运行，按名称（`"iPhone 16 Pro"`）或 UDID 指定。默认：已启动的模拟器，否则启动最新的 iPhone。配合 `--target android`：应用在哪台设备或模拟器上运行，按序列号（`adb devices` 列出的）指定。默认：`ANDROID_SERIAL` 指定的那台，否则第一台。 |
| `--display <N>` | 配合 `--target macos` 或 `gpui`：应用窗口在哪个显示器上居中打开：`1` 是主显示器（在 macOS 上是带菜单栏的那个），`2` 是下一个，依此类推；没有这个编号的显示器时在主显示器上打开。默认在副显示器（主显示器之外的第一个，且不是它的镜像）上打开，让测试运行占用一块单独的屏幕；只有一个显示器时在主显示器上打开。测试在每个显示器上的运行结果相同。 |
| `--foreground` | 配合 `--target macos`、`windows`、`gpui` 或 `linux`：让应用成为当前活跃的应用，和用户使用时一样。默认应用在后台运行：窗口照常显示，键盘留在你正在输入的应用里，测试的点击、按键和快捷键直接发给这些窗口。在 Linux 桌面上，后台的按键直接输入到控件里，和 Wayland 上一样；测试 Tab、方向键或输入法时请带上 `--foreground`。在没有人输入的显示器上（Xvfb），Linux 应用无论是否带这个选项都按前台方式运行。依赖应用处于活跃状态的测试（`lifecycle()` 随应用是否活跃而变），或 `examples/gallery/tools/perf.py` 这类性能测量（它会传入该选项），应带上它运行。 |
| `--web-host <JS>` | headless 运行时测试打开的应用所用的 Web 页面宿主模块（默认：`nsh.json` 的 `web.host`；它导出 `createHost(player)`）：它应答应用的 [`host`](../modules/nsh.md#host) 调用，它的 `player.hostEvent` 会送到 `host.on`（[测试](./testing-and-trace.md#页面的宿主)）。只用于 headless 运行；`--target web` 运行 `nsh.json` 的 `web.host`。 |

NSH 生成的文件都放在 `.nsh/` 下：类型声明、runner 源码，以及默认的构建和打包输出 `.nsh/out/`。Cargo 保留它通常的 `target/` 缓存和已有的 `CARGO_TARGET_DIR` 行为；NSH 不会添加 Cargo 配置来移动它。`--out` 仍可指定输出位置。使用我们推荐的 [huacnlee/cargo](https://github.com/huacnlee/cargo) 时，构建产物放在 `~/.cargo/targets/` 下，可执行文件仍在 `target/`。

## nsh check

```sh
nsh check [ENTRY] [--tsc <TSC>] [-- <TSC ARGS>...]
```

对应用做类型检查。带有自己 Rust crate 的应用（`nsh.json` `"rust"`）会先在每个 crate 自己的目录下用 `cargo check --all-targets` 检查它（包括它的测试）；Cargo 报错时以非零退出码结束。Rust 应用（`"root"`）随后只检查它所拥有的 TypeScript：有 `tsconfig.json`（`nsh init --template rust` 为 `App.test.tsx` 写入的那个）时，它的测试文件也会做类型检查。TypeScript 检查会刷新 `.nsh/types` 和 `.nsh/tsconfig.json`，然后以应用的 `tsconfig.json` 运行 `tsc -p <应用目录> --noEmit`。它使用原生编译器 TypeScript 7，不需要 Node：第一次运行时从 npm registry 下载（约 9 MB），按 NSH 记录的校验和校验，并保存在 NSH 的缓存里（macOS 上为 `~/Library/Caches/nsh`，Linux 上为 `~/.cache/nsh`，Windows 上为 `%LOCALAPPDATA%\nsh`，或 `NSH_CACHE`）。有类型错误时以非零退出码结束。`tsconfig.json` 没有继承 `./.nsh/tsconfig.json`（NSH 在那里维护它的 TypeScript 设置）时会给出警告（[项目结构](./project-structure.md)）。

| 参数 | 说明 |
|---|---|
| `--tsc <TSC>` | 改为运行这个 `tsc`（也可用 `NSH_TSC`），例如 `node_modules` 里的，或者给没有网络的机器准备的副本。 |
| `-- <TSC ARGS>` | 原样传给 `tsc`，例如 `nsh check -- --pretty false`。 |

## nsh build

```sh
nsh build [ENTRY] [-o <OUT>] [--release] [--split]
```

构建应用。对 Rust 应用（`nsh.json` 的 `"root"`），它构建并描述应用的 crate，并写出 `app.json` 和这些 crate 附带的文件（`assets/`）：它的运行器挂载根组件。对 TSX 应用，它打包应用并编译为 QuickJS 字节码，供嵌入 NSH、自行分发 bundle 的应用使用。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-o, --out <OUT>` | `.nsh/out` | 输出目录。 |
| `--release` | | 压缩代码并去掉调试信息。 |
| `--split` | | 把 `import()` 加载的代码放进独立的 chunk 文件，第一次导入时才下载（Web 应用，见[拆分 bundle](./web.md#拆分-bundle)）。不加时，bundle 包含整个应用。 |

输出内容：

| 文件 | 内容 |
|---|---|
| `bundle.js` | JavaScript 形式的 bundle |
| `bundle.js.map` | 它的 source map（堆栈会映射回你的源码） |
| `bundle.nshc` | 编译后的字节码 bundle：应用实际加载的就是它 |
| `<Chunk>.js`、`<Chunk>.js.map`、`<Chunk>.nshc` | 使用 `--split` 时：每个 chunk、它的 source map 和字节码（`import("./Screen")` 对应 `Screen.js`） |
| `capabilities.json` | `nsh.json` 中声明的 `capabilities`（未声明时删除） |
| `assets/` | 所有被导入的图片和字体，保持相对于应用根目录的路径 |

## nsh package

```sh
nsh package [ENTRY] --target ios|ios-simulator|android|macos|linux|windows|web [-o <OUT>] [flags]
```

以 release 模式构建可安装的应用。Rust 应用（`nsh.json` 中有 `"root"`）用它自己的运行器打包，运行器由 Cargo 用你的 crate 和 NSH 的 crate 构建，挂载根组件，不带 QuickJS（见[用 Rust 开发](./rust.md)）；TSX 应用使用预构建的运行时。整个过程不需要 Xcode 工程或 Gradle 构建：NSH 自己组装应用包，并使用 Xcode 的 `actool` 和 `codesign`（iOS）或 SDK 中的 `aapt2`、`zipalign` 和 `apksigner`（Android）；macOS 则用 `codesign` 组装一个默认 ad hoc 签名或用 `--sign` 签名的 `.app`（图标用 `sips` 转换）；Linux 则复制运行器并用 `tar` 生成 `.tar.gz`；Windows 则复制运行器、嵌入图标并生成 `.zip`，不需要任何工具；Web 则写出一个静态站点，同样不需要任何工具。元数据来自 `nsh.json`，可被参数覆盖。

| 参数 | 说明 |
|---|---|
| `--target <TARGET>` | 必填。`ios`：iOS 设备，签名的 `.ipa`（不带 `--sign` 时为未签名的 `.app`）。`ios-simulator`：ad hoc 签名的 `.app`。`android`：签名的 `.apk`。`macos`：签名的 `.app`（不带 `--sign` 时为 ad hoc 签名）（[macOS](./macos.md#打包)）。`linux`：一个目录 `<Name>/`（可执行文件、`nsh/`、`.desktop` 文件）和 `<Name>.tar.gz`（[Linux](./linux.md#打包)）。`windows`：一个目录 `<Name>\`（`<Name>.exe`、`nsh\`）、`<Name>.zip`、Inno Setup 脚本 `<Name>.iss`，以及装有 Inno Setup 时生成的安装程序 `<Name>-setup.exe`（[Windows](./windows.md#打包)）。`web`：一个目录 `<Name>/`，即静态站点（`index.html` 和以内容命名的文件）（[Web](./web.md#发布应用)）。其他名字为在 NSH 之外构建的同名平台打包（[外部 target](#外部-target)）。 |
| `-o, --out <OUT>` | 输出目录（默认 `.nsh/out`）。 |
| `--name <NAME>` | 显示名称。 |
| `--id <ID>` | Bundle identifier，例如 `com.example.app`。 |
| `--app-version <VERSION>` | 版本号，例如 `1.2.0`。 |
| `--build <BUILD>` | 构建号。 |
| `--icon <ICON>` | 应用图标：正方形 PNG，最好是 1024×1024。 |
| `--sign <IDENTITY>` | iOS 设备和 macOS：代码签名身份，例如 `"Apple Development: …"` 或 `"Developer ID Application: …"`。在 macOS 上启用 Hardened Runtime 和安全时间戳。 |
| `--profile <FILE>` | iOS 设备：描述文件（`.mobileprovision`），entitlements 取自其中。可以重复传入，给每个应用扩展（`nsh.json` `ios.extensions`）各传一个。 |
| `--keystore <FILE>` | Android：release keystore。默认使用 `~/.android/debug.keystore` 中的调试密钥（不存在时创建）。 |
| `--key-alias <ALIAS>` | Android：keystore 中的密钥别名。 |
| `--keystore-password <PASSWORD>` | Android：keystore 密码，也可从 `NSH_KEYSTORE_PASSWORD` 读取。 |
| `--format <FORMAT>` | Android：`apk`（默认）或 `aab`，即用于 Google Play 的 Android App Bundle，使用 `jarsigner` 签名。Linux：`appimage` 或 `flatpak`，在目录和压缩包之外另行生成（见 [Linux](./linux.md)）。不能与 `--run` 同时使用。 |
| `--abi <ABI>` | Android：APK 包含的 ABI（`arm64-v8a`、`armeabi-v7a`、`x86_64`），可重复或用逗号分隔。默认：`arm64-v8a` 和 `armeabi-v7a`，加上 `--run` 时还有设备的 ABI。 |
| `--arch <ARCH>` | macOS：应用运行的处理器，`arm64`（Apple 芯片）、`x86_64`（Intel）或 `universal`（两者合在一个可执行文件里）。默认：本机的。为另一种处理器编 runner 需要它的 Rust target（`rustup target add x86_64-apple-darwin`）。 |
| `--run` | 打包完成后安装并启动应用：在模拟器中（`ios-simulator`）或在已连接的 Android 设备上；`macos`、`linux` 和 `windows` 则直接启动它；`web` 在本机提供站点服务，并打印其地址。 |
| `--device <DEVICE>` | 配合 `--run`：在哪个模拟器里运行应用（`ios-simulator`），按名称或 UDID 指定，与 `nsh run` 相同；或者装到哪台 Android 设备或模拟器上，按序列号（`adb devices` 列出的）指定。Android 的默认：`ANDROID_SERIAL` 指定的那台，否则第一台。 |
| `--asset-url <URL>` | Web：站点文件所在的 http(s) 地址（CDN），页面按它引用这些文件；`index.html` 和 `manifest.webmanifest` 仍在页面自己的地址下（和不带它时一样按相对路径引用），CDN 要返回 `Access-Control-Allow-Origin`。默认：放在页面旁边，用相对路径引用。`--run` 从本机直接提供站点，所以不带它。 |

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile dev.mobileprovision
nsh package my-app --target android --keystore release.jks --key-alias upload
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target web
```

参见[打包](./packaging.md)。

## 外部 target

`nsh dev`、`nsh run`、`nsh test` 和 `nsh package` 的 `--target` 不是 NSH 自带的 target 时，会运行在 NSH 之外构建的同名平台：应用的[平台 nshm](./nshm.md#平台-nshm) 提供的那个，否则是 `PATH` 上的程序 `nsh-platform-<name>`，就像 Cargo 运行 `cargo-<name>` 一样。它收到命令和除 `--target` 及其值以外的所有参数，以及环境变量 `NSH`（当前的 `nsh` 可执行文件）、`NSH_VERSION` 和 `NSH_TARGET`（平台名）；它的退出码就是命令的退出码。

```sh
nsh package my-app --target miniprogram --out dist
# 运行：nsh-platform-miniprogram package my-app --out dist
```

名字由小写字母、数字和短横线组成，以字母开头。`PATH` 上没有对应程序时，`nsh` 会说明这一点并列出自带的 target。[构建平台](./platform-extensions.md)介绍了这样的平台需要实现什么。

## nsh update

把已安装的 `nsh` 更新到所在渠道的最新构建；指定渠道即切换（与 `rustup update nightly` 一致）（[安装](./installation.md#更新)）。

```sh
nsh update [stable|nightly]
```

## nsh add

为当前目录（或向上最近的有 `nsh.json` 的目录）的应用添加 [nshm](./nshm.md)（NSH 模块）：来自 crates.io、Git 或本地目录的 Rust crate，或 Git 仓库里的 TSX，应用导入它导出的组件、模块和类（`import { Gauge } from "acme-gauge"`，Rust 中则是 `acme_gauge::gauge()`）。

```sh
nsh add acme-gauge                                   # crates.io：最新版本
nsh add acme-gauge@1.2                               # crates.io：匹配 ^1.2 的最新版本
nsh add github:acme/ui                               # GitHub：最新的版本标签，没有则用默认分支
nsh add github:acme/ui@^1.4                          # GitHub：匹配 ^1.4 的最新标签
nsh add https://git.example.com/ui.git --tag v1.4.0  # 任意 Git 地址的某个标签；或 --rev <提交或分支>
nsh add --path ../gauge                              # 本地目录，按当前内容使用
nsh add nsh-extra --features camera                  # 开启 crate 的 Cargo feature（逗号分隔或重复传入）
```

它像 `Cargo.toml` 一样按包名（crate 名，或 Git、本地 nshm 的 `nsh.json` 中的 `"name"`）把 nshm 记录到 `nsh.json` 的 `"dependencies"`：`"acme-gauge": "^1.2.0"`、`{ "github": "acme/ui", "version": "^1.4" }`、`{ "git": "…", "tag": "v1.4.0" }`、`{ "git": "…", "rev": "…" }` 或 `{ "path": "../gauge" }`，对象形式可加 `"version"`、`"features"` 和 `"targets"`（要链接 Rust nshm 的 target，再次 `nsh add` 时保留：[nshm](./nshm.md#使用-nshm)）。没写版本时写入 `^` 加解析到的版本。随后它重新解析应用用到的所有 nshm，把缺少的安装到 `~/.nsh/nshms`，锁定在 `nsh.lock`（随应用提交），应用有自己的 crate（`"rust"`）时把 Rust nshm 加入该 crate 的 `[dependencies]`。它会打印要导入的标识；如果 nshm 给纯 TSX 应用带来了 Rust，也会说明，此后开发机和 CI 需要 Rust 工具链（[用 Rust 开发](./rust.md)）。若 nshm 无法解析、与应用的 crate 或其他 nshm 冲突（同一个包、标识或模块），或不兼容当前 NSH，应用的文件保持不变。

`--features` 开启 Rust nshm 的 Cargo feature，即应用用到的模块，已列出的会保留（在 `camera` 之后 `nsh add nsh-extra --features push` 仍保留 `camera`）；crate 未定义的名字会让 `nsh add` 停止。要关闭某个 feature，从 `nsh.json` 和应用 crate 的 `Cargo.toml` 依赖中删掉它。crate 在 `[package.metadata.nsh]` 中为开启的 feature 声明的内容会进入打包结果，除 entitlements 外也进入开发宿主（[打包的应用需要什么](./nshm.md#打包的应用需要什么)）。

版本是语义化版本要求，含义与 Cargo 相同：`1.2` 和 `^1.2` 接受 1.2.0 起的任何 1.x，`~1.2`、`=1.2.3`、`>=1.2, <2` 和 `*` 与 `Cargo.toml` 中一样（在 shell 里要加引号：`nsh add "acme-gauge@>=1.2, <2"`）。Git 上的 nshm 以标签（`v1.4.0` 或 `1.4.0`）为版本。`nsh.json` 写可以接受什么，`nsh.lock` 记录解析出了什么：只要锁定的版本仍满足要求，所有命令都用它构建，不访问网络；要求改变时重新解析。整个应用中每个包只解析出一个版本，即所有要求都接受的最新版本；没有满足的版本时，错误会指出谁要求了什么。nshm 适用的 NSH 版本是它 `nsh.json` 中的 `"nsh"` 要求，Rust nshm 还有它的 `nsh-core` 要求，二者都会与当前运行的 `nsh` 比对。

nshm 的构建脚本和过程宏会在应用构建时执行，它的代码以应用的权限运行：请像审查应用自己的代码一样审查它的源码和 `nsh.lock` 的变更。

## nsh upgrade

把应用的 nshm（全部或指定的几个）升级到其要求接受的最新版本，并锁定在 `nsh.lock`；Rust nshm 在应用 crate 中的依赖随之更新。要越过某个要求，在 `nsh.json` 中修改它，或用新的要求运行 `nsh add`。

```sh
nsh upgrade [NAME]...
```

## nsh remove

从应用中移除 nshm：从 `nsh.json` 的 `"dependencies"`、`nsh.lock` 和应用 crate 的 `[dependencies]` 中删除。已安装的副本留在 `~/.nsh/nshms`，其他应用可能还在使用。

```sh
nsh remove <NAME>...
```

## nsh component

添加、删除或列出已安装 `nsh` 旁边的运行时：它所在平台之外的那些（`android`、`android-symbols`、`ios`、`web`、`gpui`、`tui`）。需要某个运行时的命令第一次运行时会自己添加它（[安装](./installation.md#组件)）。

```sh
nsh component list
nsh component add <NAME>...
nsh component remove <NAME>...
```

## 签名命令

这些命令用于生成和校验签名包（`.nshpkg`）：嵌入 NSH 的应用会下载这些应用包，并在运行前进行校验。[签名包](./signed-packages.md)介绍了整个模型（由离线保存的根密钥为某些应用 id 认证 release 密钥）。

### nsh keygen

```sh
nsh keygen <NAME>
```

创建一对 Ed25519 密钥：`<NAME>.secret` 和 `<NAME>.pub`（例如 `nsh keygen keys/root`）。根密钥的 `.secret` 应离线保存；应用信任的是它的 `.pub`。

### nsh update-manifest

```sh
nsh update-manifest [<ARCHIVE>...] [--package <FILE.nshpkg>] [--entry <DIR>] [--key <FILE>] [--notes <FILE>] [--notes <TAG>=<FILE>]... [--link ios=<URL>] [--link android=<URL>] [--previous <ARCHIVE>]... [--base-url <URL>] [-o <DIR>]
```

根据各平台 `nsh package` 产出的压缩包写出 `latest.json`（加 `--key` 时还有 `latest.json.sig`）；加 `--package` 时还写入应用代码的签名包（`nsh publish` 产出），写入前会按应用 id 和 `updater.packages.roots` 校验它，详见 [OTA 更新](/zh-CN/docs/ota-updates)。一个版本可以只有包。
`--notes <TAG>=<FILE>` 加入另一种语言（BCP 47 标签）的更新说明，写在清单旁边的 `notes.<TAG>.md`；需要同时给不带标签的 `--notes`。
`--previous <ARCHIVE>` 传入上一版本某平台的压缩包，在清单旁写出从它到新版本的补丁（`<压缩包>.from-<版本>.patch`）；运行那个版本的应用会下载补丁，而不是整个压缩包。

### nsh certify

```sh
nsh certify --root <ROOT.secret> --key <KEY.pub> --apps <PATTERN>... [--days <DAYS>] -o <OUT>
```

用根密钥为 release 密钥签发证书，限定可签名的应用 id 和有效时间段；签名包会携带该证书。

| 参数 | 说明 |
|---|---|
| `--root <ROOT>` | 根密钥的私钥。 |
| `--key <KEY>` | release 密钥的公钥。 |
| `--apps <APPS>` | 允许签名的应用 id：`*`、`com.example.*` 或具体 id。可重复。 |
| `--days <DAYS>` | 从现在起可签名的天数（默认 365）。 |
| `-o, --out <OUT>` | 要写入的证书。 |

### nsh publish

```sh
nsh publish [ENTRY] --key <KEY.secret> --cert <CERT> [-o <OUT>] [--id <ID>] [--app-version <V>] [--build <N>]
            [--source-map package|file|none] [--strip-debug] [--min-runtime <VERSION>]
```

以 release 模式构建应用并签名为一个包。元数据来自 `nsh.json`，可被参数覆盖。

如果给的是一个包（`ENTRY` 是 `.nshpkg` 文件），则用这个密钥为它重新签名，适合用自己的一个密钥为旗下应用统一签名的平台。包的文件和头
保持原样，证书、签名时间和签名换成新密钥的（[签名包](./signed-packages.md#重新签名包)）。`-o` 可以就是读入的那个包，此时只有 `--key`、
`--cert` 和 `-o` 适用。

| 参数 | 说明 |
|---|---|
| `--key <KEY>` | release 密钥的私钥。 |
| `--cert <CERT>` | 它的证书（`nsh certify`）。 |
| `-o, --out <OUT>` | 要写入的包。默认：`.nsh/out/<id>-<build>.nshpkg`。 |
| `--id <ID>` | 应用 id。 |
| `--app-version <VERSION>` | 版本号。 |
| `--build <BUILD>` | 构建号：每次发布都必须递增。 |
| `--source-map <WHERE>` | source map 放在哪里：`package`（默认）、`file`（包旁边的 `<package>.map`）或 `none`（[签名包](./signed-packages.md#已发布包的报错)）。 |
| `--strip-debug` | 字节码中不保留行号和列号表：更小，但报错调用栈里没有位置。 |
| `--min-runtime <VERSION>` | 能运行该包的最低运行时版本，例如 `0.2.0`；更旧的运行时会拒绝它。默认：本 CLI 的版本（[签名包](./signed-packages.md#哪些运行时能运行包)）。 |

### nsh publish android

```sh
nsh publish android <BUNDLE.aab> [--track <TRACK>] [--rollout <FRACTION>] [--status <STATUS>] [--listing] [--draft]
nsh publish android --from <TRACK> --track <TRACK> [--rollout <FRACTION>]
```

把 Android App Bundle 上传到 Google Play 并发布到某个轨道，全程在一次 edit 中完成（创建、上传、更新轨道、提交；失败的 edit
会被删除）。不带 `--track` 时只发布到**内部测试**；发布给更多测试者或公众，必须显式给出 `--track`。用 `--from` 代替 bundle
时，把一个轨道上最新的版本推进到另一个轨道。登录身份是一个在 Play Console 中有该应用发布权限的 Google Cloud
服务账号（[发布到 Google Play](./publish.md#publish-to-google-play)）。

| 参数 | 说明 |
|---|---|
| `--entry <DIR>` | 应用目录或入口，其 `nsh.json` 的 `id` 即包名。默认：`.`。 |
| `--package <NAME>` | Google Play 上的包名。默认：`nsh.json` 的 `id`。 |
| `--credentials <KEY.json>` | 服务账号的 JSON 密钥。默认读取 `NSH_PLAY_CREDENTIALS`。不要提交到仓库。 |
| `--track <TRACK>` | `internal`（默认）、`alpha`、`beta`、`production` 或自定义轨道名。 |
| `--from <TRACK>` | 推进：把该轨道最新版本的 version code 发布到 `--track`，不上传任何文件。 |
| `--rollout <FRACTION>` | 分阶段发布给该轨道这一比例的用户，大于 0 小于 1，例如 `0.1`。 |
| `--status <STATUS>` | `completed`（默认）、`in-progress`（带 `--rollout` 时的默认）、`halted`（暂停分阶段发布，需带 `--rollout`）或 `draft`。 |
| `--draft` | 以草稿发布：应用在 Play Console 中完成首次发布之前，Play 只接受草稿。 |
| `--store <DIR>` | [商店目录](./publish.md#store-listing)。默认：应用目录下的 `store`。 |
| `--listing` | 同时按商店目录更新商店信息（名称、描述、图片），覆盖 Play 上这些语言已有的内容。 |

要扩大分阶段发布，用更大的 `--rollout` 再发布同一版本；要全量发布，不带 `--rollout` 再发布一次。

### nsh publish status android

```sh
nsh publish status android [--entry <DIR>] [--package <NAME>] [--credentials <KEY.json>] [--json]
```

列出每个轨道的版本：状态、version code 和放量比例。它在一个随后删除的 edit 中读取，不做任何改动。`--json` 输出
`{"package", "releases": [{"track", "name", "status", "version_codes", "user_fraction"}]}`，供脚本使用。

### nsh publish doctor android

```sh
nsh publish doctor android [--entry <DIR>] [--package <NAME>] [--credentials <KEY.json>] [--store <DIR>]
```

不改动 Play 上的任何内容，检查 `nsh publish android` 所需的一切：服务账号密钥、包名、商店目录、登录，以及对该应用的访问权限（打开一个
edit 再删除）。有检查失败时以错误退出。


### nsh publish linux

```sh
nsh publish linux <ARCHIVE.tar.gz> [--url <URL>] [--entry <DIR>] [--out <DIR>]
nsh publish status linux [--entry <DIR>] [--json]
nsh publish doctor linux [--entry <DIR>]
```

为发布压缩包写入或更新应用的 Flathub manifest（`<id>.yml`）：下载 URL 与 SHA-256。下载 URL 默认取 `nsh.json` 的 `store.linux.archiveUrl`（其中 `{version}` 替换为版本号），也可用 `--url` 指定。不会创建 Pull Request，需自行提交到 `flathub/<id>` 仓库。`status` 显示 Flathub 上的版本，与 `nsh.json` 不一致时退出码为 1；`doctor` 检查 Flathub 要求的元数据（`id`、商店文案、`store.linux`、图标），并校验 metainfo 与 desktop 文件。

### nsh publish windows

```sh
nsh publish windows <APP.msix> [--entry <DIR>] [--product-id <ID>] [--notes <FILE>|<LANG>=<FILE>]... [--wait]
nsh publish status windows [--entry <DIR>] [--product-id <ID>] [--submission <ID>] [--json]
nsh publish doctor windows [--entry <DIR>] [--product-id <ID>]
```

用 Store submission API 把 MSIX 包提交到 Microsoft Store：基于上次发布创建 submission、替换包、设置各 listing 的更新说明（默认取商店文案各语言的 `releaseNotes`，也可用 `--notes` 指定）、上传并提交认证。提交前失败会删除该 submission；已有 pending submission 时拒绝执行。`--wait` 轮询直到认证结束。`status` 退出码：已发布 0、进行中 2、失败 1。`doctor` 只读检查 `nsh.json`、凭据和 Store ID。Store ID 写在 `nsh.json` 的 `store.windows.productId`（或用 `--product-id`）。凭据为关联 Partner Center 的 Azure AD 应用，只从 `NSH_MS_TENANT_ID`、`NSH_MS_CLIENT_ID`、`NSH_MS_CLIENT_SECRET` 读取。首次提交（定价、分级、商店页）需在 Partner Center 完成。

### nsh verify

```sh
nsh verify <PACKAGE> [--root <ROOT.pub>]... [--revocations <LIST>]
```

按信任给定根密钥的应用的方式校验一个包。不带 `--root` 时只检查包自身的签名。它会打印包的 SHA-256，`nsh revoke --package` 接受的就是这个值。

### nsh symbolicate

```sh
nsh symbolicate <MAP> [INPUT]
```

把包上报的报错中的 bundle 位置（`bundle.js:LINE:COL`）改写为你的源码位置并打印结果。`MAP` 是 source map
（`nsh publish --source-map file` 输出的 `<package>.map`，或 `bundle.js.map`），或带有 source map 的包；`INPUT`
是报错文本（默认：标准输入）。

### nsh revoke

```sh
nsh revoke --root <ROOT.secret> [--extend <LIST>] [--sequence <N>] [--key <ID>]... [--package <SHA256>]... -o <OUT>
```

签发一份吊销列表：列出不允许再加载的 release 密钥和包。

| 参数 | 说明 |
|---|---|
| `--root <ROOT>` | 根密钥的私钥。 |
| `--extend <EXTEND>` | 保留这份列表（最近发布的那份）中的条目。 |
| `--sequence <N>` | 列表编号，必须大于此前发布过的任何编号。配合 `--extend` 时默认为那份列表的编号加一。 |
| `--key <ID>` | 要吊销的 release 密钥 id。可重复。 |
| `--package <SHA256>` | 要吊销的包的 SHA-256。可重复。 |
| `-o, --out <OUT>` | 要写入的列表。 |

## 环境变量

| 变量 | 使用者 | 说明 |
|---|---|---|
| `ANDROID_HOME`、`ANDROID_SDK_ROOT` | Android 目标 | Android SDK 位置。后备路径：`~/Library/Android/sdk`。 |
| `ANDROID_SERIAL` | Android 目标 | `--device` 没有指定时要使用的设备或模拟器的序列号，与 adb 读取它的方式相同。 |
| `CARGO_TARGET_DIR` | 带 Rust crate 的应用 | 应用运行器的构建目录。默认为应用的 `target/`。 |
| `NSH_KEYSTORE_PASSWORD` | `package --target android` | keystore 密码。 |
| `NSH_RUNTIME` | `run`、`package` | 用来替代 CLI 旁边运行时的运行时目录。 |
| `NSH_VERBOSE` | 所有命令 | `1`：等同于 `--verbose`。 |
| `NSH_WASM_BINDGEN` | `run`、`package`（`--target web`） | 应用的 crate [调用浏览器 API](./web.md#在-rust-中使用浏览器-api) 时使用的 `wasm-bindgen` CLI。默认使用 `PATH` 中的。 |
| `NO_COLOR` | 所有命令 | 设置后，终端输出不带颜色。 |

## nsh publish ios

```sh
nsh publish ios <IPA> [--app-id <ID>] [--issuer-id <ID>] [--key-id <ID>] [--private-key <PATH>]
```

在 macOS 上将经过 App Store 签名的 IPA 上传到 App Store Connect，等待处理、分发 TestFlight 测试组、
准备 App Store 版本与商店文案，加 `--submit` 时提交审核。`nsh publish status ios` 与 `nsh publish doctor ios`
报告发布状态并检查配置。参数也可通过
`NSH_APP_STORE_APP_ID`、`NSH_APP_STORE_ISSUER_ID`、`NSH_APP_STORE_KEY_ID` 和
`NSH_APP_STORE_PRIVATE_KEY` 环境变量提供。App ID 默认读 `nsh.json` 的 `store.ios.appId`，私钥默认读
`~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`，配置好的应用只需 `nsh publish ios <IPA>`。签名、凭据和处理流程见[发布到 App Store](./publish.md#upload-to-testflight)。
