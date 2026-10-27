---
title: macOS
description: Run Rust and TSX NSH apps on macOS in AppKit windows, package them as .app bundles, embed them in a Mac app with AppView, and what differs on macOS.
order: 13
group: platforms
---

# macOS

NSH apps also run as native Mac apps. The macOS backend renders them with AppKit views and Core Animation and lays out
text with CoreText; the core, the reactive graph, the renderer, Taffy layout and the native modules are the
same as on iOS and Android, so one app runs everywhere. On macOS, `os()` is `Os::MacOs` (`platform.os` is `"macos"`
in TSX) and TSX's `desktop={{…}}` props apply. The window's title, a title bar of the app's own, the menu bar and
context menus come from `nsh_core::element::desktop` in Rust ([Desktop title bars](./rust.md#desktop-title-bars)) and
[`nsh/desktop`](../modules/nsh-desktop.md) in TSX.

The macOS backend behaves like a desktop app: mouse, trackpad and keyboard input, resizable windows, dialogs
over the window and a menu bar.

## Requirements

- **macOS 14** or later, where the app runs.
- Xcode's command line tools (`xcode-select --install`), to build Rust apps' runners and NSH's macOS runtime from a
  checkout, and to package apps (`codesign`, `sips`). The distribution made with `cargo xtask dist` on a Mac ships the
  runtime of TSX apps in `runtime/macos/`.

## Running an app

A Rust app runs from its directory:

```sh
nsh run --target macos         # the default on a Mac
```

`nsh` builds a debug runner with your crate and opens the app in a window, with its logs (`log::info!` and the rest)
in the terminal; a change to the crate's Rust code builds the runner again and restarts the app. `cargo run` starts
the same root from the crate's `src/main.rs`, which `nsh init --template rust` writes: [`run_app`](#embedding-in-a-mac-app)
with `AppSource::Rust`.

A TSX app names its entry:

```sh
nsh run App.tsx --target macos
```

The app opens in an AppKit window (1200×800 by default), with hot reload, logs in the terminal and the error overlay as
on the other targets; Cmd+R reloads the latest build. The menu bar and the window show the app's name (nsh.json
`"name"`, else its directory's). In a checkout, `nsh run` builds the development host
(`nsh-macos-host`) first. Stopping `nsh run` closes the window, and closing the window ends `nsh run`. The host also
runs a built bundle on its own:

```sh
nsh build my-app --release -o build
dist/nsh/runtime/macos/nsh-macos-host --bundle build/bundle.nshc --window-size 1200x800   # in a checkout: target/debug/nsh-macos-host
```

`--window-size` is the window's initial size (TSX apps); the window can be resized. `--display <n>` (`nsh run` / `nsh test
--target macos --display <n>`) centers it on display `n`: `1` is the primary display, the one with the menu bar.

`nsh test --target macos` runs a TSX app's tests in macOS windows, on a secondary display when there is one (the main
screen stays yours; `--display <n>` picks another): each app a test opens gets a window of its own, at the size the
test asks for even on a display shorter than it, and
the steps click, type and scroll with the system's input at the views their selectors name
([Testing](./testing-and-trace.md#on-a-real-platform)).

### Performance monitor

`--fps` (`AppOptions { fps: true, .. }` in a Rust app's `run_app`, `AppView::set_fps_monitor(true)` when embedding,
`nsh run App.tsx --target macos --fps`, the host's `--fps`, or a packaged TSX app's `open -a MyApp --args --fps`) shows a panel at the top right of the
app that updates twice a second:

| Row | Measures |
|---|---|
| `FPS` | Frames shown over the last second: display refreshes in which the app changed (an idle app reads low; that is not slowness). `max` is what the main thread could keep up with, then the display's rate (120 Hz on ProMotion screens). |
| `TICK` | The gaps between display refreshes as they arrived (mean, p95) and `gap`, the p95 gap between shown frames: one refresh (8.3 ms at 120 Hz) when nothing is late. |
| `MAIN` | Main-thread time per frame (applying the engine's changes, drawing text and canvases, animations, input), its 95th percentile, and `drop`: the share of frames that took longer than one refresh. |
| `JS` / `CORE` | Per commit: your code (handlers, timers, list rows) and NSH's core (layout, text, diffing); commits per second, native view changes per commit. |
| `HOP` | How long changes wait between the engine thread and the main thread; how busy the engine thread is. |
| `CPU` / `GPU` / `MEM` | The process: CPU (100% is one core), its GPU share, its memory footprint (Activity Monitor's figure). |

The bars below are the last 120 frames' main-thread time against one refresh (the line): green within half of it, amber
within it, red over. While the panel shows, the readings are also logged once a second (target `nsh::perf`, in the
Linux backend's shape with macOS's frame phases `tick`, `drain` and `canvas`; milliseconds as mean/p50/p95/max), which
`nsh test --fps -v` shows and `examples/gallery/tools/perf.py` reads. Measure release builds; the monitor costs nothing
while it is off.

## Packaging

```sh
nsh package --target macos [--run]           # a Rust app, from its directory
nsh package App.tsx --target macos [--run]   # a TSX app
```

Writes an app bundle:

```text
.nsh/out/<Name>.app/Contents/
  Info.plist
  MacOS/<Name>               the executable: a Rust app's own runner, built with its crate; nsh's release runner for TSX
  Resources/nsh/bundle.nshc  a TSX app, compiled
  Resources/nsh/assets/…     the assets it imports (a Rust crate's `assets!()` too)
  Resources/nsh/app.json     the window title and the app's appearance
  Resources/AppIcon.icns     the icon, when nsh.json names one (converted with sips)
```

The `.app` is signed ad hoc, so it runs on the Mac that built it. To distribute it, sign it with a Developer ID and
notarize it. `--run` opens the app after packaging it.

## Embedding in a Mac app

The `nsh-platform-macos` crate (from the NSH repository) gives a Rust Mac app `AppView`: one NSH engine as an `NSView`.
Each `AppView` is independent; several can run at once. It runs a Rust root, the root component of your crate:

```rust
use std::rc::Rc;
use nsh_platform_macos::{
    objc2::MainThreadMarker, objc2_app_kit::NSWindow, set_ui_sets, AppOptions, AppView, Root,
};

fn show(window: &NSWindow) -> Rc<AppView> {
    // Once, before the first view: the UI sets the apps import (NSH's and your crate's).
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let mtm = MainThreadMarker::new().expect("main thread");
    let view = AppView::new(mtm, AppOptions::default());
    // register native components here, before loading
    view.load(Root::of::<my_app::App>().into());
    window.setContentView(Some(&view.view()));
    // Keep the view while the window shows it; `stop` it when the window closes.
    view
}
```

`Root::tokens` gives the root its [theme](./rust.md#theme) (`nsh_base::Theme::from_json(json)?.into_tokens()`) and
`Root::app_id` the id its data is kept under. A TSX bundle that `nsh build` wrote loads into the same view:

```rust
use nsh_platform_macos::{AppOptions, AppView, AssetBase, Bundle};

let view = AppView::new(mtm, AppOptions {
    asset_base: Some(AssetBase::Directory("app/assets".into())),
    ..AppOptions::default()
});
let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
view.load(Bundle::source(code).into());
```

`AppView::load` replaces whatever ran; `stop` ends the app. `asset_base` tells it where `asset:/` URIs resolve
(`AssetBase::Directory` or `AssetBase::Http`). Bytecode bundles (`bundle.nshc`) load with
`unsafe { Bundle::bytecode(bytes) }`: bytecode is trusted input, so only load it from your own app's files.
For an app that is only an NSH app, `run_app(source, options)` (`AppSource::Rust(root)` or `AppSource::Bundle(bundle)`) opens one `AppView` in a window with a standard menu
(About, Hide, Quit, Edit, Minimize, Zoom, Enter Full Screen, Close), which the app can replace with
`Menu.setApplicationMenu` ([`nsh/desktop`](../modules/nsh-desktop.md)), and runs until the window closes.
By default, closing the window or choosing Quit stops the engine and returns from `run_app`;
the caller can then finish cleanup or relaunch its executable.

Set `AppOptions { keep_alive_on_close: true, ..Default::default() }` to keep the
standalone session alive when its window closes. Closing hides the window;
reopening from the Dock shows that same window and engine. For an explicit Exit
or update relaunch, call `nsh_platform_macos::quit_app()` from any thread. It
closes the retained window, stops the engine and returns from `run_app`.
`nsh_core::element::desktop::close_window()` follows the chosen window-close policy.


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
[Native components](./native-components.md#registering-on-macos-rust). `set_ui_sets(sets)` sets the UI sets every
engine serves: NSH's (`nsh_base::registry()`) and your crates' (`my_app::registry()`, which `#[native_module]`
makes), so the TSX a view loads imports your Rust components and modules too.

## What differs on macOS

The environment is a desktop's: the safe area and the keyboard height are 0, `idiom()` is the desktop
(`platform.idiom` is `"desktop"`), `os_version()` (`platform.version`) is the macOS version, and dark mode follows the system's appearance live. See
[Device and environment](./device-and-environment.md).

Input is a desktop's: the mouse, the trackpad (scrolling with momentum, pinch and rotation) and the keyboard.
`selectable` text is selected by dragging, double- and triple-clicking, and copied with Cmd+C. Escape, Option+Left,
Cmd+[ and the mouse's back button close the newest dialog or go back in a stack (Escape in a focused field or web page
only leaves it; a page gets these keys first, and keeps those it uses); a `Dialog` is a layer over the whole window
that shows the app's popup and backdrop. Pages show their `header` at the top. A click anywhere in an `Input`, its padding too, puts the caret at the nearest
point. `AlertDialog` shows an `NSAlert` sheet on the window: up to two alert actions in a row (the cancel
action leftmost, the last regular one the default for Return), more actions and an action sheet's actions stacked in
their order with the cancel action last and no default; Escape chooses the cancel action.

### Keyboard

| Keys | Do |
|---|---|
| Return | In an `Input`, what `submitBehavior` says: submit (`onSubmit`), submit and leave the field, or a new line (multiline inputs) |
| Return, keypad Enter, Space | Activate a focused view with `onPress` once on key-down; auto-repeat is consumed |
| Shift+Return, Option+Return, Ctrl+Return | A new line in a multiline input whose return submits |
| Tab, Shift+Tab (Ctrl too) | The next / previous field or pressable view in screen order, within the newest dialog; Option+Tab types a tab in a multiline input |
| Escape | Leaves the focused field; else clears a text selection, then closes the newest dialog or goes back |
| Option+Left, Cmd+[, mouse back button | Go back (not while a field has the focus: there Option+Left moves the caret) |
| Option / Cmd + arrows, with Shift; Option+Delete, Cmd+Delete; Ctrl+A / E / K | Move, select and delete by word and line in a field, as in every Mac app |
| Cmd+Z, Shift+Cmd+Z, Cmd+X / C / V / A | Undo, redo, cut, copy, paste, select all (a `masked` field refuses cut and copy); Cmd+A / Cmd+C select and copy `selectable` text |
| Arrows; Page Up / Down, Space, Shift+Space, Option+Up / Down; Home / End, Cmd+Up / Down | Scroll the scroll view around the focused view or under the mouse by a line, a page, to the start / end (not while a field has the focus) |
| Cmd+W, Cmd+M, Ctrl+Cmd+F, Cmd+H, Option+Cmd+H, Cmd+Q | Close, minimize, full screen, hide, hide others, quit (`nsh package` and `nsh run` apps' menus) |
| Cmd+R | Reloads the latest build (`nsh run`) |

The app's own shortcuts ([`keymap`](../modules/nsh.md#keymap)) come before these, except activation keys addressed to a focused pressable view, Quit, Hide,
Minimize and Full Screen, which cannot be bound.

Shortcuts work with any keyboard layout (on a Cyrillic or Greek one, Cmd+C is the key that types C on a US layout).
A return that commits an input method's composition (Chinese, Japanese, ...) never submits. `onKeyPress` reports
what React Native reports: the typed text, `"Enter"`, `"Backspace"`, and `"Escape"`.

Not supported, or different:

- **Zooming scroll views** (`zoomTo`, the zoom props).
- **`mixBlendMode`**, and `brightness()` above 1.
- **Inputs**: content types and autofill, keyboard types, autocapitalization, letter spacing; input accessory views
  are never shown (there is no software keyboard) and `keyboardShouldPersistTaps` is ignored.
- **`WebView`'s `scrollable={false}`** keeps the mouse wheel and the trackpad from scrolling the page: they scroll
  the app's scroll views around it, as on iOS. The page still scrolls with its keyboard (Space, the arrows) and its own
  scripts, and trackpad swipes between its pages (`allowsBackForwardNavigationGestures`) stop as well.
- **Accessibility**: custom `accessibilityActions`.
- **The status bar** and **haptics** (no desktop equivalent).

## See also

- [CLI](./cli.md): `nsh run --target macos`, `nsh package --target macos`
- [Packaging](./packaging.md)
- [Platform-specific code](./platform-specific.md)
