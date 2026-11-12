---
title: 网页视图与视频
description: 用 WebView 显示网页、用 Video 播放视频：来源、页面与应用之间的消息、导航、播放控制、ref 以及能力声明。
order: 45
group: ui
---

# 网页视图与视频

Web 视图和视频播放器把平台自己的网页引擎和媒体播放器作为普通视图嵌入：Rust 中是 `web_view` 和 `video`（`nsh_core::prelude`），TSX 中是 `nsh` 的 `WebView` 和 `Video`。由于 NSH 用原生视图渲染，它们在布局中与其他元素无异：随父视图滚动、支持圆角和裁剪，其他视图可以覆盖在它们上面而不会出现层级问题。

| 组件 | iOS | Android | macOS | Linux | Windows |
|---|---|---|---|---|---|
| `WebView` | WKWebView | `android.webkit.WebView` | WKWebView | WebKitGTK 6.0 的 `WebKitWebView` | WebView2，位于子窗口中 |
| `Video` | AVPlayerLayer；设置 `controls` 时为 AVPlayerViewController | TextureView 上的 MediaPlayer；设置 `controls` 时为 MediaController | AVPlayerLayer；设置 `controls` 时为 AVKit 的 AVPlayerView | `GtkPicture` 中的 GTK 媒体流（GStreamer）；设置 `controls` 时为 `GtkVideo` | Media Foundation 媒体引擎，画面用 Direct2D 绘制；设置 `controls` 时为 NSH 自己的控制栏 |

它们背后的框架（WebKit、AVFoundation）在应用第一次用到时才加载，所以从不显示网页或视频的应用不会在启动时为它们付出代价。

在 [macOS](./macos.md) 上，Web 视图没有自己的滚动视图：`scrollable={false}` 时，鼠标滚轮和触控板滚动的是它外面的应用滚动视图，
而不是页面；页面仍可用键盘和它自己的脚本滚动。

在 [Linux](./linux.md) 上，Web 视图是绘制在它的视图之内的 WebKitGTK 页面：绘制在它上方的 NSH 内容（对话框、sheet）会遮住它，父视图会裁剪它。
那里的 `webview` 权限同样作用于框架的导航（未获授权的主机的 `iframe` 保持空白），`scrollable: false` 让页面本身不滚动（页面中的元素仍可滚动）。
应用需要装有 WebKitGTK 6.0；不带它构建的运行时显示中性的占位视图。视频能播放哪些格式取决于已安装的
GStreamer 插件；不支持 `rate`（始终以 1× 播放），`onEnd` 只对不循环的视频触发。

在 [Windows](./windows.md) 上，Web 视图是位于子窗口中的 WebView2 控件，跟随它的视图移动：它会被父视图和圆角裁剪，但绘制在它上方的
NSH 内容（对话框、sheet）会被它遮住。它需要 WebView2 Runtime（Windows 11 自带，Windows 10 上随 Edge 安装），否则显示占位视图；
不支持 HTML 的 `baseUrl`、`scrollable` 和 `allowsBackForwardNavigationGestures`。视频是普通内容（像其他视图一样被裁剪、
变换和遮挡），能播放哪些格式取决于已安装的 Media Foundation 解码器；`rate` 可用，没有封面图（poster），开启 `controls` 时控制栏始终显示。

## WebView

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    web_view("https://en.m.wikipedia.org/wiki/Swift_(programming_language)").flex_1()
}
```

```tsx tabs
import { mount, WebView } from "nsh";

function App() {
  return <WebView src="https://en.m.wikipedia.org/wiki/Swift_(programming_language)" style={{ flex: 1 }} />;
}

mount(App);
```

### 来源

网页视图显示 `src` 和 `html` 二者之一：

| 属性 | 显示内容 |
|---|---|
| `src="https://…"` | 一个网页。 |
| `html="<!doctype html>…"` | 字符串形式的 HTML，代替 `src` 显示。 |
| `html` 加上 `baseUrl="https://example.com/"` | 相对 URL 以 `baseUrl` 为基准解析的 HTML。 |

在 Rust 中，`web_view(url)` 显示网页，`web_view_html(html, base_url)` 显示 HTML（`base_url` 是 `Option<&str>`）；URL 和 HTML 都可以是 signal 或闭包，它读取的值变化时页面会重新加载。改变 `src` 或 `html` 会加载新的页面。

### 属性

在 Rust 中，每个属性是一个蛇形命名的构建方法（`injected_java_script`、`java_script_enabled`、`scrollable`、`user_agent`、`incognito`；`injectedJavaScriptBeforeContentLoaded` 对应 `injected_java_script_before_content`，iOS 的 `allowsBackForwardNavigationGestures` 对应 `back_forward_gestures`），每个事件是一个 `on_…` 方法（`on_navigation_state_change`），其监听函数收到 `WebNavigation`（`url`、`title`、`loading`、`can_go_back`、`can_go_forward`），`on_error` 和 `on_message` 收到 `&str`。Rust 还可以用 `url_scheme` 向页面提供应用自己的资源（[见下文](#应用提供的资源)）。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `src` | `string` | | 要显示的页面的 URL。 |
| `html` | `string` | | 内联 HTML，代替 `src` 显示。 |
| `baseUrl` | `string` | | `html` 中相对 URL 的解析基准。它需要与该地址的页面相同的授权（`webview.hosts`）；未授权时 HTML 不带基准 URL 加载，`onError` 报告 `ERR_ACCESS_DENIED`。 |
| `injectedJavaScript` | `string` | | 每个页面加载完成后运行。 |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | 在每个页面自己的脚本之前运行。 |
| `javaScriptEnabled` | `boolean` | `true` | 页面可以运行脚本。 |
| `scrollable` | `boolean` | `true` | 用户可以滚动页面。 |
| `userAgent` | `string` | | 浏览器的 user agent 字符串。 |
| `incognito` | `boolean` | `false` | 页面的网站数据只与网页视图同存亡，各平台的做法见[下文](#网站数据)。在网页视图创建时读取。 |
| `ios={{ allowsBackForwardNavigationGestures }}` | `boolean` | | iOS：滑动在页面历史中前进后退。 |
| `desktop={{ allowsBackForwardNavigationGestures }}` | `boolean` | | macOS：双指在触控板上轻扫，在页面历史中前进后退；Windows：在触摸屏上轻扫；Linux：在触控板上轻扫。 |

事件：

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `onLoadStart` | `WebViewNavigation` | 页面开始加载。 |
| `onLoad` | `WebViewNavigation` | 页面加载完成。 |
| `onError` | `{ message, code? }` | 加载失败、平台无法显示网页视图（`code` 为 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`），或页面的进程结束（`code` 为 `"ERR_NSH_WEBVIEW_TERMINATED"`）；均见下文。 |
| `onNavigationStateChange` | `WebViewNavigation` | URL、标题、加载状态或历史改变。 |
| `onMessage` | `{ data: string }` | 页面发来消息（见下文）。 |

`WebViewNavigation` 为 `{ url, title, loading, canGoBack, canGoForward }`。

### 带前进后退的浏览器

Web 视图的 ref（Rust 中用 `.element_ref(&web)` 挂上的 `element_ref()`，TSX 中的 `ref`）提供 `reload`、`go_back` / `goBack`、`go_forward` / `goForward`、`stop_loading` / `stopLoading`、`inject_java_script` / `injectJavaScript(script)`、`post_message` / `postMessage(data)`、`load` / `load({ src, headers })`（见[下文](#已登录的页面请求头)）和 `send_input` / `sendInput(input)`（见[下文](#像用户一样输入)）：

```rust tabs
use nsh_core::prelude::*;

pub fn browser() -> impl IntoElement {
    let web = element_ref();
    let nav = signal(None::<WebNavigation>);
    let button = move |label: &'static str, enabled: fn(&WebNavigation) -> bool, action: fn(&ElementRef)| {
        let enabled = move || nav.with(|n| n.as_ref().is_some_and(enabled));
        text(label)
            .p(px(12.0))
            .text_color(move || if enabled() { rgb(0x0969da) } else { rgb(0x8c959f) })
            .disabled(move || !enabled())
            .on_press(move || action(&web))
    };
    view()
        .flex_1()
        .pt(px(50.0))
        .child(
            text(move || {
                nav.with(|n| match n {
                    Some(n) if n.loading => "Loading…".to_owned(),
                    Some(n) => n.title.clone(),
                    None => String::new(),
                })
            })
            .number_of_lines(1)
            .px(px(12.0))
            .text_color(rgb(0x57606a)),
        )
        .child(
            web_view("https://developer.mozilla.org/")
                .element_ref(&web)
                .flex_1()
                .on_navigation_state_change(move |n: &WebNavigation| nav.set(Some(n.clone())))
                .back_forward_gestures(true),
        )
        .child(
            view()
                .flex_row()
                .justify_around()
                .child(button("Back", |n| n.can_go_back, |web| web.go_back()))
                .child(button("Forward", |n| n.can_go_forward, |web| web.go_forward()))
                .child(button("Reload", |_| true, |web| web.reload())),
        )
}
```

```tsx tabs
import { mount, signal, Text, View, WebView, type WebViewNavigation, type WebViewRef } from "nsh";

function Browser() {
  let web!: WebViewRef;
  const nav = signal<WebViewNavigation | null>(null);
  const button = (label: string, enabled: boolean, action: () => void) => (
    <Text onPress={enabled ? action : undefined} style={{ padding: 12, color: enabled ? "#0969da" : "#8c959f" }}>
      {label}
    </Text>
  );
  return (
    <View style={{ flex: 1, paddingTop: 50 }}>
      <Text style={{ numberOfLines: 1, paddingHorizontal: 12, color: "#57606a" }}>
        {nav()?.loading ? "Loading…" : nav()?.title ?? ""}
      </Text>
      <WebView
        ref={web}
        src="https://developer.mozilla.org/"
        style={{ flex: 1 }}
        onNavigationStateChange={(n) => nav.set(n)}
        ios={{ allowsBackForwardNavigationGestures: true }}
      />
      <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
        {button("Back", !!nav()?.canGoBack, () => web.goBack())}
        {button("Forward", !!nav()?.canGoForward, () => web.goForward())}
        {button("Reload", true, () => web.reload())}
      </View>
    </View>
  );
}

mount(Browser);
```

### 页面与应用之间的消息

页面通过 `window.nsh.postMessage(string)` 向应用发消息，应用收到 `on_message`（`onMessage`）。应用通过 ref 的 `post_message`（`postMessage(string)`）向页面发消息，页面在 `window` 上收到 `message` 事件。消息是字符串；结构化数据请发送 JSON。收到的消息要当作不可信的数据，检查后再处理：页面运行的任何脚本都能发消息，而在 Android 上，页面的每个 frame（包括 `iframe`）都有 `window.nsh`。

```rust tabs
use nsh_core::prelude::*;

const PAGE: &str = r#"<!doctype html>
<html><head><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, sans-serif; margin: 16px">
  <button onclick="window.nsh.postMessage(JSON.stringify({ type: 'hello', at: Date.now() }))">
    Post to the app
  </button>
  <p id="got">Nothing from the app yet.</p>
  <script>
    window.addEventListener("message", (e) => {
      document.getElementById("got").textContent = "The app says: " + e.data;
    });
  </script>
</body></html>"#;

#[component]
pub fn App() -> impl IntoElement {
    let web = element_ref();
    let last = signal(String::new());
    view()
        .flex_1()
        .pt(px(50.0))
        .gap(px(12.0))
        .child(
            web_view_html(PAGE, None)
                .element_ref(&web)
                .h(px(240.0))
                .on_message(move |data: &str| {
                    let message: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
                    last.set(message["type"].as_str().unwrap_or_default().to_owned());
                }),
        )
        .child(
            text("Post to the page")
                .p(px(16.0))
                .text_color(rgb(0x0969da))
                .on_press(move || web.post_message("hi from nsh")),
        )
        .child(text(move || format!("Last message: {}", last.get())).px(px(16.0)))
}
```

```tsx tabs
import { mount, signal, Text, View, WebView, type WebViewRef } from "nsh";

const page = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, sans-serif; margin: 16px">
  <button onclick="window.nsh.postMessage(JSON.stringify({ type: 'hello', at: Date.now() }))">
    Post to the app
  </button>
  <p id="got">Nothing from the app yet.</p>
  <script>
    window.addEventListener("message", (e) => {
      document.getElementById("got").textContent = "The app says: " + e.data;
    });
  </script>
</body></html>`;

function App() {
  let web!: WebViewRef;
  const last = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 50, gap: 12 }}>
      <WebView
        ref={web}
        html={page}
        style={{ height: 240 }}
        onMessage={(e) => last.set(JSON.parse(e.data).type)}
      />
      <Text onPress={() => web.postMessage("hi from nsh")} style={{ padding: 16, color: "#0969da" }}>
        Post to the page
      </Text>
      <Text style={{ paddingHorizontal: 16 }}>Last message: {last()}</Text>
    </View>
  );
}

mount(App);
```

ref 的 `inject_java_script`（`injectJavaScript(script)`）可以随时在当前页面中运行代码；`injected_java_script` 和 `injected_java_script_before_content`（`injectedJavaScript`、`injectedJavaScriptBeforeContentLoaded`）在每次页面加载时运行，分别在页面自己的脚本之后或之前，适合用来安装钩子：

```rust tabs
web_view("https://example.com")
    .injected_java_script_before_content("window.isNativeApp = true;")
    .injected_java_script("window.nsh.postMessage(document.title);")
    .on_message(|title: &str| log::info!("title {title}"))
```

```tsx tabs
<WebView
  src="https://example.com"
  injectedJavaScriptBeforeContentLoaded={`window.isNativeApp = true;`}
  injectedJavaScript={`window.nsh.postMessage(document.title);`}
  onMessage={(e) => console.log("title", e.data)}
/>
```

### 应用提供的资源

页面可以从应用自己的 URL scheme 加载应用持有的字节（内存或磁盘中的图片、邮件的附件）。`url_scheme` 指定 scheme
和应答其请求的 Rust 函数；页面像引用其他 URL 一样引用它的 URL（`<img src="app-image:42">`、
`fetch("app-image:42")`），网页引擎像加载任何子资源一样加载它们：字节原样传给页面，不经过页面的脚本。几十 MB
的图片也能以读文件的速度加载。

```rust
use nsh_core::{
    prelude::*,
    web_resource::{WebResource, WebResourceRequest},
};

fn serve(request: WebResourceRequest) {
    // 在主线程上调用：把耗时的工作交给线程，并在那里应答。
    std::thread::spawn(move || match std::fs::read(path_for(request.url())) {
        Ok(bytes) if !request.is_cancelled() => request.respond(WebResource::new("image/png", bytes)),
        _ => request.fail(),
    });
}

web_view_html(html, None).url_scheme("app-image", serve).flex_1()
```

处理函数在平台的主线程上运行，因此应立即返回；请求只应答一次，可以当场或稍后、在任何线程上应答：`respond`
（字节和 MIME 类型）或 `fail`（图片的 `error` 事件、被拒绝的 `fetch`）。未应答就被丢弃的请求视为失败。页面不再需要
它时（页面已跳转、网页视图已移除），`is_cancelled()` 变为 true，之后的应答会被丢弃。应答带有
`Access-Control-Allow-Origin: *`，所以无论页面的来源是什么，页面的脚本都能 `fetch` 它们；Content-Security-Policy
像其他来源一样写出 scheme 即可（`img-src app-image:`）。

scheme 以字母开头，后接字母、数字、`+`、`-` 或 `.`，且不能是 Web 或系统的 scheme（`http`、`https`、`file`、
`data`、`blob`、`about` 等）。多个 scheme 就调用多次。与 `incognito` 一样，scheme 在创建网页视图时读取。iOS、
macOS 和 Linux 提供它们（WebKit 的 `WKURLSchemeHandler` 和 `webkit_web_context_register_uri_scheme`）。

### 已登录的页面：请求头

要显示应用已登录的某个服务的页面，把凭据放在页面请求的请求头里，而不是 URL 里：URL 会留在历史记录、日志和 `Referer` 中。ref 的 `load` 加载一个页面，并只给这一个请求带上请求头：

```rust tabs
use nsh_core::{WebLoad, prelude::*};

fn open(web: &ElementRef, token: &str) {
    let headers = vec![("Authorization".to_owned(), format!("Bearer {token}"))];
    if let Some(load) = WebLoad::new("https://docs.example.com/", headers) {
        web.load(load);
    }
}
```

```tsx tabs
web.load({ src: "https://docs.example.com/", headers: { Authorization: `Bearer ${token}` } });
```

- 只有页面自身的请求带这些请求头：它的图片、脚本等子资源不带，之后的导航和 `reload()` 也不带，所以凭据不会发给页面用到的其他主机。页面再次需要它时（点链接、重新加载），用 `load` 再加载一次，并为那次请求生成新值（DPoP proof 与 URL 绑定）。
- 之后页面的显示与 `src` 加载的一样；之后 `src` 属性一变，就改为加载那个页面。
- 它的主机必须是 `webview.hosts` 允许的（[`webview`](./sandbox-and-capabilities.md#webview)），与 `src` 相同；否则什么也不加载，核心会在日志里说明要添加哪个主机。
- 请求头的名字不是 HTTP token、或值里有换行时，抛出 `TypeError`（`WebLoad::new` 返回 `None`），一个请求头不能借此开始另一个。NSH 的日志只写请求头的名字，从不写值。
- macOS、iOS、Mac Catalyst、Android、Windows、Linux 和 GPUI 后端会发送这些请求头；浏览器后端做不到（iframe 无法设置请求头），调用不做任何事。

### 像用户一样输入

`injectJavaScript` 只能产生合成事件，页面会把它们视为不可信（`event.isTrusted` 为 `false`），有些控件会忽略它们。ref 的 `send_input`（`sendInput(input)`）以用户亲手操作的方式把输入交给页面，因此页面收到的事件是可信的：

- `{ type: "click", x, y }` 点击视口中的一个点，单位为 CSS 像素（即 `getBoundingClientRect()` 报告的值）。
- `{ type: "text", text }` 把文本逐键输入到页面中当前有焦点的元素：每个字符用 US 布局上对应的键，换行按 Enter，US 键盘打不出的字符（`é`、中日韩文字、emoji）不对应任何键（`code` 为 `"Unidentified"`）。
- `{ type: "key", key }` 按下 `Enter`、`Tab`、`Escape` 或 `Backspace`。

```rust tabs
use nsh_core::{WebInput, WebKey, prelude::*};
use std::time::Duration;

fn search(web: &ElementRef) {
    web.send_input(WebInput::Click { x: px(120.0), y: px(40.0) });
    let web = *web;
    set_timeout(Duration::from_millis(50), move || {
        web.send_input(WebInput::Text("espresso".into()));
        web.send_input(WebInput::Key(WebKey::Enter));
    });
}
```

```tsx tabs
web.sendInput({ type: "click", x: 120, y: 40 });
setTimeout(() => {
  web.sendInput({ type: "text", text: "espresso" });
  web.sendInput({ type: "key", key: "Enter" });
}, 50);
```

在 Rust 中它们是 `WebInput::Click { x, y }`、`WebInput::Text(text)` 和 `WebInput::Key(WebKey::Enter)`。

可信输入带有用户激活（它可以打开窗口、写入剪贴板、打开系统的文件面板，或按下页面的确认按钮），所以它是一项单独的能力：应用需要在 `nsh.json` 的 `capabilities` 中声明 `"webview": { "input": true }`（见 [`webview`](./sandbox-and-capabilities.md#webview)），没有声明任何能力的应用也一样，否则核心会丢弃这次调用。

和点击一样，`sendInput` 会把键盘焦点交给网页视图，应用自己的 `Input` 随之失去焦点。页面按自己的节奏处理输入：点击的事件在下一次调用开始时可能仍在途中，所以点击后先等它生效（大约一帧）再输入。目前由 macOS 投递这些输入，其他平台暂时忽略。

在提供依赖它的功能之前，先确认它在当前环境下可用：`web_input_available()`（`WebView.inputAvailable()`）只有在平台会投递输入、并且应用拥有 `webview.input` 授权时才得到 `true`；在忽略这个调用的平台上，或者应用没有这项授权时，结果都是 `false`。

```rust tabs
use nsh_core::prelude::*;

let input = signal(false);
spawn(async move { input.set(web_input_available().await) });
```

```tsx tabs
import { signal, WebView } from "nsh";

const input = signal(false);
WebView.inputAvailable().then((available) => input.set(available));
```

### 网站数据

网页视图把页面的网站数据（cookie、local storage、IndexedDB、缓存）和应用的放在一起，所以在一个网页视图里登录，下一个网页视图里、
应用重启后也还是登录状态。显示应用不信任的页面（别人生成的 HTML、一次性的登录页）的网页视图加上 `incognito`：它的页面使用一份
自己的存储，只在内存里，随网页视图一起销毁。

```rust tabs
web_view("https://example.com/preview").incognito(true).flex_1()
```

```tsx tabs
<WebView src="https://example.com/preview" incognito style={{ flex: 1 }} />
```

`incognito` 在网页视图创建时读取，所以在 Rust 里它接收一个值；在 TSX 里之后再改它，网页视图保留原来的存储并打印一条警告。
要切换，就显示一个新的网页视图。各平台这样保存它的存储：

| 平台 | incognito 网页视图的存储 |
|---|---|
| iOS、macOS | 自己的一份非持久 `WKWebsiteDataStore`。 |
| Linux | 自己的一份临时 WebKit 网络会话。 |
| Windows | InPrivate 模式的 WebView2 控制器。同时打开的 incognito 网页视图共用一份内存中的存储，最后一个关闭时清空。 |
| Android | cookie 和网页存储属于整个应用，所有网页视图共用，网页视图关闭后仍然保留。incognito 网页视图加载时不使用 HTTP 缓存，也不保存表单数据。 |
| Web | 浏览器为页面所在源保存的存储，和任何 `iframe` 一样。 |

### 网页视图可以显示哪些网站

如果 `nsh.json` 声明了 `"capabilities"`，网页视图只能显示并导航到 `webview` 下列出的主机：

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

检查覆盖网页视图的 `src` 以及页面发起的每一次顶层导航（链接、重定向、修改 `location`）；它在平台询问能否继续导航时由原生决定。页面自己的子资源（脚本、图片、iframe）属于网页内容自身的事情，不做检查。`*.example.com` 只匹配子域名；要包括裸域名，还需列出 `example.com`。没有 `"capabilities"` 键的应用可以显示任何页面。见[沙箱与能力声明](./sandbox-and-capabilities.md)。

### 没有网页引擎时

网页视图依赖平台的网页引擎，而有些环境里没有：未带 WebKitGTK 构建的 Linux 运行时、没有安装 WebView2 Runtime 的 Windows、没有启用系统 WebView 的 Android 设备。这时网页视图显示占位内容，应用可以立刻改为显示别的东西（代码块、链接、文件卡片）。

可以先用 `web_view_available()`（`WebView.available()`）询问：平台在启动时就知道自己无法显示网页视图时，或应用的能力未授予 `webview` 时，它得到 `false`。

```rust tabs
use nsh_core::prelude::*;

let web = signal(true);
spawn(async move { web.set(web_view_available().await) });
```

```tsx tabs
import { signal, WebView } from "nsh";

const web = signal(true);
WebView.available().then((available) => web.set(available));
```

有些引擎要到网页视图启动时才会失败（Windows 上的 WebView2），所以网页视图自己也会报告：平台一旦知道，就触发 `onError`，其 `code` 为 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`。

```tsx
import { signal, Text, WebView } from "nsh";

function Preview(props: { url: string }) {
  const failed = signal(false);
  return (
    <If when={!failed()} else={<Text>{props.url}</Text>}>
      <WebView
        src={props.url}
        onError={(e) => e.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" && failed.set(true)}
        style={{ flex: 1 }}
      />
    </If>
  );
}
```

### 页面的进程结束时

网页视图的页面运行在单独的进程里，这个进程可能在应用运行时结束：它崩溃了，或系统回收了它的内存。应用继续运行，网页视图不再显示页面；它的
`onError` 触发，`code` 为 `"ERR_NSH_WEBVIEW_TERMINATED"`（Rust 中为 `.on_process_terminated`，参数为消息）。ref 的 `reload()`、
`load()` 或新的 `src` / `html` 会重新显示页面（Android 会为此新建一个 WebView）。iOS、macOS、Linux 和 Android 会报告它。

```tsx
import { WebView, type WebViewRef } from "nsh";

function Diagram(props: { html: string }) {
  let web!: WebViewRef;
  return (
    <WebView
      ref={web}
      html={props.html}
      onError={(e) => e.code === "ERR_NSH_WEBVIEW_TERMINATED" && web.reload()}
      style={{ flex: 1 }}
    />
  );
}
```

## Video

```rust tabs
use nsh_core::prelude::*;

pub fn player() -> impl IntoElement {
    let player = element_ref();
    let paused = signal(true);
    let time = signal(String::new());
    let link = |label: &'static str| text(label).text_color(rgb(0x0969da));
    view()
        .flex_1()
        .justify_center()
        .p(px(16.0))
        .gap(px(12.0))
        .child(
            video("https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4")
                .element_ref(&player)
                .paused(paused)
                .repeat(true)
                .object_fit(ResizeMode::Contain)
                .h(px(220.0))
                .rounded(px(12.0))
                .overflow_hidden()
                .bg(rgb(0x000000))
                .on_progress(move |e: &VideoProgress| {
                    time.set(format!("{:.1} / {:.1} s", e.current_time, e.duration))
                })
                .on_end(move || paused.set(true)),
        )
        .child(
            view()
                .flex_row()
                .gap(px(16.0))
                .items_center()
                .child(
                    text(move || if paused.get() { "Play" } else { "Pause" })
                        .text_color(rgb(0x0969da))
                        .font_weight(FontWeight::SEMIBOLD)
                        .on_press(move || paused.update(|p| *p = !*p)),
                )
                .child(link("Restart").on_press(move || player.seek(0.0)))
                .child(text(move || time.get()).text_color(rgb(0x57606a))),
        )
}
```

```tsx tabs
import { mount, signal, Text, Video, type VideoRef, View } from "nsh";

function Player() {
  let video!: VideoRef;
  const paused = signal(true);
  const time = signal("");
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 16, gap: 12 }}>
      <Video
        ref={video}
        src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
        paused={paused()}
        repeat
        style={{ height: 220, borderRadius: 12, overflow: "hidden", backgroundColor: "#000000" }}
        onProgress={(e) => time.set(`${e.currentTime.toFixed(1)} / ${e.duration.toFixed(1)} s`)}
        onEnd={() => paused.set(true)}
      />
      <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
        <Text onPress={() => paused.set(!paused())} style={{ color: "#0969da", fontWeight: "600" }}>
          {paused() ? "Play" : "Pause"}
        </Text>
        <Text onPress={() => video.seek(0)} style={{ color: "#0969da" }}>
          Restart
        </Text>
        <Text style={{ color: "#57606a" }}>{time()}</Text>
      </View>
    </View>
  );
}

mount(Player);
```

播放由属性控制：用 signal 设置 `paused`、`muted`、`volume` 和 `rate`，播放器随之变化。已播放到结尾的视频，取消暂停后从头再播。ref 提供 `seek(seconds)`。

在 Rust 中，`video(url)` 创建播放器（URL 可以是值、signal 或闭包），每个属性是一个蛇形命名的构建方法（`paused`、`repeat(true)`、`object_fit(ResizeMode::Contain)`，`progressUpdateInterval` 对应 `progress_interval`）；`on_load` 收到 `VideoInfo`（`duration`、`size`），`on_progress` 收到 `VideoProgress`（`current_time`、`duration`），`on_buffer` 收到 `bool`。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `src` | `string` | | 视频的 URL。 |
| `paused` | `boolean` | `false` | 暂停播放。 |
| `muted` | `boolean` | `false` | 静音。 |
| `volume` | `number` | `1` | 0..1。 |
| `rate` | `number` | `1` | 播放速度。 |
| `repeat` | `boolean` | `false` | 播放到结尾后从头再播。 |
| `objectFit`（样式）、`object-*` 类 | `"cover" \| "contain" \| "fill" \| "none" \| "scale-down"` | `"contain"` | 画面如何适应视图，与 CSS 的 `object-fit` 相同（`class="object-cover"`）。 |
| `controls` | `boolean` | `false` | 显示平台的播放控件。 |
| `progressUpdateInterval` | `number` | `250` | 两次 `onProgress` 之间的毫秒数。 |

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `onLoadStart` | | 开始加载。 |
| `onLoad` | `{ duration, size }` | 视频就绪：时长（秒）与尺寸。 |
| `onProgress` | `{ currentTime, duration }` | 播放期间，每 `progressUpdateInterval` 毫秒一次。 |
| `onBuffer` | `{ isBuffering }` | 因等待数据而暂停，或恢复播放。 |
| `onEnd` | | 播放到结尾。 |
| `onError` | `{ message }` | 加载或播放失败。 |

设置 `controls` 时，平台会绘制自己的播放按钮、进度条和全屏按钮。不设置时，用视图在视频上方或下方画你自己的控件；由于视频是布局中的原生视图，覆盖层可以自然地叠在上面：

```rust tabs
view()
    .h(px(220.0))
    .child(video(url).paused(paused).flex_1())
    .child(
        view()
            .absolute()
            .inset_0()
            .items_center()
            .justify_center()
            .on_press(move || paused.update(|p| *p = !*p))
            .child(when(move || paused.get(), || {
                text("▶").text_size(px(48.0)).text_color(rgb(0xffffff))
            })),
    )
```

```tsx tabs
<View style={{ height: 220 }}>
  <Video src={url} paused={paused()} style={{ flex: 1 }} />
  <View
    onPress={() => paused.set(!paused())}
    style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}
  >
    <If when={paused()}>
      <Text style={{ fontSize: 48, color: "#ffffff" }}>▶</Text>
    </If>
  </View>
</View>
```

视频来源是网络请求：声明了能力时，视频所在的主机必须在 `nsh.json` 的 `network` 下得到允许，与 `fetch` 和远程图片相同。被拒绝的来源不显示任何内容，并且会记录一次日志，指出需要添加的键。

## 相关内容

- [`WebView`](../elements/web-view.md) 与 [`Video`](../elements/video.md)：元素参考。
- [沙箱与能力声明](./sandbox-and-capabilities.md)：`webview` 与 `network` 授权。
- [原生组件](./native-components.md)：嵌入宿主应用提供的其他原生视图。
