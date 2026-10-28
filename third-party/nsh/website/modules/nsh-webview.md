---
title: WebView
description: WebView, a native web page view (WKWebView, android.webkit.WebView), with its props, events and ref methods.
order: 2.35
---

# WebView

`nsh` exports `WebView`: a web page shown by the platform's own browser engine (`WKWebView` on iOS and Mac Catalyst, `android.webkit.WebView` on Android). It is a native view laid out like any other, so it scrolls, clips and overlaps other views correctly.

```ts
import { WebView, type WebViewNavigation, type WebViewProps } from "nsh";
```

See [Web view and video](../docs/web-view-and-video.md) for the guide and [`<WebView>`](../elements/web-view.md) for its props.

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

## Props

`WebView` takes the [view props](../elements/view.md) (style, classes, layout, accessibility, `ref`; no children), plus:

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | | The URL of the page to show. |
| `html` | `string` | | Inline HTML, shown instead of `src`. |
| `baseUrl` | `string` | | What `html`'s relative links resolve against. |
| `injectedJavaScript` | `string` | | Runs after each page loads. |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | Runs before each page's own scripts. |
| `userAgent` | `string` | platform's | The user agent string. |
| `scrollable` | `boolean` | `true` | The user can scroll the page. |
| `javaScriptEnabled` | `boolean` | `true` | Pages run scripts. |
| `ios` | `{ allowsBackForwardNavigationGestures?: boolean }` | | iOS only: swipe from the edges to go back and forward. |
| `desktop` | `{ allowsBackForwardNavigationGestures?: boolean }` | | macOS: two-finger trackpad swipes go back and forward; Windows: touchscreen swipes; Linux: touchpad swipes. |

## Events

| Event | Payload | When |
|---|---|---|
| `onLoadStart` | `WebViewNavigation` | A page starts loading. |
| `onLoad` | `WebViewNavigation` | A page finished loading. |
| `onError` | `{ message: string }` | A page failed to load. |
| `onNavigationStateChange` | `WebViewNavigation` | The URL, title, loading state or history changed. |
| `onMessage` | `{ data: string }` | The page called `window.nsh.postMessage(data)`. |

```ts
interface WebViewNavigation {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
```

## Ref methods

| Method | Description |
|---|---|
| `reload()` | Reloads the page. |
| `goBack()` | Goes back in its history. |
| `goForward()` | Goes forward in its history. |
| `stopLoading()` | Stops loading. |
| `injectJavaScript(script)` | Runs `script` in the page. |
| `postMessage(data)` | Sends `data` (a string) to the page: a `message` event on `window`, with `data` as `event.data`. |

## Talking to the page

The page sends strings to the app with `window.nsh.postMessage(…)`; the app sends strings to the page with `ref.postMessage(…)`. Send JSON for structured data.

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

## Capabilities

When your app declares `capabilities` in `nsh.json`, a web view may only show and navigate to the hosts listed under `webview`; other top-level navigations are refused natively. An app without a `capabilities` key may show anything. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```
