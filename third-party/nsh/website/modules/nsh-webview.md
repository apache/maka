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
| `baseUrl` | `string` | | What `html`'s relative links resolve against. It needs the same grant as a page there (`webview.hosts`); without it the HTML loads with no base URL and `onError` reports `ERR_ACCESS_DENIED`. |
| `injectedJavaScript` | `string` | | Runs after each page loads. |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | Runs before each page's own scripts. |
| `userAgent` | `string` | platform's | The user agent string. |
| `scrollable` | `boolean` | `true` | The user can scroll the page. |
| `javaScriptEnabled` | `boolean` | `true` | Pages run scripts. |
| `incognito` | `boolean` | `false` | The pages' website data (cookies, storage, the cache) lives only as long as the web view, apart from the app's; on Android the web view loads without the HTTP cache and saves no form data ([website data](../docs/web-view-and-video.md#website-data)). Read when the web view is made. |
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
| `evaluate(script, { timeout? })` | Runs `script` in the page and resolves `{ value }`, its result as JSON; see [Evaluating scripts](#evaluating-scripts). |
| `postMessage(data)` | Sends `data` (a string) to the page: a `message` event on `window`, with `data` as `event.data`. |
| `load({ src, headers? })` | Loads `src` with `headers` (`Record<string, string>`) on the page's own request only, not on its subresources, later navigations or reloads; for a signed-in page (`Authorization`). The host must be one `webview.hosts` allows. An invalid header throws a `TypeError`. The browser backend does nothing. See [Signed-in pages](../docs/web-view-and-video.md#signed-in-pages-request-headers). |

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

When your app declares `capabilities` in `nsh.json`, a web view may only show and navigate to the hosts listed under `webview`; other top-level navigations are refused natively. An app without a `capabilities` key may show anything; on macOS its files keep to one folder: a web view whose `src` is a `file://` page may open files in that page's folder (and below it), and no file outside it. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## Evaluating scripts

`await ref.evaluate(script, { timeout })` runs `script` in the page's main
document and resolves `{ value }`, the script's completion value. A Promise the
script returns is awaited; to use `await` inside the script, return an async
function's call. `timeout` is in milliseconds (30 000 by default). Call it after
`onLoad` when the script reads the loaded document.

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

`value` is JSON: strings, finite numbers, booleans, `null`, arrays and plain
objects, nested up to 64 levels and 1 MiB in all. Convert DOM nodes, dates and
maps to these in the script, as the example does. A script is up to 1 MiB, and an
engine runs up to 64 evaluations at once.

An evaluation belongs to the document it started in: a new main-document
navigation, `load`, `reload`, `goBack`, `goForward`, a source prop that loads
again, or the web view going away ends it with `ERR_NSH_WEBVIEW_ABORTED`.
Same-document history updates, subframe loads and refused navigations keep it
running. Its result is the page's: treat it as untrusted input. The page's Content
Security Policy applies to the script. `injectJavaScript(script)` runs a script
without waiting for it.

`WebView.evaluateAvailable()` resolves whether this platform evaluates scripts
in web views: iOS, Android and macOS do. A failure rejects with an `Error`
carrying one of these codes; wrong arguments reject with a `TypeError` or
`RangeError`.

| Code | Meaning |
|---|---|
| `ERR_NSH_WEBVIEW_SCRIPT` | The script threw or rejected, its result is not JSON, or the page runs no scripts. |
| `ERR_NSH_WEBVIEW_ABORTED` | The document navigated, or the web view went away. |
| `ETIMEDOUT` | The script did not answer within `timeout`. |
| `ERR_NSH_QUOTA_EXCEEDED` | The script, its result or the number of evaluations is over its limit. |
| `ERR_ACCESS_DENIED` | The app's capabilities do not grant `webview`. |
| `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` | This platform evaluates no scripts in web views. |

Rust components evaluate through the web view's element ref:

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

It resolves `Result<Evaluation, JsError>`; `EvaluateOptions { timeout }` is a
`Duration`.
