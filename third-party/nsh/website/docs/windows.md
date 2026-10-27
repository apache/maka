---
title: Windows
description: Run Rust and TSX NSH apps on Windows in Win32 windows drawn with Direct2D, package them, embed them in a Win32 app with AppView, and what differs on Windows.
order: 14
group: platforms
---

# Windows

NSH apps also run on Windows. The Windows backend draws them in Win32 windows with Direct2D and lays out text with
DirectWrite; the core, the reactive graph, the renderer, Taffy layout and the native modules are the same
as on iOS and Android, so one app runs everywhere. On Windows, `os()` is `Os::Windows` (`platform.os` is `"windows"`
in TSX) and TSX's `desktop={{…}}` props apply. The window's title, a title bar of the app's own, the menu bar and
context menus come from `nsh_core::element::desktop` in Rust ([Desktop title bars](./rust.md#desktop-title-bars)) and
[`nsh/desktop`](../modules/nsh-desktop.md) in TSX.

## Requirements

- **Windows 10 1809** or later, or Windows 11.
- The **WebView2 Runtime** for web views. It comes with Windows 11 and with Microsoft Edge on Windows 10; without it a
  `WebView` shows a placeholder.
- **Media Foundation codecs** for the video formats your app plays (videos play through Windows' own media stack).
- To build a Rust app's runner: Visual Studio Build Tools with the C++ workload and the Windows SDK. To build NSH's
  Windows runtime (from a checkout, or `cargo xtask dist` on Windows) also LLVM (for QuickJS' bindings).

## Running an app

On Windows, `nsh run` opens the app in a window. A Rust app runs from its directory:

```sh
nsh run                        # --target windows is the default on Windows
```

`nsh` builds a debug runner with your crate and opens the app, with its logs (`log::info!` and the rest) in the
terminal; a change to the crate's Rust code builds the runner again and restarts the app. `cargo run` starts the same
root from the crate's `src/main.rs`, which `nsh init --template rust` writes: [`run_app`](#embedding-in-a-win32-app)
with `AppSource::Rust`.

A TSX app names its entry, and opens in a 1200×800 window by default, with hot reload, logs in the terminal and the
error overlay as on the other targets:

```sh
nsh run App.tsx
```

In a checkout, `nsh run` builds the development host (`nsh-windows-host.exe`) first; the distribution made on Windows
ships it in `runtime\windows\`. Ctrl-C closes the window, and closing the window ends `nsh run`; the host never
outlives `nsh`, however it ends. The host also runs a built bundle on its own:

```sh
nsh build my-app --release -o build
dist\nsh\runtime\windows\nsh-windows-host --bundle build\bundle.nshc --window-size 390x844   # in a checkout: target\debug\nsh-windows-host
```

`--window-size` is the window's size in points (`<width>x<height>`; TSX apps).

### Performance monitor

`--fps` (`nsh run App.tsx --target windows --fps`, `nsh test --target windows --fps`, the host's `--fps`, or
`AppOptions { fps: true, .. }` in a Rust app's `run_app`) logs the performance monitor's readings once a second
(target `nsh::perf`): frames shown over the display's rate, the main thread's time per frame and its phases (`tick`,
`drain`, `paint`, `present`, `canvas`), the engine's commits, CPU and memory, in the shape the other desktops log
(milliseconds as mean/p50/p95/max). `nsh test --fps -v` shows them and `examples/gallery/tools/perf.py` reads them
([Performance report](./performance-report.md#windows-win32-direct2d)). Measure release builds; the monitor costs
nothing while it is off.

## Packaging

```sh
nsh package --target windows [--run]           # a Rust app, from its directory
nsh package App.tsx --target windows [--run]   # a TSX app
```

Writes a directory and the same as an archive:

```text
.nsh\out\<Name>\
  <Name>.exe             the executable, with the app's icon: a Rust app's own runner, built with its crate; nsh's release runner for TSX
  nsh\bundle.nshc         a TSX app, compiled
  nsh\assets\…           the assets it imports (a Rust crate's `assets!()` too)
  nsh\app.json           the window title, the app id, the version and the appearance
.nsh\out\<Name>.zip
```

The executable finds `nsh\` next to itself; copy the whole directory (or unpack the `.zip`) wherever the app should
live: nothing is installed. The icon from `nsh.json` is embedded in the executable (Explorer and the taskbar show it)
without any extra tools; packaging on another system keeps the default icon. The app id groups the app's windows in
the taskbar. `--run` launches the app after packaging it. The executable is not signed: sign it with your own
certificate (`signtool`) to distribute it.

## Embedding in a Win32 app

The `nsh-platform-windows` crate (from the NSH repository) gives a Rust Win32 app `AppView`: one NSH engine in a child
window of a window of yours. Each `AppView` is independent; several can run at once. It runs a Rust root, the root
component of your crate:

```rust
use std::rc::Rc;
use nsh_platform_windows::{
    windows::{self, Win32::{Foundation::HWND, System::Ole::OleInitialize, UI::WindowsAndMessaging::MoveWindow}},
    set_ui_sets, AppOptions, AppView, Root,
};

/// Called on the thread that runs your message loop, with your window.
fn embed(parent: HWND) -> windows::core::Result<Rc<AppView>> {
    // Once per thread: COM and OLE (the clipboard, image decoding).
    unsafe { OleInitialize(None)? };
    // Once, before the first view: the UI sets the apps import (NSH's and your crate's).
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let view = AppView::new(
        Some(parent),
        AppOptions {
            app_id: "com.example.host".into(),
            ..AppOptions::default()
        },
    )?;
    // register native components here, before loading
    view.load(Root::of::<my_app::App>().into());
    Ok(view)
}

// On WM_SIZE of `parent`:
// unsafe { MoveWindow(view.hwnd(), 0, 0, width, height, true) };
```

A TSX bundle that `nsh build` wrote loads into the same view, with `asset_base` set to its `assets` directory:

```rust
let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(Bundle::source(code).into());
```

The view is a child window: your message loop runs it, and you place it with `MoveWindow` on its `hwnd()` when the
parent resizes. `AppView::load` replaces whatever ran; `stop` (or destroying the window) ends the app. `asset_base`
tells it where `asset:/` URIs resolve (`AssetBase::Directory` or `AssetBase::Http`). Bytecode bundles (`bundle.nshc`)
load with `unsafe { Bundle::bytecode(bytes) }` (or `Bundle::read_trusted(path)`, unsafe too): QuickJS bytecode is trusted input, so
only load it from your own app's files. A standalone window is `nsh_platform_windows::run_app(source, options)`, with
`AppSource::Rust(root)` or `AppSource::Bundle(bundle)`. `Root::tokens` gives a root its [theme](./rust.md#theme) and
`Root::app_id` the id its data is kept under.

`AppOptions::cache` (or `AppView::set_cache`, for the apps loaded next) sets where the apps keep their caches, the
[images they download](./images-and-assets.md#kept-on-disk), and how much each keeps (`CacheOptions`: the system's
cache directory and 256 MiB of images by default).

`AppView::set_locale(Some(locale))` and `AppView::set_font_scale(Some(scale))` give the app your app's language and
text size in place of the system's (`None` follows the system's again): `locale()`, `Intl`, `fontScale()` and text
follow at once ([Device and environment](./device-and-environment.md#in-an-embedding-app)).

`AppView::set_theme_overrides(Some(json))` puts your app's brand over the app's [theme](./tailwind.md#theme-tokens): a theme file
in the format of `nsh.json`'s `"theme"`, whose tokens win over the app's of the same names in light and dark mode
while the app's others stay; classes such as `bg-primary` restyle at once, and apps loaded later start with it
(`None` gives the app its own theme back; a file that does not parse is an error and changes nothing).

Native components are registered with `AppView::register_component`; see
[Native components](./native-components.md#registering-on-windows-rust). `set_ui_sets(sets)` sets the UI sets every
engine serves: NSH's (`nsh_base::registry()`) and your crates' (`my_app::registry()`, which `#[native_module]`
makes), so the TSX a view loads imports your Rust components and modules too.

## What differs on Windows

The environment is a desktop's: the safe area and the keyboard height are 0, `idiom()` is the desktop
(`platform.idiom` is `"desktop"`) and `os_version()` (`platform.version`) is `"10.0"` (on Windows 11 too: Windows kept the version number). Dark mode
follows Settings > Personalization > Colors live, `fontScale()` the Text size setting, reduce motion the animation
effects setting and the locale the user's regional format. See [Device and environment](./device-and-environment.md).

### Keyboard

| Keys | Do |
|---|---|
| Return | In an `Input`, what `submitBehavior` says: submit (`onSubmit`), submit and leave the field, or a new line (multiline inputs) |
| Shift+Return, Alt+Return | A new line in a multiline input whose return submits (Ctrl+Return submits) |
| Tab, Shift+Tab | The next / previous text field, within the newest dialog; the field's text is selected, as in Windows' dialogs |
| Escape | Leaves the focused field; else clears a text selection, then closes the newest dialog or goes back |
| Alt+Left, Browser Back key, mouse back button | Go back (also from a field) |
| Ctrl+arrows, Home / End, Ctrl+Home / End, with Shift; Ctrl+Backspace / Delete | Move, select and delete by word and line in a field, as in every Windows app |
| Ctrl+Z, Ctrl+Y, Ctrl+X / C / V / A; Shift+Delete, Ctrl+Insert, Shift+Insert | Undo, redo, cut, copy, paste, select all (a `masked` field refuses cut and copy); Ctrl+A / Ctrl+C select and copy `selectable` text |
| Arrows; Page Up / Down, Space, Shift+Space; Home / End, Ctrl+Home / End | Scroll the scroll view around the focused view or under the mouse by a line, a page, to the start / end (not while a field has the focus) |
| F11, Alt+F4 | Full screen, close the window (`nsh package` and `nsh run` apps) |
| Ctrl+R, F5 | Reload the latest build (`nsh run`) |

Shortcuts work with any keyboard layout (on a Cyrillic or Greek one, Ctrl+C is the key that types C on a US layout).
A return that commits an input method's composition (Chinese, Japanese, ...) never submits. `onKeyPress` reports
what React Native reports: the typed text, `"Enter"`, `"Backspace"`, and `"Escape"`; pasted text is not reported.

The app's own shortcuts ([`keymap`](../modules/nsh.md#keymap)) come before a focused field's keys, navigation
and scrolling; Alt+F4, F11 and Ctrl+Q cannot be bound.

Different, or not supported:

- **`WebView`**: a page inside a view with a 3D transform (perspective) is not shown, and a `backdropFilter` over a
  page does not blur it. `baseUrl` takes `http(s)` URLs. A native component that brings a window of its own
  stays above everything NSH draws.
- **Video**: the formats the installed codecs decode; no poster; the control bar always shows with `controls`.
- **Zooming scroll views** (`zoomTo`, the zoom props); the scroll indicator cannot be dragged.
- **`mixBlendMode` and `backdropFilter`** are drawn, but not inside a view that has a `filter` or a 3D transform;
  `borderCurve: "continuous"` draws circular corners.
- **Text**: head and middle ellipses on a single line only (more lines get a tail ellipsis); color emoji from COLR
  fonts only; small caps only where the font has them.
- **Text inputs**: keyboard types and autofill do not apply (there is no software keyboard); Tab moves between text
  fields. A right click opens the edit menu (Undo, Cut, Copy, Paste, Delete, Select All), as on selectable text (Copy,
  Select All).
- **Accessibility** (UI Automation): alert dialogs and toasts are not exposed; headings report
  level 1.
- **Input accessory views** and the **status bar** (no desktop equivalent).

## See also

- [CLI](./cli.md): `nsh run --target windows`, `nsh package --target windows`
- [Packaging](./packaging.md)
- [Platform-specific code](./platform-specific.md)
