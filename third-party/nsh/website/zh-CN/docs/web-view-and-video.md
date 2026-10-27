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

在 Rust 中，每个属性是一个蛇形命名的构建方法（`injected_java_script`、`java_script_enabled`、`scrollable`、`user_agent`；`injectedJavaScriptBeforeContentLoaded` 对应 `injected_java_script_before_content`，iOS 的 `allowsBackForwardNavigationGestures` 对应 `back_forward_gestures`），每个事件是一个 `on_…` 方法（`on_navigation_state_change`），其监听函数收到 `WebNavigation`（`url`、`title`、`loading`、`can_go_back`、`can_go_forward`），`on_error` 和 `on_message` 收到 `&str`。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `src` | `string` | | 要显示的页面的 URL。 |
| `html` | `string` | | 内联 HTML，代替 `src` 显示。 |
| `baseUrl` | `string` | | `html` 中相对 URL 的解析基准。 |
| `injectedJavaScript` | `string` | | 每个页面加载完成后运行。 |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | 在每个页面自己的脚本之前运行。 |
| `javaScriptEnabled` | `boolean` | `true` | 页面可以运行脚本。 |
| `scrollable` | `boolean` | `true` | 用户可以滚动页面。 |
| `userAgent` | `string` | | 浏览器的 user agent 字符串。 |
| `ios={{ allowsBackForwardNavigationGestures }}` | `boolean` | | iOS：滑动在页面历史中前进后退。 |
| `desktop={{ allowsBackForwardNavigationGestures }}` | `boolean` | | macOS：双指在触控板上轻扫，在页面历史中前进后退；Windows：在触摸屏上轻扫；Linux：在触控板上轻扫。 |

事件：

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `onLoadStart` | `WebViewNavigation` | 页面开始加载。 |
| `onLoad` | `WebViewNavigation` | 页面加载完成。 |
| `onError` | `{ message }` | 加载失败。 |
| `onNavigationStateChange` | `WebViewNavigation` | URL、标题、加载状态或历史改变。 |
| `onMessage` | `{ data: string }` | 页面发来消息（见下文）。 |

`WebViewNavigation` 为 `{ url, title, loading, canGoBack, canGoForward }`。

### 带前进后退的浏览器

Web 视图的 ref（Rust 中用 `.element_ref(&web)` 挂上的 `element_ref()`，TSX 中的 `ref`）提供 `reload`、`go_back` / `goBack`、`go_forward` / `goForward`、`stop_loading` / `stopLoading`、`inject_java_script` / `injectJavaScript(script)` 和 `post_message` / `postMessage(data)`：

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
import { mount, signal, Text, View, WebView, type WebViewNavigation, type YNode } from "nsh";

function Browser() {
  let web!: YNode;
  const nav = signal<WebViewNavigation | null>(null);
  const button = (label: string, enabled: boolean, action: () => void) => (
    <Text onPress={enabled ? action : undefined} style={{ padding: 12, color: enabled ? "#0969da" : "#8c959f" }}>
      {label}
    </Text>
  );
  return (
    <View style={{ flex: 1, paddingTop: 50 }}>
      <Text numberOfLines={1} style={{ paddingHorizontal: 12, color: "#57606a" }}>
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

页面通过 `window.nsh.postMessage(string)` 向应用发消息，应用收到 `on_message`（`onMessage`）。应用通过 ref 的 `post_message`（`postMessage(string)`）向页面发消息，页面在 `window` 上收到 `message` 事件。消息是字符串；结构化数据请发送 JSON。

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
import { mount, signal, Text, View, WebView, type YNode } from "nsh";

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
  let web!: YNode;
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
                .resize_mode(ResizeMode::Contain)
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
import { mount, signal, Text, Video, View, type YNode } from "nsh";

function Player() {
  let video!: YNode;
  const paused = signal(true);
  const time = signal("");
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 16, gap: 12 }}>
      <Video
        ref={video}
        src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
        paused={paused()}
        repeat
        resizeMode="contain"
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

播放由属性控制：用 signal 设置 `paused`、`muted`、`volume` 和 `rate`，播放器随之变化。ref 提供 `seek(seconds)`。

在 Rust 中，`video(url)` 创建播放器（URL 可以是值、signal 或闭包），每个属性是一个蛇形命名的构建方法（`paused`、`repeat(true)`、`resize_mode(ResizeMode::Contain)`，`progressUpdateInterval` 对应 `progress_interval`）；`on_load` 收到 `VideoInfo`（`duration`、`size`），`on_progress` 收到 `VideoProgress`（`current_time`、`duration`），`on_buffer` 收到 `bool`。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `src` | `string` | | 视频的 URL。 |
| `paused` | `boolean` | `false` | 暂停播放。 |
| `muted` | `boolean` | `false` | 静音。 |
| `volume` | `number` | `1` | 0..1。 |
| `rate` | `number` | `1` | 播放速度。 |
| `repeat` | `boolean` | `false` | 播放到结尾后从头再播。 |
| `resizeMode` | `"cover" \| "contain" \| "stretch" \| "center"` | | 画面如何适应视图。 |
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
