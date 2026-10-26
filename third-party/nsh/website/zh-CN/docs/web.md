---
title: Web
description: 用 Rust 或 TSX 和 Native Shell 组件构建 HTML 和 CSS 界面，在浏览器里开发 Web 应用，并发布到任意静态托管服务或 CDN。
order: 16
group: platforms
demo: counter
---

# Web

用 Native Shell 构建 Web 应用，沿用原生平台上的组件、样式和业务逻辑。NSH 将界面渲染为 HTML 元素和 CSS：文字、图片、输入框、滚动、视觉样式和交互都使用浏览器的 DOM 和 Web API。

`nsh package --target web` 把应用发布成可放在任何 Web 服务器或 CDN 上的静态站点（[发布应用](#发布应用)），`nsh run --target web` 在你编辑时把它运行在浏览器里（[在浏览器里开发](#在浏览器里开发)）。本站每一个实时演示都使用这个 Web 后端。

## 各部分在哪里运行

页面由 HTML 元素和 CSS 样式构成。NSH 将组件更新转换为批量 DOM 操作，浏览器负责界面显示、滚动、文字选择和输入。WebAssembly 承载共享的 Rust 引擎，负责组件状态、布局计算和更新：Rust 应用的 crate 编译在其中，TSX 应用则带着 QuickJS。

在每个原生平台上，引擎都有自己的线程，每次提交把一个 `MountBatch` 交给主线程。浏览器页面只有一个线程，所以 Web 版由页面的事件循环一步步驱动同一个引擎（`nsh_engine::LocalEngine`）：

```text
指针 / 键盘 / 滚动事件 ──────────┐
setTimeout（引擎给出的截止时间）─┼─▶ nsh.wasm：引擎的一轮（Rust 或 JS、核心、布局）─▶ 一个 JSON 批次 ─▶ nsh.js：DOM
requestAnimationFrame ───────────┘                                                   ▲
                                                           原生动画的输出 ────────────┘
```

- **布局由核心完成。** 每个视图都是一个绝对定位的元素，位置和大小就是 Taffy 算出的 frame，所以 flexbox、grid、`aspectRatio` 和百分比的表现与设备上完全一致，浏览器自身的布局不参与。
- **样式在 Rust 里转成 CSS。** 背景、边框、圆角、阴影（`shadow*` 和 `boxShadow`）、渐变、滤镜、`backdropFilter`、变换、`transformOrigin`、`outline`、`mixBlendMode`、过渡和内置的关键帧动画都会变成 CSS 属性。Tailwind 类、`active:`、`hover:`、`focus:` 状态和 `dark:` 与设备上一样在原生侧解析。
- **文本在 Rust 里排版**，字体度量来自浏览器（`CanvasRenderingContext2D.measureText`），再按排版确定的位置逐段绘制，所以测量的就是绘制的。换行发生在空格之后、CJK 字符前后和 `\n` 处；`numberOfLines` 会截断并加省略号。
- **原生动画在 Rust 里运行**，由 `requestAnimationFrame` 驱动：`Animated` 的 timing、spring、decay，`interpolate`，绑定到 `opacity`、`transform`、`backgroundColor` 的动画值，用 `pan` 绑定的拖拽、滚动联动的值和画布参数。和设备上一样，每一帧都不经过 JS。`LayoutAnimation`、样式过渡、`animate-*` 关键帧和页面切换的动效与桌面后端一致；开启 `prefers-reduced-motion` 时它们不再播放（页面切换改为淡入淡出）。
- **输入**：带 `activeStyle` / `active:` 反馈的按压和长按、响应者系统（`onTouch*`、`PanResponder`）、原生拖拽和双指捏合、旋转、滚动视图（浏览器自身的滚动）、下拉刷新、可缩放的滚动视图（双指捏合、Ctrl+滚轮和触控板捏合、`zoomTo`）、受控的 `<Input>`（焦点、提交）、`Canvas`、带页面 `header` 的 `NavStack` 和 `NavPage`、`Dialog`。
- **系统界面绘制在页面内**：`AlertDialog` 在桌面浏览器上与桌面后端的对话框外观一致，在手机上与 iOS 一致（即 `desktop` 界面类型，见下文），`Toast.show` 在底部显示提示。自定义字体在浏览器加载完成后会重新测量文本，应用导入的字体加载好之前不显示第一帧。
- **对话框**与桌面后端一样，是覆盖整个应用的一层，显示应用的弹出层和背景。Escape、浏览器的返回按钮和点击背景会关闭它（`closeOnEscape`、`closeOnBackdropPress`），`animation`、`onOpen`、`onClose`、`onCancel` 和 `onOpenChange` 与设备上一致。

## 键盘、鼠标和触摸

发布出去的应用，在桌面浏览器里表现得像桌面应用，在手机浏览器里表现得像手机应用：

- **滚轮和触控板**滚动沿其方向、还能继续滚动的最内层滚动视图（没有可滚动的纵向视图时，纵向滚轮也会滚动横向列表），并且直到这次滚动结束都停留在这个视图上；滚轮的每一格平滑滑动，分页和吸附的视图每次滚动移动一页。Ctrl + 滚轮和触控板捏合会捏合带原生捏合值的视图，而不是缩放页面。和桌面平台一样，用鼠标拖动不会滚动：鼠标拖动交给拖拽手势、响应者系统和文字选择。滚动视图像桌面平台一样上报 `onScrollDragStart` / `onScrollDragEnd`、`onMomentumStart` / `End` 和 `onScrollEnd`。
- **键盘**：Tab 和 Shift+Tab 在可按压的视图和输入框之间移动（焦点环和 `focus:` 样式标出键盘焦点）；回车按下获得焦点的视图，空格在松开时按下；方向键、Page Up / Page Down、空格、Home 和 End 滚动焦点所在或鼠标下方的滚动视图；Escape 先离开输入框、关闭对话框，再返回。`nsh/keymap` 的快捷键在浏览器里同样有效，当场匹配（Mac 上的 Safari 和 Chrome 里 `mod` 是 Command，其他地方是 Control）。
- **返回**：Escape、Alt+左方向键（Mac 上是 Cmd+[）和鼠标的后退键会关闭最上层的对话框或弹出最内层的栈，和 Android 返回键一样；`popOnBack` 和 `onBackPress` 也照常生效。应用占据整个页面时，每个压入的页面和打开的对话框都是一条浏览器历史记录，浏览器的后退按钮会在应用内返回。
- **触摸**：只有滚动视图可以平移；应用下面的页面本身不会滚动、缩放或下拉刷新，点按没有延迟。嵌在 iframe 里时，应用不处理的滑动会滚动外层页面。在带原生平移、捏合的视图和响应者系统上的拖动都交给应用处理。
- **无障碍**：`role`、`accessibilityLabel`、`accessibilityHint`、`accessibilityState`、`accessibilityValue`、`accessibilityLiveRegion` 和 `accessibilityElementsHidden` 会转成 ARIA；`announce` 通过实时区域朗读，`setAccessibilityFocus` 移动焦点。对话框或提示框下面的视图不可交互。
- **选择和菜单**：在桌面浏览器中，文字默认可以选择，和网页一样，但交互元素里的文字（带按压或触摸处理的视图：按钮、可按压的列表行、标签栏）以及设置了 `selectable={false}` 或 `select-none` 的文字除外；在上面拖动鼠标会选择文字，Ctrl/Cmd+C 按行复制，Ctrl/Cmd+A 全选选区所在的这段文字。在手机和平板浏览器中，只有 `selectable` 文字可以选择，和原生应用一样。浏览器的右键菜单只在可选文字和输入框里出现。


## 带 Rust 组件的应用

用 Rust 编写的应用（[用 Rust 开发](./rust.md)）在自己的目录里发布和在浏览器中运行：

```sh
nsh package --target web           # .nsh/out/<Name>/：应用自己的 nsh.wasm，包含它的 crate
nsh run --target web               # 开发服务器的页面；修改 Rust 代码会重新构建
```

当 `nsh.json` 指定了应用的根组件（`"root"`）时，页面只包含应用的 Rust 代码和 NSH 的页面脚本：`nsh.wasm` 包含引擎、组件和应用的
crate，不含 QuickJS；站点里没有 `app.nshc` 和 `harden.nshc`；运行时和字体加载完后，页面直接挂载根组件。整个 Rust gallery 为
3.3 MB（gzip 后 1.06 MB，brotli 后 0.75 MB），比 TSX 应用的运行时还小。通过 TSX 入口（`nsh package App.tsx --target web`）时，
同一个应用像 TSX 应用一样运行在 QuickJS 上，并导入 crate 的组件和模块。

两种方式下，crate 的资源（`assets!()`）都会随应用的资源一起发布，其中的字体在第一帧之前加载。`nsh run --target web`
期间，修改 crate 的 Rust 代码会重新构建运行时，已打开的页面会自动加载新的运行时；TSX 的修改仍然是热更新。

要在包括 Web 在内的所有平台上运行的 Rust 代码，使用引擎提供的服务：`fetch(url).await` 通过与 JS `fetch` 相同的网络栈发出 HTTP
请求（这里是浏览器的网络栈，遵循它的 CORS 规则）；`timer`、`set_timeout` 和 `set_interval` 用于等待；`nsh_core::time::Instant`
和 `nsh_core::time::unix_ms()` 读取时钟。`background` 和 `blocking` 在原生目标的线程上运行任务。

构建需要 Rust 的目标和能编译到 WebAssembly 的 clang，与运行时本身的构建相同：`rustup target add wasm32-unknown-unknown`，
以及 `clang` 和 `llvm-ar`（macOS 上使用 LLVM 工具链，例如 Homebrew 的 `llvm`，通过 `CC_wasm32_unknown_unknown` 和
`AR_wasm32_unknown_unknown` 指定）。

### 在 Rust 中使用浏览器 API

crate 可以通过 [wasm-bindgen](https://wasm-bindgen.github.io/wasm-bindgen/) 及其 `web-sys`、`js-sys` crate，在
`#[cfg(target_arch = "wasm32")]` 下调用浏览器自身的 API：WebSocket、`IndexedDB`、剪贴板以及任何 Web API，还有 crate 自己的
JS（`#[wasm_bindgen(inline_js = …)]`、`module = "/js/…"`）。当应用的 Web 运行时以这种方式调用 JS 时（包括 `JsValue` 转换），`nsh` 会对它运行
`wasm-bindgen` CLI，并把胶水代码和 crate 的 JS 放在运行时旁边，开发时和发布的站点都是如此。CLI 的版本就是运行时链接的
`wasm-bindgen` crate 的版本，`nsh` 会指出这个版本：用 `cargo install wasm-bindgen-cli --version <version> --locked` 安装
（`NSH_WASM_BINDGEN` 可以指定 `PATH` 以外的 CLI）。链接了 wasm-bindgen 但不通过它调用 JS 的运行时
（例如经由某个依赖的默认特性）与其他运行时一样构建。

crate 以 `web-sys` 特性列出它用到的 API；固定 `wasm-bindgen` 的版本，可以让它的版本以及 CLI 的版本在每次构建中保持一致：

```toml
[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "=0.2.129"
web-sys = { version = "0.3", features = ["WebSocket", "MessageEvent"] }
futures-channel = "0.3"
```

浏览器的回调（收到消息、页面的定时器）会唤醒应用的任务，任务随即运行：

```rust
#[cfg(target_arch = "wasm32")]
async fn echo(url: &str, text: String) -> Result<String, String> {
    use wasm_bindgen::{JsCast, prelude::*};
    let ws = web_sys::WebSocket::new(url).map_err(|e| format!("{e:?}"))?;
    let (tx, rx) = futures_channel::oneshot::channel();
    let tx = std::cell::RefCell::new(Some(tx));
    let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
        if let (Some(tx), Some(data)) = (tx.borrow_mut().take(), e.data().as_string()) {
            let _ = tx.send(data);
        }
    });
    ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    on_message.forget();
    let open = ws.clone();
    let on_open = Closure::<dyn FnMut()>::new(move || {
        let _ = open.send_with_str(&text);
    });
    ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    on_open.forget();
    rx.await.map_err(|_| "closed".to_owned())
}
```

crate 对浏览器 API 的调用以页面自身的权限运行，正如 crate 的原生代码在其他平台上以应用的权限运行：
`nsh.json` 的能力管理经由引擎的内容（`fetch`、应用的 JS），浏览器的规则（CORS、页面的 Content-Security-Policy）
管理页面发出的每个请求。

## 发布应用

```sh
# Rust 应用，在它的目录里
nsh package --target web                   # .nsh/out/<Name>/：一个静态站点
nsh package --target web --run             # 并在本机提供服务（打开它打印的地址）

# TSX 应用
nsh package App.tsx --target web
nsh package App.tsx --target web --run
```

`nsh package --target web` 写出 `.nsh/out/<Name>/`（用 `--out` 指定其他目录），结构与前端构建产物相同：一个页面，其余文件都以内容命名。

| 文件 | 内容 |
|---|---|
| `index.html` | 应用的页面：以应用名作为标题，带图标、按 `appearance` 设定的颜色、加载指示，以及应用无法加载或启动时的提示 |
| `manifest.webmanifest` | 浏览器安装应用时使用的名称、id、图标和颜色 |
| `nsh.<digest>.js` | DOM 运行时，已压缩（79 KB，brotli 后 22.5 KB） |
| `nsh.<digest>.wasm` | Rust 应用：引擎、组件和你的 crate（整个 Rust gallery 为 3.3 MB，brotli 后 0.75 MB）。TSX 应用：引擎、核心、运行时的模块和不含编译器的 QuickJS（约 3.5 MB，gzip 后 1.2 MB，brotli 后 0.93 MB） |
| `nsh-bindgen.<digest>.js` | 应用的 crate [在 Rust 中调用浏览器 API](#在-rust-中使用浏览器-api) 时所需的 wasm-bindgen 胶水代码，已压缩 |
| `snippets.<digest>/<crate>-<hash>/…` | 胶水代码导入的这些 crate 的 JS（`inline_js`、`module = "/js/…"`），保留 wasm-bindgen 给它们的路径 |
| `app.<digest>.nshc` | TSX 应用本身，构建方式与 `nsh build --release --split` 相同，并编译成 QuickJS 字节码：浏览器里不再编译，启动更快 |
| `harden.<digest>.nshc` | TSX 应用的[沙箱](./sandbox-and-capabilities.md)的加固脚本，同样编译成字节码（1.4 KB） |
| `host.<digest>.js` | 页面的宿主，即 `nsh.json` 的 `web.host`（[宿主的函数](#宿主的函数)） |
| `chunks/<name>.<digest>.nshc` | TSX 应用中 `import()` 加载的代码，同样是字节码，第一次导入时才下载（[拆分 bundle](#拆分-bundle)） |
| `assets/<path>.<digest>.<ext>` | 应用导入的每个资源，用到时才从其 URL 加载（字体在注册它们的代码运行前加载，因为文本要用它们测量：在应用启动前，或随导入它们的分块一起加载） |
| `icons/<size>.<digest>.png` | `nsh.json` 中的图标，尺寸为 32（favicon）、180（`apple-touch-icon`）、192 和 512 像素 |

`<digest>` 是文件内容 SHA-256 的前几位：文件名只在内容变化时才变化，所以新版本只会改动 `index.html` 和真正变化了的文件。所有 URL 都是相对的，站点放在任何主机的任何目录下都能运行（`https://example.com/apps/counter/`）。

### 部署

把目录上传到任意静态托管：CDN 后面的对象存储、Cloudflare Pages、Netlify、GitHub Pages、nginx。遵循两条规则，加载就快，更新也可靠：

| 文件 | `Cache-Control` |
|---|---|
| `index.html`、`manifest.webmanifest` | `no-cache`（每次加载都重新验证，新版本立即生效） |
| 其余所有文件 | `public, max-age=31536000, immutable` |

以 `application/wasm` 类型提供 `.wasm`（浏览器会边下载边编译），并让托管服务或 CDN 压缩文本和 WebAssembly（gzip 或 brotli）。`nsh package --target web --run` 就按这种方式在 `http://127.0.0.1:4173/` 上提供站点。

发布到 Web 的应用与打包的原生应用运行方式相同：以发布模式运行，TSX 应用经过[加固](./sandbox-and-capabilities.md)（没有 `eval`），具有其 `nsh.json` 声明的能力。当能力限制了 `network` 时，页面还会带上 Content-Security-Policy `connect-src`，其中列出声明的主机（以及页面自身的源），由浏览器自己拒绝发往其他主机的请求和重定向。导致应用无法启动的错误会显示在页面上；之后的错误输出到浏览器控制台。

### 用 iframe 嵌入

Web 上没有嵌入 API：用 `<iframe>` 嵌入已发布的应用，它的尺寸就是应用的窗口：

```html
<iframe src="https://apps.example.com/counter/" title="Counter"
        style="width: 390px; height: 844px; border: 0"></iframe>
```

## 在浏览器里开发

```sh
nsh run --target web               # Rust 应用，在它的目录里
nsh run App.tsx --target web       # TSX 应用
```

会启动开发服务器，并打印它的页面地址 `http://127.0.0.1:8790/`，在任意浏览器中打开即可。这个页面和其他开发宿主一样：运行应用的每次构建，在应用上方显示构建错误和运行时错误，并把应用的日志发送到终端。修改 Rust 应用的 crate 会重新构建它的运行时，已打开的页面会自动加载；TSX 的修改则就地应用（热更新）。同一网络中的手机打开 `nsh run` 在其下方打印的地址（`on this network: http://192.168.…:8790/`）即可。只要 Web 运行时存在（发行包中总是存在），`nsh dev` 也会提供同一个页面。

## 构建本站的播放器

```sh
cargo xtask web                       # nsh.wasm、nsh.js、播放器页面，以及 website/demos/*.tsx
cargo xtask web --out target/play     # 输出到其他目录
```

输出目录包含：

| 文件 | 内容 |
|---|---|
| `gallery/nsh.<digest>.wasm` | 已发布应用使用的运行时（约 3.5 MB，gzip 后 1.2 MB，brotli 后 0.93 MB；用 `web` profile 构建），播放器和示例应用共用 |
| `nsh-playground.wasm` | 同上，另含 NSH 的 TSX 编译器，供[在线试用](#在线试用)使用（约 8 MB，gzip 后 2.4 MB） |
| `gallery/nsh.<digest>.js` | DOM 运行时（已压缩）：加载 wasm，应用批次，把输入转成事件 |
| `index.html` | 播放器页面：根据 `#<name>` 运行 `demos/<name>.nshc` |
| `demos/<name>.nshc` | 用 `nsh build --release` 编译的各个演示 |
| `gallery/` | 用 `nsh package --target web` 发布的示例应用 Gallery，显示在[示例应用](/zh-CN/gallery)页面 |

用任意静态服务器托管该目录即可（流式编译需要 `application/wasm` 这个 MIME 类型），然后打开 `index.html#counter`。

## 在线试用

[在线试用](/zh-CN/playground)页面可以在浏览器里编辑并运行应用：页面用 NSH 自己的 JSX 编译器（编进 `nsh-playground.wasm`，不需要 rolldown）编译 TSX，每次停止输入后立即运行。本站每个演示都有「在线编辑」链接；「分享」会把代码直接放进链接里，不经过任何服务器存储。

在线试用的应用只有一个模块：可以导入 NSH 的模块（`nsh` 和 `nsh/*`），但不能导入其他文件或包。`console.log` 的输出和错误显示在手机下方。

编译器也是一个 Rust 函数：`nsh_bundler::compile_module(name, source, ui_sets)`，不开启该 crate 的 `bundle` 特性也能使用。

## 嵌入到页面

Rust 应用以发布后的站点嵌入，放在 [iframe](#用-iframe-嵌入) 里。对 TSX 而言，`nsh.js` 是一个 ES 模块。`createPlayer` 把运行时加载进一个容器，`run` 启动 `nsh build` 写出的应用包：字节码 `bundle.nshc`（以字节传入），或 `bundle.js`（以字符串传入）。`nsh package --target web` 附带的运行时（`nsh.wasm`）不含 JavaScript 编译器，只运行字节码；开发用的运行时（发行包中的 `nsh-dev.wasm`）两者都能运行：

```js
import { createPlayer } from "./nsh.js";

const player = await createPlayer(document.querySelector("#phone"), {
  wasm: "./nsh.wasm",
  assetBase: "./assets/",   // `asset:/…` URI（导入的图片）从这里加载
  // dark: true,            // 强制外观；不设置时跟随系统
  // idiom: "phone",        // 强制 "phone"、"pad" 或 "desktop"；不设置时由指针和尺寸决定
  // history: false,        // 页面和对话框是否作为浏览器历史记录；默认只在应用占据整个页面时开启，iframe 里不开启
});
player.run(await (await fetch("./bundle.nshc")).arrayBuffer());
```

`assets`（从 `asset:/` 路径到 URL 的映射）可代替 `assetBase`，`readAsset(uri)` 返回引擎需要立即读取的资源（字体）的字节，或 `null`，`glue` 是 crate [在 Rust 中调用浏览器 API](#在-rust-中使用浏览器-api) 的运行时的 wasm-bindgen 胶水代码的 URL（`nsh-bindgen.<digest>.js`），播放器会随运行时一起加载它；`player.run(code, { release: true, capabilities })` 以发布模式、在应用声明的能力下运行应用包（默认是开发模式）；运行字节码时，发布模式还要传入加固脚本的字节码（`harden`，即 `harden.<digest>.nshc` 的字节）。`nsh package --target web` 写出的页面都用到了。

`run(code, { chunks, chunkBase })` 还可以指定[拆分 bundle](#拆分-bundle) 的 chunk 所在位置。

页面运行不属于自己的代码时（就像嵌入 NSH 的应用那样），可以给它设置限制：`run(code, { limits: "memory=128MB,call=500ms" })` 设置页面写出的这几项，其余保持[嵌入时的默认值](./sandbox-and-capabilities.md#限制)（`limits: ""`：全部使用默认值）。引擎运行在页面主线程上，所以调用预算也能让页面保持响应。不传 `limits` 时，应用像发布出去的应用一样独立运行。

使用 `nsh-playground.wasm` 时，`player.runSource(tsx, name, options)` 会先编译 TSX，再用 `run` 的选项运行，返回编译错误或 `null`；`player.compile(tsx)` 返回 `{ code }` 或 `{ error }`。官网的 playground 用 `{ limits: "" }` 运行访客写的代码。

容器的尺寸就是应用的窗口（`windowSize()`），调整容器大小会同步调整应用。`player.setDark(true)` 可在运行时切换外观，应用通过 `colorScheme()` 和 `dark:` 类感知到变化。

## 宿主的函数

在 Web 上，页面就是应用的宿主：它应答 [`nsh/host`](../modules/nsh-host.md) 的 `host.call(name, args)`，并发送 `host.on` 监听的事件。`createPlayer` 的 `host` 是一个对象，它的 `call(name, args)` 返回结果或结果的 Promise；抛出异常或 Promise 被拒绝时，应用的调用以错误消息被拒绝。`player.hostEvent(event, payload)` 发送一个带 JSON 数据的事件（数据不是 JSON 时抛出异常）。传入 `host` 后，`host.available()` 为 `true`。

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: {
    async call(name, args) {
      if (name === "user.info") return { name: "Ada" };
      throw new Error(`no host function ${name}`);
    },
  },
});
player.hostEvent("theme", { dark: true });
```

发布的应用从 `nsh.json` 得到宿主：`web.host` 指向应用目录内的一个 JS 模块（路径相对于 `nsh.json`），它导出 `createHost(player)`。`nsh package --target web` 把它以 `host.<digest>.js` 复制进站点，页面在应用启动前用播放器调用 `createHost`；它返回（或 resolve）的对象就是播放器的 `host`，必须带 `call` 函数，否则页面显示应用无法加载。`createHost` 拿到的播放器从此可以发送事件：

```json
{
  "capabilities": {
    "host": ["user.*"]
  },
  "web": { "host": "./host.js", "connect": ["api.example.com"] }
}
```

```js
// host.js
const post = (url) => (args) =>
  fetch(url, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());

// 应用可以调用的函数，按完整名字登记。
const functions = new Map([
  ["user.info", post("https://api.example.com/user/info")],
  ["user.settings", post("https://api.example.com/user/settings")],
]);

export async function createHost(player) {
  addEventListener("online", () => player.hostEvent("online", {}));
  return {
    call(name, args) {
      const f = functions.get(name);
      if (!f) throw new Error(`no host function ${name}`);
      return f(args);
    },
  };
}
```

宿主按原样的名字在自己的函数表里查找（如上），URL 和路径由宿主自己决定：`capabilities.host` 按名字开头授权（`user.*`），宿主若把名字拼成路径，就可能访问到授权之外的地址。运行时只放行由 `A`–`Z`、`a`–`z`、`0`–`9`、`_`、`.`、`:`、`-` 组成、长度 1 到 128 且不含 `..` 的名字，其他名字的调用直接 reject。前缀授权以分隔符结尾（`bridge.*`）：`bridge*` 也会匹配 `bridgeAdmin`。

应用运行之前发送的事件（比如 `createHost` 里发送的）会在应用启动后立即按顺序送达，应用顶层注册的 `host.on` 监听器能收到它们。监听器注册之前发送的事件不会补发给它：应用通过调用（`host.call("user.info")`）读取启动时的状态，再通过事件跟进变化。

宿主模块运行在应用的页面里，与应用共用页面的 Content-Security-Policy：应用的能力限制了 `network` 时，页面的 `connect-src` 包含页面自身的源、`capabilities.network` 列出的主机和 `web.connect` 列出的主机。`web.connect` 列出宿主模块自己的请求（`fetch`、`XMLHttpRequest`、`WebSocket`）访问的主机，写法与 `capabilities.network.hosts` 的模式相同（`api.example.com`、`*.example.com`、`"*"`），如上面的 `api.example.com`；应用自己的请求仍按它的 `capabilities` 检查。

模块按原样复制，所以它通过绝对 URL 导入其他代码。应用调用的每个函数仍需在 `host` [能力](./sandbox-and-capabilities.md)中声明。`nsh run --target web` 在开发页面上运行它，`nsh test` 会为测试打开的每个应用运行同一个模块，无界面运行或在浏览器中（`--target web`）都一样，从而一起测试应用和它的宿主（[测试](./testing-and-trace.md#页面的宿主)）。

## 浏览器作为平台

`platform.os` 为 `"web"`。浏览器所在设备的类型决定应用的行为，即 `platform.idiom`：

- `"desktop"`：有鼠标（能悬停的精确指针），且容器宽度至少 600 点。此时 `platform.select` 选 `desktop`，`desktop={{…}}` 属性生效。
- `"pad"`：短边至少 600 点的触摸屏；其余为 `"phone"`。两者都属于移动端：`platform.select` 选 `mobile`。

界面风格在应用启动时确定，运行期间不变，与其他平台一致；变窄的桌面窗口仍是桌面，按自己的 `windowSize()` 布局。`web={{…}}` 属性、`platform.select({ web })` 和 `web:` 类只在浏览器中生效；`ios={{…}}`、`native` 和 `ios:` 在浏览器中不生效。

环境的其余部分由页面报告，并随时更新：

| 值 | 来自浏览器的 |
|---|---|
| 区域设置（`Intl` 的默认值） | `navigator.languages[0]` |
| 时区（`Date` 的本地时间、`Intl` 默认的 `timeZone`） | 浏览器的时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`），包括夏令时 |
| 布局方向（`rtl:` / `ltr:`） | 设置了 `<html dir>` 时取它，否则取区域设置的书写方向 |
| `reduceMotion()` | `prefers-reduced-motion` |
| `fontScale()` | 根元素字号 / 16 px（浏览器的文字大小设置） |
| `pixelRatio()` | `devicePixelRatio`（随缩放和屏幕变化） |
| `colorScheme()` | `prefers-color-scheme` |
| `safeArea()` | 与容器重叠部分的 `env(safe-area-inset-*)`（手机上 `viewport-fit=cover` 的页面） |
| `keyboardFrame()` | 屏幕键盘遮住容器的高度（`visualViewport`） |

`platform.version` 为 `"0.0"`，`screenReaderEnabled()` 始终为 `false`（浏览器不提供这一信息）。页面周围的栏属于浏览器；页面的 [`statusBar`](../modules/nsh-base.md#status-bar) 用于手机。

## 网络

`fetch`（包括流、`AbortController` 和 `FormData`）以及 `<Image>` 的 URL 都走浏览器自己的网络栈，在此之前 NSH 已按应用的[能力声明](./sandbox-and-capabilities.md)做过检查。请求是浏览器发出的，所以遵循浏览器的规则：

- **相对 URL** 与浏览器里一样，相对于页面的 URL 解析：发布出去的应用用 `fetch("/api/items")` 就能访问自己的接口，`<Image src="/photos/a.jpg" />` 从自己的服务器加载。（原生平台没有页面，仍需使用绝对 URL。）
- **CORS。** 发往页面所在源以外的请求，只有对方服务器允许页面的源（`Access-Control-Allow-Origin`）才会成功，否则 `fetch` 以网络错误拒绝。只能读到服务器公开的响应头。
- **Cookie**（以及 HTTP 认证信息）只发送给页面自己的源（`credentials: "same-origin"`），浏览器禁止的请求头（`Cookie`、`User-Agent`、`Host` 等）会被丢弃。
- **重定向**由浏览器跟随。不应跟随重定向的请求遇到重定向时会失败：`redirect: "manual"` 和 `"error"`，以及能力声明限制了 `network` 的应用发出的请求（NSH 要逐跳检查，而浏览器在跟随之前不会透露重定向的目标）。
- 作为 `ReadableStream` 的**请求体**会先收齐再一次发出；响应体则随到随读，以流的形式交给应用。

## 拆分 bundle

TSX Web 应用不必在第一个界面出现之前下载全部代码（Rust 应用是一个 `nsh.wasm`，浏览器边下载边编译）。`nsh package --target web` 以拆分方式发布 TSX 应用：每个 chunk 写成 `chunks/<name>.<digest>.nshc`，由页面把 chunk 映射到这些文件（以字节码运行的应用包，其 chunk 也以字节码加载：`Screen.js` 旁边的 `Screen.nshc`）。要自己拆分 bundle，可以用 `nsh build --split`，它把 `import()` 加载的模块放进各自的 chunk，放在 `bundle.js` 旁边：

```sh
nsh build --release --split -o site/app
# bundle.js        应用到第一个界面为止的代码
# Screen.js        import("./Screen") 以及只有它用到的代码
# detail.js        两个 chunk 共用的代码（如果有，由打包器生成）
```

第一次 `import("./Screen")` 会一次性下载 `Screen.js` 和它导入的 chunk，然后执行它们；之后再导入会立即兑现。页面负责告诉运行时 chunk 在哪里：默认在页面旁边（`chunkBase`），也可以为每个 chunk 指定一个 URL，例如带内容摘要的文件名，便于 CDN 永久缓存：

```js
player.run(code, {
  chunks: { "Screen.js": "/app.3f2a9c.js", "detail.js": "/app.81bb07.js" },
});
```

无法下载的 chunk 会让 `import()` 以一个指明该 chunk 的 `TypeError` 拒绝；下一次 `import()` 会重新尝试。chunk 名称是 bundle 中固定的文件名：应用无法让页面下载其他任何东西。

[示例应用](/zh-CN/gallery)就是这样加载每个演示的：`lazy`（位于 `examples/gallery/ui.tsx`）生成一个组件，它在第一次渲染时开始导入，导入完成前显示占位内容，之后渲染导入的组件。首次加载只有索引和最先显示的演示；演示导入的字体随该演示的 chunk 一起加载。原生构建包含所有模块，因此导入会立即完成：

```tsx
const Stocks = lazy(() => import("./demos/Stocks").then((m) => m.Stocks));
```

## 限制

下列内容由浏览器决定，Web 后端遵循它：

- **其他网站的 Web 视图**：`WebView` 是一个 `<iframe>`。内联 HTML（`html`）功能完整：`onMessage`、`postMessage`、`injectJavaScript`、注入脚本和加载事件都可用（它在独立的源中运行，与所在页面隔离）。其他网站的页面只有 `postMessage` 和加载事件，事件中的 URL 是传入的那个：浏览器不向外层页面透露它的导航、标题、历史和错误，`userAgent` 也无法设置。
- **自动播放的有声视频**：`Video` 是一个 `<video>`，支持全部属性和事件，但浏览器只在用户操作之后才允许有声视频开始播放（静音视频可以自动播放）。
- **原生组件**：注册的原生组件属于嵌入 NSH 的原生应用；在 Web 上它的视图保持为空，并在控制台给出警告。
- **平台服务**：读取剪贴板（`Clipboard.readText`，`hasText` 也一样）需要安全上下文（HTTPS），并可能询问用户。图片不报告 `onProgress`。
- **文本整形细节**：换行规则只是 UAX #14 的一个子集（空格、CJK、连字符，以及 CJK 标点的避头尾规则：`。`、`，`、`」` 这类收尾标点不放在行首，`（`、`「` 这类开头标点不放在行尾），没有自动断词，除段落方向外也不做双向重排。

播放器和开发服务器以开发模式运行应用（不做加固），发布的应用经过加固。两者都使用默认的[资源限制](./sandbox-and-capabilities.md)。

## 另请参阅

- [打包](./packaging.md)：`nsh package` 的其他目标。
- [架构](./architecture.md)：Web 版复用的引擎、核心和挂载批次。
- [测试](./testing-and-trace.md)：`nsh test` 以近似的文本引擎无界面地运行同一个引擎。
