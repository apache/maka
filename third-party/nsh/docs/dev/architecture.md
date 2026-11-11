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
- **Reactivity is native**: signals, memos, effects, owners and context are a graph in Rust (`crates/nsh-js/src/reactive.rs`). Apps reach it through `nsh` (`signal`, `computed`, `effect`, ...).
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
- Measurements are cached per engine (`MeasureCache` in `nsh-core`); a color-only change does not trigger layout.
- One `Surface` (Apple, Linux, Windows) / `NshView` (Android) is one engine (one QuickJS runtime), with no global singletons, so NSH can be embedded in
  existing apps with several instances. `AppView` (Apple: a `UIView` or, on macOS, an `NSView`; Linux: a GTK widget; Windows: a window; GPUI: a GPUI view) wraps a surface for embedding and owns its dev session; a standalone app is
  just "one AppView filling the window".
- Mount `Insert` items describe native stacking order, including `zIndex`. A sink that needs logical document
  order opts in with `MountSink::needs_tree_order`; the core includes `TreeOrder` in the completed batch when
  nodes are mounted, moved or detached. The terminal uses it for focus traversal independently of paint order.
- Anchored overlays include their resolved anchor bounds, optional anchor node and final placement side in
  `ViewProps::overlay_anchor`. The terminal uses this to keep a popup outside the anchor's occupied Cells;
  other native backends continue using the core's point frames.
- **Android**: the engine thread typesets with `StaticLayout` through JNI; each commit is encoded once and handed to
  `Mounter.java` on the UI thread (`crates/nsh-platform-android/src/encode.rs`).
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
  Animation (the iOS backend's), text and canvases drawn into content layers, desktop input and scroll views as on Linux; each
  commit is one main-queue hop; native animations run on a display link made from the root of a window that shows
  (the main one's, else one of the app's own: `macos.md` "Frames").
- **Windows** (Win32, `windows.md`): one retained `NshView` per node, the whole tree drawn by the surface's window
  with Direct2D into a flip-model swap chain (no child windows but web views and components' own windows); each
  commit is one `WM_NSH_WAKE` posted to the window; native animations run on a ticker paced by the compositor
  (`DwmFlush`).
- **GPUI** (macOS, Windows, Linux; `gpui.md`): the Windows backend's retained `NshView` tree, painted by one GPUI
  element per surface with GPUI's primitives (`DrawCx` keeps the transform and opacity GPUI lacks); each commit is one
  closure on GPUI's main thread (`rt::invoke`), and every main-thread entry point ends with `rt::flush`, which
  notifies the views of changed surfaces; native animations run on the window's frames.
- **Web APIs** (TS apps only; Rust code uses crates of its choice): `fetch` with `Headers` / `Request` / `Response`, the
  Streams API (readable streams with byte streams and BYOB readers, writable and transform streams, `pipeTo` /
  `pipeThrough`, `TextEncoderStream` / `TextDecoderStream`), `Blob` / `File` / `FormData`, `URL` / `URLSearchParams`,
  `TextEncoder` / `TextDecoder`, `Event` / `CustomEvent` / `EventTarget`, `AbortController` / `AbortSignal`: native
  classes in `crates/nsh-js/src/web/` (module docs there), made on first use of any of those globals (zero startup cost
  otherwise), as in browsers so libraries such as axios work (`fetch.rs` lists where they differ). `Intl`
  (`NumberFormat`, `DateTimeFormat`) and the `toLocaleString`s of numbers, BigInts and dates, which QuickJS lacks, are
  there too (`web/format/`): formatted in Rust for the common languages (limits in its module doc), in `Environment::locale` by
  default (the platform's region format: `NSLocale.currentLocale`, `Locale.getDefault()`), local time `Date`'s,
  named as the zone the C library computes it in (`TZ`, `/etc/localtime`; on Windows and Android as the platform
  reports it, `LocaleSettings::time_zone`, `localeSettings().timeZone`).
- **Time**: an engine runs on a `nsh_core::time::Clock` (`EngineConfig::clock`), its thread's while it runs
  (`Clock::enter`): JS's timers, Rust tasks' timers, throttled scroll events, mouse moves and the frames' time read it
  through `nsh_core::time::now()`, `Intl` and `Date` through `unix_ms()`. The system's clock is the default. A manual
  one (`Clock::manual`) moves only when told: the loop no longer wakes for timers, and `EngineControl::advance_clock`
  steps it to each time something comes due on the way (timers, task timers, the clock's alarms such as a held-back
  response), running it before going on, as Playwright's `clock.runFor` and Jest's fake timers do. A manual clock
  that moves with frames (`Clock::with_frames`: a test's app on a real platform, `nsh test --target`) also moves to a
  frame after the last (`time::FRAME`) with each display frame, and runs the frames the app waits for on the way
  while it is moved. `EngineControl::flush` runs what was sent and what is due now without moving the clock, and
  answers whether the engine is idle (nothing queued or due now, no request in flight): a headless step on a manual clock
  settles with it instead of waiting for quiet. On a manual clock `Date` and
  `performance` read it too (`nsh-js` `clock.rs`). The idle collection keeps the system's time.
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
