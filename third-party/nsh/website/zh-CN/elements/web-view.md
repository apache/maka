---
title: WebView
description: WebView 元素：在应用中显示网页和内联 HTML，并支持双向通信。
order: 9
group: primitives
demo: el-web-view
---

# WebView

web view 在应用内显示一个网页，或你传入的一段 HTML：iOS 和 Mac Catalyst 上是 WKWebView，Android 上是 `android.webkit.WebView`。由于 NSH 用原生视图渲染，web view 和其他视图一样处在布局中，与周围视图按顺序排列。Rust 用 `web_view(url)` 或 `web_view_html(html, base_url)` 创建，TSX 用从 `nsh` 导入的 `<WebView>`。

```rust tabs
use nsh_core::prelude::*;

fn browser() -> impl IntoElement {
    let title = signal(SharedString::from("加载中…"));
    view()
        .flex_1()
        .child(text(title).number_of_lines(1))
        .child(
            web_view("https://example.com")
                .flex_1()
                .on_navigation_state_change(move |e: &WebNavigation| title.set(e.title.clone().into())),
        )
}
```

```tsx tabs
import { signal, Text, View, WebView, type WebViewNavigation } from "nsh";

function Browser() {
  const nav = signal<WebViewNavigation | null>(null);
  return (
    <View style={{ flex: 1 }}>
      <Text numberOfLines={1}>{nav()?.title ?? "加载中…"}</Text>
      <WebView
        src="https://example.com"
        style={{ flex: 1 }}
        onNavigationStateChange={(e) => nav.set(e)}
      />
    </View>
  );
}
```

在 TSX 中 web view 接受 `src` 和 `html` 二者之一（参见 [WebView API](../modules/nsh-webview.md)）。[Web view 与视频指南](../docs/web-view-and-video.md)介绍了通信模式和能力声明。

## 属性

web view 接受 [view](./view.md) 的属性（它没有子元素），另外还有：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `src` | `web_view(url)` | `string` | | 要显示的页面的 URL。 |
| `html` | `web_view_html(html, base_url)`、`.html(html, base_url)` | `string` | | 内联 HTML，代替 `src` 显示。 |
| `baseUrl` | `web_view_html` / `.html` 的 `base_url` | `string` | | `html` 中相对链接的解析基准。 |
| `injectedJavaScript` | `.injected_java_script(..)` | `string` | | 每个页面加载完成后执行。 |
| `injectedJavaScriptBeforeContentLoaded` | `.injected_java_script_before_content(..)` | `string` | | 在每个页面自身的脚本之前执行。 |
| `userAgent` | `.user_agent(..)` | `string` | | 浏览器的 user agent 字符串。 |
| `javaScriptEnabled` | `.java_script_enabled(..)` | `boolean` | `true` | 页面可以运行脚本。 |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | 用户可以滚动页面。 |

| `ios` 键 | Rust | 类型 | 说明 |
|---|---|---|---|
| `allowsBackForwardNavigationGestures` | `.back_forward_gestures(..)` | `boolean` | 从边缘轻扫以后退和前进。 |

| `desktop` 键 | Rust | 类型 | 说明 |
|---|---|---|---|
| `allowsBackForwardNavigationGestures` | `.back_forward_gestures(..)` | `boolean` | macOS：双指在触控板上轻扫以后退和前进；Windows：在触摸屏上轻扫；Linux：在触控板上轻扫。 |

## 事件

| 事件 | Rust | 载荷 | 时机 |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | `WebViewNavigation` | 页面开始加载。 |
| `onLoad` | `.on_load` | `WebViewNavigation` | 页面加载完成。 |
| `onError` | `.on_error` | `{ message }`（`&str`） | 加载失败。 |
| `onNavigationStateChange` | `.on_navigation_state_change` | `WebViewNavigation` | URL、标题、加载状态或历史记录发生变化。 |
| `onMessage` | `.on_message` | `{ data: string }`（`&str`） | 页面调用了 `window.nsh.postMessage(data)`。 |

`WebViewNavigation` 为 `{ url, title, loading, canGoBack, canGoForward }`；Rust 中为 `WebNavigation`，字段是 `url`、`title`、`loading`、`can_go_back` 和 `can_go_forward`。

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `reload()` | `reload()` | 重新加载页面。 |
| `goBack()` / `goForward()` | `go_back()` / `go_forward()` | 在页面历史中后退 / 前进。 |
| `stopLoading()` | `stop_loading()` | 停止加载。 |
| `injectJavaScript(script)` | `inject_java_script(script)` | 在页面中执行 JavaScript。 |
| `postMessage(data)` | `post_message(data)` | 向页面发送一个字符串，页面会在 `window` 上收到 `message` 事件。 |

## 通信

应用和页面之间交换的是字符串。页面通过 `window.nsh.postMessage(data)` 发送；应用通过 ref 的 `postMessage(data)`（Rust 中为 `post_message(..)`）发送。结构化数据请用 JSON。

```rust tabs
use nsh_core::prelude::*;

const PAGE: &str = r#"<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('来自页面的问候')">发给应用</button>
<p id="got"></p>
<script>
  window.addEventListener("message", (e) => { document.getElementById("got").textContent = e.data; });
</script>"#;

fn bridge() -> impl IntoElement {
    let message = signal(String::new());
    let web = element_ref();
    view()
        .gap_3()
        .child(
            web_view_html(PAGE.to_string(), None)
                .element_ref(&web)
                .h(px(200.0))
                .on_message(move |data: &str| message.set(data.to_string())),
        )
        .child(
            text(move || format!("发给页面 · 收到：{}", message.get()))
                .on_press(move || web.post_message("来自应用的问候")),
        )
}
```

```tsx tabs
import { signal, Text, View, WebView, type YNode } from "nsh";

const page = `<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('来自页面的问候')">发给应用</button>
<p id="got"></p>
<script>
  window.addEventListener("message", (e) => { document.getElementById("got").textContent = e.data; });
</script>`;

function Bridge() {
  const message = signal("");
  let web!: YNode;
  return (
    <View style={{ gap: 12 }}>
      <WebView ref={web} html={page} style={{ height: 200 }} onMessage={(e) => message.set(e.data)} />
      <Text onPress={() => web.postMessage("来自应用的问候")}>发给页面 · 收到：{message()}</Text>
    </View>
  );
}
```

## 能力声明

应用在 `nsh.json` 中声明了[能力](../docs/sandbox-and-capabilities.md)时，web view 显示和跳转到 `webview` 下列出的主机。指向其他主机的 `src` 显示为空视图；跳到其他主机的顶层导航（用户点击的链接）会在原生侧取消。

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## 平台说明

- iOS 在第一次创建 web view 时才加载 WebKit，应用在显示 web view 时才为此付出开销。
- 在 Android 上，页面的 `postMessage` 调用会到达后台线程，再按顺序转发给应用。
- 要给 web view 加圆角，设置圆角半径和 `overflow: "hidden"`（`.overflow_hidden()`）。
