# The Windows backend (Win32, Direct2D)

`crates/nsh-platform-windows` renders NSH apps in Win32 windows: the views are drawn with Direct2D, text is laid out
with DirectWrite. `crates/nsh-windows-host` is its development host (`nsh run --target windows`, the default on
Windows), `crates/nsh-windows-app` the release runner of `nsh package --target windows`. It follows the Linux
backend's design module by module (`docs/dev/linux.md`): one retained view per node, the core lays everything out.
Unlike GTK, NSH draws every view itself (there are no system widgets to host): text fields, alerts and
video controls are NSH's own, drawn with Direct2D and DirectWrite. User-facing page: `website/docs/windows.md`.

## Building and checking

Windows 10 1809 or later (Windows 11 recommended) and:

- the MSVC toolchain: Visual Studio Build Tools with the "Desktop development with C++" workload (the compiler for
  QuickJS) and the Windows SDK;
- LLVM, for `libclang`: `nsh-js` turns on rquickjs' `bindgen` feature on every native target, so QuickJS' bindings
  are generated at build time. bindgen finds LLVM in `C:\Program Files\LLVM`, else set `LIBCLANG_PATH` to its `bin`
  (CI does).

Off Windows the crates are empty (like the other platform crates off their targets), so check them on Windows:

```sh
cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app --all-targets
cargo test -p nsh-platform-windows          # needs no visible window: tests do not show one
cargo build -p nsh-windows-host             # target\debug\nsh-windows-host.exe
```

The keyboard tests process real messages (`TranslateMessage` / `DispatchMessageW` and
`PeekMessageW`) through a window's procedure without showing it; they run in the crate's one test binary:

```sh
cargo test -p nsh-platform-windows keyboard
cargo test -p nsh-platform-windows a_captured_key_is_never_translated
cargo test -p nsh-platform-windows a_binding_consuming_an_untranslated_key_keeps_an_unrelated_character
```

CI runs the crate's whole test binary on windows-latest (`.github/workflows/windows.yml`), which includes both;
no extra test binary or Windows-only workflow step is needed.

The stationary-cursor regression opens a window on an interactive desktop. It positions the mouse once and
temporarily captures mouse input on the test thread; a timer then applies cursor style batches and checks
the system cursor without further motion. It releases capture and restores the mouse position and cursor
when it ends, including on failure. Run it separately:

```sh
cargo test -p nsh-platform-windows cursor_style_updates_without_mouse_motion -- --ignored --test-threads=1
```

If rustc or clippy overflows its stack on the `windows` crate (its generated bindings are very large), give it a
bigger one: `RUST_MIN_STACK=268435456` (256 MiB) in the environment.

The Windows binaries are built for the machine itself, so the CLI finds them in `target\<profile>` (not
`target\<triple>\<profile>`) and builds them first in a checkout; `cargo xtask dist` on Windows puts them in
`dist\nsh\runtime\windows\` next to `bin\nsh.exe` (`docs/dev/tooling.md`, `embedding.md`). CI:
`.github/workflows/windows.yml` (windows-latest: clippy with `-D warnings` and tests of the Windows crates, the CLI,
`nsh-dev` and xtask).

Features: `js` (default; JS apps; without it the crate only runs Rust apps and links no QuickJS) and `dev` (the dev
server client, log forwarding, the error overlay: `dev.rs`). The host turns on `dev`, the runner only `js`.

## Architecture

- **One retained view per node, one window per surface.** Each node is an `NshView` (`view.rs`): an `Rc` node with
  its `ViewState` (frame, style, animated values, content), its children in drawing order and a weak parent. A
  surface's window draws its tree with Direct2D into a flip-model swap chain (`render.rs`); NSH content needs
  no child windows. Changing a view (`changed` / `moved`) queues it on its surface and invalidates the window;
  `WM_PAINT` draws once, however many views changed, only where they changed ("Partial frames", below). Only native components that bring a window of their own are child `HWND`s, and they
  sit above everything NSH draws (the "airspace" limit, below).
- **Window composition for web views** (`compose.rs`). A window without web views or composed components has one
  swap chain. The first web view makes a DirectComposition target on the window that layers each web view's visual
  between swap-chain layers of what NSH paints before and after it, so later siblings, dialogs and the dev overlay
  draw above web views, for any number of them. Windows without web views or composed components pay nothing for it;
  the composition lives as long as a web view or a composed component holds it (`Surface::compose`). A registered
  native component may bring a visual of its own the same way (`NativeComponent::composed` / `visual`, `native.rs`):
  content another device draws, such as a swap chain of the app's own. The first frame that draws its view in a
  window asks it for the visual on that window's composition device, and the window draws again with the visual in
  its composition; the composition stacks it in paint order like a web view's page and hands the component its
  `Placement` (transform, size, clip, corner radii, opacity) with `placed` every frame, which the component applies to
  its visual before the window commits. Unlike a child window, it is covered by what NSH draws after it.
- **Drawing a view** (`render::draw_view`): shadows and background (`decor.rs`), the content clipped to the bounds
  (text, image, canvas), the children (clipped to the rounded bounds when the view clips), the items the view hosts
  (`ViewState::natives`: text editors, alerts, overlays, videos — the `Hosted` trait), the scroll
  indicator, then the border, all inside an opacity layer when translucent (bounded by the area the subtree draws in:
  an unbounded layer is a surface as large as the clip around it, often the window; a view that paints only its
  background color fades the color instead, with no layer). A view's content clip is pushed only when it has content
  (text, an image, a canvas). A subtree that draws nothing (no area and nothing outside it, with children that draw
  nothing or are clipped away: a `display: none` subtree, which the core lays out with no size) is left out at its top
  without visiting its views (`draws_nothing`). In the window's pass, a view whose own area (bounds, shadows, outlines,
  hosted items, through its transforms) lies outside what the window and the clips of the views around it leave
  visible, whichever ancestors those are, draws nothing of its own: with its subtree when that stays inside its box
  (it clips, or has no children), else only its children, each culled the same way, so a long list in a box that does
  not clip draws only its rows in sight. Transforms are CSS-like 4x4 matrices
  (`geom.rs`); affine ones are Direct2D's 3x2 world transform, projective ones (perspective) draw the subtree into an
  offscreen bitmap mapped with `DrawBitmap`'s perspective transform. Units are points: the device context's DPI is
  the window's (the process is per-monitor DPI aware, v2).
- **One hop per commit.** The engine runs on its own thread (`nsh_engine::Engine`); its sink queues each commit and
  posts one `WM_NSH_WAKE` to the window, and the main thread applies every queued batch in order (`surface.rs`,
  `mount.rs`). The animated values go into the views after those batches (`Surface::write_animations`) and before
  each desktop command in one, which can paint its window before the batch ends (docs/dev/pitfalls.md, "Windows").
  The table of views by node id belongs to the mounter and is shared with the surface (`Rc<Views>`), so
  input and hosted items find views by id while a batch is being applied. Worker threads (image decoding, media
  callbacks, the dev client) run code back on a UI thread with `UiThread::invoke`: each UI thread has a message-only
  dispatcher window of its own, a surface records the `UiThread` it was made on (`Surface::ui_thread`), and work
  started on a UI thread carries that handle to wherever it finishes, so its closure runs where the surface's
  thread-locals are (the surface is found by key in the thread-local map of that thread). The process-wide image cache
  returns each load to the thread that asked, and releases a frame's bitmaps on every thread that drew it.
- **Resizes wait for the layout** (`Surface::resized`, the one place the main thread waits for the engine, as on
  macOS): `WM_SIZE` waits for the layout at the new size (`MountSink::resized`), at most 16 ms, and applies it before
  it draws. An engine that misses the deadline (JS busy, a costly layout) is not waited for again until it reports a
  resize done; the area the window grew by then shows the window's background until the layout arrives.
  A window's swap chain never stretches (`DXGI_SCALING_NONE`): DWM shows the window at its new size before that frame
  is presented, and a stretched last frame would move everything by part of a pixel on each step of a resize. The last
  frame stays where it is, and DWM shows the window's redirection surface past it, which `WM_SIZE` fills with the
  window's background before it waits for the layout (`window::fill`; DWM never shows a window swap chain's own
  background color).
- **Text is typeset on the engine thread** with DirectWrite's shared, free-threaded factory; the final layout is plain
  data (glyph runs recorded through a text renderer of NSH's own), which the main thread only draws and hit-tests
  (`text.rs`).
- **Frames**: a ticker thread waits for each composition (`DwmFlush`) and posts `WM_NSH_TICK` (one at a time) while
  something animates: native animation values (`animation.rs` over `nsh_core::animation`), JS frame requests,
  transitions and keyframes (`transition.rs`; curves, interpolation and timing in `nsh_core::transition`), scroll
  glides, navigation transitions (`Surface::on_frame`), video frames, shaders and fades (`Surface::on_draw_frame`).
  The ticker parks when nothing animates. While nothing composes (`DwmFlush` fails: a locked or remote session) it
  posts no ticks and asks the compositor again every 100 ms. Frame clients report what they have left (`Next`: done,
  drawing only, or a deadline), and `Surface::keep_deadline` keeps the earliest deadline (the graph's or a client's;
  batches never wait for a frame, `drain` applies them as they arrive) with one thread timer 50 ms past it: if no
  frame ran since it came due, it runs one, so animations end and report it on time without frames ("Deadlines" in
  docs/dev/animation.md), and pauses the ticker once nothing is left. Drawing-only work (an endless animation, a
  shader, a JS frame request) waits for the compositor. Caret blinking and animated GIF / WebP frames use thread
  timers instead, so they cost no frames.
- **Devices**: one Direct3D 11 device (hardware, else WARP) and its Direct2D device and context per thread
  (`gfx.rs`); a lost device (driver update, GPU reset) is made again and `gfx::generation` tells caches of device
  resources (bitmaps, command lists) to make theirs again. Devices are made with
  `D3D11_CREATE_DEVICE_PREVENT_INTERNAL_THREADING_OPTIMIZATIONS`: NSH draws with a device from the thread that made
  it (video decoding takes Direct3D's multithread lock), and the worker threads drivers otherwise start for each
  device (about 28 on NVIDIA, 15 on AMD) only contend with the UI threads; the driver does its work on the calling
  thread instead, and no call becomes unsafe. Measured against the flag's absence on an NVIDIA laptop (RTX 3050, 4K
  60 Hz), one 1280×800 window: animating lightly, CPU 27% → 12% of a core; redrawing the whole window every frame,
  78% → 53% and the UI thread's frames 1.4 ms shorter at p95; scrolling text, 52% → 40%; playing a video, 17% → 9%;
  44 → 25 threads; frame rates unchanged. With a device per thread on several UI threads the contention grows
  with each: 4 such windows missed 300–500 frames a minute each and recovered fully without the threads, on NVIDIA,
  Intel UHD and AMD Radeon alike. On WARP, which then rasterizes on the calling thread too, 1 and 4 windows improved
  and 8 windows missed about 0.3% more of their frames.
- **The standalone app** (`run_app`, `app.rs`) runs the window and its message loop on a thread of its own
  (`nsh-ui`, 8 MiB of stack for deep trees) and joins it: the devices, font faces and bitmaps cached in that thread's
  thread-locals are released at a plain thread exit. Released by the main thread's thread-local destructors instead,
  they would run inside `ExitProcess`, after the graphics DLLs are gone, and the process would end with a stray exit
  code. The UI thread sets per-monitor DPI awareness and `OleInitialize`s (clipboard, drag and drop, WIC).
  With nsh.json `window.defaultVisible: false` the window is made and its app runs, unshown: the app's first
  `show()` / `focus()`, or a link from a later launch (`linking.rs`), shows it as `AppView::show` does
  (`app::show_main`: cloaked until its background and a frame are drawn, then in the mode it opens in).
  Windows changes a window's mode by showing it (`ShowWindow`, `SetWindowPlacement`), so a hidden window (the main
  one or one of the app's own, before its first show or hidden by the app) is not put in a mode: the mode asked for
  (nsh.json's, `setMode`, `setPlacement`, `setBounds` out of another mode) is held (`window::held_mode`), read as the
  window's mode in its state, and entered when the window shows (`window::show`,
  `window_state::enter_held_mode`). A development host holds its first show until the first app came (`dev.rs`,
  `DevUi::held`): a session's first bundle places the window as a runner does (`AppView::place_main_window`: its
  size, place and the mode it opens in, which waits for the first show while the window is hidden), and the app's
  `defaultVisible` decides whether it shows. An error shows the window while it is hidden (held, or hidden by the
  app: a tray app whose startup failed), so it is seen; a reload leaves it as it is.
- **Embedding**: `AppView` (`app.rs`) is one surface as a window: a child of the embedding app's window, or top-level;
  the host's message loop runs it. `set_ui_sets` serves the UI sets beside the runtime's modules
  (`nsh/base` by default; an app with Rust components of its own passes `nsh_base::registry()` and its sets).

## How each area maps to Windows

| Area | Module | Windows |
|---|---|---|
| Text | `text.rs` | DirectWrite on the engine thread: one `IDWriteTextLayout` per prepared text, re-broken at each width asked for; the final layout's glyph runs are recorded through a custom `IDWriteTextRenderer` and drawn on the main thread with `DrawGlyphRun`, so what was measured is what is drawn. Line heights follow Pango's model (each span as tall as its own font; DirectWrite only breaks lines). Color emoji are the COLR layers of `TranslateColorGlyphRun`. Colors and decorations are read per cluster from the drawn text's spans (a layout is reused for texts that only differ in them). Custom fonts load into an in-memory font collection (`IDWriteInMemoryFontFileLoader`). `fontVariant` is OpenType features. `selectable` text has a desktop-style range selection (mouse drags, Ctrl+A, Ctrl+C); `fontFamily` lists: the first installed or registered family is the format's, the others found an `IDWriteFontFallback` (each family over all of Unicode, then the system's) set on the paragraph's `IDWriteTextFormat1`: one list per paragraph, its first style's |
| Decoration | `decor.rs` | Direct2D geometries: shadows (React Native's take the box's shape with a fill, the content's without, as iOS), blurred once into bitmaps cached by what they look like (`decor/cache.rs`); colors; linear and radial gradients as gradient brushes, conic ones drawn into cached bitmaps (`decor/gradient.rs`); inset shadows; borders per side (over the children, as UIKit); outlines; `filter`s as Direct2D effects on the subtree recorded offscreen (`decor/layer.rs`); `mixBlendMode` and `backdropFilter` read the backdrop out of the pass's target |
| Images | `image.rs` | Loaded through the core's shared loader and decoded images (`docs/dev/images.md` "Loading and memory"), decoded at the view's size bucket: WIC (PNG, JPEG, BMP, TIFF, ICO, HEIF / WebP with their codecs; its scaler shrinks), the `image` crate for GIF and WebP (every frame of animations); pixels in the process's image budget, leased by the views showing them; Direct2D bitmaps made when first drawn (counted in the budget then), made again after a device loss and released with their entry; animated GIF / WebP on thread timers at their frame delays (paused while not drawn); blur and tint as effects at draw time |
| Canvas | `canvas.rs` | The recorded drawing replayed into an `ID2D1CommandList` when it changes (vector: sharp at any scale), played back with the view's transform; a drawing whose animated values are read late is two lists, the operations before the first that reads one (`nsh_core::canvas::first_animated`) recorded once and the rest again when a value changes (the tail replays the head's state without painting it; recorded whole when the tail would combine with the head's pixels: a composite operation in effect or set in it, a `clearRect`); the current path kept in canvas' model; shadows through the shadow effect; composite operations through the Composite / Blend effects; conic gradients as thin wedges masked by the shape; text in DirectWrite, the fonts `measureText` uses; `drawImage`'s images through the shared loader (`image::load_bitmap`), an SVG rasterized at the surface's scale (an `OffscreenCanvas`'s: its own) so it stays sharp, its source rectangle and default size in its own points (`CanvasBitmap::scale`). A source-over paint whose current values cannot change a pixel skips its geometry, text layout or bitmap before they are made (zero global alpha, a transparent color or animated color, an empty or degenerate gradient); a shadow keeps a transparent foreground on the regular path, and `clearRect`, clipping, save/restore and other composites are untouched. The drawing's slot dependencies are classified once: a changed slot that cannot move, resize or re-ink geometry (alpha, color, dash offset) draws the cached damaged area, while slot-driven geometry, clips, `clearRect` and composites keep the full scans. `OffscreenCanvas` images (`canvas/offscreen.rs`) replay the same command list into a target bitmap of the UI thread's device and copy it into a CPU-readable one; a Direct3D event query ended after the copy is polled without flushing from a thread timer (`image::after`), so the UI thread keeps drawing frames while the GPU works, and the bitmap is mapped once the query is done (after 5 s it is mapped anyway); the rows come out in one copy when packed, and unpremultiplying and WIC's PNG encoder run on a thread of their own. A side over `GetMaximumBitmapSize`, or a bitmap the device's memory cannot hold (`E_OUTOFMEMORY`, `D2DERR_MAX_TEXTURE_SIZE_EXCEEDED`), answers `RenderFailure::TooLarge` (`ERR_NSH_QUOTA_EXCEEDED`) |
| Shaders | `shader.rs` | `nsh_engine::shader`'s frames as Direct2D bitmaps (`docs/dev/shaders.md`), on textures shared with the shader's Direct3D 12 device where it is on the same adapter (fences signalled after `EndDraw`), else read back: a fill under the content and children, drawn again when its frame comes back (a new layer that leaves it a fill picturing nothing with the same overflow, such as new uniforms, asks for no paint of its own, so each change presents once); an effect, a running transition and the root's screen effect or transition instead of the children, which are drawn into a target bitmap by a context of their own and read back as the shader's content or `sample_to` once a view in them or the whole window changed (`render::Readback`, which keeps its bitmaps and pixels; `NshView::changes`, `Surface::whole_change`); a transition's `sample_from` drawn offscreen when it starts (`render::draw_offscreen`); what is behind a view read back from the window's target before it draws (a partial frame that meets such a view draws all of its box and overflow); pages and dialogs through a shader as a hosted `NavItem` over the stack or the root, playing recordings of their two sides on the shader's own transition clock, ended at once when their window finds the device lost (those of another window draw no recording of the lost device) |
| Scroll views | `scroll.rs`, `nsh_core::scroll` | Offsets of their own (`ScrollState`, with the physics and gestures in `nsh_core::scroll`, shared with GPUI and Linux; `scroll.rs` draws the indicator and spinner and walks the view tree), reported as UIKit's `contentOffset`; wheel / touchpad / touch and pen scrolling with UIKit-like deceleration, snapping, paging, sticky cells, rubber banding for touch drags (wheels stop at the edges; mouse drags never scroll: they are the app's, for pans, responders and text selection; pull to refresh needs a touchscreen); the keyboard (arrows by 40 pt, Page Up / Page Down and Space / Shift+Space by 87.5% of a page, Home / End and Ctrl+Home / Ctrl+End, animated); mirrored horizontal lists for right to left; an indicator that fades and that the mouse drags as a scroll bar, shown and kept as on Linux; it runs along the part of the view the scroll views and clips around it leave in sight (`NshView::visible_bounds`, `ScrollState::thumb_within`), so a horizontal scroll view taller than the vertical one it is in (a `DiffView`'s or `Editor`'s side) keeps its bar at the bottom of the viewport |
| Input | `input.rs`, `window.rs`, `nsh_core::input` | Its own hit testing over the views (frames, scroll offsets, 3D transforms inverted, `pointerEvents`, `hitSlop`, `overflow: hidden`, `Overflow` areas); mouse from the `WM_*BUTTON*` messages, touch and pen from `WM_POINTER*`; touches for the responder system with `panActivation` gates; presses, long presses, hover and pressed states (a text field takes its own clicks: only an `Input` listening to presses hears a press on its field, `onPressDown` as it goes down and `onPressUp` and `onPress` on release; no view around it does), `onMouseEnter` / `onMouseLeave` / `onMouseMove` (picked at each mouse move, with or without a button down: `pressedButton` is the first of the message's `MK_*` buttons held; heard again where the mouse rests when a modifier key changes with no button down; over a `windowDrag`, `windowControl` or `windowResize` view, non-client area, picked at its `WM_NCMOUSEMOVE` too; a leave message looks where the pointer is and the views hear a move there or a leave, so crossing between such a view and an ordinary one keeps the hover, and a leave that keeps it untracked is looked at again once the queued input is handled; while the system's move or size loop or a held press on a drag region holds the pointer, leaves wait for its end, which tells the views where the pointer is once: `chrome::Tracking`, "Windows, Win32" in `pitfalls.md`), `onContextMenu` (the right button; a field or selectable text nearer opens its edit menu, but where the selectable view around the text, or a view between them, listens: that hears it, as on macOS, and its app's menu takes `copy` / `selectAll` role items, which act on the selection), cursors (a batch that changes `cursor` reapplies it under a resting mouse once the batch is complete; the window under the pointer and its client hit test keep other windows and non-client cursors intact); pan / pinch / rotate animated values (Ctrl + wheel, and precision touchpads' pinch, which Windows sends as Ctrl + wheel, pinch the view under the pointer); wheel and precision touchpad scrolling routed to scroll views, staying on the view it began in, and offered first to a web view under the pointer, then to the native components of the view under it (`NativeComponent::wheel`, before the scroll views and Ctrl + wheel's pinch); keys go to the window's shortcuts, the system (dialogs), the focused field, selectable text, navigation, scroll views, then Tab between text fields (see "Keyboard"); the decisions over plain data (what a pointer may start, a press's events, hover changes, hit areas, pinches, wheel latching) are `nsh_core::input`'s, shared with the GPUI, Linux and macOS backends |
| Text inputs | `text_input.rs`, `richedit.rs` | Windows' own text box: a windowless RichEdit (msftedit.dll's `ITextServices2` on our `ITextHost2`, no child window) per field, drawn with `TxDrawD2D` into the view's Direct2D target at the content box; the view draws the decoration. Editing, word moves, undo, selection, spell checking (`IMF_SPELLCHECKING` while `autoCorrect` is on, never on masked fields), password masking and IME through TSF (`SES_USECTF`; `TXTBIT_ADVANCEDINPUT` aborts msftedit) are the system's (a field in a window of the app's own maps its points to the screen through that window, so the candidates sit at its caret); `EN_CHANGE` / `EN_SELCHANGE` / composition notifications become `onChangeText`, selection and `onCompositionChange` events; the host draws RichEdit's caret itself on the blink timer; formatting shortcuts and Tab are not forwarded; paste goes through `onPaste` and `EM_REPLACESEL`; offsets converted between UTF-16 and UTF-8; return does what `submitBehavior` says (see "Keyboard"); a right click opens the edit menu (`chrome::popup_actions`), labelled in the language the app shows (`nsh/i18n`), as the role items with no label of the app's menus are; the core sends `DesktopCommand::SetMenuLabels` when that language changes |
| Keyboard focus and hardware keys | `input.rs`, `keyboard.rs`, `window.rs` | A focusable custom view (one that takes presses, or `focusable`) takes the keyboard focus with Tab / Shift+Tab among the window's stops, a click, `ref.focus()` or UI Automation; while it has it, `WM_KEYDOWN` / `WM_KEYUP` become `KeyDown` / `KeyUp` events (the current layout's logical key, the scan code's DOM `code`, repeats from the message) that the engine bubbles within the window. Mounted `capture_keys` rules take a key before the menu's shortcuts and the native defaults, removing the `WM_CHAR` it would have typed; the app's keymap, window shortcuts and dialogs keep their precedence, and text fields, web views and native component windows own their o…
| Navigation | `navigation.rs` | The decisions shared with the other desktops (`nsh_core::navigation`: the screens a stack shows and the user popped, transitions' timing, easing and offsets, what going back acts on); pages are child views, only the top one (and the one below during a transition) drawn; NSH draws no header: a page's `header` (the app's view) is a child of the page that the core places at its top, as wide as the page, with the content below it and kept above it (the system header's items of iOS and Android stay hidden); each page has an opaque backdrop in the window's color under the app's content; leaving pages and dialogs slide out as images recorded into command lists; Escape (unless a text field has the focus: Escape leaves the field), Alt+Left, the Browser Back key and the mouse's back button send `onBackPress` to the top page when the app listens and pop natively unless its `popOnBack` is false (a stack inside the newest dialog first, else that dialog gets the close attempt, `"cancel"`, and closes when `closeOnEscape`; without a dialog, the app's back listeners hear it before the stacks, and `Command::Back` goes on when none takes it) |
| Dialogs (`Dialog`) | `navigation.rs` | Children of the root above the app's views, at the size of the surface, sliding up or fading in: transparent layers with no look of their own, showing only the app's popup and backdrop (`presentation` is ignored); Tab stays inside the newest dialog, and the field that had the focus when a dialog opened leaves it and gets it back when the dialog closes |
| Alerts (`AlertDialog`) | `system.rs` | Drawn in the surface as items the root hosts, in Windows 11's content dialog style (a rounded card, the default button in the system's accent color), not `MessageBox` / `TaskDialog`: they stay with an embedded surface and never run a modal loop of their own. No text field yet: an alert's `input` is left out and its answer has no `value`. |
| Video | `native/video.rs` | Media Foundation's media engine in frame-server mode on the thread's Direct3D 11 device (a DXGI device manager); each frame is copied into a texture Direct2D draws, so a video clips, transforms and is covered like any view; `controls` draws NSH's own control bar (play / pause, scrubber, time) |
| Web views | `native/web.rs`, `compose.rs` | WebView2 composition controllers (`webview2-com`, the loader linked statically: apps ship no `WebView2Loader.dll`) drawing into a visual of the window's composition, between the layers of what NSH draws before and after them, so NSH content covers them; the visual is transformed like the view (affine), clipped to its clipping ancestors (axis-aligned bounds) and its own rounded corners, faded with its and its ancestors' opacity, and out of the tree while the view is not drawn (hidden, concealed screens); a deleted view's page stays while a removal animation keeps the view on screen. Input is NSH's: hit testing gives a point over the page to it only when no NSH content covers it there (`Hosted::raw`), and mouse buttons, moves and wheels go through `SendMouseInput`, touch and pen contacts through `SendPointerInput` (synthesized ones as the mouse); the page's cursor comes from `CursorChanged`; a click gives the page the keyboard focus (`MoveFocus`, WebView2 then takes keys and the IME itself, NSH's fields blur), a click on NSH content or Tab out of the page (`MoveFocusRequested`) gives it back. Rasterized at the window's scale (`RasterizationScale`, monitor changes not followed by WebView2 itself); bounds are the view's window pixels (pop-ups and IME candidates are placed from them). `baseUrl` navigates to the base URL and answers that document's request with the HTML (`WebResourceRequested`); `scrollable={false}` gives the wheel to the scroll views around and keeps the page's viewport from scrolling (`overflow: hidden` on its root, scripts still scroll); `desktop={{ allowsBackForwardNavigationGestures }}` is `IsSwipeNavigationEnabled` (touchscreen swipes). One environment per thread and profile folder (`%LOCALAPPDATA%\<app id>\WebView2`), the controller made from the first props (InPrivate for `incognito`); a placeholder without the WebView2 Runtime |
| Native components | `native.rs` | `AppView::register_component(name, factory)`; a `NativeComponent` draws with Direct2D in the view (`draw`) or brings a child window (`window`) that follows its view after every frame, clipped with a window region, above everything NSH draws; `ComponentContext::emit` / `set_size` / `redraw` from any thread |
| Accessibility | `access.rs`, `access/uia.rs` | UI Automation: a server-side provider tree answered on `WM_GETOBJECT`, one provider per exposed view (holding only the surface key and node id); control types from `role` / text / press handlers / labelled images; `testID` as the automation id; Invoke, Toggle, ExpandCollapse, SelectionItem, RangeValue, Value and Scroll patterns; `ShowContextMenu` (`IRawElementProviderSimple2`) raises `onContextMenu` with no pointer (`input::show_context_menu`); `accessible={true}` groups its content as on iOS and Android; children in tree order, a scroll view's and a page list's (`ViewProps::screen_order`) as they are on screen (`nsh_core::scroll::reading_order`), as Tab; `accessibilityElementsHidden`, `visibility: hidden` (as in a browser) and screens below the top of a stack hide a subtree; property, structure and live-region notification events only while a client listens |
| Environment | `system.rs` | Re-read on `WM_SETTINGCHANGE` (and theme / DWM color changes). Color scheme: the app's appearance (`nsh.json` `"appearance"`, `setColorScheme`) when it forces one, else `AppsUseLightTheme`, live; the title bar (DWM's immersive dark mode) and the root's background follow it. The locale (`Intl`) from `GetUserDefaultLocaleName` (not `LANG` / `LC_*`); the preferred languages (`localeSettings()`'s `languages`) from `GetUserPreferredUILanguages` (the display languages, most preferred first); the regional preferences (`localeSettings()`'s `hourCycle` and the like) from the regional format's `LOCALE_STIMEFORMAT` (its hour letter), `LOCALE_IFIRSTDAYOFWEEK` and `LOCALE_IMEASURE` (`GetLocaleInfoEx` with the user's changes); font scale from `TextScaleFactor` (Settings > Accessibility > Text size); reduce motion from `SPI_GETCLIENTAREAANIMATION`; right to left from the UI language's reading direction; the screen reader from `SPI_GETSCREENREADER`; the pixel ratio the window's DPI over 96; `platform.os` `"windows"`, idiom `desktop`, OS version `RtlGetVersion`'s major.minor (10.0 on Windows 11 too); the accent palette for dialogs; safe area and keyboard height 0. The app's state (`lifecycle()`), followed on `WM_ACTIVATEAPP` and the window's `WM_WINDOWPOSCHANGED`, an embedded surface's from its root window, subclassed (`SetWindowSubclass`, only on the root window's own thread: a surface whose root is another thread's follows its own window's messages; the root is the one the surface had when it was made, kept while it lives) to pass them on to the surface's window (`WM_NSH_ROOT` for the moves; `window.rs` `observe_root`): `background` while the window (an embedded surface's root window) is minimized or hidden, `active` while the app is the active one (`WM_ACTIVATEAPP`'s flag, sent per thread; before the first, the foreground window being the process's), `inactive` otherwise; `background` too while the user cannot see the window: the session locked or without a display (`WM_WTSSESSION_CHANGE`), the display off (`GUID_CONSOLE_DISPLAY_STATE`), the window on another virtual desktop (cloaked by the shell, re-read on the cloaking WinEvents), all from the system's notifications, which each surface's window registers for (`presence.rs`; a test's app ignores the session and the display, as on macOS); and from `WM_QUERYENDSESSION` (signing out, shutting down, the Restart Manager), whose answer waits a bounded time for the engine to run the app's handlers; `WM_ENDSESSION` ending the session stops the engine as quitting does, so quit listeners run and storage is written before it is answered (`session.rs`; an embedded surface hears its root window's). The time zone (`localeSettings()`'s `timeZone`): the setting's zone (`GetDynamicTimeZoneInformation`'s key name) by its IANA name from the ICU Windows ships (`ucal_getTimeZoneIDForWindowsID`, loaded at run time; `UTC` without it), re-read on `WM_TIMECHANGE`. The wake count (`wakeCount()`): one more on `WM_POWERBROADCAST` with `PBT_APMRESUMEAUTOMATIC`, which top-level windows get (an embedded surface's root window passes it on; the app's other windows do not count it again). |
| The app's icon | `window.rs`, `notifications.rs` | The window class's icon is the executable's resource 1 (`nsh package` on Windows embeds it); without one, `AppOptions::icon` (an `.ico`: the runner's `nsh\icon.ico`, the development host's `--icon`, which the CLI makes from `nsh.json` `"icon"` in `.nsh/windows/`) is the window's `WM_SETICON` big and small icons at its DPI, so the title bar, the taskbar and Alt+Tab show the app's; the same file is the toasts' `IconUri` |
| Window chrome (`nsh/desktop`) | `chrome.rs` | The title (`SetWindowTextW`); the hidden title bar: `WM_NCCALCSIZE` gives the client area the window's whole height (the side and bottom resize borders stay non-client; a maximized window's top is moved in by the frame it hangs off the monitor by, another one's by Windows 11's visible top border, which would cover the app's top row), `WM_NCHITTEST` answers the top resize border, the caption buttons (`HTMINBUTTON` / `HTMAXBUTTON` / `HTCLOSE`, so Windows 11 shows snap layouts) and `windowDrag` views (`HTCAPTION`, with the system title bar too: the system moves, maximizes and opens the window menu; a primary press on an app's `windowDrag` view is held with the mouse captured, moved by the pointer's offset from the press when not maximized and handed to `SC_MOVE | HTCAPTION` once it leaves the drag rectangle (`SM_CXDRAG` / `SM_CYDRAG`), or delivered to the app as a click on release, pressed where it went down, if the view it went down on is still there and draggable, so overlays close; losing the capture or replacing the app drops it; a double click keeps the system's action); the caption buttons drawn over the app after the tree (46 points wide, as tall as the app's bar: `titleBar`'s `height`, 32 by default; Windows 11's glyphs and hover colors, dimmed while inactive), their non-client clicks handled here, never by `DefWindowProc` (which would draw Windows 95's); `WM_NCACTIVATE` with `lparam` -1 so the old caption is not painted over the app; full screen is `window::toggle_full_screen` (F11's), which tells the chrome to hide the menu bar and zero the title bar's area; quitting (`Application.quit()`, the `quit` role) posts `WM_CLOSE` as closing does, then ends the message loop; `Application.restart()` quits so in the standalone app (`app::request_restart`, nothing in an embedded view) and, when the UI thread's run has ended, starts the executable again with `NSH_RESTART_AFTER` naming this process, whose `run_app` waits for it to exit (at most 10 seconds) before it opens its window (`nsh_core::restart`; a development host, feature `dev`, only quits: `nsh run` ends with it). Menus are Win32 menus: the menu bar (`SetMenu`, removed while the title bar is hidden or in full screen; `&` escaped, the shortcut after a tab), context menus with `TrackPopupMenuEx` (posted as `WM_NSH_MENU`: its modal loop must not run while a batch is applied); dark with the app through uxtheme's `SetPreferredAppMode` / `FlushMenuThemes` (ordinals 135 / 136) and, for the bar, `WM_UAHDRAWMENU` / `WM_UAHDRAWMENUITEM` plus the line under it after `WM_NCPAINT`; shortcuts matched on key downs before the app's key handling (`input::key`) but after `nsh`'s bindings, the editing roles excepted (they send the field its own Ctrl+key). A menu item's `icon` (not the bar's titles) is `SetMenuItemInfoW`'s `hbmpItem`: a 32-bit premultiplied ARGB DIB section (bottom-up) of `SM_CXSMICON` at the window's DPI, made from the images' pipeline (`image::load_menu_icon`, off the main thread) and centered on its square (`desktop::menu_icon::canvas`) so labels line up, freed after its menu (`IconBitmaps`). Win32 has no template bitmaps: an SVG is painted in the menu text's color when it is made (`COLOR_MENUTEXT` / `COLOR_GRAYTEXT`, or the dark theme's), a disabled bitmap dimmed, and the menu bar's made again when the appearance or the DPI changes. Windows does not repaint a popup it is tracking, so a context menu waits for its icons, at most `ICON_WAIT` (100 ms), with the message loop running, before it opens; a failed icon warns and leaves the item as it is |
| Windows of the app's own (`<Window>`, `Window.open`) | `app_window.rs`, `shell.rs`, `window_state.rs`, `window_close.rs` | A dialog root the runtime opens a window for becomes the root of a top-level window of its own, drawn by `render::window_frame` and sized by `set_root_size`; its input goes through the surface's input in its root (`Surface::input_root`). Each window, the main one included, has a `Shell` (`shell.rs`): its kind's window styles and the attributes applied natively. The close, Escape and blur policies, state and title bar reports, and the main window's close are covered under "Windows" below |
| Login item (`Application.launchAtLogin()`, `setLaunchAtLogin`) | `login_item.rs` | A value of `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` named by the app id (an empty id is `EINVAL`), holding the quoted path of the executable the app started from (`nsh_core::restart::program_path`, taken as the backend is made at the app's start; at most 260 characters, the `Run` key's limit: `ENAMETOOLONG` beyond; a path that is not Unicode, an unpaired UTF-16 surrogate in it, is `EINVAL`, and a value that is not reads as naming no executable); written only when the app asks for a change that differs, since a program the key started should not write to it while it runs. A value naming another executable reads as disabled and stays on disabling (paths compared as Windows compares them: case, separators and a verbatim `\\?\` or `\\?\UNC\` prefix aside). Settings and Task Manager turn an app off in `...\Explorer\StartupApproved\Run` (a binary value of the same name, its first byte odd), read as `requiresApproval` and never written (its format is not documented: a mark missing or of a form not known reads as approved). `AppView::load` gives the engine the backend only in `run_app`'s own view (not one embedded beside it) with `AppOptions::login_item`, which `nsh-windows-app` sets unless `NSH_APP_DIR`; the installer's `[Code]` removes the value on uninstall when its program (read as `names` reads it, the value taken as written or with its environment variables expanded, since Inno Setup does not give its type) is that installation's executable (`nsh-cli` `windows.rs`) |
| Clipboard | `system.rs` | The Win32 clipboard (`CF_UNICODETEXT`); reads are synchronous, so `Clipboard.readText` is answered at once |
| Networking | `nsh_engine::net` | ureq (rustls, webpki roots), one thread per request, streaming both ways; only connecting and the response head have deadlines |
| Dev | `dev.rs` | The dev server client on its own thread; the status pill and the error overlay drawn as items the root hosts, above the app and its dialogs; Ctrl+R and F5 reload the latest build |

## Keyboard

`WM_KEYDOWN` / `WM_SYSKEYDOWN` become `KeyEvent`s (`window.rs`) that `input::key` hands, in order, to:

- **The window's shortcuts** (`Surface::shortcuts`, wherever the focus is): the standalone app's F11 (`app.rs`: full
  screen on the window's monitor, `window::toggle_full_screen`; an embedded `AppView` has none) and the dev host's
  Ctrl+R and F5 (`dev.rs`). Alt+F4 is `DefWindowProc`'s.
- **Dialogs** (`system.rs`): Tab and the arrows between their buttons, Return / Space, Escape.
- **The app's shortcuts** (`nsh`'s `keymap`, `keymap.rs`; see "App shortcuts" below), then **the focused custom
  view's raw keys** (`keyboard.rs`; see "Hardware keys on custom views" below): its `KeyDown` is dispatched whatever
  its capture rules say, and a `capture_keys` rule of the view or its enabled ancestors consumes the key before
  everything after this. A consumed key was taken out of `TranslateMessage` before the loop translated it, so it
  made no characters.
- **The application menu's** shortcuts (`chrome::shortcut`, the editing roles excepted).
- **The focused field** (`text_input.rs`): arrows (Ctrl: by word; Alt+Left / Right are left for navigation), Home /
  End (Ctrl: the text's edges), Up / Down and Page Up / Down in a multiline field, Backspace / Delete (Ctrl: a word),
  Ctrl+A / C / X / V / Z / Y, Ctrl+Shift+Z, Ctrl+Insert / Shift+Insert / Shift+Delete. Return does what
  `InputConfig::submit()` says (`return_key`): a single line submits; a multiline input whose return submits does so
  on a plain return or Ctrl+Return, and Shift+Return or Alt+Return insert a line break. While the IME composes it
  takes the keys it uses (they come as `VK_PROCESSKEY`), so a return that commits a composition submits nothing; one
  that comes anyway with a composition pending only completes it (`CPS_COMPLETE`), and the commit is reported as the
  IME's are. Escape is reported and goes on.
  Characters come as `WM_CHAR`; control characters (Ctrl+Backspace's 0x7F, Return's `\r`, Tab) are dropped there.
- **Selectable text** (`text.rs`) with a selection: Ctrl+A, Ctrl+C / Ctrl+Insert, Escape.
- **Navigation** (`navigation::key_pressed`): Escape (which leaves a focused field instead), Alt+Left and the Browser
  Back key (also from a field) go back.
- **Scrolling** (`scroll.rs`), then **Tab / Shift+Tab** (`input::tab`): the next focus stop in tree order — a text
  field or a focusable custom view (`keyboard::is_stop`) — (a scroll view's content as it is on screen,
  `nsh_core::scroll::reading_order`: a list's recycled cells are not in their rows' order) within
  `navigation::focus_scope` (the newest dialog of the window the input is in, else the surface); a field's text is
  selected as in Windows' dialogs, a custom view reports its focus and scrolls into view.

A handled Alt combination swallows its `WM_SYSCHAR` (Alt+Return makes one, which `DefWindowProc` would beep at) and
the Alt release (which would open the window menu). Shortcuts read virtual keys, which follow the key's US letter
under non-Latin layouts (Cyrillic, Greek), so Ctrl+C is the same key on all of them.

`onKeyPress` reports what UIKit's does: the typed text (`"Enter"` for a line break, and for a return that submits),
`"Backspace"` for a deletion (in an empty field too) and `"Escape"`. Pasted text (Ctrl+V, UI Automation's
`SetValue`) and undone edits report nothing.

**App shortcuts** (`nsh`'s `keymap`, `keymap.rs`): `input::key` matches every key down against the mounted table
(`Keymap::find`) right after the window's shortcuts (`Surface::shortcuts`: full screen, the dev host's reload) and
the dialogs (`system::key`), and before the application menu's shortcuts (`chrome::shortcut`), the focused field,
selectable text, navigation and scroll views. A match is consumed and reported as the root's `KeyCommand`; its
queued `WM_CHAR` / `WM_SYSCHAR` (`PeekMessageW`) are removed only when the message was translated at all
(`KeyEvent::translated`): an untranslated key — a captured private `WM_NSH_KEYDOWN`, or input synthesized in the
backend — queued none, and none are taken for it. An auto-repeat (`KeyEvent::repeat`) of a binding without `repeat`
is consumed silently.
Keys are matched by virtual key code (letters and digits on every layout, punctuation by the US `VK_OEM_*` keys); a
focused text field counts as editing (`when`). With feature `dev`, Ctrl+R is never matched (the dev host reloads).

**Hardware keys on custom views** (`keyboard.rs`): a view that is a focus stop (`focusable`, or one that takes
presses, `ViewProps::focus_stop`) takes the keyboard focus with Tab / Shift+Tab — the same traversal as fields, in
the newest dialog of the window the input is in — a click (the view or its nearest focusable ancestor), `ref.focus()`
/ `blur()`, or UI Automation's `SetFocus`. While it has it, every `WM_KEYDOWN` / `WM_KEYUP` becomes a
`nsh_core::KeyEvent` (`KeyDown` / `KeyUp`) dispatched at that view, which the engine bubbles to enabled listening
ancestors within the same window:

- `key` is the current layout's logical key as DOM's `KeyboardEvent.key` names it: DOM spellings for named keys
  (`Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `ArrowLeft`, `F5`, `Shift`, `Control`, `Alt`, `Meta`, ...), the
  character a printable key types in its actual case, with Shift and Caps Lock (a reported `é` stays `é`, never
  forced onto a US key), and `"Unidentified"` for a dead key or a key the layout cannot name. The source's own
  translation is used as it is: AltGr (Windows reports it as Control+Alt) keeps the character the layout provides
  (`@` for AltGr+Q); only a Control/Alt combination that makes a control character (Ctrl+A's 0x01) falls back to the
  key's own character (`a`). A keypad key with Num Lock off is the navigation key it is (or `Clear`, `Delete` for
  `5` and the decimal point).
- `code` is the DOM `KeyboardEvent.code` of the message's scan code with its extended bit: the key's physical place
  on any layout (`KeyA`, `ArrowLeft`, `NumpadEnter`, `Numpad1`, `ShiftLeft`/`ShiftRight`,
  `ControlLeft`/`ControlRight`, …), never derived from the layout's character or the virtual key; `""` when the
  message carries no scan code, as input injected as text does. `modifiers` are the keys held after the
  transition, `repeat` is the message's previous-key-state bit, and `default_prevented` says whether a capture rule
  took this press.
- `capture_keys` is read from the mounted props of the focused view and its enabled ancestors, with the app
  keymap's own keystrokes (`crate::keymap`: virtual keys, so Ctrl+C is the same key under a Cyrillic layout):
  `KeyCapture::All` takes every key, `KeyCapture::keys([...])` the listed shortcuts, and a key without a shortcut
  (a modifier key, an unidentified one) only `All`. A captured key is consumed before the application menu's
  shortcuts and every native default (Tab's traversal, Return/Space pressing, a context menu, scrolling); the
  app's keymap, the window's shortcuts (F11, the dev host's Ctrl+R) and the dialogs over the app keep their
  precedence. The event is still dispatched, with `default_prevented` set; the listener runs on the app's frame
  afterwards, so it reports the decision made before `TranslateMessage` rather than vetoing it synchronously.
- A captured key is not translated into characters at all: the thread's `WH_GETMESSAGE` hook (and the standalone
  loop, should the hook be unavailable) asks `keyboard::suppress_translation` before `TranslateMessage`, and a
  consumed key down becomes the private `WM_NSH_KEYDOWN` / `WM_NSH_SYSKEYDOWN`, which `TranslateMessage` ignores and
  the window procedure handles as the key down it was. No `WM_CHAR` / `WM_SYSCHAR` is made, and the message queue is
  never inspected, moved or restamped: a character queued before, around or after the key keeps its place and its
  delivery. The hook is thread-scoped, so an embedding host's own message loop is covered without a DLL.
- Keyboard ancestry for interest and capture follows `ViewProps::key_parent` when core sets it (a view a native
  surface portals at a root it does not logically live under, such as an `Overlay`): the walk uses the logical parent
  instead of the mounted `Insert` parent, and still stops at a window of the app's own. The override is read from
  the cached `ViewProps` (core updates it on portal creation/reparent), so no extra mount item is sent. Focus, hit
  testing and layout keep the mounted parent; the notification is still dispatched once to the focused view and the
  engine bubbles it to the logical ancestors.
- A modal presented over a window saves the custom view with the focus, as it saves a text field, and gives it back
  when it closes if that view is still attached, enabled and shown in a window no modal covers.
- The raw path is only for a focused custom view: a text field (`Input`, the system's RichEdit and IME) and a hosted
  web view or native component own their keys and text, and a capture on their ancestors does not intercept them. A
  view that is removed, concealed or disabled loses the focus (a `Blur`) without a synthetic key release; a real
  release the window gets is reported on whichever view has the focus then. `ToUnicodeEx` supplies the logical key
  from the current layout (never a US guess), always with its keyboard-state-not-changed flag (0x4), so a
  dead key read for an event (also an AltGr-layer one) is never stored and the layout's pending composition is left
  alone; a dead key's composition is committed through `WM_CHAR` (and the IME), never as the event's key.

## Checking a change: `nsh test --target windows`

The development host takes the steps of `nsh/test` tests (`docs/dev/tooling.md`, "On a real platform"): `agent.rs`
implements `nsh_testing::agent::Native`, each call on the surface's UI thread (`UiThread::invoke`), with the input `synth.rs`
makes at the input module's entry points, so it works while the window is in the background or covered (and goes
through NSH's hit testing to web views, as real input does):

- a press is the mouse's down and up at the view's middle (after a move there); back is the mouse's back button
  (XBUTTON1), which goes back from wherever the focus is;
- typing goes into the focused field key by key (`text_input::char_input`), or into the page of a focused web view
  (posted to its window as `WM_CHAR`s); Return, Backspace and select all (Ctrl+A) go through `input::key`, and keys
  without modifiers to a focused page;
- a scroll is precision touchpad events of at most 20 points, one per display refresh (`DwmFlush`: a 16 ms sleep,
  rounded up by Win32's ~15.6 ms timers, sent fewer events than the display shows frames);
- a dialog's button is pressed at its laid-out middle (`system::dialog_point`), or outside the card to close it;
- a screenshot is what the window shows, web views and their layers included, at the window's scale: `PrintWindow`
  with `PW_RENDERFULLCONTENT`, which composes the window's swap chain and DirectComposition content as DWM does,
  whatever covers the window (drawn offscreen with Direct2D when the window cannot be captured: no pages then); the
  appearance is the system's, simulated; the size is the client area's.

`dev.rs` hands the model to the surface on the server's test session (posted messages keep their order, so it comes
before the first bundle).

`nsh test` starts the host with `--background` unless `--foreground` (`AppOptions::background`): the app's windows
show without activating and nothing brings them to the foreground, so the keyboard stays with the app the user types
in. The window that would have the keyboard is kept in `window.rs` ("Running in the background"): its fields show
their caret, the agent's keys go to it, and `WindowState.focused` and `closeOnBlur` follow it. `lifecycle()` stays
`inactive`.

```sh
target\debug\nsh test examples\gallery --target windows
echo 'await app.screenshot("a.png"); await app.press("label:Navigation"); await app.screenshot("b.png")' | target\debug\nsh test examples\gallery\App.tsx --target windows
```

The host takes `--bundle <path>` to run a build (`nsh build`) without a dev server; without it it connects to the dev
server on this machine (`--dev-server ws://…/ws` names another); `--trace` logs per-commit timings; `--fps` the
performance monitor's readings once a second ("Performance"); `--data-dir <dir>`
keeps the apps' data there (`nsh test` gives each app a fresh one). Timers are Win32's (~15.6 ms granularity).

## Performance: `--fps`

`nsh-windows-host --fps` (`nsh run --target windows --fps`, `nsh test --target windows --fps`; `AppOptions::fps`, `NSH_FPS=1`, the app's `setFpsEnabled`)
logs one `nsh::fps` line a second (`fps.rs`, on `nsh_engine::perf::PerfMonitor`), in the Linux and macOS
backends' shape: frames shown over the compositor's rate (`DwmGetCompositionTimingInfo`), the main thread's time per
shown frame and its phases (`tick`: the ticker's animations and frame callbacks; `drain`: batches applied as they
arrived; `paint`: Direct2D drawing the tree, of which `canvas` is the canvases' recording and replay; `present`:
`Present`, which queues the frame and is not counted as work), the engine's commits, its busy share, and
the process' CPU (`GetProcessTimes`) and working set. While it measures, the ticker runs on every refresh: its ticks
close the frames. While nothing composes, only the frames deadlines run (`Surface::keep_deadline`) are measured. `examples/gallery/tools/perf.py` runs the gallery under it (`--target windows` is the default on
Windows).

### Partial frames

A frame draws only what changed since the back buffer was last drawn, and presents only what changed since the last
frame: changed views queue their old and new painted areas on their surface (`Surface::take_damage`, `NshView::changed`
/ `moved`, the mounter's `redrawn`), `render::frame` draws the tree once clipped to the merged damage of this frame
and the one before (`SwapChain::to_draw`), widened to the whole box and overflow of each shader view reading what is
behind it that the damage meets (`with_backdrops`: the back buffer holds its own earlier output), and `Present1`
presents only the changed rectangles.
A frame of several areas draws through a layer masked by their rectangles, and the layer is blended over the back
buffer, so the clear inside it would keep what a transparent window (whose background is clear) had there: such a
window first clears each area on the back buffer under an axis-aligned clip.
A subtree a frame leaves out (hidden, concealed, turned away, out of sight) forgets where it was painted
(`NshView::forget_painted`): its old area was drawn by the change that left it out, and a record kept would add it to
every later change of a view around it (a moved or shrunk panel's rows repainting their old area on each scroll
frame). Each view knows whether its subtree holds a record at all, so these walks stop at subtrees that hold none.
A view taken out of the tree keeps the area its whole subtree was painted in (`NshView::unparent`): a subtree leaves
from its top and is then torn down, and its views, out of the window, cannot queue their own areas any more.
`Surface::invalidate` (theme, size, scale, device loss, composition) and changes it cannot bound draw the whole
window. Changes wholly outside the window (an animation scrolled out of it) draw and present nothing.

`render.rs`'s `a_partial_frame_draws_what_a_whole_one_does` draws a tree whole, changes it (a move, a color, a
removal) and checks that drawing the damage over the old pixels gives the bytes a whole frame gives;
`a_partial_frame_of_a_transparent_window_replaces_its_areas` does so for two areas apart in a transparent window, and
`a_subtree_torn_down_from_its_top_is_drawn_again_where_it_was` for a view with a shadow that leaves after its host.

A view whose own painted area (its box, shadows, outline and shader overflow) meets no damage paints none of its
own decoration in a partial frame: no backdrop filter, shadows, background, shader, content, hosted items, scroll
indicator or border (`render::own_paint_needed`). It is still walked, because its children may reach the damage, and
its clip, opacity group and `set_painted` bookkeeping stay. Views whose own paint has effects beyond its pixels keep
the whole path: hosted items (drawn above the children at their own rectangles), filters and blend modes (drawn
offscreen as one image), and shader views (an effect shader's children are its content, and a shader reading a
backdrop must still call `shader::take_backdrop`, whose pixels are read as its own paint begins; the shader state
that tells the inputs apart is private to `shader.rs`, so every shader view stays conservative). The fixtures
(`a_partial_frame_draws_a_child_without_repainting_its_parent`, `..._keeps_clips_opacity_and_transforms`,
`..._applies_backdrop_readers_with_off_damage_parent` and their siblings) compare every partial frame with a fresh
whole frame byte for byte. A test-only probe counts the decoration entry points by view: the parent whose own area
misses the damage reaches `draw_backdrop`, `draw_background` and the outer-shadow bake zero times (1, 1, 1 before the
skip), while the parent whose shadow meets the damage reaches all three.

A rounded box's `ID2D1Geometry` is made lazily (`decor::BoxShape`): a uniform fill draws `FillRoundedRectangle`, a
multi-fill clip takes one geometry once and forgets it after squaring the corners, and only corners that differ
(`FillGeometry`) make one.

Decoration bitmaps (blurred shadows, conic gradients) live in a 96 MiB LRU cache whose eviction now knows the
drawing pass: `render::draw_into` opens a frame (`decor::begin_frame`, nested offscreen passes share it, `Drop`
closes it on early returns), `get_or_make` records it beside the LRU use, and eviction drops other passes' bitmaps
first, so a pass keeps what it draws with. When every cached bitmap is current the bound still wins and the oldest
current bitmaps go; the bitmap just returned is already cloned out for its caller.

Outer shadows stay whole-bitmap bakes. A nine-patch of one small square's blur was implemented and measured, then
removed: Direct2D's Gaussian blur is translation-invariant in the corner, edge and middle for the same local shape on
different bitmap sizes, but a destination whose shape extent differs moves the faint outer tail by one alpha unit
(a 66 × 66 shape and a 200 × 80 one on the same 224 × 104 canvas differ at alpha 1 versus 0), so sliced pixels cannot
equal a whole-frame bake byte for byte. The reference bake and its cache key stay, and the deferral is recorded on
the performance page.

What a frame costs then follows what changed: the gallery's Stocks page (~690 views, 1200 × 800 points on a 150%
display) changes ~34 views a frame (pulsing sparklines, prices, the chart's live point), drawn in ~1.4 ms of
`paint`. Canvases record their animated tail only (see the table above), omit paints whose current values cannot
change a pixel, and ask for the cached damage of the slots that changed when the drawing lets them bound it (the full
`DamageScan` scans otherwise); views without content of their own push no clip, and views out of sight are not drawn,
under any clipping ancestor.

### Frame pacing

Every swap chain (a window's, a transparent window's composed one, a `Window.open` window's) has a frame latency
waitable object and one frame in flight (two buffers), and a window draws only when its chain holds the free token
(`SwapChain::ready`, a non-blocking poll). Otherwise `render::frame` returns before drawing, the damage and the
invalid flag stay, and a thread pool wait on the object posts `WM_NSH_PAINT` to the window when a frame is free
(posted, not `InvalidateRect`: a posted message comes before the `WM_PAINT`s that wait for the thread's other
messages). A resized window draws in its `WM_SIZE` once it holds the token (`SwapChain::wait_ready`): it waits for its
frame in flight to be shown, at most 50 ms, so a drag runs at the display's rate with one frame in flight and the
window keeps up with the pointer. This is the one place a window's present holds its thread up, for a vblank at most:
an embedding app that resizes an `NshView`, or an app resizing a window again and again, has its UI thread paced
to that window's display meanwhile. A window DWM does not show (hidden, minimized, cloaked) only polls, and a resized
window without the token waits for `WM_NSH_PAINT` as any other.

The gate is what lets several windows share a UI thread (`Window.open`, several `AppView`s in an embedding app): a
blocking `Present(1)` waited for the vertical blank of the other windows' frames, about 60 presents a second for the
whole thread, and the window whose `WM_PAINT` came last kept them: with 2 to 8 windows one showed 60 fps and the others
stopped at their first frames. Each window now shows 60 fps, with 1 to 8 windows on the thread. With the waitable flag
`Present` never waits, so the gate is also what bounds the queue: an ungated chain queues frames up to the device's
limit and shows each about 350 ms late. The device allows 16 queued frames (`MAX_DEVICE_LATENCY`) so its own limit
(three, for all chains together) never gates a window. The frame is shown about 15 ms sooner than with a blocking
present (PresentMon's present to display, p50: 47 → 32 ms at 60 Hz, one window or several). Two frames in flight were
measured and are not used: they bring back that latency (48 ms) for the same frame rate.

## Not implemented, or different

- **Web views** are composed (above), with these limits: a web view inside a view drawn with a projective transform
  (perspective) is not shown (a visual takes no perspective), nor is one whose view a shader draws a picture of (in an
  effect or a running transition, under a screen effect: WebView2 draws the page into its own visual, never into the
  picture), and one inside a filtered view is placed but not filtered; ancestors' rounded clips clip it to their
  bounds (only its own corners are rounded); a `backdropFilter` or `mixBlendMode` drawn over a page does not see it
  (the layer above starts transparent); the image a leaving page or dialog slides out as has no page (its web view
  closed with its views). The layers are presented unsynchronized with the window's swap chain, so for a frame NSH
  content above and below a page may come from consecutive frames while both animate. `baseUrl` answers only the
  document's request: other requests (images, scripts, links) go to the network, and `http(s)` base URLs are the ones
  WebView2 lets the app answer. Touch and pen input reaches pages as pointer input when it comes from the system
  (swipe navigation needs it). An offscreen drawing of the window has no pages (`PrintWindow`'s capture does). Without
  the WebView2 Runtime (it comes with Windows 11; Windows 10 gets it with Edge) a web view shows a neutral
  placeholder.
- **Native components with a window of their own** (`NativeComponent::window`) stay child windows: they cover NSH
  content drawn over them and are not in offscreen drawings of the window. Hosting an arbitrary `HWND` in a composition is not
  possible (only content made for it, such as a swap chain or a WebView2 composition controller, can be a visual).
- **Video**: which formats play depends on the installed Media Foundation codecs; there is no poster; the control bar
  always shows while `controls` is on. Unlike GTK, `rate` works.
- **Zooming scroll views**: `zoomTo` and the zoom props are ignored. Notched
  mouse wheels scroll in steps (not animated).
- **`mixBlendMode` and `backdropFilter`** are drawn (unlike Linux), except inside a view that is itself drawn
  offscreen (a filtered or 3D-transformed ancestor): there the blend is normal and the backdrop unfiltered.
  `borderCurve: "continuous"` draws circular corners; Android's `elevation` is not drawn.
- **Text**: head and middle ellipses apply to a single line only (more lines fall back to a tail ellipsis); the
  paragraph direction is set per text, not per paragraph; color emoji come from COLR fonts only (Segoe UI Emoji is
  one); small caps are not synthesized (only fonts with the `smcp` feature have them).
- **Text inputs**: Tab moves between the focus stops of the window (text fields and focusable custom views);
  keyboard types and autofill do not apply; the IME's composition is drawn inline at the caret. Clicking outside a
  field leaves the focus where it is (as on Linux and Mac Catalyst; a click on another field or on a focusable view
  moves it).
- **Hardware keys on custom views**: a focused custom view hears key downs, repeats and ups with the layout's
  logical key and the scan code's DOM `code`; a dead key's composition is not in the event (the
  committed text goes to the field/IME), and a key the system sends to a hosted web view or a native component's
  window never reaches these events.
- **Accessibility** (UI Automation): items NSH draws itself (alerts) are not in the
  tree; there is no Text pattern; headings report level 1; live regions raise UIA notifications.
- **No desktop equivalent**: the status bar, input accessory views, `keyboardShouldPersistTaps` (there is no software
  keyboard); the safe area and the keyboard height are 0.
- **Window chrome**: the menu bar is not shown while the title bar is hidden (its shortcuts work; apps open its menus
  with `Menu.popup`); an embedded surface (a child window) only shows context menus, its host owns the window. The
  dark menu bar relies on uxtheme's undocumented messages and ordinals (as Windows' own apps and Notepad++ do).
- **Precision touchpads**: Windows sends its own inertia as more wheel deltas, so a glide cannot be stopped by
  touching the pad.
- **Packaged apps** are a directory with `<name>.exe` and a `.zip` (`embedding.md`); nothing is installed.

### Programmatic window frame and level

A window's bounds are what shows of it (`window_state::visible_rect`): its
window rectangle without the resize borders Windows 10 and 11 keep invisible
outside its left, right and bottom edges, and for a maximized window without
what hangs over the monitor's work area. The compositor's frame bounds
(`DWMWA_EXTENDED_FRAME_BOUNDS`) give them for a window in the normal mode; as a
window maximizes they still are its normal frame's, so a maximized window's are
its rectangle within the work area. A normal rectangle (`rcNormalPosition`, the
placement's bounds) takes the margins measured the last time the window was in
the normal mode (`window::normal_margins`), else the system frame's.
`WindowRef.setBounds`, `center`, `setPlacement` and an opening `defaultPosition`
place that visible frame: the window's rectangle is it grown by the margins.
`WindowRef.setBounds` merges supplied fields with those bounds and uses
`SetWindowPos` without changing activation or z-order. Dimensions include the
non-client area that shows; points are scaled by the surface's current DPI.
Changes are immediate. The `level` attribute uses `HWND_TOPMOST`, `HWND_NOTOPMOST` or `HWND_BOTTOM`;
the last moves to the bottom of the current z-order, and later activation can
raise the window. The top-level guard keeps these commands out of embedded child
windows. The `taskbar` attribute (and `AppOptions::skip_taskbar`) calls
`ITaskbarList::DeleteTab` / `AddTab`; the taskbar adds a tab again whenever a
window is shown, so the choice is kept in the window's `Shell` and applied again
whenever the window is shown.

### Windows

Every window, the main one and the app's own, is a top-level Win32 window with
a `Shell` (`shell.rs`) that holds its attributes and turns them into window
styles, DWM attributes and taskbar calls; `window_state.rs` reads and sets
modes, bounds and placements in points across the monitors' scales and reports
`WindowEvent::State` once a move or resize settles. The window procedure answers
the close, Escape and blur policies on the spot from the attributes already
mounted: a close the user asks for reports `ClosePress` first and, with
`closeOnPress`, closes the window once the engine has run the app's handlers.
`windowDrag`, `windowControl` and `windowResize` views take part in
`WM_NCHITTEST`, so the system moves, snaps and resizes the window. A window of
the app's own opens hidden and shows after its first frame is drawn. Each window
carries its own content: a UI Automation tree of its own views on
`WM_GETOBJECT`, its popups and dialogs inside its root, its web views in its own
composition and the windows of native components as its children. The app's
keymap, menu shortcuts and the mouse's back button work in whichever window has
the input. Windows has no per-window control offset or workspaces; those
attributes are accepted and have no effect there.

### Transparent windows

`AppOptions::transparent` makes a borderless top-level window (`WS_POPUP`, no
system frame or shadow) with `WS_EX_NOREDIRECTIONBITMAP`, so nothing but
DirectComposition shows. The surface makes its `Composition` with the window and
keeps it (`Surface::base`); the window's own swap chain is then a composition
swap chain with premultiplied alpha (`DXGI_ALPHA_MODE_PREMULTIPLIED`), the
bottom visual of the tree, below web views and their layers, and frames clear
to transparent instead of the window background. Web views reuse that
composition. Example: `cargo run -p nsh-platform-windows --example transparent`.

## Local file drops

Views listening to `onFileDrop` register an OLE `IDropTarget` for their surface
window. The embedding UI thread must initialize OLE, as for other embedded COM
features (`OleInitialize`); the standalone runner already does so. Registration
ends when the last destination disappears or the surface stops.

`DragEnter` reads and retains the `CF_HDROP` filename list (not file contents)
for `onFileDragEnter`. Moves between destinations reuse it. Enter and
over callbacks convert screen pixels to client points and use retained view hit
testing, stopping at a modal root. Eligible targets advertise Copy. Drop reads
the local file list in native order and converts absolute paths to escaped file
URLs, then releases the storage medium with `ReleaseStgMedium`. Leave, drop,
disablement and deletion clear the active destination. Applications decide what
to do with the URLs; receiving a drop does not itself open or transfer a file.

This implementation still needs compilation and Explorer drag verification on
Windows, including target switching, cancellation, modal isolation, directories
and non-ASCII filenames.
