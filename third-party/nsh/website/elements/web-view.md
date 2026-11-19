---
title: WebView
description: "The WebView element: web pages and inline HTML inside an app, with messaging both ways."
order: 80
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
      <Text style={{ numberOfLines: 1 }}>{nav()?.title ?? "Loading…"}</Text>
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
| `baseUrl` | `base_url` of `web_view_html` / `.html` | `string` | | What `html`'s relative links resolve against. It needs the same grant as a page there (`webview.hosts`); without it the HTML loads with no base URL and `onError` reports `ERR_ACCESS_DENIED`. |
| `injectedJavaScript` | `.injected_java_script(..)` | `string` | | Runs after each page loads. |
| `injectedJavaScriptBeforeContentLoaded` | `.injected_java_script_before_content(..)` | `string` | | Runs before each page's own scripts. |
| `userAgent` | `.user_agent(..)` | `string` | | The browser's user agent string. |
| `javaScriptEnabled` | `.java_script_enabled(..)` | `boolean` | `true` | Pages run scripts. |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | The user can scroll the page. |
| `incognito` | `.incognito(bool)` | `boolean` | `false` | The pages' website data (cookies, storage, the cache) lives only as long as the web view, apart from the app's; on Android the web view loads without the HTTP cache and saves no form data ([website data](../docs/web-view-and-video.md#website-data)). Read when the web view is made. |

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
| `onError` | `.on_error` | `{ message, code? }` (`&str`, the message) | Loading failed; `code` is `"ERR_ACCESS_DENIED"` for a page, `html` or `baseUrl` the app's capabilities do not grant, `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"` where the platform shows no web view (Rust: also `.on_unavailable`, the message), and `"ERR_NSH_WEBVIEW_TERMINATED"` when the page's process ended, until `reload()`, `load()` or a new source (Rust: also `.on_process_terminated`). |
| `onNavigationStateChange` | `.on_navigation_state_change` | `WebViewNavigation` | The URL, title, loading state or history changed. |
| `onMessage` | `.on_message` | `{ data: string }` (`&str`) | The page called `window.nsh.postMessage(data)`. |
| `onDownload` | `.on_download` | `WebViewDownload` (`WebDownload`) | A download started, finished, failed, or was cancelled. |

`WebViewNavigation` is `{ url, title, loading, canGoBack, canGoForward }`; in Rust `WebNavigation` with `url`, `title`,
`loading`, `can_go_back` and `can_go_forward`.

`WebView.available()` (Rust `web_view_available()`) resolves whether a web view shows a page here: `false` where the
platform has no web engine or the app's capabilities do not grant `webview` ([When there is no web
engine](../docs/web-view-and-video.md#when-there-is-no-web-engine)).

Native download decisions and app-data destinations are available on iOS, macOS, Linux and Windows.

`WebViewDownload` is `{ state, id, url, filename, path, bytes?, message?, source, code?, reason? }`.
Its `state` is `"started"`, `"finished"`, `"failed"` or `"cancelled"`.
`"finished"` means the file has been published at `path`; `bytes` is its size. A failure carries a diagnostic
`message` and, when available, a stable `code`. A cancellation reports its `reason`: `"app"`, `"timeout"`,
`"teardown"` or `"noListener"`.
Removing both download listeners cancels in-flight downloads with `reason: "noListener"`; the WebView stays mounted.

`source` describes the available data: `"transfer"` for a live browser download, `"request"` for a request owned by
NSH, or `"none"` when the browser reported the download after releasing its response. `"page"` is reserved for
page-provided data. The event's source describes the transfer, not a promise that every engine produces each kind.

With an `onDownload` listener, owned downloads are saved in the app's data directory as
`downloads/<id>/<filename>`, where `path` points, and the app reads them with `fs/promises`. The app manages its
storage budget and removes completed files when it has finished using them. Removing the web view stops its
active downloads; owned temporary output is cleaned after writing stops. Published files belong to the app.
Filenames are sanitized for path separators, control and bidirectional-formatting characters, length, and the
destination platform's reserved names. Download outcomes use `onDownload`; navigation errors use `onError`.

### Download destinations in Rust

A Rust host chooses where a download goes by registering `.on_download_pending(..)`. Registration selects manual
decisions; otherwise the automatic behavior above applies. The `WebDownloadPending` event contains `id`, `url`,
`filename`, `source`, and optional `mime_type`, `bytes` and `method`. Metadata can be unknown; in particular,
a URL alone does not establish the method of the request that produced it.

The event carries a private decision handle. Clones refer to the same download, and changing public metadata does
not retarget the handle. Its inherent `accept(destination)` and `cancel()` methods return an awaitable decision
result. A `WebDownload` event has an inherent `cancel()` method for an active transfer.

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

`accept` resolves when the transport accepts its output, not when the file is complete. `on_download` reports the
transfer's outcome. The destination must be absolute, name a file, and have an existing parent directory. Existing
entries are refused by default, including one created while a transfer is running. `overwrite(true)` permits
replacement only at successful publication. The transfer writes into an owned private staging directory beside
the destination; failure and cancellation preserve an existing destination.

`cancel()` applies while pending or active. It waits for writing to stop and for owned output to be cleaned.
An unanswered pending decision expires after 60 seconds; a command's reply has a separate 30-second deadline.
Late, duplicate, foreign and unbound decisions cannot affect another transfer. `WebDownloadPending::default()`
has no bound download and its decisions return an error.

An unavailable response is reported with `ERR_NSH_DOWNLOAD_DISCARDED`, rather than being fetched again automatically.

Saving to arbitrary host paths and pending decisions are Rust-host APIs. TSX observes the shared `onDownload`
lifecycle. Applications can compose a save-path picker with `accept` where the platform provides that picker.

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `reload()` | `reload()` | Reloads the page. |
| `goBack()` / `goForward()` | `go_back()` / `go_forward()` | Moves in the page's history. |
| `stopLoading()` | `stop_loading()` | Stops loading. |
| `injectJavaScript(script)` | `inject_java_script(script)` | Runs JavaScript in the page. |
| `postMessage(data)` | `post_message(data)` | Sends a string to the page, which receives a `message` event on `window`. |
| `load({ src, headers })` | `load(WebLoad::new(src, headers)?)` | Loads `src` with `headers` (e.g. `Authorization`) on the page's own request only, not its subresources or later navigations ([guide](../docs/web-view-and-video.md#signed-in-pages-request-headers)). |

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
import { signal, Text, View, WebView, type WebViewRef } from "nsh";

const page = `<!doctype html>
<meta name="viewport" content="width=device-width">
<button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
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
      <Text onPress={() => web.postMessage("hi from the app")}>Post to the page · got: {message()}</Text>
    </View>
  );
}
```

## Capabilities

When the app declares [capabilities](../docs/sandbox-and-capabilities.md) in `nsh.json`, a web view shows and
navigates to the hosts listed under `webview`. A `src` on another host, or `html` in an app without `webview`, shows an
empty view; a `baseUrl` on another host is dropped, and the HTML loads without it; a top-level navigation to another
host (a link the user taps) is cancelled natively. Each reports
`onError` with `code` `"ERR_ACCESS_DENIED"`.

A page's own `blob:` URL (`URL.createObjectURL`, a `<a download>` link) counts as the origin it embeds: it shows
and downloads when that origin is granted, while an opaque `blob:null/…` is refused.

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

## Platform notes

- iOS loads WebKit the first time a web view is created, so it costs an app something only once it shows one.
- On macOS `onDownload` saves downloads with WebKit's `WKDownload`.
- On Android the page's `postMessage` calls arrive on a background thread and are forwarded to the app in order.
- To round the corners of a web view, give it a corner radius and `overflow: "hidden"` (`.overflow_hidden()`).
