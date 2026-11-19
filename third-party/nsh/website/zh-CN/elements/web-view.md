---
title: WebView
description: WebView 元素：在应用中显示网页和内联 HTML，并支持双向通信。
order: 80
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
      <Text style={{ numberOfLines: 1 }}>{nav()?.title ?? "加载中…"}</Text>
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
| `baseUrl` | `web_view_html` / `.html` 的 `base_url` | `string` | | `html` 中相对链接的解析基准。它需要与该地址的页面相同的授权（`webview.hosts`）；未授权时 HTML 不带基准 URL 加载，`onError` 报告 `ERR_ACCESS_DENIED`。 |
| `injectedJavaScript` | `.injected_java_script(..)` | `string` | | 每个页面加载完成后执行。 |
| `injectedJavaScriptBeforeContentLoaded` | `.injected_java_script_before_content(..)` | `string` | | 在每个页面自身的脚本之前执行。 |
| `userAgent` | `.user_agent(..)` | `string` | | 浏览器的 user agent 字符串。 |
| `javaScriptEnabled` | `.java_script_enabled(..)` | `boolean` | `true` | 页面可以运行脚本。 |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | 用户可以滚动页面。 |
| `incognito` | `.incognito(bool)` | `boolean` | `false` | 页面的网站数据（cookie、存储、缓存）只与网页视图同存亡，与应用的数据分开；Android 上网页视图加载时不使用 HTTP 缓存、不保存表单数据（见[网站数据](../docs/web-view-and-video.md#网站数据)）。在网页视图创建时读取。 |

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
| `onError` | `.on_error` | `{ message, code? }`（`&str`，即消息） | 加载失败；页面、`html` 或 `baseUrl` 不在应用的能力范围内时 `code` 为 `"ERR_ACCESS_DENIED"`，平台无法显示网页视图时为 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`（Rust 中也可用 `.on_unavailable`，参数为消息），页面的进程结束时为 `"ERR_NSH_WEBVIEW_TERMINATED"`，直到 `reload()`、`load()` 或新的来源（Rust 中也可用 `.on_process_terminated`）。 |
| `onNavigationStateChange` | `.on_navigation_state_change` | `WebViewNavigation` | URL、标题、加载状态或历史记录发生变化。 |
| `onMessage` | `.on_message` | `{ data: string }`（`&str`） | 页面调用了 `window.nsh.postMessage(data)`。 |
| `onDownload` | `.on_download` | `WebViewDownload`（`WebDownload`） | 下载开始、完成、失败或取消。 |

`WebViewNavigation` 为 `{ url, title, loading, canGoBack, canGoForward }`；Rust 中为 `WebNavigation`，字段是 `url`、`title`、`loading`、`can_go_back` 和 `can_go_forward`。

`WebView.available()`（Rust 为 `web_view_available()`）得到网页视图在当前环境下能否显示页面：平台没有网页引擎，或应用的能力未授予 `webview` 时为 `false`（见[没有网页引擎时](../docs/web-view-and-video.md#没有网页引擎时)）。

iOS、macOS、Linux 和 Windows 支持原生下载决策及应用数据目录中的下载文件。

`WebViewDownload` 为 `{ state, id, url, filename, path, bytes?, message?, source, code?, reason? }`。`state` 为 `"started"`、`"finished"`、`"failed"` 或 `"cancelled"`。`"finished"` 表示文件已经发布到 `path`，`bytes` 是文件大小。失败包含诊断信息 `message`，以及可用时的稳定错误码 `code`。取消的 `reason` 为 `"app"`、`"timeout"`、`"teardown"` 或 `"noListener"`。

`source` 描述数据来源：`"transfer"` 表示浏览器持有的原始下载，`"request"` 表示 NSH 持有的请求，`"none"` 表示浏览器报告下载时已经释放响应；`"page"` 保留给页面提供的数据。来源说明该次传输的数据归属，各引擎产生的来源类型由其实际能力决定。
移除全部下载监听器会以 `reason: "noListener"` 取消进行中的下载，WebView 本身保持挂载。

设置 `onDownload` 后，NSH 持有数据的下载保存在应用数据目录的 `downloads/<id>/<filename>`，即 `path` 所指的位置，应用用 `fs/promises` 读取。应用负责存储预算和已完成文件的清理。移除 web view 会停止其活动下载，停写后清理专属临时输出；已发布的文件属于应用。文件名会处理路径分隔符、控制字符、双向格式字符、长度以及目标平台的保留名称。下载结果通过 `onDownload` 报告，导航错误通过 `onError` 报告。

### Rust 中指定下载目的地

Rust 宿主通过 `.on_download_pending(..)` 选择手动决策，否则采用上面的自动行为。`WebDownloadPending` 包含 `id`、`url`、`filename`、`source`，以及可选的 `mime_type`、`bytes`、`method`。元数据可以未知；仅凭 URL 无法确定产生该下载的请求方法。

事件携带私有决策句柄。克隆指向同一个下载，修改公开元数据不会改变操作对象。其固有方法 `accept(destination)` 和 `cancel()` 返回可等待的决策结果。`WebDownload` 事件也提供固有的 `cancel()` 方法，用于取消活动传输。

```rust
use nsh_core::prelude::*;
use nsh_core::webview::{DownloadDestination, WebDownloadPending};

web_view("https://example.com").on_download_pending(|event: &WebDownloadPending| {
    let (event, path) = (event.clone(), std::env::temp_dir().join("report.pdf"));
    spawn(async move {
        let destination = DownloadDestination::new(path).overwrite(false);
        if let Err(error) = event.accept(destination).await {
            log::warn!("download destination refused: {error}");
        }
    });
});
```

`accept` 在传输后端接受输出位置时完成；文件的最终结果由 `on_download` 报告。目的地必须是绝对路径、指向文件，且父目录存在。默认拒绝已有条目，包括传输期间由其他操作创建的条目。`overwrite(true)` 只允许在成功发布时替换。传输写入目的地旁的私有暂存目录，失败和取消保留已有目标文件。

`cancel()` 可用于待处理或活动下载，等待停写并清理专属输出。未回答的下载决策在 60 秒后过期，命令回复有独立的 30 秒期限。迟到、重复、跨视图和未绑定的决策不会影响其他传输。`WebDownloadPending::default()` 没有关联的下载，决策方法返回错误。

已经释放的响应以 `ERR_NSH_DOWNLOAD_DISCARDED` 报告，而不是自动重新请求。

任意宿主路径和待处理决策属于 Rust 宿主 API；TSX 观察共同的 `onDownload` 生命周期。在提供保存路径选择器的平台上，应用可以先选择路径，再调用 `accept`。

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `reload()` | `reload()` | 重新加载页面。 |
| `goBack()` / `goForward()` | `go_back()` / `go_forward()` | 在页面历史中后退 / 前进。 |
| `stopLoading()` | `stop_loading()` | 停止加载。 |
| `injectJavaScript(script)` | `inject_java_script(script)` | 在页面中执行 JavaScript。 |
| `postMessage(data)` | `post_message(data)` | 向页面发送一个字符串，页面会在 `window` 上收到 `message` 事件。 |
| `load({ src, headers })` | `load(WebLoad::new(src, headers)?)` | 加载 `src`，只给页面自身的请求带上 `headers`（如 `Authorization`），子资源和之后的导航不带（[指南](../docs/web-view-and-video.md#已登录的页面请求头)）。 |

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
import { signal, Text, View, WebView, type WebViewRef } from "nsh";

const page = `<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('来自页面的问候')">发给应用</button>
<p id="got"></p>
<script>
  window.addEventListener("message", (e) => { document.getElementById("got").textContent = e.data; });
</script>`;

function Bridge() {
  const message = signal("");
  let web!: WebViewRef;
  return (
    <View style={{ gap: 12 }}>
      <WebView ref={web} html={page} style={{ height: 200 }} onMessage={(e) => message.set(e.data)} />
      <Text onPress={() => web.postMessage("来自应用的问候")}>发给页面 · 收到：{message()}</Text>
    </View>
  );
}
```

## 能力声明

应用在 `nsh.json` 中声明了[能力](../docs/sandbox-and-capabilities.md)时，web view 显示和跳转到 `webview` 下列出的主机。指向其他主机的 `src`，或未声明 `webview` 的应用中的 `html`，显示为空视图；指向其他主机的 `baseUrl` 会被丢弃，HTML 不带它加载；跳到其他主机的顶层导航（用户点击的链接）会在原生侧取消。每种情况都会触发 `onError`，其 `code` 为 `"ERR_ACCESS_DENIED"`。

页面自己的 `blob:` URL（`URL.createObjectURL`、`<a download>` 链接）按它内嵌的源计算：该源被授予时可以显示和下载，
不透明 `blob:null/…` 则会被拒绝。

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## 平台说明

- iOS 在第一次创建 web view 时才加载 WebKit，应用在显示 web view 时才为此付出开销。
- 在 macOS 上，`onDownload` 通过 WebKit 的 `WKDownload` 保存下载内容。
- 在 Android 上，页面的 `postMessage` 调用会到达后台线程，再按顺序转发给应用。
- 要给 web view 加圆角，设置圆角半径和 `overflow: "hidden"`（`.overflow_hidden()`）。
