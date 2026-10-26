---
title: 项目结构
description: 用 Rust 或 TSX 编写的 NSH 应用包含的文件、nsh.json 的每个键、.nsh/types 中的 TypeScript 配置、资源，以及模块和包的导入方式。
order: 5
group: start
---

# 项目结构

一个 NSH 应用就是一个目录，包含一个 `nsh.json` 和它的代码：一个 Rust crate（由 `nsh.json` 指定其根组件），或一个 TSX 入口模块，或两者都有。其他一切（更多模块、图片、字体、JSON 文件）都从这里找到：crate 的模块和它的 `assets/` 目录，或者 TSX 入口导入的文件，因此不需要维护文件清单。

用 Rust 编写的应用是一个 Cargo 项目：

```text
my-app/
├── nsh.json           name, id, version, icon, the crate ("rust") and its root component ("root"), theme
├── Cargo.toml         the crate: nsh-core, nsh-base and your dependencies
├── src/
│   ├── lib.rs         the root component and the crate's UI set (#[native_module])
│   ├── main.rs        cargo run: the root on this machine's desktop backend
│   └── screens/       your own modules (any layout you like)
├── assets/            files the crate ships: asset!("logo@2x.png"), fonts
├── .gitignore         .nsh/ and target/
├── .nsh/              generated: the runners' sources, test entries, build output (.nsh/out)
└── target/            Cargo's build directory
```

TSX 应用是一个入口及它导入的模块：

```text
my-app/
├── App.tsx            the entry module: calls mount()
├── App.test.tsx       its tests (nsh test)
├── nsh.json           name, id, version, icon, Tailwind theme, capabilities
├── tsconfig.json      TypeScript settings for editors
├── .gitignore         .nsh/ and target/
├── components/        your own modules (any layout you like)
│   └── Header.tsx
├── assets/
│   ├── logo@2x.png    imported images
│   └── Inter.ttf      imported fonts
└── .nsh/              generated: type declarations, development host builds, test entries, build output (.nsh/out)
```

两者都有的应用在 `"rust"` 中列出它的 crate，并有一个导入它们的 TSX 入口（[用 Rust 开发](./rust.md#用-tsx-扩展-rust-应用)）。

每个命令都以应用目录或它的入口作为参数（`nsh run my-app`、`nsh run my-app/App.tsx`）。`nsh.json` 和入口所在的目录就是应用的根目录：`nsh.json` 从这里读取，资源路径相对于它，`.nsh/` 也写在这里。在 Rust 应用中（`nsh.json` 带 `"root"`），目录运行根组件；指定 TSX 入口则运行该入口。

## 根组件

Rust 应用的根是它的 crate 中的一个组件，`nsh.json` 的 `"root"` 用它在 crate 中的路径指定（`App`、`shell::Gallery`）。TSX 入口是一个普通模块，最后渲染根组件：

```rust tabs
// src/lib.rs; nsh.json: { "rust": ".", "root": "App" }
mod screens;

use nsh_core::prelude::*;

/// What a TSX entry may import from the crate.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>().assets(assets!());
}

#[component]
pub fn App() -> impl IntoElement {
    screens::home()
}
```

```tsx tabs
// App.tsx
import { mount } from "nsh";
import { Home } from "./components/Home";

function App() {
  return <Home />;
}

mount(App);
```

`nsh run` 和 `nsh package` 在所有平台上挂载 Rust 根组件，不带 QuickJS。在 TSX 中，`mount(component, props?)` 把组件渲染到应用的界面上，并返回一个用于移除它的函数；应用只调用它一次。入口顶层的代码在 bundle 加载时、第一帧之前运行。

## nsh.json

`nsh.json` 位于应用的根目录。`nsh init` 会写入 `name`、`id`、`version` 和 `build`，Rust 应用还会写入 crate 及其根组件：

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "rust": ".",
  "root": "App",
  "theme": "theme.json"
}
```

其他键都是可选的；TSX 应用也可以省略这四个。TSX 应用的 `nsh.json` 可以是这样：

```json
{
  "name": "Gallery",
  "id": "com.example.gallery",
  "version": "1.0.0",
  "build": 1,
  "icon": "icon.png",
  "tailwind": {
    "colors": { "brand": { "500": "#7c3aed", "600": "#6d28d9" } },
    "radius": { "card": 14 }
  },
  "capabilities": {
    "network": { "hosts": ["api.example.com", "*.cdn.example.com"] }
  }
}
```

| 键 | 类型 | 使用者 | 说明 |
|---|---|---|---|
| `name` | string | `package` | 应用图标下显示的名称。默认：入口所在目录的名称。 |
| `id` | string | `package`, `publish`, `Storage` | Bundle identifier / application id，反向 DNS 形式，例如 `com.yourcompany.app`；`package` 和 `publish` 必须提供。没有时 `nsh run` 使用 `com.example.<name>`。 |
| `version` | string | `package`, `publish` | 用户可见的版本号，例如 `1.2.0`（`CFBundleShortVersionString`，Android 的 `versionName`）。 |
| `build` | number | `package`, `publish` | 构建号（`CFBundleVersion`，Android 的 `versionCode`）。签名包要求它在每次发布时递增。 |
| `minRuntime` | string | `publish` | 能运行该签名包的最低 NSH 运行时版本，例如 `0.2.0`。默认：CLI 的版本（[签名包](./signed-packages.md#哪些运行时能运行包)）。 |
| `icon` | string | `package` | 一张正方形 PNG，最好是 1024×1024，路径相对于 `nsh.json`。 |
| `tailwind` | object | 每次构建 | 扩展 `class` 字符串所依据的 Tailwind 主题（[Tailwind](./tailwind.md)）。 |
| `theme` | string 或 object | 每次构建 | 应用的设计令牌（shadcn/ui 的 `cssVars`，叠加在默认的 `neutral` 主题之上），供 token 类名、`token()` 和 Rust 组件绘制时使用：相对于 `nsh.json` 的主题文件路径，或直接内联的主题（[用 Rust 开发](./rust.md#主题)、[主题 token](./tailwind.md#主题-token)）。 |
| `statusBar` | object | 每次构建、`package` | 所有页面和对话框之下的状态栏默认值（iOS 和 Android）：`{ "foreground": "auto" \| "light" \| "dark", "hidden": boolean }`，两个字段都可省略。打包的 iOS 应用从启动屏起就使用它（[状态栏](../modules/nsh-base.md#status-bar)）。 |
| `capabilities` | object | 每次构建 | 应用可以访问 VM 之外的哪些资源：网络主机、网页视图主机、状态栏（[沙箱与权限](./sandbox-and-capabilities.md)）。 |
| `resolve` | object | 每次构建 | 裸导入如何解析：npm 包的导出条件和别名（[npm 包](#npm-包)）。 |
| `rust` | string 或 string[] | 每个命令 | 应用的 Rust crate 或 crate 列表，路径相对于 `nsh.json`：其中的组件和模块，TSX 按每个 crate 的 `#[native_module]` 名称导入（[用 Rust 开发](./rust.md#多个-crate)）。 |
| `web` | object | `package` | Web 包给页面添加的内容。`web.host`：一个 JS 模块，路径相对于 `nsh.json`，导出 `createHost(player)`，应答应用的 [`host`](../modules/nsh.md#host) 调用；`web.connect`：该模块自己的请求访问的主机，写法同 `capabilities.network.hosts` 的模式，页面的 Content-Security-Policy 允许它们（[Web](./web.md#宿主的函数)）。 |
| `root` | string | `run`, `package` | Rust 应用的根组件，即它在 `rust` crate（列表时为第一个）中的路径（`App`、`shell::Gallery`）：对应用目录执行 `nsh run` 和 `nsh package` 时，在所有平台上直接挂载它，不使用 QuickJS；`nsh run App.tsx` 仍然运行 TSX 入口（[用 Rust 开发](./rust.md)）。 |

`nsh package` 和 `nsh publish` 的参数（`--name`、`--id`、`--app-version`、`--build`、`--icon`、`--min-runtime`）会覆盖文件中的值（[CLI](./cli.md)）。

`tailwind`、`theme`、`appearance`、`statusBar`、`capabilities` 和 `resolve` 在构建应用时会被校验。拼写错误会导致构建失败，而不是变成一个悄无声息不起作用的设置：

```text
error building App.tsx failed
nsh.json: tailwind: unknown theme key `colours`
```


### capabilities

没有 `capabilities` 键时，应用可以自由使用网络、网页视图和状态栏：独立应用归开发者自己所有。设置了该键后，未列出的一切都会被拒绝，无论是开发中还是打包后的应用：

```json
"capabilities": {
  "network": {
    "hosts": ["api.example.com", "*.cdn.example.com"],
    "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }]
  },
  "webview": { "hosts": ["*.example.com"] },
  "statusBar": true
}
```

`network` 涵盖 `fetch`、远程图片和视频源；本地资源始终允许访问。嵌入 NSH 的应用可以授予比应用声明更少的权限。详情见 [沙箱与权限](./sandbox-and-capabilities.md)。

## tsconfig.json 与 .nsh/types

NSH 不需要 `node_modules`。取而代之的是，每个构建应用的命令（`init`、`build`、`test`、`dev`、`run`、`package`、`publish`、`check`）都会把 NSH 提供的所有内容的 TypeScript 声明写入 `.nsh/types`，并把 NSH 的 TypeScript 设置写入 `.nsh/tsconfig.json`。应用的 `tsconfig.json` 继承它：

```json
{
  "extends": "./.nsh/tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx"]
}
```

`.nsh/tsconfig.json` 把 `nsh` 的导入和应用自己的 crate 指向 `.nsh/types`，包含全局声明、资源声明和令牌声明，并设置 NSH 应用使用的编译选项（`lib`、`jsx`、`strict` 等）。NSH 会让它保持最新：新版本增加了库或路径时，应用在下一次构建时就会得到，而你的 `tsconfig.json` 保持你写的样子。你在 `tsconfig.json` 中添加的选项会覆盖 NSH 的设置。

| `.nsh/types/nsh/` 中的文件 | 声明的内容 |
|---|---|
| `index.d.ts` | `nsh`：`signal`、`computed`、`effect`、`mount`、`View`、`Text` 等，并重新导出下列类型 |
| `types.d.ts` | 样式（`ViewStyle`、`TextStyle` 等）、每个元素的 props 和事件、`YNode`（`ref` 接收到的对象） |
| `jsx-runtime.d.ts` | TypeScript 通过 `jsxImportSource` 解析的 JSX 运行时（`JSX` 命名空间） |
| `globals.d.ts` | `If` 和 `Each`；`console`、定时器、`requestAnimationFrame`、`fetch` 及其他[全局 API](../modules/globals.md) |
| `assets.d.ts` | 导入图片或字体得到的值 |
| `tokens.d.ts` | `Tokens`：应用的设计令牌，来自它的 `"theme"`，为 [`token()`](../modules/nsh.md#token) 提供类型 |
| `mobile.d.ts`、`desktop.d.ts` | 每个模块一个文件（`nsh/mobile`、`nsh/desktop`） |
| `base.d.ts` | `nsh/base` |

`lib` 是不含 `DOM` 的 `ES2023`：没有 `document` 或 `window`。`.nsh` 中的文件会被重新生成（只在内容变化时），所以不要编辑，也不要提交；`.gitignore` 已经排除了 `.nsh/`。如果克隆项目后编辑器提示找不到 `nsh`，运行任意一个构建命令即可，例如 `nsh check`。

`.nsh/tsconfig.json` 加入了 `"ESNext.Disposable"`，它声明了运行时提供的 `using` 声明和 `Symbol.dispose`：`using account = new Account()` 在块结束时释放一个 [Rust 类](./rust.md)的值。其中的 `jsxImportSource: "nsh"` 和 `jsx: "preserve"` 只对编辑器有意义：无论 `tsconfig.json` 怎么写，NSH 都用自己的编译器编译 JSX。TypeScript 类型由编辑器检查（如果装了 `tsc` 也可以用它）；`nsh` 只剥离类型，不做检查。

由较早的 `nsh init` 创建的应用，如果它的 `tsconfig.json` 是 NSH 的模板且没有改动过，会在下一次构建时换成新的 `tsconfig.json`，NSH 会打印一行说明。你改过的 `tsconfig.json` 归你所有：它没有继承 `./.nsh/tsconfig.json` 时，`nsh check` 会指出来，你加上 `extends` 这一行并删掉它已经设置的选项即可。

## 模块

Rust 应用的代码就是它的 crate 的模块（`mod screens;`），依赖和任何 crate 一样来自 crates.io；NSH 自己的 crate 是 `nsh-core`（基础元素、signal 和带类型的样式，`use nsh_core::prelude::*`）和 `nsh-base`（基础组件和主题）。

在 TSX 中，可以把应用拆成任意多个 `.ts` 和 `.tsx` 模块，用相对路径导入；扩展名可以省略：

```tsx
import { Header } from "./components/Header";
import { formatPrice } from "./lib/format";
import strings from "./strings.json";
```

它们都会被打包进同一个脚本。JSON 文件导入后就是解析后的值。

### 按需加载代码

对应用自己的模块调用 `import()`，会得到一个兑现为其导出的 promise，和浏览器里一样：

```tsx
const open = async () => {
  const { Settings } = await import("./screens/Settings");
  screen.set(() => Settings);
};
```

设备上的应用只分发一个 bundle，模块已经在里面，promise 会立即兑现。以拆分方式发布的 Web 应用（`nsh build --split`）会把这个模块以及只有它用到的代码放进单独的文件，在 `import()` 第一次请求时才下载（[Web](./web.md#拆分-bundle)）。参数必须是字面量相对路径：打包器需要知道导入的是哪个模块。

### NSH 的模块

对 `nsh` 和 `nsh/...` 的导入不会被打包：运行时以原生方式提供它们。

| 模块 | 内容 |
|---|---|
| `nsh` | 响应式（`signal`、`computed`、`effect` 等）、`mount`、`split`、`context`；基础元素 `View`、`Text`、`Scroll`、`Image`、`List`、`Canvas`、`WebView`、`Video`（`View` 的 `selectable` 用于文本选择）；安全区域边距（`safeArea`、`safeAreaInsets`）和软键盘（`Keyboard`、`keyboardFrame`）；原生动画；`PanResponder`；环境（`platform`、`windowSize`、`colorScheme`、`fontScale`、`pixelRatio`、`locale`）；读屏与减少动态效果的状态、朗读通知；剪贴板、照片选择器、存储、宿主通道、键盘快捷键；嵌入应用注册的组件和函数（[参考](../modules/nsh.md)） |
| `nsh/base` | 应用界面的无样式基础：导航栈及其页面（`NavStack`、`NavPage`、`createNavStack`）、对话框（`Dialog`）、按压目标（`Button`）、文本输入框（`Input`）和系统警告对话框（`AlertDialog`）；页面和对话框设置状态栏（`statusBar`）（[参考](../modules/nsh-base.md)） |
| `nsh/mobile` | iOS 和 Android 的 API：`TabBar`、`InputAccessoryView`（iOS）、`BackHandler`（Android）（[参考](../modules/nsh-mobile.md)） |
| `nsh/desktop` | macOS、Windows 和 Linux 的 API：`Window`、`titleBar`、`Menu`（[参考](../modules/nsh-desktop.md)） |

[模块参考](../modules/index.md) 逐一介绍了它们。导入 NSH 没有的模块（`nsh/foo`）会导致构建错误。代码用到、但模块没有导出的名字（`import { Buton } from "nsh/base"`）同样是构建错误：错误指向这条导入，并给出最接近的导出名（``did you mean `Button`?``）。只当作类型用的名字由 `nsh check` 检查。

### npm 包

NSH 本身不依赖 npm 上的任何东西，但如果你用包管理器安装了包，打包器会从 `node_modules` 目录解析裸导入。包会解析到它们的浏览器版本，因为运行时提供的是 Web API（`fetch`、streams、`URL`、`TextEncoder` 等），而不是 Node 的 API（`fs`、`Buffer`、`process`）。依赖 DOM 的包无法工作：这里没有 DOM。

浏览器版本依赖 DOM 的包，往往另有面向 worker 或 React Native 的版本。`resolve.conditions` 指定解析包时使用的导出条件，取代默认的 `["browser"]`：`import`、`require`、`module` 和 `default` 始终生效；不含 `browser` 时，包通过 `module` 和 `main` 字段解析。`resolve.alias` 替换一个导入：换成相对 `nsh.json` 的路径（`./` 或 `../`）、另一个包，或用 `false` 换成空模块。TypeScript（`nsh check` 和编辑器）按导入原本的写法做类型检查：不是已安装包的名称，其类型由应用里的 `.d.ts` 文件声明。

```json
"resolve": {
  "conditions": ["worker"],
  "alias": { "dom-only-helper": "./shims/helper.ts", "node-polyfill": false }
}
```

```ts
// shims/aliases.d.ts
declare module "node-polyfill";
```

`solid-js` 不能被导入：打包器会拒绝它，并提示改用 `nsh` 自己的 `signal`、`computed` 和 `effect`，它们取代了 Solid。

## 资源

图片和字体随应用一起发布。Rust crate 在编译时用 `asset!` 读取它的 `assets/` 目录中的每个文件，并在它的 `#[native_module]` 函数中用 `registry.assets(assets!())` 把它们全部发布；TSX 像模块一样导入它们，打包器会记录每个被导入的文件（以及图片的像素密度变体）。`nsh build` 把它们复制到 `.nsh/out/assets/`，`nsh package` 把它们放进应用，开发期间则提供给应用。

```rust tabs
use nsh_core::element::{FontAsset, ImageAsset, asset};

const LOGO: ImageAsset = asset!("logo@2x.png");      // its url, and its size: 64×64 points
const INTER: FontAsset = asset!("Inter.ttf");        // its uri, and its family: "Inter"

image(LOGO)
text("Hello").font_family(INTER.family)
```

```tsx tabs
import { Image, Text } from "nsh";
import logo from "./assets/logo@2x.png";   // { url: "asset:/assets/logo@2x.png", size: { width: 64, height: 64 } }
import Inter from "./assets/Inter.ttf";     // "Inter"

<Image src={logo} />
<Text style={{ fontFamily: Inter }}>Hello</Text>
```

| 扩展名 | 导入得到 |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic` | 一个 `ImageAsset`：`{ url, size, scales? }`，单位为点。文件名带 `@2x` / `@3x` 后缀时，像素尺寸除以 2 / 3。不带后缀的文件还会发布它的 `@1.5x`–`@4x` 同名文件（列在 `scales` 中），并加载适合屏幕的变体（[像素密度](./images-and-assets.md#像素密度)）。 |
| `.svg` | 一个 `ImageAsset`，尺寸取自 SVG 的 `width` 和 `height`（或 `viewBox`），单位为点。 |
| `.ttf`, `.otf` | 字体的族名，一个字符串。字体会在第一帧之前注册。 |
| `.json` | 解析后的 JSON |

参见 [图片与资源](./images-and-assets.md) 和 [字体](./fonts.md)。

## 生成的目录

- **`.nsh/`**：NSH 生成的一切：类型声明（`.nsh/types`）、Rust 应用运行器的源码（`.nsh/rust`）、`nsh run` 安装到模拟器和设备上的内容（Catalyst 宿主应用、Android 开发 APK），以及 `.nsh/out`，即 `nsh build` 的默认输出（`bundle.js`、`bundle.js.map`、`bundle.nshc`、`capabilities.json`、`assets/`；Rust 应用是 `app.json` 和 `assets/`）和 `nsh package` 的输出（`.app`、`.ipa`、`.apk`、网站）；用 `-o` 写到别处。可以放心删除，会被重新生成。
- **`target/`**：应用的 crate 和运行器的 Cargo 构建目录（或 `CARGO_TARGET_DIR`）。
