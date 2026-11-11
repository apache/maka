# Platforms built outside NSH

NSH ships the backends of iOS, Android, macOS, Windows, Linux, GPUI, the terminal and the web. A platform beyond
them is built and maintained outside this repository, by whoever needs it, on the same public API NSH's own backends
use: the engine (`nsh-engine`), the mount items and text engine of the core (`nsh-core`), and the command line's
external targets. This page is the reference for those extension points. Its worked example is
[`nsh-platform-miniprogram`](https://github.com/huacnlee/nsh-platform-miniprogram), a demonstration platform that
runs NSH apps in WeChat Mini Programs; each section points at the part of it that uses the extension point.
User-facing page: `website/docs/platform-extensions.md`.

## What NSH provides

| Extension point | Where | What a platform does with it |
|---|---|---|
| The engine | `nsh_engine::Engine` (a thread of its own), `nsh_engine::LocalEngine` (driven by the host's event loop) | Runs the app: the core, layout, the reactive graph, the app's components, QuickJS for TSX (feature `js`) |
| Mount batches | `nsh_engine::MountSink`, `nsh_core::MountItem` | Receives one batch per commit and applies its items to the platform's views |
| Text | `nsh_core::TextEngine` | Measures and lays out text on the engine's side, with the platform's fonts |
| Input | `nsh_engine::EngineControl` | Sends events, scroll offsets, sizes, environment changes and display frames to the engine |
| The environment | `nsh_core::platform::Environment`: `platform`, `os`, `idiom` | Says where the app runs: `platform` is the platform's own name (`platform.name`), `os` the device's OS |
| Host services | `EngineConfig`'s `network`, `storage`, `filesystem`, `assets`, `clipboard`, ... | Optional: each is the platform's implementation of a service apps use |
| The command line | `nsh <dev\|run\|test\|package> --target <name>` → `nsh-platform-<name>` | Builds, runs and packages apps for the platform (`crates/nsh-cli/src/platforms.rs`) |
| A Rust app's root | `.nsh/rust/rust-app` (`nsh_rust_app`): `ui_sets()`, `app_ui_sets()`, `root()` | Links the app's crates into the platform's runner without generating that code itself |

What NSH keeps for itself: the core's mount items, the text engine's split, the engine's threads and the event kinds
are NSH's protocol and change with NSH; a platform follows NSH's releases as NSH's own backends do (pin the NSH version
it is built against, and build it again for a new one).

## The engine

A platform starts one engine per surface (`docs/dev/architecture.md`): `Engine::start(config, make_text_engine,
sink)` on a thread of its own, or `LocalEngine::start(config, text_engine, sink)` where the host has no threads to
block (WebAssembly in a browser or a Mini Program's logic layer). `EngineConfig::new(app)` gives a phone-sized
surface with nothing else; set what the platform has over it:

```rust
let config = EngineConfig {
    viewport: Size::new(Points(width), Points(height)),
    environment: Environment { os: Os::Ios /* the device's */, platform: Some("miniprogram"), idiom: Idiom::Phone, ..Environment::default() },
    header_heights: nsh_core::NO_NATIVE_HEADER, // the platform draws no header of its own
    ui_sets,
    ..EngineConfig::new(App::Rust(root))
};
let engine = LocalEngine::start(config, text_engine, sink)?;
```

A `LocalEngine` runs when the host calls `pump()`, which returns when it is due again (`Option<Instant>`): the
host's timer calls `pump` then, and after every input it sends (`set_wake` covers work woken outside a pump).
`nsh-platform-miniprogram`'s `Runtime` (`crates/nsh-platform-miniprogram/src/lib.rs`) is a complete example: start,
pump, frames, events, scrolling and size changes in about a hundred lines.

`nsh-engine` with `default-features = false` is the engine for apps written in Rust: no QuickJS, no bundler, and it
builds for `wasm32-unknown-unknown`. The feature `js` adds QuickJS for TSX apps (a C library: the platform's target
needs a C toolchain).

## Mount batches

`MountSink::submit` receives each commit's `MountBatch`, in order. Its items create, insert, move, remove and delete
views, set their frames (relative to the parent, in points), decoration (`ViewStyle`), text (`Text`, with the layout
the platform's text engine made), events, scroll configuration and images; `nsh_core::MountItem`'s docs describe each.
The rules every backend follows:

- Apply items in order: `Insert` refers to views earlier items created. `Insert`'s `before` is a sibling (the child goes
  below it in drawing order; `None`: on top), never an index.
- Frames are final: the core laid everything out, so a platform places views at their frames and never lays them
  out itself. A platform without absolute positioning still sets each view's size and offset from them.
- A view reports only the events in its `Events` mask; the main thread answers nothing by waiting for the engine
  (`AGENTS.md`, "The main thread never waits for JS").
- Items a platform does not show are skipped: the batch stays consistent without them.

`MountSink`'s other methods are optional: `request_frame` (call `EngineControl::frame` at the next display frame),
`report_error` / `report` (show the app's errors), `needs_tree_order` (add logical tree order to batches), `resized`,
`run_on_main_thread` (run an app's `MainThreadTask` on the UI thread after the batches submitted before it; the
default runs it at once on the engine thread, which suits a platform whose engine runs on its UI thread).

In `nsh-platform-miniprogram`, `encode.rs` turns each batch into JSON operations, and the Mini Program's runtime
(`runtime/nsh/tree.js`) applies them to a tree of plain objects and updates the page with the fewest `setData` paths;
a recursive component draws each node at its frame.

## Text

`TextEngine` runs on the engine's side: `prepare` once per content, `measure` at any number of widths during layout,
`layout` once at the final size (`docs/dev/text.md`). The `TextLayout` it returns is the platform's own object
(`TextLayout(Arc<dyn Any>)`), which `MountItem::Text` carries back to the platform to draw: the platform decides what
a layout holds. `breaks_lines_greedily` returning true lets the core reuse a measurement across widths.
`ApproxTextEngine` (`nsh_core`) is a deterministic stand-in for tests.

`nsh-platform-miniprogram`'s `text.rs` measures with the host's canvas (`measureText`), breaks lines itself and hands
the render layer each line's text and position, so the page draws lines exactly where the engine measured them.

## Input and the environment

`EngineControl` (from `engine.control()`) sends what the user does: `dispatch_event(id, kind, payload)` (a press is
`EventKind::Press` with `EventPayload::None` where the platform does not know the pointer), `scroll(id, offset,
applied)`, `resize(size)`, `set_environment(environment)` (appearance, safe areas, locale, ...), `frame()`.

`Environment::platform` names a platform built outside NSH (`Some("miniprogram")`); NSH's own platforms leave it
`None`. Apps read it as `platform.name` (TSX) and `platform_name()` (Rust, `nsh_core::prelude`), which is the OS's
name (`ios`, `web`, ...) on NSH's own platforms (`Environment::platform_name`). The name is lower case and none of
`Os`'s; it is the same name as the command line's `--target`. A Mini Program is a platform that runs on an operating
system, so the environment holds both: the platform's name and the OS beneath it.

`Environment::os` is always the device's real OS (`platform.os`, `os()`), so a platform built outside NSH picks the `Os` it
runs on: the Mini Program platform reports iOS or Android from `wx.getDeviceInfo().platform`, and in WeChat DevTools
the simulated device's `system`. The OS's props (`ios={{…}}`, `android={{…}}`) then apply as they do on that OS, and
the backend skips the mount items it does not show. `Idiom` says whether desktop behavior applies (`Idiom::Desktop`)
or mobile (`Phone`, `Pad`).

## WebAssembly hosts

On `wasm32-unknown-unknown`, NSH's crates import a few functions from their host, module `nsh`, which a platform
running there provides alongside its own:

| Import | Crate | What it returns |
|---|---|---|
| `now_ms() -> f64` | `nsh-core` (`time.rs`) | A monotonic clock in milliseconds (`performance.now()`) |
| `date_now_ms() -> f64` | `nsh-core` (`time.rs`) | The wall clock in milliseconds since the Unix epoch (`Date.now()`) |
| `local_offset(ms: f64) -> f64` | `nsh-base` (`calendar.rs`) | Local time's offset from UTC at `ms`, in seconds east |

A module asks only for what it links. `nsh-platform-miniprogram` reads its module's import section when it packages an
app and fails when the runtime does not provide one (`crates/nsh-platform-miniprogram-cli/src/wasm.rs`), so a newer
NSH that asks its host for more is caught at build time.

## The command line: external targets

`nsh dev`, `nsh run`, `nsh test` and `nsh package` with a `--target` that is none of NSH's own run the executable
`nsh-platform-<name>` found on `PATH`, as Cargo runs `cargo-<name>` for a subcommand it does not know
(`crates/nsh-cli/src/platforms.rs`):

```sh
nsh package examples/counter --target miniprogram --out dist
# runs: nsh-platform-miniprogram package examples/counter --out dist
```

- The platform gets the command and every argument but `--target` and its value, in their order (global flags
  such as `-v` included; past `--` nothing is read).
- Its environment has `NSH` (the nsh executable: the platform calls it back, `$NSH build <app>`), `NSH_VERSION`
  and `NSH_TARGET` (the name).
- Its exit code is the command's.
- `nsh` reports a name with no such program on `PATH`, listing NSH's own targets; names are lower-case ASCII
  letters, digits and dashes, starting with a letter.

A platform's program implements the commands that apply to it and reports the others (the Mini Program target runs
no tests itself: `nsh test` runs an app's tests headless, on the engine the platform runs).

## A Rust app's root

For an app written in Rust (`nsh.json` `"rust"` and `"root"`), every `nsh` command that builds it writes the Cargo
workspace `.nsh/rust` (`crates/nsh-cli/src/rust_app.rs`), whose crate `rust-app` (lib `nsh_rust_app`) is for
platforms built outside NSH:

```rust
pub fn ui_sets() -> Vec<nsh_core::element::Registry>;     // nsh/base, then the app's crates'
pub fn app_ui_sets() -> Vec<nsh_core::element::Registry>; // the app's crates' only: their files (fonts) without nsh/base's TSX registry
pub fn root() -> nsh_core::element::Root;                 // the root component with nsh.json's theme, appearance, id, ...
```

It takes NSH's crates from where the app's crates do (crates.io at the CLI's version, or a checkout), so a platform's
runner depends on it by path and takes its own NSH crates from the same place (a `[patch.crates-io]` to the checkout
when `rust-app`'s `nsh-core` is a path), and the app and the backend share one `nsh-core`. `app_ui_sets` serves a
platform that runs no TSX: its module then links only the base components the app's code uses.

`nsh-platform-miniprogram-cli/src/runner.rs` writes such a runner: a `cdylib` with one line,
`nsh_platform_miniprogram::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root())`.

## The worked example: WeChat Mini Programs

[`nsh-platform-miniprogram`](https://github.com/huacnlee/nsh-platform-miniprogram) is a demonstration, built outside
NSH to show the extension points at work, and open to a maintainer who wants to take it further (its README). Its
layout:

| Part | What it does | Extension points |
|---|---|---|
| `crates/nsh-platform-miniprogram` | The backend, a library built for `wasm32-unknown-unknown`: `Runtime` (a `LocalEngine`), `encode.rs` (mount items → JSON operations), `text.rs` (a `TextEngine` on the host's `measureText`), `effects.rs` (styles as CSS), `anim.rs` (the core's `Animator`, ticked on the host's frames), `ffi.rs` (the module's exports and imports) | The engine, mount batches, text, input, `Environment::platform` (`"miniprogram"`) with the device's `Os`, the WebAssembly host imports |
| `crates/nsh-platform-miniprogram-cli` | `nsh-platform-miniprogram`: `package`, `run` / `dev`; writes the runner, builds it, checks its imports, writes the Mini Program project with the module brotli-compressed | External targets, `nsh_rust_app` |
| `runtime/` | The Mini Program's side: `nsh/nsh-mp.js` (loads the module, timers, events), `nsh/tree.js` (the tree and its `setData` paths), the recursive `nsh-node` component, the page | — |

Its tests show how each part is checked without the platform's own tools: the backend runs an app on a
`LocalEngine` on the host and checks the operations a press produces; the runtime's tree is tested on Node; and a
packaged app's real module runs on Node through the real `nsh-mp.js`, with stand-ins for the Mini Program's APIs.
