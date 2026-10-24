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
cargo test -p nsh-platform-windows          # needs no window: tests do not open one
cargo build -p nsh-windows-host             # target\debug\nsh-windows-host.exe
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
- **Window composition for web views** (`compose.rs`). A window without web views has no composition: one swap
  chain, drawn and presented as above. The first web view makes a DirectComposition target on the window (above
  its swap chain, below its child windows) whose root holds, bottom to top, each web view's visual (the WebView2
  composition controller's root visual target) and after each one a layer: a composition swap chain the size of
  the window (premultiplied alpha) with what NSH paints after that web view. The tree is still drawn in one pass:
  reaching a web view records where it goes (`DrawCx::compose`: its transform in window pixels, its clipping
  ancestors' clip, its own rounded corners, its opacity), and the next thing drawn first moves the context to the
  next layer (`DrawCx::realize`: the pushed clips and opacity layers are popped, the target changes, they are
  pushed again, as `flatten` does for backdrops). So what is painted before a web view is below it, and what is
  painted after it (later siblings, dialogs, alerts and toasts, the dev overlay: everything the root
  hosts later) is above it, for any number of web views. A layer nothing is drawn into is neither drawn, presented
  nor shown; the layers are presented unsynchronized (`Present(0)`) and the window's own swap chain waits for the
  vertical blank once for all; the root is re-arranged only when the order of its visuals changes, and a frame's
  changes are one `Commit`. Without a composition, `realize` is one `Option` test per view: no extra surface, copy
  or per-frame work (the cost of composing one full-window layer in DWM is not paid by windows that do not need
  it, which is why the single swap chain path stays rather than composing every window). The composition lives as
  long as a web view holds it (`Surface::compose`), and goes with the last one.
- **Drawing a view** (`render::draw_view`): shadows and background (`decor.rs`), the content clipped to the bounds
  (text, image, canvas), the children (clipped to the rounded bounds when the view clips), the items the view hosts
  (`ViewState::natives`: text editors, alerts, overlays, videos — the `Hosted` trait), the scroll
  indicator, then the border, all inside an opacity layer when translucent (bounded by the area the subtree draws in:
  an unbounded layer is a surface as large as the clip around it, often the window; a view that paints only its
  background color fades the color instead, with no layer). A view's content clip is pushed only when it has content
  (text, an image, a canvas). The children of a clipping view (a scroll view's content) whose drawn area
  (`drawn_area`: bounds, shadows, outlines, transformed children) lies outside what the window and the clips leave
  visible are not drawn (`hidden_by_clips`, in the window's pass only). Transforms are CSS-like 4x4 matrices
  (`geom.rs`); affine ones are Direct2D's 3x2 world transform, projective ones (perspective) draw the subtree into an
  offscreen bitmap mapped with `DrawBitmap`'s perspective transform. Units are points: the device context's DPI is
  the window's (the process is per-monitor DPI aware, v2).
- **One hop per commit.** The engine runs on its own thread (`nsh_engine::Engine`); its sink queues each commit and
  posts one `WM_NSH_WAKE` to the window, and the main thread applies every queued batch in order (`surface.rs`,
  `mount.rs`). The table of views by node id belongs to the mounter and is shared with the surface (`Rc<Views>`), so
  input and hosted items find views by id while a batch is being applied. Worker threads (image decoding, media
  callbacks, the dev client) run code on the main thread with `window::invoke` (a message-only dispatcher window) and
  find their surface by key in a thread-local map; no globals are shared between surfaces.
- **Text is typeset on the engine thread** with DirectWrite's shared, free-threaded factory; the final layout is plain
  data (glyph runs recorded through a text renderer of NSH's own), which the main thread only draws and hit-tests
  (`text.rs`).
- **Frames**: a ticker thread waits for each composition (`DwmFlush`) and posts `WM_NSH_TICK` (one at a time) while
  something animates: native animation values (`animation.rs` over `nsh_core::animation`), JS frame requests,
  transitions and keyframes (`transition.rs`; curves, interpolation and timing in `nsh_core::transition`), scroll
  glides, navigation transitions, video frames (`Surface::on_frame`). The ticker parks when nothing animates. Caret
  blinking and animated GIF / WebP frames use thread timers instead, so they cost no frames.
- **Devices**: one Direct3D 11 device (hardware, else WARP) and its Direct2D device and context per thread
  (`gfx.rs`); a lost device (driver update, GPU reset) is made again and `gfx::generation` tells caches of device
  resources (bitmaps, command lists) to make theirs again.
- **The standalone app** (`run_app`, `app.rs`) runs the window and its message loop on a thread of its own
  (`nsh-ui`, 8 MiB of stack for deep trees) and joins it: the devices, font faces and bitmaps cached in that thread's
  thread-locals are released at a plain thread exit. Released by the main thread's thread-local destructors instead,
  they would run inside `ExitProcess`, after the graphics DLLs are gone, and the process would end with a stray exit
  code. The UI thread sets per-monitor DPI awareness and `OleInitialize`s (clipboard, drag and drop, WIC).
- **Embedding**: `AppView` (`app.rs`) is one surface as a window: a child of the embedding app's window, or top-level;
  the host's message loop runs it. `set_ui_sets` serves the UI sets beside the runtime's modules
  (`nsh/base` by default; an app with Rust components of its own passes `nsh_base::registry()` and its sets).

## How each area maps to Windows

| Area | Module | Windows |
|---|---|---|
| Text | `text.rs` | DirectWrite on the engine thread: one `IDWriteTextLayout` per prepared text, re-broken at each width asked for; the final layout's glyph runs are recorded through a custom `IDWriteTextRenderer` and drawn on the main thread with `DrawGlyphRun`, so what was measured is what is drawn. Line heights follow Pango's model (each span as tall as its own font; DirectWrite only breaks lines). Color emoji are the COLR layers of `TranslateColorGlyphRun`. Colors and decorations are read per cluster from the drawn text's spans (a layout is reused for texts that only differ in them). Custom fonts load into an in-memory font collection (`IDWriteInMemoryFontFileLoader`). `fontVariant` is OpenType features. `selectable` text has a desktop-style range selection (mouse drags, Ctrl+A, Ctrl+C) |
| Decoration | `decor.rs` | Direct2D geometries: shadows (React Native's take the box's shape with a fill, the content's without, as iOS), blurred once into bitmaps cached by what they look like (`decor/cache.rs`); colors; linear and radial gradients as gradient brushes, conic ones drawn into cached bitmaps (`decor/gradient.rs`); inset shadows; borders per side (over the children, as UIKit); outlines; `filter`s as Direct2D effects on the subtree recorded offscreen (`decor/layer.rs`); `mixBlendMode` and `backdropFilter` read the backdrop out of the pass's target |
| Images | `image.rs` | Loaded and decoded on worker threads: WIC (PNG, JPEG, BMP, TIFF, ICO, HEIF / WebP with their codecs), the `image` crate for GIF and WebP (every frame of animations); pixels in an LRU cache per resolved location, Direct2D bitmaps made when first drawn and made again after a device loss; animated GIF / WebP on thread timers at their frame delays (paused while not drawn); blur and tint as effects at draw time |
| Canvas | `canvas.rs` | The recorded drawing replayed into an `ID2D1CommandList` when it changes (vector: sharp at any scale), played back with the view's transform; a drawing whose animated values are read late is two lists, the operations before the first that reads one (`nsh_core::canvas::first_animated`) recorded once and the rest again when a value changes (the tail replays the head's state without painting it; recorded whole when the tail would combine with the head's pixels: a composite operation in effect or set in it, a `clearRect`); the current path kept in canvas' model; shadows through the shadow effect; composite operations through the Composite / Blend effects; conic gradients as thin wedges masked by the shape; text in DirectWrite, the fonts `measureText` uses |
| Scroll views | `scroll.rs`, `nsh_core::scroll` | Offsets of their own (`ScrollState`, with the physics and gestures in `nsh_core::scroll`, shared with GPUI and Linux; `scroll.rs` draws the indicator and spinner and walks the view tree), reported as UIKit's `contentOffset`; wheel / touchpad / touch and pen scrolling with UIKit-like deceleration, snapping, paging, sticky cells, rubber banding for touch drags (wheels stop at the edges; mouse drags never scroll: they are the app's, for pans, responders and text selection; pull to refresh needs a touchscreen); the keyboard (arrows by 40 pt, Page Up / Page Down and Space / Shift+Space by 87.5% of a page, Home / End and Ctrl+Home / Ctrl+End, animated); mirrored horizontal lists for right to left; an indicator that fades and that the mouse drags as a scroll bar, shown and kept as on Linux |
| Input | `input.rs`, `window.rs`, `nsh_core::input` | Its own hit testing over the views (frames, scroll offsets, 3D transforms inverted, `pointerEvents`, `hitSlop`, `overflow: hidden`, `Overflow` areas); mouse from the `WM_*BUTTON*` messages, touch and pen from `WM_POINTER*`; touches for the responder system with `panActivation` gates; presses, long presses, hover and pressed states, `onHoverIn` / `onHoverOut` / `onHoverMove` (picked at each mouse move), `onContextMenu` (the right button; a field or selectable text nearer opens its edit menu), cursors; pan / pinch / rotate animated values (Ctrl + wheel, and precision touchpads' pinch, which Windows sends as Ctrl + wheel, pinch the view under the pointer); wheel and precision touchpad scrolling routed to scroll views, staying on the view it began in; keys go to the window's shortcuts, the system (dialogs), the focused field, selectable text, navigation, scroll views, then Tab between text fields (see "Keyboard"); the decisions over plain data (what a pointer may start, a press's events, hover changes, hit areas, pinches, wheel latching) are `nsh_core::input`'s, shared with the GPUI, Linux and macOS backends |
| Text inputs | `text_input.rs` | An editor of NSH's own (`nsh_core::text_edit`: text, selection, words, undo; the GPUI backend's too), drawn with DirectWrite and Direct2D as a hosted item at the content box; the view draws the decoration; IME composition through IMM32 (`ImmGetCompositionStringW`, the candidate window placed at the caret), enabled only while a field that is neither `readonly` nor `masked` has the focus; the composition is drawn at the caret and kept out of the text, which changes (`onChangeText`) only when it is committed, and `onCompositionChange` reports it as it starts, changes and ends (after the committed text's `onChangeText`; a commit and the next composition in one `WM_IME_COMPOSITION` are an end and a new start); a `value` JS sets while the IME composes is held and applied when the composition ends, unless the user's commit made it stale; caret blinking on a thread timer; edit counts drop stale JS values; offsets converted between UTF-16 and UTF-8; return does what `submitBehavior` says (see "Keyboard"); a right click opens the edit menu (Undo, Cut, Copy, Paste, Delete, Select All: a context menu of the platform's own, `chrome::popup_actions`, whose items send the field its keys), as on selectable text (Copy, Select All) |
| Navigation | `navigation.rs` | The decisions shared with the other desktops (`nsh_core::navigation`: the screens a stack shows and the user popped, transitions' timing, easing and offsets, what going back acts on); pages are child views, only the top one (and the one below during a transition) drawn; NSH draws no header: a page's `header` (the app's view) is a child of the page that the core places at its top, as wide as the page, with the content below it and kept above it (the system header's items of iOS and Android stay hidden); each page has an opaque backdrop in the window's color under the app's content; leaving pages and dialogs slide out as images recorded into command lists; Escape (unless a text field has the focus: Escape leaves the field), Alt+Left, the Browser Back key and the mouse's back button send `onBackPress` to the top page when the app listens and pop natively unless its `popOnBack` is false (a stack inside the newest dialog first, else that dialog gets the close attempt, `"cancel"`, and closes when `closeOnEscape`; without a dialog, the app's back listeners hear it before the stacks, and `Command::Back` goes on when none takes it) |
| Dialogs (`Dialog`) | `navigation.rs` | Children of the root above the app's views, at the size of the surface, sliding up or fading in: transparent layers with no look of their own, showing only the app's popup and backdrop (`presentation` is ignored); Tab stays inside the newest dialog, and the field that had the focus when a dialog opened leaves it and gets it back when the dialog closes |
| Alerts (`AlertDialog`), toasts | `system.rs` | Drawn in the surface as items the root hosts, in Windows 11's content dialog style (a rounded card, the default button in the system's accent color), not `MessageBox` / `TaskDialog`: they stay with an embedded surface and never run a modal loop of their own |
| Video | `native/video.rs` | Media Foundation's media engine in frame-server mode on the thread's Direct3D 11 device (a DXGI device manager); each frame is copied into a texture Direct2D draws, so a video clips, transforms and is covered like any view; `controls` draws NSH's own control bar (play / pause, scrubber, time) |
| Web views | `native/web.rs`, `compose.rs` | WebView2 composition controllers (`webview2-com`, the loader linked statically: apps ship no `WebView2Loader.dll`) drawing into a visual of the window's composition, between the layers of what NSH draws before and after them, so NSH content covers them; the visual is transformed like the view (affine), clipped to its clipping ancestors (axis-aligned bounds) and its own rounded corners, faded with its and its ancestors' opacity, and out of the tree while the view is not drawn (hidden, concealed screens); a deleted view's page stays while a removal animation keeps the view on screen. Input is NSH's: hit testing gives a point over the page to it only when no NSH content covers it there (`Hosted::raw`), and mouse buttons, moves and wheels go through `SendMouseInput`, touch and pen contacts through `SendPointerInput` (synthesized ones as the mouse); the page's cursor comes from `CursorChanged`; a click gives the page the keyboard focus (`MoveFocus`, WebView2 then takes keys and the IME itself, NSH's fields blur), a click on NSH content or Tab out of the page (`MoveFocusRequested`) gives it back. Rasterized at the window's scale (`RasterizationScale`, monitor changes not followed by WebView2 itself); bounds are the view's window pixels (pop-ups and IME candidates are placed from them). `baseUrl` navigates to the base URL and answers that document's request with the HTML (`WebResourceRequested`); `scrollable={false}` gives the wheel to the scroll views around and keeps the page's viewport from scrolling (`overflow: hidden` on its root, scripts still scroll); `desktop={{ allowsBackForwardNavigationGestures }}` is `IsSwipeNavigationEnabled` (touchscreen swipes). One environment per thread and profile folder (`%LOCALAPPDATA%\<app id>\WebView2`); a placeholder without the WebView2 Runtime |
| Native components | `native.rs` | `AppView::register_component(name, factory)`; a `NativeComponent` draws with Direct2D in the view (`draw`) or brings a child window (`window`) that follows its view after every frame, clipped with a window region, above everything NSH draws; `ComponentContext::emit` / `set_size` / `redraw` from any thread |
| Accessibility | `access.rs`, `access/uia.rs` | UI Automation: a server-side provider tree answered on `WM_GETOBJECT`, one provider per exposed view (holding only the surface key and node id); control types from `role` / text / press handlers / labelled images; `testID` as the automation id; Invoke, Toggle, ExpandCollapse, SelectionItem, RangeValue, Value and Scroll patterns; `accessible={true}` groups its content as on iOS and Android; `accessibilityElementsHidden`, `visibility: hidden` (as in a browser) and screens below the top of a stack hide a subtree; property, structure and live-region notification events only while a client listens |
| Environment | `system.rs` | Re-read on `WM_SETTINGCHANGE` (and theme / DWM color changes). Color scheme: the app's appearance (`nsh.json` `"appearance"`, `setColorScheme`) when it forces one, else `AppsUseLightTheme`, live; the title bar (DWM's immersive dark mode) and the root's background follow it. The locale (`Intl`) from `GetUserDefaultLocaleName` (not `LANG` / `LC_*`); font scale from `TextScaleFactor` (Settings > Accessibility > Text size); reduce motion from `SPI_GETCLIENTAREAANIMATION`; right to left from the UI language's reading direction; the screen reader from `SPI_GETSCREENREADER`; the pixel ratio the window's DPI over 96; `platform.os` `"windows"`, idiom `desktop`, OS version `RtlGetVersion`'s major.minor (10.0 on Windows 11 too); the accent palette for dialogs; safe area and keyboard height 0 |
| Window chrome (`nsh/desktop`) | `chrome.rs` | The title (`SetWindowTextW`); the hidden title bar: `WM_NCCALCSIZE` gives the client area the window's whole height (the side and bottom resize borders stay non-client; a maximized window's top is moved in by the frame it hangs off the monitor by, another one's by Windows 11's visible top border, which would cover the app's top row), `WM_NCHITTEST` answers the top resize border, the caption buttons (`HTMINBUTTON` / `HTMAXBUTTON` / `HTCLOSE`, so Windows 11 shows snap layouts) and `windowDrag` views (`HTCAPTION`, with the system title bar too: the system moves, maximizes and opens the window menu); the caption buttons drawn over the app after the tree (46 points wide, as tall as the app's bar: `Window.setTitleBar`'s `height`, 32 by default; Windows 11's glyphs and hover colors, dimmed while inactive), their non-client clicks handled here, never by `DefWindowProc` (which would draw Windows 95's); `WM_NCACTIVATE` with `lparam` -1 so the old caption is not painted over the app; full screen is `window::toggle_full_screen` (F11's), which tells the chrome to hide the menu bar and zero the title bar's area. Menus are Win32 menus: the menu bar (`SetMenu`, removed while the title bar is hidden or in full screen; `&` escaped, the shortcut after a tab), context menus with `TrackPopupMenuEx` (posted as `WM_NSH_MENU`: its modal loop must not run while a batch is applied); dark with the app through uxtheme's `SetPreferredAppMode` / `FlushMenuThemes` (ordinals 135 / 136) and, for the bar, `WM_UAHDRAWMENU` / `WM_UAHDRAWMENUITEM` plus the line under it after `WM_NCPAINT`; shortcuts matched on key downs before the app's key handling (`input::key`) but after `nsh/keymap`'s bindings, the editing roles excepted (they send the field its own Ctrl+key) |
| Clipboard | `system.rs` | The Win32 clipboard (`CF_UNICODETEXT`); reads are synchronous, so `Clipboard.readText` is answered at once |
| Networking | `nsh_engine::net` | ureq (rustls, webpki roots), one thread per request, streaming both ways; only connecting and the response head have deadlines |
| Dev | `dev.rs` | The dev server client on its own thread; the status pill and the error overlay drawn as items the root hosts, above the app and its dialogs; Ctrl+R and F5 reload the latest build |

## Keyboard

`WM_KEYDOWN` / `WM_SYSKEYDOWN` become `KeyEvent`s (`window.rs`) that `input::key` hands, in order, to:

- **The window's shortcuts** (`Surface::shortcuts`, wherever the focus is): the standalone app's F11 (`app.rs`: full
  screen on the window's monitor, `window::toggle_full_screen`; an embedded `AppView` has none) and the dev host's
  Ctrl+R and F5 (`dev.rs`). Alt+F4 is `DefWindowProc`'s.
- **Dialogs** (`system.rs`): Tab and the arrows between their buttons, Return / Space, Escape.
- **The app's shortcuts** (`nsh/keymap`, `keymap.rs`; see "App shortcuts" below), then **the application menu's**
  (`chrome::shortcut`, the editing roles excepted).
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
- **Scrolling** (`scroll.rs`), then **Tab / Shift+Tab** (`input::tab`): the next field in tree order within
  `navigation::focus_scope` (the newest dialog, else the surface), its text selected as in Windows' dialogs.

A handled Alt combination swallows its `WM_SYSCHAR` (Alt+Return makes one, which `DefWindowProc` would beep at) and
the Alt release (which would open the window menu). Shortcuts read virtual keys, which follow the key's US letter
under non-Latin layouts (Cyrillic, Greek), so Ctrl+C is the same key on all of them.

`onKeyPress` reports what UIKit's does: the typed text (`"Enter"` for a line break, and for a return that submits),
`"Backspace"` for a deletion (in an empty field too) and `"Escape"`. Pasted text (Ctrl+V, UI Automation's
`SetValue`) and undone edits report nothing.

**App shortcuts** (`nsh/keymap`, `keymap.rs`): `input::key` matches every key down against the mounted table
(`Keymap::find`) right after the window's shortcuts (`Surface::shortcuts`: full screen, the dev host's reload) and
the dialogs (`system::key`), and before the application menu's shortcuts (`chrome::shortcut`), the focused field,
selectable text, navigation and scroll views. A match is consumed, its queued `WM_CHAR` / `WM_SYSCHAR` removed (`PeekMessageW`), and reported as
the root's `KeyCommand`; an auto-repeat (`KeyEvent::repeat`) of a binding without `repeat` is consumed silently.
Keys are matched by virtual key code (letters and digits on every layout, punctuation by the US `VK_OEM_*` keys); a
focused text field counts as editing (`when`). With feature `dev`, Ctrl+R is never matched (the dev host reloads).

## Checking a change: `nsh test --target windows`

The development host takes the steps of `nsh/test` tests (`docs/dev/tooling.md`, "On a real platform"): `agent.rs`
implements `nsh_testing::agent::Native`, each call on the main thread (`window::invoke`), with the input `synth.rs`
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

```sh
target\debug\nsh test examples\gallery --target windows
echo 'await app.screenshot("a.png"); await app.press("label:Navigation"); await app.screenshot("b.png")' | target\debug\nsh test examples\gallery\App.tsx --target windows
```

The host takes `--bundle <path>` to run a build (`nsh build`) without a dev server; without it it connects to the dev
server on this machine (`--dev-server ws://…/ws` names another); `--trace` logs per-commit timings; `--fps` the
performance monitor's readings once a second ("Performance"); `--data-dir <dir>`
keeps the apps' data there (`nsh test` gives each app a fresh one). Timers are Win32's (~15.6 ms granularity).

## Performance: `--fps`

`nsh-windows-host --fps` (`nsh run --target windows --fps`, `nsh test --target windows --fps`; `AppOptions::fps`)
logs one `nsh::perf` line a second (`fps.rs`, on `nsh_engine::perf::PerfMonitor`), in the Linux and macOS
backends' shape: frames shown over the compositor's rate (`DwmGetCompositionTimingInfo`), the main thread's time per
shown frame and its phases (`tick`: the ticker's animations and frame callbacks; `drain`: batches applied as they
arrived; `paint`: Direct2D drawing the tree, of which `canvas` is the canvases' recording and replay; `present`:
`Present`, which waits for the vertical blank and is not counted as work), the engine's commits, its busy share, and
the process' CPU (`GetProcessTimes`) and working set. While it measures, the ticker runs on every refresh: its ticks
close the frames. `examples/gallery/tools/perf.py` runs the gallery under it (`--target windows` is the default on
Windows).

### Partial frames

A frame draws only what changed since the back buffer was last drawn, and presents only what changed since the last
frame:

- **What changed** (`Surface::take_damage`): `NshView::changed` (and `moved`, which every frame, style, content,
  animation, transition and scroll change goes through) puts the view on its surface's list. A view records where the
  window's frame painted it (`set_painted`: its bounds out by shadows and outline, with the items it hosts, clipped
  to what was visible; in a pass drawn offscreen for a filter or a 3D transform, that view's area). The damage of a
  changed view is where it and its subtree were painted (`painted_subtree`) and where its subtree draws now
  (`to_root` and `drawn_area`). A view taken out of its parent queues itself before it leaves; one inserted queues
  itself after. The mounter queues the view of every applied item that may change what is drawn (`mount.rs`
  `redrawn`), whatever applied it, and an item for the whole window (`Appearance`, `LayoutDirection`)
  invalidates all of it. `Surface::invalidate` (theme, size, scale, chrome, device loss, composition) draws the
  whole window; so do a change below a projective transform or in a subtree whose area is not known (a hosted item:
  text editors, alerts), and the system's own `WM_PAINT` with nothing queued.
- **What is drawn** (`render::frame`): the swap chain is `FLIP_SEQUENTIAL` with two buffers, so the back buffer
  holds the frame of two presents ago and a frame draws its own damage and the last frame's (`SwapChain::to_draw`;
  a new or resized chain, a window with web views and the frame after a whole one draw everything). The rectangles,
  in pixels, are merged where they touch or their union costs nothing, then the cheapest pairs until at most 24 are
  left (`merged`). The tree is drawn once into them: an axis-aligned clip for one, a layer masked by a geometry
  group of rectangles for several (pushed on the context's stack, so `flatten` keeps it; `DrawCx::clip_skip` keeps
  it out of what views record as visible), cleared to the window's background first. A view whose own area meets
  none of the rectangles is left out with its subtree when it clips its children or has none.
- **What is presented**: `Present1` with the frame's own changed rectangles, so DWM composes only those.

`render.rs`'s `a_partial_frame_draws_what_a_whole_one_does` draws a tree whole, changes it (a move, a color, a
removal) and checks that drawing the damage over the old pixels gives the bytes a whole frame gives.

What a frame costs then follows what changed: the gallery's Stocks page (~690 views, 1200 × 800 points on a 150%
display) changes ~34 views a frame (pulsing sparklines, prices, the chart's live point), drawn in ~1.4 ms of
`paint`. Canvases record their animated tail only (see the table above), views without content of their
own push no clip, and the children of a clipping view out of sight are not drawn.

## Not implemented, or different

- **Web views** are composed (above), with these limits: a web view inside a view drawn with a projective transform
  (perspective) is not shown (a visual takes no perspective), and one inside a filtered view is placed but not
  filtered; ancestors' rounded clips clip it to their bounds (only its own corners are rounded); a `backdropFilter`
  or `mixBlendMode` drawn over a page does not see it (the layer above starts transparent); the image a leaving
  page or dialog slides out as has no page (its web view closed with its views). The layers are presented
  unsynchronized with the window's swap chain, so for a frame NSH content above and below a page may come from
  consecutive frames while both animate. `baseUrl` answers only the document's request: other requests
  (images, scripts, links) go to the network, and `http(s)` base URLs are the ones WebView2 lets the app answer.
  Touch and pen input reaches pages as pointer input when it comes from the system (swipe navigation needs it). An
  offscreen drawing of the window has no pages (`PrintWindow`'s capture does). Without the WebView2
  Runtime (it comes with Windows 11; Windows 10 gets it with Edge) a web view shows a neutral placeholder.
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
- **Text inputs**: Tab moves between text fields only; keyboard types and autofill do not
  apply; the IME's composition is drawn inline at the caret. Clicking outside a field leaves the focus where it is (as
  on Linux and Mac Catalyst; a click on another field moves it).
- **Accessibility** (UI Automation): items NSH draws itself (alerts, toasts) are not in the
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

`Window.setFrame` merges supplied fields with `GetWindowRect` and uses
`SetWindowPos` without changing activation or z-order. Dimensions include the
non-client area; points are scaled by the surface's current DPI. Changes are
immediate. `Window.setLevel` uses `HWND_TOPMOST`, `HWND_NOTOPMOST` or `HWND_BOTTOM`;
the last moves to the bottom of the current z-order, and later activation can
raise the window. The top-level guard keeps these commands out of embedded child
windows.

## Local file drops

Views listening to `onFileDrop` register an OLE `IDropTarget` for their surface
window. The embedding UI thread must initialize OLE, as for other embedded COM
features (`OleInitialize`); the standalone runner already does so. Registration
ends when the last destination disappears or the surface stops.

`DragEnter` checks for `CF_HDROP` without retrieving the file list. Enter and
over callbacks convert screen pixels to client points and use retained view hit
testing, stopping at a modal root. Eligible targets advertise Copy. Drop reads
the local file list in native order and converts absolute paths to escaped file
URLs, then releases the storage medium with `ReleaseStgMedium`. Leave, drop,
disablement and deletion clear the active destination. Applications decide what
to do with the URLs; receiving a drop does not itself open or transfer a file.

This implementation still needs compilation and Explorer drag verification on
Windows, including target switching, cancellation, modal isolation, directories
and non-ASCII filenames.
