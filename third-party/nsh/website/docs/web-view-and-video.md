---
title: Web view and video
description: Showing web pages with WebView and playing video with Video - sources, messaging between the page and the app, navigation, playback control, refs and capabilities.
order: 45
group: ui
---

# Web view and video

The web view and the video player embed the platform's own web engine and media player as ordinary views: `web_view` and `video` in Rust (`nsh_core::prelude`), `WebView` and `Video` from `nsh` in TSX. Because NSH renders with native views, they sit in your layout like any other element: they scroll with their parent, take rounded corners and clipping, and other views can overlap them without layering problems.

| Component | iOS | Android | macOS | Linux | Windows |
|---|---|---|---|---|---|
| `WebView` | WKWebView | `android.webkit.WebView` | WKWebView | WebKitGTK 6.0's `WebKitWebView` | WebView2, in a child window |
| `Video` | AVPlayerLayer; AVPlayerViewController with `controls` | MediaPlayer on a TextureView; MediaController with `controls` | AVPlayerLayer; AVKit's AVPlayerView with `controls` | GTK's media stream (GStreamer) in a `GtkPicture`; `GtkVideo` with `controls` | Media Foundation's media engine, frames drawn with Direct2D; NSH's own control bar with `controls` |

The frameworks behind them (WebKit, AVFoundation) are loaded the first time an app uses one, so apps that never show a web page or a video do not pay for them at launch.

On [macOS](./macos.md) the web view has no scroll view of its own: with `scrollable={false}` the mouse wheel and the
trackpad scroll the app's scroll views around it instead of the page, which still scrolls with its keyboard and its
own scripts.

On [Linux](./linux.md) a web view is a WebKitGTK page drawn inside its view: NSH content over it (a dialog, a sheet)
covers it, and its parents clip it. The `webview` capability also applies to the navigations of frames there (an
`iframe` of a host that is not granted stays empty), and `scrollable: false` stops the page itself from scrolling
(elements inside it still scroll). Apps need WebKitGTK 6.0 installed; a runtime built without it shows a neutral
placeholder. Videos play the formats the installed GStreamer plugins decode; `rate` is not supported (they
play at 1×), and `onEnd` only comes for videos that do not loop.

On [Windows](./windows.md) a web view is a WebView2 control in a child window that follows its view: it is clipped to
its parents and rounded corners, but NSH content drawn over it (a dialog, a sheet) stays under it. It needs the
WebView2 Runtime (part of Windows 11; installed with Edge on Windows 10), else it shows a placeholder;
`baseUrl` for HTML, `scrollable` and `allowsBackForwardNavigationGestures` are not supported. Videos are
ordinary content (clipped, transformed and covered like any view) and play the formats the installed Media Foundation
codecs decode; `rate` works, there is no poster, and the control bar always shows while `controls` is on.

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

### Sources

A web view shows one of `src` and `html`:

| Props | Shows |
|---|---|
| `src="https://…"` | A web page. |
| `html="<!doctype html>…"` | HTML from a string, shown instead of `src`. |
| `html` with `baseUrl="https://example.com/"` | HTML whose relative URLs resolve against `baseUrl`. |

In Rust, `web_view(url)` shows a page and `web_view_html(html, base_url)` shows HTML (`base_url` an `Option<&str>`); the URL and the HTML can be a signal or a closure, which loads the page again when what it reads changes. Changing `src` or `html` loads the new page.

### Props

In Rust each prop is a builder method in snake case (`injected_java_script`, `java_script_enabled`, `scrollable`, `user_agent`; `injected_java_script_before_content` for `injectedJavaScriptBeforeContentLoaded`, `back_forward_gestures` for iOS's `allowsBackForwardNavigationGestures`) and each event an `on_…` method (`on_navigation_state_change`) whose listener gets a `WebNavigation` (`url`, `title`, `loading`, `can_go_back`, `can_go_forward`) or, for `on_error` and `on_message`, a `&str`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | | The URL of the page to show. |
| `html` | `string` | | Inline HTML, shown instead of `src`. |
| `baseUrl` | `string` | | What `html`'s relative URLs resolve against. |
| `injectedJavaScript` | `string` | | Runs after each page loads. |
| `injectedJavaScriptBeforeContentLoaded` | `string` | | Runs before each page's own scripts. |
| `javaScriptEnabled` | `boolean` | `true` | Pages run scripts. |
| `scrollable` | `boolean` | `true` | The user can scroll the page. |
| `userAgent` | `string` | | The browser's user agent string. |
| `ios={{ allowsBackForwardNavigationGestures }}` | `boolean` | | iOS: swipe back and forward through the page history. |
| `desktop={{ allowsBackForwardNavigationGestures }}` | `boolean` | | macOS: swipe with two fingers on the trackpad to go back and forward; Windows: swipe on a touchscreen; Linux: swipe on the touchpad. |

Events:

| Event | Payload | When |
|---|---|---|
| `onLoadStart` | `WebViewNavigation` | A page started loading. |
| `onLoad` | `WebViewNavigation` | A page finished loading. |
| `onError` | `{ message }` | Loading failed. |
| `onNavigationStateChange` | `WebViewNavigation` | The URL, title, loading state or history changed. |
| `onMessage` | `{ data: string }` | The page posted a message (below). |

`WebViewNavigation` is `{ url, title, loading, canGoBack, canGoForward }`.

### A browser with back and forward

The web view's ref (an `element_ref()` put on it with `.element_ref(&web)` in Rust, `ref` in TSX) has `reload`, `go_back` / `goBack`, `go_forward` / `goForward`, `stop_loading` / `stopLoading`, `inject_java_script` / `injectJavaScript(script)` and `post_message` / `postMessage(data)`:

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

### Messaging between the page and the app

Pages talk to the app with `window.nsh.postMessage(string)`, which arrives as `on_message` (`onMessage`). The app talks to the page with the ref's `post_message` (`postMessage(string)`), which arrives in the page as a `message` event on `window`. Messages are strings; send JSON for structured data.

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

The ref's `inject_java_script` (`injectJavaScript(script)`) runs code in the current page at any time; `injected_java_script` and `injected_java_script_before_content` (`injectedJavaScript`, `injectedJavaScriptBeforeContentLoaded`) run on every page load, before or after the page's own scripts, which is the place to install hooks:

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

### Which sites a web view may show

If your `nsh.json` declares `"capabilities"`, a web view may only show and navigate to the hosts listed under `webview`:

```json
{
  "capabilities": {
    "webview": { "hosts": ["example.com", "*.example.com"] }
  }
}
```

The check covers the web view's `src` and every top-level navigation the page makes (links, redirects, `location` changes); it is decided natively when the platform asks whether a navigation may proceed. A page's own subresources (scripts, images, frames) are the web content's business and are not checked. `*.example.com` matches subdomains only; list `example.com` as well for the bare domain. An app without a `"capabilities"` key may show any page. See [Sandbox and capabilities](./sandbox-and-capabilities.md).

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

Playback is controlled by props: set `paused`, `muted`, `volume` and `rate` from signals and the player follows. The ref has `seek(seconds)`.

In Rust, `video(url)` makes the player (the URL a value, a signal or a closure) and each prop is a builder method in snake case (`paused`, `repeat(true)`, `resize_mode(ResizeMode::Contain)`, `progress_interval` for `progressUpdateInterval`); `on_load` gets a `VideoInfo` (`duration`, `size`), `on_progress` a `VideoProgress` (`current_time`, `duration`) and `on_buffer` a `bool`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | | The video's URL. |
| `paused` | `boolean` | `false` | Playback is paused. |
| `muted` | `boolean` | `false` | No sound. |
| `volume` | `number` | `1` | 0..1. |
| `rate` | `number` | `1` | The playback speed. |
| `repeat` | `boolean` | `false` | Plays again from the start at the end. |
| `resizeMode` | `"cover" \| "contain" \| "stretch" \| "center"` | | How the picture fits the view. |
| `controls` | `boolean` | `false` | The platform's playback controls. |
| `progressUpdateInterval` | `number` | `250` | Milliseconds between `onProgress` events. |

| Event | Payload | When |
|---|---|---|
| `onLoadStart` | | Loading started. |
| `onLoad` | `{ duration, size }` | The video is ready: its length in seconds and its size. |
| `onProgress` | `{ currentTime, duration }` | While playing, every `progressUpdateInterval` ms. |
| `onBuffer` | `{ isBuffering }` | Playback stalled waiting for data, or resumed. |
| `onEnd` | | Playback reached the end. |
| `onError` | `{ message }` | Loading or playback failed. |

With `controls`, the platform draws its own play button, scrubber and full-screen button. Without, draw your own with views over or below the video; since the video is a native view in your layout, overlays work naturally:

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

Video sources are network requests: with declared capabilities, the video's host must be allowed under `network` in `nsh.json`, as for `fetch` and remote images. A refused source shows nothing, and the refusal is logged once with the key to add.

## Related

- [`WebView`](../elements/web-view.md) and [`Video`](../elements/video.md): the element references.
- [Sandbox and capabilities](./sandbox-and-capabilities.md): `webview` and `network` grants.
- [Native components](./native-components.md): embedding other native views your host app provides.
