---
title: GPUI
description: Embed Rust and TSX NSH apps in a GPUI or GPUI Kit app with AppView, drawn by GPUI on macOS, Windows and Linux, try TSX apps in the GPUI development host, and what the GPUI backend does differently.
order: 15.5
group: platforms
---

# GPUI

The GPUI backend draws NSH apps with [GPUI](https://gpui-kit.com) (GPUI Fast), the GPU-accelerated UI framework that
GPUI Kit is built on, on macOS, Windows and Linux alike. It is the backend for embedding in GPUI and GPUI Kit apps: an
`AppView` is a GPUI view, so a GPUI or GPUI Kit app shows NSH apps, a Rust root of its own or TSX it loads, anywhere
in its own element tree. Standalone apps
run and are packaged with each desktop's own backend: [macOS](./macos.md) (AppKit), [Windows](./windows.md) (Win32)
and [Linux](./linux.md) (GTK). The core, the reactive graph, the renderer,
Taffy layout and the native modules are the same as on every other platform, so one app runs
everywhere. `os()` (`platform.os` in TSX) is the OS it runs on (macOS, Windows or Linux) and TSX's `desktop={{…}}`
props apply.

Every element and module of the [macOS](./macos.md) (AppKit), [Windows](./windows.md) (Win32) and
[Linux](./linux.md) (GTK) backends is there; where GPUI draws something its own way, [Differences](#differences)
says how.

## How it works

- **One element per surface.** A surface is one GPUI element that fills the space its parent gives it and paints the
  whole view tree with GPUI's primitives: quads, shadows, paths, glyphs and images. NSH keeps one retained view per
  node, as on Windows, and redraws only when a commit changed something.
- **Text is shaped on the engine thread** with GPUI's text system (the app's own fonts), broken into lines by NSH;
  the main thread only paints the glyphs.
- **One hop per commit.** The engine runs on its own thread; each commit is one closure sent to GPUI's main thread,
  which notifies the view.
- **Input** comes from GPUI's mouse, scroll, key and input method events; hit testing, presses, the responder system,
  scrolling and text editing are the same logic as the Windows backend's.
- **Scroll bars** stay faintly visible at rest and brighten during scrolling or hover, so their draggable thumbs
  remain easy to find.

## Requirements

- macOS, Windows or Linux, with a GPU GPUI can draw with (Metal on macOS, DirectX on Windows, Vulkan on Linux).
- On macOS, building your GPUI app or the runtime from a checkout uses Xcode's Metal Toolchain (`xcodebuild -downloadComponent
  MetalToolchain`), which compiles GPUI's shaders ahead of time. On a Mac without it, `nsh run` builds
  the runtime with GPUI's `runtime-shaders` feature and say so: the shaders are compiled when the app starts (a fraction
  of a second the first time, cached by macOS after that).
- On Linux: a Vulkan driver, Wayland or X11 with `libxkbcommon`, GTK 3 and WebKitGTK 4.1 (web views) and GStreamer
  1.20 or later with its base and good plug-ins (videos). Web views need X11: on a Wayland desktop run the app under
  Xwayland (`WAYLAND_DISPLAY=` empty), else they show a placeholder. Building the runtime from a checkout also needs
  the development packages; on Debian and Ubuntu:

  ```sh
  sudo apt-get install clang libclang-dev pkg-config libfontconfig-dev libfreetype-dev libwayland-dev libx11-xcb-dev \
    libxcb1-dev libxkbcommon-dev libxkbcommon-x11-dev libzstd-dev libvulkan1 libgtk-3-dev libwebkit2gtk-4.1-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-good
  ```

## Running an app

A Rust app runs inside your GPUI app: embed its root with `AppView` ([Embedding in a GPUI app](#embedding-in-a-gpui-app))
and `cargo run` the GPUI app; your crate and the app are one Cargo build. On its own, a Rust app runs on this OS's own
backend (`nsh run --target macos`, `windows` or `linux`).

A TSX app runs in the GPUI development host:

```sh
nsh run App.tsx --target gpui
```

It opens the app in a GPUI window (1200×800 by default), as a GPUI app that embeds it shows it, with hot reload, logs in
the terminal and the error overlay as on the other targets. The development host (`nsh-gpui-host`) runs in place on
every OS, with no app bundle around it. In a checkout, `nsh run` builds it first; the distribution ships it in `runtime/gpui/`. The host also runs a built
bundle on its own:

```sh
nsh build my-app --release -o build
dist/nsh/runtime/gpui/nsh-gpui-host --bundle build/bundle.nshc --window-size 390x844   # in a checkout: target/debug/nsh-gpui-host
```

`--window-size` is the window's size in points (`<width>x<height>`).

## Packaging

A GPUI app ships NSH inside its own executable: it embeds the app's Rust root or TSX bundle with `AppView` ([Embedding in a GPUI
app](#embedding-in-a-gpui-app)) and is built and distributed as the GPUI app it is. A standalone NSH app is packaged
with this OS's own target: [`--target macos`](./macos.md#packaging), [`--target windows`](./windows.md#packaging) or
[`--target linux`](./linux.md#packaging) ([Packaging](./packaging.md)).

On Linux, a GPUI app with web views and videos links WebKitGTK 4.1 and GStreamer dynamically, so the machines it runs
on need them installed, with GTK 3 and GStreamer's base and good plug-ins (Debian / Ubuntu: `libwebkit2gtk-4.1-0`,
`libgstreamer1.0-0`, `libgstreamer-plugins-base1.0-0`, `gstreamer1.0-plugins-good`), besides a Vulkan driver and
`libxkbcommon`.

## Embedding in a GPUI app

The `nsh-platform-gpui` crate (from the NSH repository) gives a Rust GPUI app `AppView`: one NSH engine as a GPUI
view (`Entity<AppView>`), which fills the space its parent element gives it. Each `AppView` is independent; several
can run at once. It runs a Rust root, the root component of your crate:

```rust
use gpui::{AppContext, WindowOptions};
use nsh_platform_gpui::{set_ui_sets, App, AppOptions, AppView, Root};

// Once, before the first view: the UI sets the apps import (NSH's and your crate's).
set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
gpui_platform::application().run(|cx| {
    cx.open_window(WindowOptions::default(), |window, cx| {
        cx.new(|cx| {
            let view = AppView::new(AppOptions::default(), window, cx);
            view.load(App::Rust(Root::of::<my_app::App>()));
            view
        })
    })
    .unwrap();
});
```

`Root::tokens` gives the root its [theme](./rust.md#theme) (`nsh_base::Theme::from_json(json)?.into_tokens()`,
`Theme` is re-exported here) and `Root::app_id` the id its data is kept under. A TSX bundle that `nsh build` wrote
loads into the same view:

```rust
use nsh_platform_gpui::{App, Bundle};

let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(App::Js(Bundle::source(code)));
```

Put the entity in your element tree like any other view (a GPUI Kit `Root`, a panel, a dock). `AppView::load`
replaces whatever ran; `stop` (or dropping the view) ends the app. `AppOptions::asset_base` tells it where `asset:/`
URIs resolve (`AssetBase::Directory` or `AssetBase::Http`). Bytecode bundles (`bundle.nshc`) load with
`unsafe { Bundle::bytecode(bytes) }` (or `Bundle::read_trusted(path)`, unsafe too): QuickJS bytecode is trusted input,
so only load it from your own app's files.

- `open_app_window(source, options, cx)` opens a window with one `AppView` in a running GPUI app.
- `run_app(source, options)` starts GPUI and runs one app in a window until it closes (what the development host does).
- `AppView::register_component(name, factory)` registers a native component of yours before loading
  ([Native components](./native-components.md)).
- `AppOptions::cache` (or `AppView::set_cache`, for the apps loaded next) sets where the apps keep their caches, the
  [images they download](./images-and-assets.md#kept-on-disk), and how much each keeps: `CacheOptions { location,
  images }`, `CacheLocation::System` (the default), `Dir(path)` or `Off`, `CachePolicy::Default` (256 MiB),
  `MaxSize(ByteSize::mib(n))` or `Off`.
- `AppView::host()` is the view's channel with the apps it runs ([`host`](../modules/nsh.md#host)), a
  `HostChannel` any thread may use: `set_params(map)` before loading gives the app its launch parameters
  (`host.params`), `send(name, data)` an event (`host.on`), and `handle(name, |call| …)` answers its
  `host.call(name, data)` and hears its `host.post` (`call.resolve(json)`, `call.reject(message)`, at once or later
  from any thread). Handlers run on the engine thread: hand the call to your GPUI entities (a channel that a
  `cx.spawn` task reads) and answer from there. The macOS, Windows and Linux `AppView`s have the same `host()`.
  Its `handle_open_url(|request| …)` sees the URLs the app opens ([`openUrl`](../modules/nsh.md#openurl))
  before the system does: `request.handled()` when your app routed the URL itself, `request.decline()` (or dropping
  the request) for the system to open it with GPUI's `open_url`.
- `AppOptions::limits` (or `AppView::set_limits`, for the apps loaded next) sets the VM limits: the JS heap, the
  stack, the time budgets and the node quota ([Sandbox and capabilities](./sandbox-and-capabilities.md)). Embedded apps get `Limits::default()` (a
  256 MB heap); the development host runs apps on its own, with `Limits::standalone()`.
- `AppView::connect_dev_server(url, cx)` (feature `dev`) loads the app from `nsh dev` and reloads it as you edit,
  with the error overlay over the view; `AppView::on_error` keeps hearing the app's errors.
- `AppView::on_app_error(|error| …)` hears the app's errors: `error.kind` (the app failed to load, an uncaught
  exception, the VM stopped), `error.is_fatal()` when no JS of the app runs again, `error.message`, `error.stack`
  and `error.package` (the id and build of the signed package it came from). `AppView::on_error` gets the same
  errors as text.
- `AppView::set_locale(locale, cx)` and `AppView::set_font_scale(scale, cx)` give the app your app's language and
  text size in place of the system's (`None` follows the system's again): `locale()`, `Intl`, `fontScale()` and text
  follow at once ([Device and environment](./device-and-environment.md#in-an-embedding-app)).
- `AppView::run_package(&package)` runs a [signed package](./signed-packages.md#loading-packages-in-a-host-app)
  from `verify_package` or `load_package`; `accept_package` records it once your app decided it is healthy.
- `set_ui_sets(sets)` sets the UI sets every engine serves: NSH's (`nsh_base::registry()`) and your crates'
  (`my_app::registry()`, which `#[native_module]` makes; [Building with Rust](./rust.md)), and gives your app's own sets: an app reaches the functions and classes of one by name with
  [`nativeModule`](../modules/nsh.md#nativemodule) and is built with the stock `nsh build`. The repository's
  `examples/embed-gpui` keeps a trading desk in the host this way, which two embedded order tickets and the host's
  own widgets share.

## Differences

What draws or behaves differently from the native desktop backends:

- **Transforms**: rotated, skewed and projected views turn their backgrounds, borders and shadows, but text stays
  upright, and images, videos and canvases draw at their bounds.
- **Opacity** applies to each color rather than to a group, so overlapping children of a translucent view show
  through each other; an image's opacity (a fade-in, a translucent view) changes in sixteenths.
- **Rounded clips** (`overflow: "hidden"` with a radius) round the backgrounds and images of the children, but text,
  borders, videos and native components are cut by the rectangle.
- **Not drawn**: `filter: blur()`, `backdropFilter` and `mixBlendMode`; shadows show through translucent fills;
  `borderCurve: "continuous"` draws circular corners.
- **Canvas text** is approximated: upright under rotations, made smaller rather than narrower for `maxWidth`,
  gradients paint it in one color, `strokeText` fills, its shadows are not blurred, and composite operations and
  `clearRect` do not apply to it.
- **Scroll views** do not zoom (`zoomTo` and the zoom props are ignored).
- **Video** plays on Linux (GStreamer); on macOS and Windows a video shows a placeholder and reports `onError`.
- **Web views** are native views above everything NSH draws at their place. On Linux they need X11 (see
  [Requirements](#requirements)); where pages stay black under Xwayland ("Failed to create GBM buffer" in the log),
  run the app with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. On macOS and Windows clipping ancestors do not cut them and
  failed loads report no `onError`. `baseUrl`, `scrollable` and `allowsBackForwardNavigationGestures` are
  not supported.
- **Accessibility** goes through AccessKit: screen readers can activate, focus, set values and scroll elements into
  view everywhere; custom actions and the context-menu action are not passed on yet.

For comparison, each native backend's own list: [macOS](./macos.md#what-differs-on-macos),
[Windows](./windows.md#what-differs-on-windows), [Linux](./linux.md#what-differs-on-linux).

## See also

- [Building with Rust](./rust.md): the crate whose root a GPUI app embeds
- [CLI](./cli.md): `nsh run --target gpui`
- [Packaging](./packaging.md): standalone apps, with each OS's own target
- [Platform overview](./platforms.md)
