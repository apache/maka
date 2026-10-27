---
title: WebView
description: "The WebView element: web pages and inline HTML inside an app, with messaging both ways."
order: 9
group: primitives
demo: el-web-view
---

# WebView

A web view shows a web page, or HTML you pass in, inside the app: WKWebView on iOS and Mac Catalyst,
`android.webkit.WebView` on Android. Because NSH renders with native views, a web view sits in the layout like any other
view, in order with the views around it. Rust makes one with `web_view(url)` or `web_view_html(html, base_url)`, TSX
with `<WebView>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

fn browser() -> impl IntoElement {
    let title = signal(SharedString::from("Loading…"));
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
      <Text numberOfLines={1}>{nav()?.title ?? "Loading…"}</Text>
      <WebView
        src="https://example.com"
        style={{ flex: 1 }}
        onNavigationStateChange={(e) => nav.set(e)}
      />
    </View>
  );
}
```

In TSX a web view takes one of `src` and `html` (see the [WebView API](../modules/nsh-webview.md)). The
[web view and video guide](../docs/web-view-and-video.md) covers messaging patterns and capabilities.

## Props

A web view takes the props of a [view](./view.md) (it has no children) plus:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `src` | `web_view(url)` | `string` | | The URL of the page to show. |
| `html` | `web_view_html(html, base_url)`, `.html(html, base_url)` | `string` | | Inline HTML, shown instead of `src`. |
| `baseUrl` | `base_url` of `web_view_html` / `.html` | `string` | | What `html`'s relative links resolve against. |
| `injectedJavaScript` | `.injected_java_script(..)` | `string` | | Runs after each page loads. |
| `injectedJavaScriptBeforeContentLoaded` | `.injected_java_script_before_content(..)` | `string` | | Runs before each page's own scripts. |
| `userAgent` | `.user_agent(..)` | `string` | | The browser's user agent string. |
| `javaScriptEnabled` | `.java_script_enabled(..)` | `boolean` | `true` | Pages run scripts. |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | The user can scroll the page. |

| `ios` key | Rust | Type | Description |
|---|---|---|---|
| `allowsBackForwardNavigationGestures` | `.back_forward_gestures(..)` | `boolean` | Swipe from the edges to go back and forward. |

| `desktop` key | Rust | Type | Description |
|---|---|---|---|
| `allowsBackForwardNavigationGestures` | `.back_forward_gestures(..)` | `boolean` | macOS: swipe with two fingers on the trackpad to go back and forward; Windows: swipe on a touchscreen; Linux: swipe on the touchpad. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | `WebViewNavigation` | A page started loading. |
| `onLoad` | `.on_load` | `WebViewNavigation` | A page finished loading. |
| `onError` | `.on_error` | `{ message }` (`&str`) | Loading failed. |
| `onNavigationStateChange` | `.on_navigation_state_change` | `WebViewNavigation` | The URL, title, loading state or history changed. |
| `onMessage` | `.on_message` | `{ data: string }` (`&str`) | The page called `window.nsh.postMessage(data)`. |

`WebViewNavigation` is `{ url, title, loading, canGoBack, canGoForward }`; in Rust `WebNavigation` with `url`, `title`,
`loading`, `can_go_back` and `can_go_forward`.

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `reload()` | `reload()` | Reloads the page. |
| `goBack()` / `goForward()` | `go_back()` / `go_forward()` | Moves in the page's history. |
| `stopLoading()` | `stop_loading()` | Stops loading. |
| `injectJavaScript(script)` | `inject_java_script(script)` | Runs JavaScript in the page. |
| `postMessage(data)` | `post_message(data)` | Sends a string to the page, which receives a `message` event on `window`. |

## Messaging

The app and the page exchange strings. The page posts with `window.nsh.postMessage(data)`; the app posts
with the ref's `postMessage(data)` (`post_message(..)` in Rust). Send JSON for structured data.

```rust tabs
use nsh_core::prelude::*;

const PAGE: &str = r#"<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
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
            text(move || format!("Post to the page · got: {}", message.get()))
                .on_press(move || web.post_message("hi from the app")),
        )
}
```

```tsx tabs
import { signal, Text, View, WebView, type YNode } from "nsh";

const page = `<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
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
      <Text onPress={() => web.postMessage("hi from the app")}>Post to the page · got: {message()}</Text>
    </View>
  );
}
```

## Capabilities

When the app declares [capabilities](../docs/sandbox-and-capabilities.md) in `nsh.json`, a web view shows and
navigates to the hosts listed under `webview`. A `src` on another host shows an empty view; a top-level navigation
to one (a link the user taps) is cancelled natively.

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## Platform notes

- iOS loads WebKit the first time a web view is created, so it costs an app something only once it shows one.
- On Android the page's `postMessage` calls arrive on a background thread and are forwarded to the app in order.
- To round the corners of a web view, give it a corner radius and `overflow: "hidden"` (`.overflow_hidden()`).
