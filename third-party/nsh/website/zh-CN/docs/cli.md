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
| `mixed` | 根目录即一个 Rust crate 的 TSX 应用：`App.tsx`、它的测试 `App.test.tsx`、`tsconfig.json`、设置了 `"rust": "."` 的 `nsh.json`、`.gitignore`、`.nsh/types`、README，以及与 `App.tsx` 并列的 crate（`Cargo.toml`、`src/lib.rs`），它的 `#[native_module("<name>/native")]` 导出一个组件、一个模块和一个类，供 `App.tsx` 使用。没有 `"root"`，入口就是 `App.tsx`。 |

| 参数 | 说明 |
|---|---|
| `--name <NAME>` | 写入 `nsh.json` 的显示名称。默认为目录名。id 会是 `com.example.<name>`（只保留字母和数字，转为小写），crate 的导入说明符是 `<name>/native`（小写，单词以 `-` 连接）。 |
| `--template <TEMPLATE>` | `rust`、`ts` 或 `mixed`（见上表）。`rust` 和 `mixed` 需要 Rust 工具链；`cargo run` 还需要原生桌面后端的开发库。 |
| `--nsh-source <DIR>` | 与 `rust` 或 `mixed` 一起使用：crate 按路径依赖 `DIR` 中 NSH 源码仓库的 crate，基于 NSH 源码构建应用。 |

`rust` 和 `mixed` 的 crate 依赖 crates.io 上与 CLI 同版本的 NSH crate（使用 `--nsh-source` 时依赖该源码仓库中的 crate），`nsh` 命令用同样的 crate 构建应用的运行器和宿主。对这样的应用，`nsh` 在每条命令之前构建一个由应用 crate 和 NSH 核心组成的小程序，用它描述这些 crate 的组件、模块和类（crate 有改动时才重新运行）；有了这份描述，CLI 自己完成打包、编译、类型检查、开发服务和打包发布。Rust 应用的构建只编译它的 crate 和 NSH 的核心。请在新的应用目录中创建它们：只要其中任何一个文件已存在，就会在写入之前报告为冲突。

当应用的 Rust crate 通过 Git 依赖 NSH 时，CLI 使用 Cargo 根据应用锁文件解析的 checkout。生成的宿主使用同一份源码，并统一应用通过 Cargo patch 重定向的 NSH 依赖。

## nsh run

```sh
nsh run [ENTRY] [--target catalyst|ios|android|macos|linux|windows|gpui|tui|web] [--device <DEVICE>] [--port <PORT>] [--release] [--limits [<LIMITS>]] [--trace] [--fps] [--name <NAME>] [--window-size <WIDTHxHEIGHT>]
```

```sh
nsh run my-app                     # Rust 应用的根组件，或 TSX 应用的 App.tsx，在本机的后端上运行
nsh run my-app --target ios        # 在 iOS 模拟器中
nsh run my-app/App.tsx --target web
```

对 TSX 入口，`nsh run` 启动开发服务器（同 `nsh dev`），启动一个从它加载应用的开发宿主，并在每次保存时重新构建。热模块替换会就地修补正在运行的应用；应用的日志和错误会打印在终端里。终端宿主用 Ctrl+Q 停止。其他宿主用 Ctrl-C 停止（或关闭 Catalyst、macOS、Linux、Windows 或 GPUI 窗口）。

Rust 应用（`nsh.json` 中有 `"root"`，见[用 Rust 开发](./rust.md)）运行时不需要开发服务器，也没有 QuickJS：`nsh run` 为目标平台构建挂载了根组件的应用运行器并启动它（桌面上是 debug 构建，日志打印在终端；模拟器和 Android 上会安装应用），修改 crate 的 Rust 代码后重新构建并重启。使用 `--target web` 时会打印页面地址，已打开的页面会自动加载新的运行时。指定 TSX 入口（`nsh run App.tsx`）则运行 TSX 入口。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--target <TARGET>` | macOS 上为 `macos`，Linux 上为 `linux`，Windows 上为 `windows` | `catalyst`：Mac Catalyst 宿主，一个 iPhone 大小的窗口（390×844）。`ios`：iOS 模拟器中的宿主。`android`：Android 设备或模拟器上的宿主。`macos`：AppKit 宿主，一个 1200×800 的窗口（[macOS](./macos.md)）。`linux`：GTK 宿主，一个 390×844 的窗口（[Linux](./linux.md)）。`windows`：Win32 宿主，一个 1200×800 的窗口（[Windows](./windows.md)）。`gpui`：GPUI 宿主，一个 1200×800 的窗口，可在 macOS、Windows 或 Linux 上运行，以嵌入它的 GPUI 应用的方式显示 TSX 应用（[GPUI](./gpui.md)）。`tui`：当前终端，提供键盘焦点、鼠标输入和 Unicode 编辑（[终端](./tui.md)）。`web`：开发服务器的页面，地址会打印出来（[Web](./web.md#在浏览器里开发)）。 |
| `--device <DEVICE>` | | 要使用的 iOS 模拟器，按名称（`"iPhone 16 Pro"`）或 UDID 指定。默认：已启动的模拟器，否则启动最新的 iPhone。 |
| `--port <PORT>` | `8790` | 开发服务器端口。被占用时使用下一个空闲端口。 |
| `--release` | | 压缩代码并去掉调试信息。release 包没有热模块替换：每次保存都会重新加载应用。 |
| `--limits [<LIMITS>]` | | 按嵌入在其他应用中的方式运行应用，使用宿主应用设置的限制：`memory` 和 `stack`（单位为 `KB`、`MB` 或 `GB`）、`load` 和 `call`（单位为 `ms` 或 `s`）以及 `nodes`，例如 `--limits memory=128MB,call=500ms`。没写的项保持嵌入时的默认值，只写 `--limits` 就全部使用默认值（[沙箱与能力](./sandbox-and-capabilities.md#限制)）。不带它时，应用像打包后的应用一样独立运行。仅 TSX 入口。 |
| `--trace` | | 宿主把每次 commit 的耗时（JS、布局、挂载项）记录到终端。 |
| `--fps` | | 性能监视器：帧率、每帧和每次 commit 的开销、CPU、GPU 和内存；macOS 上显示在应用上方（[macOS](./macos.md#性能监视器)）；macOS、Linux、Windows 和 iOS 上每秒输出一行日志。 |
| `--name <NAME>` | `nsh.json` 的 name | 菜单栏中的应用显示名称及初始窗口标题（`--target macos`，TSX 入口）。 |
| `--window-size <WIDTHxHEIGHT>` | 宿主默认值 | 初始窗口尺寸，单位为点，例如 `800x600`（`--target macos`、`linux`、`windows` 和 `gpui`，TSX 入口）。 |

使用 `--target android` 时，会选用 `adb devices` 列出的第一台设备；开发服务器的端口通过 `adb reverse` 转发到设备上。参见[快速开始](./getting-started.md)和[开发服务器与调试](./dev-server-and-debugging.md)。

## nsh dev

```sh
nsh dev [ENTRY] [--target catalyst|ios|android|macos|linux|windows|gpui|web] [--device <DEVICE>] [--server-only] [--port <PORT>] [--release] [--limits [<LIMITS>]]
```

启动开发服务器并打开当前系统的原生宿主：macOS 使用 AppKit，Linux 使用 GTK，Windows 使用 Win32。开发 iOS 或 Android 应用时显式指定 `--target ios` 或 `--target android`。用 `--server-only` 为自己启动的宿主提供服务。服务器构建应用、监视入口所在目录，并把每次重新构建推送给连接到它的宿主。使用 `--server-only` 时，它会打印本机宿主使用的 URL、每个局域网地址对应的设备 URL，以及在 Web 运行时存在时，浏览器运行应用要打开的页面（[Web](./web.md#在浏览器里开发)）：

```text
✓ built App.tsx (3.2 KB js, 9.8 KB bytecode, 21ms)
→ dev server ws://127.0.0.1:8790/ws
  browsers: http://127.0.0.1:8790/
  devices on this network: ws://192.168.1.20:8790/ws
  browsers on this network: http://192.168.1.20:8790/
```

用 `nsh dev --server-only` 连接嵌入了开发版 SDK（`NativeShellDev.xcframework`、`nsh-dev.aar`）的应用。`--target`、`--device`、`--port`、`--release` 和 `--limits` 的含义与 `nsh run` 相同。

## nsh test

```sh
nsh test [PATH] [--filter <NAME>] [--trace] [--fps] [--junit <FILE>] [--target <TARGET>] [--browser <PATH>] [--web-host <JS>]
```

以无界面方式运行应用的测试（[测试](./testing-and-trace.md)）：运行目录 `PATH`（默认为当前目录；跳过隐藏目录、`node_modules` 和 `target`）中的测试文件（`*.test.tsx`、`*.test.ts`，导入 `nsh/test`），或者测试文件 `PATH` 本身。如果传入的是带有自己 Rust crate 的应用（`nsh.json` `"rust"`：Rust 应用，或带 crate 的 TSX 应用）的目录，它会先在目录中每个 crate 自己的目录下运行 `cargo test`，并把每个 Rust 测试与 TypeScript 测试一起显示和计数，归在其测试目标的文件下（`src/lib.rs › tests::adds`）；只有 Rust 测试的 Rust 应用也这样测试。每个测试文件在各自的引擎上运行，测试打开的每个应用又在另一个全新的引擎上运行。它为每个测试打印一行；失败时还会打印抛出的内容、它在测试文件中的位置和屏幕上的文字。只要有失败，就以非零退出码结束。如果传入的是应用入口（`nsh test App.tsx`；Rust 应用为 `nsh test nsh.json`），它会在真实网络下打开应用，让它运行 1.2 s，然后执行标准输入给出的步骤（`await app.press("Add")`，其中 `app` 就是这个应用）。TSX 应用在 CLI 自己的进程里运行；带有自己 Rust crate 的应用在用这些 crate 构建的无界面运行器中运行，由 CLI 为它构建入口。除非测试以 Android 打开应用（`open` 的 `platform`），无界面运行按 iOS 处理：`platform.os` 为 `"ios"`，`ios:` 类和 `ios={{…}}` 属性都会生效。

```text
✓ App.test.tsx › counts taps (321ms)
✓ 1 test: 1 passed, 0 failed (343ms)
```

| 参数 | 说明 |
|---|---|
| `--filter <NAME>` | 只运行名称（前面带上所在 `describe` 块的名称）包含 `NAME` 的测试；对 crate 则是 `cargo test <NAME>`。 |
| `--trace` | 打印测试所打开应用的每个挂载批次，标注它所属的步骤（`── press(Add): 7 items`），以及每次 commit 的耗时：首帧、一个步骤或一帧滚动的开销。加上 `--target` 时，是 host 的批次和耗时。 |
| `--fps` | 配合 `--target linux`、`macos`、`windows` 或 `ios`：host 每秒输出一行性能监视器读数（帧率、帧各阶段、commit、CPU、内存），用 `-v` 显示。 |
| `--junit <FILE>` | 同时把结果以 JUnit XML 报告写入 `FILE`，CI 服务按这种格式展示测试结果：每个测试文件一个 `testsuite`，每个测试一个 `testcase`。 |
| `--target <TARGET>` | 在该平台的开发 host 上运行测试打开的应用，而不是 headless（`macos`、`linux`、`windows`、`gpui`、`web`、`ios` 和 `android`；`web` 在 headless 的 Chrome、Edge 或 Chromium 里运行）：步骤用平台自己的输入执行（[测试](./testing-and-trace.md#在真实平台上运行)）。crate 的 Rust 测试在本机运行，属于不带 `--target` 的运行。 |
| `--browser <PATH>` | `--target web` 运行应用所用的 Chrome、Edge 或 Chromium 可执行文件（默认：本机安装的那个）。 |
| `--web-host <JS>` | headless 运行时测试打开的应用所用的 Web 页面宿主模块（默认：`nsh.json` 的 `web.host`；它导出 `createHost(player)`）：它应答应用的 [`nsh/host`](../modules/nsh-host.md) 调用，它的 `player.hostEvent` 会送到 `host.on`（[测试](./testing-and-trace.md#页面的宿主)）。只用于 headless 运行；`--target web` 运行 `nsh.json` 的 `web.host`。 |

NSH 生成的文件都放在 `.nsh/` 下：类型声明、runner 源码，以及默认的构建和打包输出 `.nsh/out/`。Cargo 保留它通常的 `target/` 缓存和已有的 `CARGO_TARGET_DIR` 行为；NSH 不会添加 Cargo 配置来移动它。`--out` 仍可指定输出位置。

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
nsh package [ENTRY] --target ios|ios-simulator|android|macos|linux|windows|tui|web [-o <OUT>] [flags]
```

以 release 模式构建可安装的应用。Rust 应用（`nsh.json` 中有 `"root"`）用它自己的运行器打包，运行器由 Cargo 用你的 crate 和 NSH 的 crate 构建，挂载根组件，不带 QuickJS（见[用 Rust 开发](./rust.md)）；TSX 应用使用预构建的运行时。整个过程不需要 Xcode 工程或 Gradle 构建：NSH 自己组装应用包，并使用 Xcode 的 `actool` 和 `codesign`（iOS）或 SDK 中的 `aapt2`、`zipalign` 和 `apksigner`（Android）；macOS 则用 `codesign` 组装一个 ad hoc 签名的 `.app`（图标用 `sips` 转换）；Linux 则复制运行器并用 `tar` 生成 `.tar.gz`；Windows 则复制运行器、嵌入图标并生成 `.zip`，不需要任何工具；终端目标则写出控制台程序、资源和本机格式的归档；Web 则写出一个静态站点，同样不需要任何工具。元数据来自 `nsh.json`，可被参数覆盖。

| 参数 | 说明 |
|---|---|
| `--target <TARGET>` | 必填。`ios`：iOS 设备，签名的 `.ipa`（不带 `--sign` 时为未签名的 `.app`）。`ios-simulator`：ad hoc 签名的 `.app`。`android`：签名的 `.apk`。`macos`：ad hoc 签名的 `.app`（[macOS](./macos.md#打包)）。`linux`：一个目录 `<Name>/`（可执行文件、`nsh/`、`.desktop` 文件）和 `<Name>.tar.gz`（[Linux](./linux.md#打包)）。`windows`：一个目录 `<Name>\`（`<Name>.exe`、`nsh\`）和 `<Name>.zip`（[Windows](./windows.md#打包)）。`tui`：控制台程序和 `nsh/` 资源，在 macOS/Linux 上归档为 `.tar.gz`，在 Windows 上归档为 `.zip`（[终端](./tui.md#打包)）。`web`：一个目录 `<Name>/`，即静态站点（`index.html` 和以内容命名的文件）（[Web](./web.md#发布应用)）。 |
| `-o, --out <OUT>` | 输出目录（默认 `.nsh/out`）。 |
| `--name <NAME>` | 显示名称。 |
| `--id <ID>` | Bundle identifier，例如 `com.example.app`。 |
| `--app-version <VERSION>` | 版本号，例如 `1.2.0`。 |
| `--build <BUILD>` | 构建号。 |
| `--icon <ICON>` | 应用图标：正方形 PNG，最好是 1024×1024。 |
| `--sign <IDENTITY>` | iOS 设备：代码签名身份，例如 `"Apple Development: …"`。 |
| `--profile <FILE>` | iOS 设备：描述文件（`.mobileprovision`），entitlements 取自其中。 |
| `--keystore <FILE>` | Android：release keystore。默认使用 `~/.android/debug.keystore` 中的调试密钥（不存在时创建）。 |
| `--key-alias <ALIAS>` | Android：keystore 中的密钥别名。 |
| `--keystore-password <PASSWORD>` | Android：keystore 密码，也可从 `NSH_KEYSTORE_PASSWORD` 读取。 |
| `--run` | 打包完成后安装并启动应用：在模拟器中（`ios-simulator`）或在已连接的 Android 设备上；`macos`、`linux` 和 `windows` 则直接启动它；`tui` 在当前终端中运行直到退出；`web` 在本机提供站点服务，并打印其地址。 |

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile dev.mobileprovision
nsh package my-app --target android --keystore release.jks --key-alias upload
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target tui
nsh package my-app --target web
```

参见[打包](./packaging.md)。

## 签名命令

这些命令用于生成和校验签名包（`.nshpkg`）：嵌入 NSH 的应用会下载这些应用包，并在运行前进行校验。[签名包](./signed-packages.md)介绍了整个模型（由离线保存的根密钥为某些应用 id 认证 release 密钥）。

### nsh keygen

```sh
nsh keygen <NAME>
```

创建一对 Ed25519 密钥：`<NAME>.secret` 和 `<NAME>.pub`（例如 `nsh keygen keys/root`）。根密钥的 `.secret` 应离线保存；应用信任的是它的 `.pub`。

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
| `CARGO_TARGET_DIR` | 带 Rust crate 的应用 | 应用运行器的构建目录。默认为应用的 `target/`。 |
| `NSH_KEYSTORE_PASSWORD` | `package --target android` | keystore 密码。 |
| `NSH_RUNTIME` | `run`、`package` | 用来替代 CLI 旁边运行时的运行时目录。 |
| `NSH_VERBOSE` | 所有命令 | `1`：等同于 `--verbose`。 |
| `NSH_WASM_BINDGEN` | `run`、`package`（`--target web`） | 应用的 crate [调用浏览器 API](./web.md#在-rust-中使用浏览器-api) 时使用的 `wasm-bindgen` CLI。默认使用 `PATH` 中的。 |
| `NO_COLOR` | 所有命令 | 设置后，终端输出不带颜色。 |
