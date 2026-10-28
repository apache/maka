# Architecture

## Data flow and threads

```
JS (engine thread, QuickJS)  the app's components on the native reactive graph; compiled JSX calls the native renderer (nsh:rt)
nsh-js                        the renderer decodes each change from its JS values (tags, style objects, event names) -> Op, queued natively
nsh-core (engine thread)      apply(Op) maintains the shadow tree -> commit(): render components, rebuild text, Taffy layout, diff frames -> MountBatch
Platform (main thread)       one main-queue hop per commit, applying MountItems to native views in order
Input                        native gestures -> EngineControl::dispatch_event -> engine thread -> JS handler
```

- The platform main thread never waits for JS (one bounded exception: macOS waits up to 16 ms for the layout at a new
  window size, `macos.md`).
- **Reactivity is native**: signals, memos, effects, owners and context are a graph in Rust (`crates/nsh-js/src/reactive.rs`,
  scheduled by Solid 1.9's algorithm) whose nodes are QuickJS objects of native classes, so the QuickJS GC sees the
  cycles through them. Apps reach it through `nsh` (`signal`, `computed`, `effect`, ...).
- **The runtime is native** (`native-pipeline.md`): a bundle is one ES module of the app's code importing NSH's native
  modules (`nsh`, `nsh:rt`, `nsh/*`, `js-modules.md`). The renderer pushes ops straight into the host's queue; one JS
  turn's ops become one `Core::commit`. Events reach handlers held on the nodes, list cells are bound natively, and
  animations settle natively.
- **Text is laid out once**: `TextEngine` (defined in core) runs `prepare` on the engine thread (Apple: CTFramesetter) → `measure` at various widths →
  `layout` at the final size after layout (Apple: CTFrame). `MountItem::Text` hands the immutable result to the main thread, which only draws it
  (`CTFrameDraw` in `TextView`'s `drawRect`); the main thread never lays out text. Android's counterpart is `StaticLayout` (like RN's PreparedLayout),
  Linux's Pango (glyph runs as plain data, drawn as `gsk::TextNode`s with the main thread's fonts), Windows' DirectWrite
  (glyph runs recorded through a text renderer of NSH's own, drawn with Direct2D's `DrawGlyphRun`), GPUI's text
  system (each style run shaped with a `WindowTextSystem` of the engine thread's own, lines broken by NSH, glyphs
  painted with `paint_glyph`).
  Implementations must not touch main-thread-only UI objects.
- Measure cache: one content-addressed LRU per engine (`MeasureCache`, two generations of hash maps, ≤1024 entries), keyed by a hash of the
  layout-relevant content (`AttributedText::layout_hash`, colors excluded) + the width constraint; nodes also cache `Prepared` and the final layout.
  A color-only change does not trigger layout, only a new final layout.
- One `Surface` (Apple, Linux, Windows) / `NshView` (Android) is one engine (one QuickJS runtime), with no global singletons, so NSH can be embedded in
  existing apps with several instances. `AppView` (Apple: a `UIView` or, on macOS, an `NSView`; Linux: a GTK widget; Windows: a window; GPUI: a GPUI view) wraps a surface for embedding and owns its dev session; a standalone app is
  just "one AppView filling the window".
- **Android**: the engine thread typesets with `StaticLayout` through JNI; each commit is one `byte[]` plus an object
  table handed to `Mounter.java` on the UI thread, and animation items stay in Rust (the flow, the units and the JNI
  rules: `crates/nsh-platform-android/src/encode.rs`).
  Display-density changes update the shared text density and remount the existing views. Sticky ranges are replayed
  even when their logical coordinates are unchanged: the Android scroll views cache them in pixels. Each scroll
  view saves its logical offset, waits for the new content size and viewport layout, and then restores it (clamped
  to the new bounds) before reporting to the core, without counting the rescale as a core scroll command. Commands
  arriving during that layout update the saved target. Modal windows invalidate their pixel-size report cache and
  report their new dp size even when Android keeps the same pixel bounds.
- **Linux** (GTK 4, `linux.md`): one `NshView` widget per node, placed at the core's frames in `size_allocate` and
  drawn with GSK nodes in `snapshot`; each commit wakes the GTK main loop once (`MainContext::invoke`); native
  animations run on the frame clock.
- **macOS** (AppKit, `macos.md`): one flipped, layer-backed `NSView` per node at the core's frames, decorated by Core
  Animation (the iOS backend's), text and canvases drawn in `drawRect:`, desktop input and scroll views as on Linux; each
  commit is one main-queue hop; native animations run on the root's display link.
- **Windows** (Win32, `windows.md`): one retained `NshView` per node, the whole tree drawn by the surface's window
  with Direct2D into a flip-model swap chain (no child windows but web views and components' own windows); each
  commit is one `WM_NSH_WAKE` posted to the window; native animations run on a ticker paced by the compositor
  (`DwmFlush`).
- **GPUI** (macOS, Windows, Linux; `gpui.md`): the Windows backend's retained `NshView` tree, painted by one GPUI
  element per surface with GPUI's primitives (`DrawCx` keeps the transform and opacity GPUI lacks); each commit is one
  closure on GPUI's main thread (`rt::invoke`), and every main-thread entry point ends with `rt::flush`, which
  notifies the views of changed surfaces; native animations run on the window's frames.
- **Terminal** (`tui.md`): one retained `Surface` per engine, drawn into a Ratatui buffer. The engine typesets
  terminal graphemes with `TerminalTextEngine`; the terminal loop applies each mount batch and handles focus,
  editing, scrolling and native animation locally. Layout remains in points (8×16 per cell by default); one
  per-surface worker rasterizes images and canvases and encodes supported terminal graphics protocols. Embedding hosts own terminal IO and event routing;
  `run_app` supplies raw-mode lifecycle and a full-screen loop. `Renderer::Terminal` keeps the rendering medium
  separate from the host OS.
- **Web APIs** (TS apps only; Rust code uses crates of its choice): `fetch` with `Headers` / `Request` / `Response`, the
  Streams API (readable streams with byte streams and BYOB readers, writable and transform streams, `pipeTo` /
  `pipeThrough`, `TextEncoderStream` / `TextDecoderStream`), `Blob` / `File` / `FormData`, `URL` / `URLSearchParams`,
  `TextEncoder` / `TextDecoder`, `Event` / `CustomEvent` / `EventTarget`, `AbortController` / `AbortSignal`: native
  classes in `crates/nsh-js/src/web/` (module docs there), made on first use of any of those globals (zero startup cost
  otherwise), as in browsers so libraries such as axios work (`fetch.rs` lists where they differ). `Intl`
  (`NumberFormat`, `DateTimeFormat`) and the `toLocaleString`s of numbers, BigInts and dates, which QuickJS lacks, are
  there too (`web/intl/`): formatted in Rust from hand-written tables of the common languages rather than CLDR (a few
  kilobytes instead of ICU4X's megabytes; trade-offs and limits in its module doc), in `Environment::locale` by
  default (the platform's region format: `NSLocale.currentLocale`, `Locale.getDefault()`).
- **Time**: an engine runs on a `nsh_core::time::Clock` (`EngineConfig::clock`), its thread's while it runs
  (`Clock::enter`): JS's timers, Rust tasks' timers, throttled scroll events, mouse moves and the frames' time read it
  through `nsh_core::time::now()`, `Intl` and `Date` through `unix_ms()`. The system's clock is the default. A manual
  one (`Clock::manual`) moves only when told: the loop no longer wakes for timers, and `EngineControl::advance_clock`
  steps it to each time something comes due on the way (timers, task timers, the clock's alarms such as a held-back
  response), running it before going on, as Playwright's `clock.runFor` and Jest's fake timers do. A manual clock
  that moves with frames (`Clock::with_frames`: a test's app on a real platform, `nsh test --target`) also moves to a
  frame after the last (`time::FRAME`) with each display frame, and runs the frames the app waits for on the way
  while it is moved. QuickJS reads the
  system's time in C for `Date` and `performance`, so on a manual clock `nsh-js` replaces them (`clock.rs`: a native
  `Date` constructor that hands the intrinsic the clock's time and shares its prototype, and a `performance` of the
  same shape). The idle collection keeps the system's time.
- **Networking**: requests go to the platform stack through `nsh_engine::Network`
  (NSURLSession, HttpURLConnection; ureq on Linux, on Windows and for `nsh test`), streaming both ways: the stack reports the response head,
  then body chunks as they arrive (`FetchEvent`), and JS can pause reading (back pressure); a streamed request body is
  sent in chunks the stack asks for one at a time (`FetchEvent::BodyWanted`, chunked transfer encoding).

## Layers

NSH is layered as GPUI Kit is (an architecture rule, `AGENTS.md`):

| NSH | GPUI Kit | What | JS |
|---|---|---|---|
| `nsh-core` (with `nsh-js`, the runtime) | `gpui` | Primitives, the environment, layout, rendering, the reactive graph | `nsh`, `nsh/mobile`, `nsh/desktop` |
| `nsh-base` | `gpui-base` | Unstyled base components: behavior, state, focus, keyboard, accessibility; the look is the app's | `nsh/base` |
| an app's own UI set, or a community crate | `gpui-component` | A styled component library | the crate's specifier (`app/native`) |

`nsh-base` has `gpui-base`'s scope: navigation, popups (popovers, menus, tooltips, sheets, on the core's overlays),
safe areas, system dialogs, the keyboard and the status bar today; controls (toggles, sliders, selects, ...) join as
their behavior is written. Its
components take the app's styles and children, expose their parts and report changes of state the app owns
(`components.md`). The styled layer is never part of NSH: apps build their own on `nsh/base` and the primitives, or
use one a third party publishes as a crate.

## Crates

Dependency direction: `nsh-core` ← `nsh-js` ← `nsh-engine` (also ← `nsh-package`) ← `nsh-platform-*` ← `nsh-ios-host` / `nsh-ios-app` / `nsh-linux-host` / `nsh-linux-app` / `nsh-macos-host` / `nsh-macos-app` / `nsh-windows-host` / `nsh-windows-app` / `nsh-gpui-host`; `nsh-cli` depends on `nsh-bundler`, `nsh-js` and `nsh-engine`; `nsh-base` depends on `nsh-core` only and is used by the bundler, the platforms and the CLI; an app's own crates (its UI sets, `components.md`) depend on `nsh-core` only. `nsh-core` must not depend on any platform or JS crate.

The CoreText, StaticLayout, Pango, DirectWrite and GPUI text engines are documented in
`crates/nsh-platform-ios/src/text.rs`, `crates/nsh-platform-android/src/text.rs`, `crates/nsh-platform-linux/src/text.rs`,
`crates/nsh-platform-windows/src/text.rs` and `crates/gpui/nsh-platform-gpui/src/text.rs`, the measure cache in `crates/nsh-core/src/text.rs` (`MeasureCache`).
