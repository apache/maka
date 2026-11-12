---
title: WebView
description: WebView：原生网页视图（WKWebView、android.webkit.WebView），以及它的属性、事件和 ref 方法。
order: 2.35
---

# WebView

`nsh` 导出 `WebView`：由平台自带的浏览器引擎显示的网页（iOS 和 Mac Catalyst 上是 `WKWebView`，Android 上是 `android.webkit.WebView`）。它是一个和其他视图一样布局的原生视图，因此滚动、裁剪以及与其他视图的层叠都是正确的。

```ts
import { WebView, type WebViewNavigation, type WebViewProps } from "nsh";
```

教程见[网页视图与视频](../docs/web-view-and-video.md)，属性见 [`<WebView>`](../elements/web-view.md)。

## WebView

```ts
const WebView: (props: WebViewProps) => JSX.Element;

interface WebViewProps extends Omit<ViewProps, "children" | "ios" | "desktop">, WebViewHostProps {
  ios?: IOSWebViewHostProps;
  desktop?: DesktopWebViewHostProps;
}
```

```tsx
import { mount, signal, Text, View, WebView, type WebViewNavigation, type WebViewRef } from "nsh";

function Browser() {
  const nav = signal<WebViewNavigation | null>(null);
  let web!: WebViewRef;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 16, padding: 12 }}>
        <Text onPress={() => web.goBack()} style={{ opacity: nav()?.canGoBack ? 1 : 0.4 }}>Back</Text>
        <Text onPress={() => web.reload()}>Reload</Text>
        <Text style={{ numberOfLines: 1, flex: 1 }}>{nav()?.title ?? ""}</Text>
      </View>
      <WebView ref={web} src="https://example.com" style={{ flex: 1 }} onNavigationStateChange={(n) => nav.set(n)} />
    </View>
  );
}

mount(Browser);
```

## 属性

`WebView` 接受[视图属性](../elements/view.md)（样式、class、布局、无障碍、`ref`；不接受子元素），另外还有：

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `src` | `string` | | 要显示的页面的 URL。 |
| `html` | `string` | | 内联 HTML，代替 `src` 显示。 |
| `baseUrl` | `string` | | `html` 中相对链接的解析基准。它需要与该地址的页面相同的授权（`webview.hosts`）；未授权时 HTML 不带基准 URL 加载，`onError` 报告 `ERR_ACCESS_DENIED`。 |
| `injectedJavaScript` | `string` | | 每个页面加载完成后运行。 |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | 在每个页面自身的脚本之前运行。 |
| `userAgent` | `string` | 平台默认 | 用户代理字符串。 |
| `scrollable` | `boolean` | `true` | 用户可以滚动页面。 |
| `javaScriptEnabled` | `boolean` | `true` | 页面可以运行脚本。 |
| `incognito` | `boolean` | `false` | 页面的网站数据（cookie、存储、缓存）只与网页视图同存亡，与应用的数据分开；Android 上网页视图加载时不使用 HTTP 缓存、不保存表单数据（见[网站数据](../docs/web-view-and-video.md#网站数据)）。在网页视图创建时读取。 |
| `ios` | `{ allowsBackForwardNavigationGestures?: boolean }` | | 仅 iOS：从边缘轻扫以后退和前进。 |
| `desktop` | `{ allowsBackForwardNavigationGestures?: boolean }` | | macOS：双指在触控板上轻扫以后退和前进；Windows：在触摸屏上轻扫；Linux：在触控板上轻扫。 |

## 事件

| 事件 | 数据 | 时机 |
|---|---|---|
| `onLoadStart` | `WebViewNavigation` | 页面开始加载。 |
| `onLoad` | `WebViewNavigation` | 页面加载完成。 |
| `onError` | `{ message: string }` | 页面加载失败。 |
| `onNavigationStateChange` | `WebViewNavigation` | URL、标题、加载状态或历史记录发生变化。 |
| `onMessage` | `{ data: string }` | 页面调用了 `window.nsh.postMessage(data)`。 |

```ts
interface WebViewNavigation {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
```

## ref 方法

| 方法 | 说明 |
|---|---|
| `reload()` | 重新加载页面。 |
| `goBack()` | 在历史记录中后退。 |
| `goForward()` | 在历史记录中前进。 |
| `stopLoading()` | 停止加载。 |
| `injectJavaScript(script)` | 在页面中运行 `script`。 |
| `evaluate(script, { timeout? })` | 在页面中执行 `script`，返回 `{ value }`，即其 JSON 结果；参见[执行脚本](#执行脚本)。 |
| `postMessage(data)` | 向页面发送 `data`（字符串）：在 `window` 上触发 `message` 事件，`event.data` 即为 `data`。 |
| `load({ src, headers? })` | 加载 `src`，只给页面自身的请求带上 `headers`（`Record<string, string>`），子资源、之后的导航和重新加载都不带；用于已登录的页面（`Authorization`）。主机必须是 `webview.hosts` 允许的。请求头无效时抛出 `TypeError`。浏览器后端不做任何事。见[已登录的页面](../docs/web-view-and-video.md#已登录的页面请求头)。 |

## 与页面通信

页面用 `window.nsh.postMessage(…)` 向应用发送字符串；应用用 `ref.postMessage(…)` 向页面发送字符串。结构化数据请用 JSON 传递。

```tsx
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body>
  <button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
  <p id="got"></p>
  <script>
    window.addEventListener('message', (e) => { document.getElementById('got').textContent = e.data; });
  </script>
</body></html>`;

let web!: WebViewRef;
const message = signal("");

<WebView ref={web} html={page} style={{ height: 200 }} onMessage={(e) => message.set(e.data)} />
<Text onPress={() => web.postMessage("hi from the app")}>Post to the page</Text>
```

## 权限

如果应用在 `nsh.json` 中声明了 `capabilities`，网页视图只能显示和导航到 `webview` 下列出的主机；其他顶层导航会在原生侧被拒绝。没有 `capabilities` 键的应用可以显示任何内容；在 macOS 上，文件只限一个文件夹：`src` 为 `file://` 页面的网页视图可以打开该页面所在文件夹（及其子文件夹）中的文件，不能打开文件夹以外的文件。见[沙箱与权限](../docs/sandbox-and-capabilities.md)。

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## 执行脚本

`await ref.evaluate(script, { timeout })` 在页面主文档中执行 `script`，返回
`{ value }`，即脚本的完成值。脚本返回的 Promise 会被等待；要在脚本里使用
`await`，返回一个 async 函数的调用。`timeout` 以毫秒计（默认 30 000）。脚本要读取
已加载的文档时，在 `onLoad` 之后调用。

```tsx
const { value: title } = await web.evaluate("document.title");
const { value: buttons } = await web.evaluate(`
  Array.from(document.querySelectorAll("button")).map(button => ({
    text: button.textContent,
    disabled: button.disabled,
  }))
`);
const { value } = await web.evaluate("(async () => await Promise.resolve(42))()", { timeout: 5000 });
```

`value` 是 JSON：字符串、有限数字、布尔值、`null`、数组和普通对象，最多嵌套
64 层、总计 1 MiB。DOM 节点、日期和 Map 请在脚本中转换成这些类型，如上例所示。
脚本最多 1 MiB，一个引擎同时最多执行 64 个求值。

求值属于它开始时的文档：新的主文档导航、`load`、`reload`、`goBack`、`goForward`、
重新加载的 source 属性，或 WebView 被移除，都会以 `ERR_NSH_WEBVIEW_ABORTED` 结束它。
同一文档内的历史更新、子框架加载和被拒绝的导航不影响它。结果来自页面，应视为不可信
输入。页面的内容安全策略（CSP）同样作用于脚本。`injectJavaScript(script)` 执行脚本而不等待。

`WebView.evaluateAvailable()` 返回此平台能否在 WebView 中执行脚本：iOS、Android 和
macOS 可以。失败时以带下列 `code` 的 `Error` 拒绝；参数错误以 `TypeError` 或
`RangeError` 拒绝。

| Code | 含义 |
|---|---|
| `ERR_NSH_WEBVIEW_SCRIPT` | 脚本抛出或拒绝、结果不是 JSON，或页面不执行脚本。 |
| `ERR_NSH_WEBVIEW_ABORTED` | 文档发生导航，或 WebView 已被移除。 |
| `ETIMEDOUT` | 脚本未在 `timeout` 内返回。 |
| `ERR_NSH_QUOTA_EXCEEDED` | 脚本、结果或求值数量超出限制。 |
| `ERR_ACCESS_DENIED` | 应用的 capabilities 未授予 `webview`。 |
| `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` | 此平台不在 WebView 中执行脚本。 |

Rust 组件通过 WebView 的 element ref 执行：

```rust
let web = element_ref();
// web_view("https://example.com").element_ref(&web)
spawn(async move {
    match web.evaluate("document.title", EvaluateOptions::default()).await {
        Ok(evaluation) => log::info!("Page title: {}", evaluation.value),
        Err(error) => log::warn!("Evaluation failed: {}", error.message()),
    }
});
```

它返回 `Result<Evaluation, JsError>`；`EvaluateOptions { timeout }` 是 `Duration`。
