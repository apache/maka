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
| `baseUrl` | `string` | | `html` 中相对链接的解析基准。 |
| `injectedJavaScript` | `string` | | 每个页面加载完成后运行。 |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | 在每个页面自身的脚本之前运行。 |
| `userAgent` | `string` | 平台默认 | 用户代理字符串。 |
| `scrollable` | `boolean` | `true` | 用户可以滚动页面。 |
| `javaScriptEnabled` | `boolean` | `true` | 页面可以运行脚本。 |
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
| `postMessage(data)` | 向页面发送 `data`（字符串）：在 `window` 上触发 `message` 事件，`event.data` 即为 `data`。 |

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

如果应用在 `nsh.json` 中声明了 `capabilities`，网页视图只能显示和导航到 `webview` 下列出的主机；其他顶层导航会在原生侧被拒绝。没有 `capabilities` 键的应用可以显示任何内容。见[沙箱与权限](../docs/sandbox-and-capabilities.md)。

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```
