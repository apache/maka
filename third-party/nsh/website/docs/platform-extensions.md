---
title: Building a platform
description: "Bring Native Shell apps to a platform of your own: the engine, mount batches, text and input a backend implements, the nsh command line's external targets, and the WeChat Mini Program platform as a worked example."
order: 17
group: platforms
---

# Building a platform

Native Shell's backends for iOS, Android, macOS, Windows, Linux, GPUI, the terminal and the web are built on a public engine, and so is any other platform. A platform built outside NSH lives in a repository of its own, on the API NSH's own backends use: the engine runs the app (its components, layout, reactivity and text measurement), and the backend shows what the engine commits with the platform's own UI and sends the user's input back. The `nsh` command line runs such a platform by its name: `nsh package --target miniprogram` runs the program `nsh-platform-miniprogram`.

This page walks through the parts of a backend with a complete example, [`nsh-platform-miniprogram`](https://github.com/huacnlee/nsh-platform-miniprogram), which runs NSH apps written in Rust in WeChat Mini Programs. It is a demonstration of the extension points, and its README invites a maintainer who wants to take it further.

## Using a platform built outside NSH

A platform ships as a program named `nsh-platform-<name>`. Install it so that it is on your `PATH`, then use its name as a target:

```sh
cargo install --git https://github.com/huacnlee/nsh-platform-miniprogram nsh-platform-miniprogram-cli
rustup target add wasm32-unknown-unknown

nsh package my-app --target miniprogram --out dist   # a project WeChat DevTools opens
nsh run my-app --target miniprogram                  # builds it and opens it in WeChat DevTools
```

Apps check the platform as they check any other: `platform.name` is `"miniprogram"` in TSX, and `platform_name()` in Rust. `platform.os` (`os()` in Rust) is the device's operating system, iOS or Android, so the app's `ios={{…}}` and `android={{…}}` props apply as they do there. The platform's own README lists what it shows and which commands it has.

## How a platform fits together

```
Your app            components, layout, state: the same code on every platform
nsh-engine          runs the app; commits one batch of changes per turn
Your backend        applies each batch to the platform's views; measures text; sends input back
nsh-platform-<name> the command line's target: builds, runs and packages apps for the platform
```

A backend has four jobs, each with one interface in NSH:

| Job | Interface | Mini Program platform |
|---|---|---|
| Run the app | `nsh_engine::Engine` or `LocalEngine` | `LocalEngine` in WebAssembly, in the Mini Program's logic layer |
| Show what it commits | `nsh_engine::MountSink`, `nsh_core::MountItem` | JSON operations, applied to the page with `setData` |
| Measure text | `nsh_core::TextEngine` | The logic layer's `measureText`; lines broken on the engine's side |
| Send input back | `nsh_engine::EngineControl` | Taps as `onPress`, scroll offsets, size and appearance changes |

## 1. Start the engine

The engine runs the app on the platform's thread: `Engine` on a thread of its own, or `LocalEngine` where the platform's event loop drives it (WebAssembly, where there are no threads to block). Start it with an `EngineConfig` that says where the app runs. A platform built outside NSH puts its name in `platform` and the device's operating system in `os`: a Mini Program is a platform that runs on iOS or Android. The Mini Program platform reads the OS from `wx.getDeviceInfo().platform`, and in WeChat DevTools from the simulated device's `system`.

```rust
use nsh_core::{Points, Size, platform::{Idiom, Os}};
use nsh_engine::{App, EngineConfig, Environment, LocalEngine};

let config = EngineConfig {
    viewport: Size::new(Points(375.0), Points(667.0)),
    environment: Environment {
        os: Os::Ios,                    // the device's: platform.os in the app
        platform: Some("miniprogram"),  // platform.name in the app
        idiom: Idiom::Phone,
        ..Environment::default()
    },
    header_heights: nsh_core::NO_NATIVE_HEADER, // pages place their own header
    ui_sets,
    ..EngineConfig::new(App::Rust(root))
};
let mut engine = LocalEngine::start(config, text_engine, sink).expect("the app starts");
```

`LocalEngine::pump()` runs what is due and returns when it is due again: the platform calls it at that time and after each input. Depend on `nsh-engine` with `default-features = false` for apps written in Rust: the engine then builds for `wasm32-unknown-unknown` too.

## 2. Show what the engine commits

The engine hands the backend one `MountBatch` per commit through `MountSink::submit`. Its items create views, insert them into their parents, set their frames, decoration, text, images and the events they report, and remove them. Every frame is final, laid out by the engine in points relative to the parent, so the backend places each view where its frame says:

```rust
impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        for item in &batch.items {
            match item {
                MountItem::Create { id, kind } => { /* make a view of `kind` */ }
                MountItem::Insert { parent, child, before } => { /* below `before`, or on top */ }
                MountItem::Frame { id, frame } => { /* place it at `frame` */ }
                MountItem::ViewStyle { id, style } => { /* background, corners, borders, opacity */ }
                MountItem::Text { id, layout, content, .. } => { /* draw the layout at `content` */ }
                MountItem::Events { id, events } => { /* report the events in the mask */ }
                _ => {}
            }
        }
    }
}
```

Apply the items in order; skip the kinds the platform does not show. The Mini Program platform encodes each batch as a JSON array (`["c", 2, "view"]`, `["f", 2, 0, 0, 100, 40]`, …), keeps the views as a tree of plain objects in the logic layer and updates the page with the fewest `setData` paths, where a recursive component draws each view at its frame.

## 3. Measure text

Text is laid out on the engine's side, once: `TextEngine::prepare` for each content, `measure` at the widths layout tries, and `layout` at the final size. The layout is the platform's own object, which `MountItem::Text` brings back to the backend to draw:

```rust
impl TextEngine for MiniProgramTextEngine {
    type Prepared = Prepared;
    fn prepare(&self, text: &AttributedText) -> Prepared { /* the font, the pieces lines break between */ }
    fn measure(&self, p: &Prepared, max_width: Option<Points>) -> Size<Points> { /* the widest line, the lines' height */ }
    fn layout(&self, p: &Prepared, size: Size<Points>) -> TextLayout { /* each line's text and position */ }
}
```

The Mini Program platform measures with the logic layer's canvas, breaks lines at spaces and between CJK characters, and draws each line at the position it was measured at, so the page shows text exactly as the engine laid it out.

## 4. Send input back

`EngineControl` sends what the user does: `dispatch_event(id, EventKind::Press, EventPayload::None)` for a tap on a view that reports presses, `scroll(id, offset, 0)` as a scroll view moves, `resize(size)` and `set_environment(environment)` when the window or the appearance changes, `frame()` at the display frame the engine asked for (`MountSink::request_frame`).

## 5. Add the command line's target

`nsh dev`, `nsh run`, `nsh test` and `nsh package` with a `--target` none of NSH's own run `nsh-platform-<name>` from your `PATH`. It gets the command and every other argument, and the environment variables `NSH` (the `nsh` executable, to call back), `NSH_VERSION` and `NSH_TARGET`; its exit code is the command's:

```sh
nsh package my-app --target miniprogram --out dist
# runs: nsh-platform-miniprogram package my-app --out dist
```

For an app written in Rust, `$NSH build <app>` writes the crate `.nsh/rust/rust-app` (`nsh_rust_app`), which has the app's root and UI sets as functions: the platform's runner depends on it by path and starts the app with them. The Mini Program platform's runner is one line:

```rust
nsh_platform_miniprogram::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root());
```

`app_ui_sets()` gives the app's own crates' UI sets (with the fonts and files they ship) without `nsh/base`'s registry for TSX, so the module links only the components the app uses; `ui_sets()` gives both.

## Testing a platform

Each part of a backend can be tested without the platform's own tools:

- **The backend**: start an app on a `LocalEngine` on your computer with the platform's sink and a deterministic text engine, and check what a press commits.
- **The platform's side**: test how it applies a batch with the platform's runtime or a stand-in for it.
- **The whole app**: run a packaged app with stand-ins for the platform's APIs. The Mini Program platform runs a packaged app's module on Node through its real runtime, taps the button and checks the count it shows.

Then open the app on the platform itself: `nsh run my-app --target miniprogram` opens the Mini Program in WeChat DevTools.

## Following NSH

A platform is built against a version of NSH: the mount items, the text engine and the events are NSH's protocol and grow with each release. Pin the NSH version your platform builds with, and release the platform again for each NSH release. On WebAssembly, NSH's crates import a few functions from their host (module `nsh`: `now_ms`, `date_now_ms`, `local_offset`); a platform checks its module's imports when it packages an app, so a new one shows at build time.

## See also

- [Platform overview](./platforms.md): NSH's own platforms.
- [Architecture](./architecture.md): the engine, mount batches and text on every platform.
- [Building with Rust](./rust.md): apps written in Rust and their root.
- [nsh-platform-miniprogram](https://github.com/huacnlee/nsh-platform-miniprogram): the WeChat Mini Program platform's source and README.
