# The Linux backend (GTK 4)

`crates/nsh-platform-linux` renders NSH apps with GTK 4 widgets and lays text out with Pango. `crates/nsh-linux-host`
is its development host (`nsh run --target linux`, the default on Linux), `crates/nsh-linux-app` the release runner of
`nsh package --target linux`. Like the macOS and Windows backends, it follows the mobile backends' design (one native
view per node, the core lays everything out); the GPUI backend (`gpui.md`) is a separate effort. User-facing page: `website/docs/linux.md`.

## Building and checking

The crates need the GTK 4 (≥ 4.14; Pango from 1.50 on, the app's fonts going through Fontconfig) development
packages (`libgtk-4-dev` on Debian / Ubuntu, `gtk4` on Arch, `gtk4-devel` on Fedora), for web views WebKitGTK 6.0's
(2.40 or later: `libwebkitgtk-6.0-dev` on Debian / Ubuntu, `webkitgtk-6.0` on Arch, `webkitgtk6.0-devel` on Fedora) and,
for QuickJS, clang. Off Linux the crates are empty (like the other platform crates off their targets), so check them on
Linux:

```sh
cargo clippy -p nsh-platform-linux -p nsh-linux-host -p nsh-linux-app --all-targets   # with web views (the hosts' default)
cargo clippy -p nsh-platform-linux --all-targets   # without: web views as placeholders
cargo test -p nsh-platform-linux --features webview   # needs no display: tests do not start GTK
cargo build -p nsh-linux-host             # ./target/debug/nsh-linux-host
```

The Linux binaries are built for the machine itself, so the CLI finds them in `target/<profile>` (not
`target/<triple>/<profile>`) and builds them first in a checkout; `cargo xtask dist` on Linux puts them in
`dist/nsh/runtime/linux/` (`docs/dev/tooling.md`, `embedding.md`). CI: `.github/workflows/linux.yml` (Ubuntu 24.04:
clippy and tests of the Linux crates, the CLI, `nsh-dev` and xtask).

Features: `js` (default; JS apps; without it the crate only runs Rust apps and links no QuickJS), `dev` (the dev
server client, log forwarding, the error overlay: `dev.rs`) and `webview` (web views with WebKitGTK 6.0, the `webkit6`
crate: `native/web.rs`; without it a `WebView` shows a placeholder). `webview` is off in `nsh-platform-linux` itself,
so an embedding GTK app decides whether it links WebKitGTK, and on by default in `nsh-linux-host` and `nsh-linux-app`
(their own feature `webview`). TSX apps use these defaults. Generated Rust app runners turn off default features;
the app enables `nsh-platform-linux`'s `webview` feature in its own Cargo dependency when it uses web views. Cargo
unifies that feature with the runner's platform dependency, so only apps that enable it link WebKitGTK.
With `webview`, the release runner links `libwebkitgtk-6.0.so.4`, so that packaged app needs WebKitGTK 6.0
installed to start (`libwebkitgtk-6.0-4` on Debian / Ubuntu; GNOME desktops have it), whether or not it shows a
web view: WebKitGTK cannot be loaded on demand the way iOS and macOS load WebKit, as the `webkit6` bindings link
it. `cargo xtask dist` builds both with web views when `pkg-config` finds `webkitgtk-6.0`, else without them
(`--no-default-features`, with a warning), so a distribution made without WebKitGTK's development files still
works and its runner only needs GTK.

## Architecture

- **One widget per node.** Each node is an `NshView` (`view.rs`, a `gtk::Widget` subclass). The core lays everything
  out, so a view never measures itself: its parent places it in `size_allocate` at the core's frame (origin, scroll
  offset, sticky shift and transform in one `gsk::Transform`, the offset at whole points as GTK places its own widgets);
  frames are kept as `f32` points and the integer
  allocation only bounds picking. `snapshot` draws, in order: shadows and background (`decor.rs`), the content (text,
  image, canvas), the children (clipped to the rounded bounds with `overflow: hidden`), the border, then hosted GTK
  widgets (`ViewState::natives`: text editors, videos, web views).
- **One hop per commit.** The engine runs on its own thread (`nsh_engine::Engine`); its sink queues each commit and wakes
  the main loop once (`MainContext::invoke`), and the main thread applies every queued batch in order (`surface.rs`,
  `mount.rs`). `invoke` closures must be `Send`, so they find their surface by key in a thread-local map; no globals
  are shared between surfaces.
- **Text is typeset on the engine thread** with a Pango font map of the engine's own (Pango objects are not
  thread-safe, and GTK's font map belongs to the main thread). The final layout is plain data, per glyph run the font's
  description, glyph ids and positions; the main thread loads the same fonts by description from GTK's font map and
  draws `gsk::TextNode`s where the engine put them. Hinted metrics and rounded positions are off on both sides, so
  what was measured is what is drawn (`text.rs`).
- **Animations run on the frame clock**: native animation values (`animation.rs` over `nsh_core::animation`, the
  Android animator's design), JS frame requests (the root's tick callback, `surface.rs`), `LayoutAnimation`, style
  transitions and keyframes (`transition.rs`; curves, interpolation and timing in `nsh_core::transition`, shared
  with Windows, GPUI and macOS), scroll glides and navigation transitions; tick callbacks exist only while something
  animates.
- **Embedding**: `AppView` (`app.rs`) is one surface as a widget; `run_app` opens one in a window. `set_ui_sets`
  serves the UI sets beside the runtime's modules (`nsh/base` by default; an app with Rust components of its own passes
  `nsh_base::registry()` and its sets).

## How each area maps to GTK

| Area | Module | GTK |
|---|---|---|
| Text | `text.rs` | Pango layouts on the engine thread, `gsk::TextNode` glyph runs; colors and decorations read per cluster from the spans (a layout is reused for texts that only differ in them); cap / x height from the font's OS/2 table (HarfBuzz); `selectable` text's range selection, desktop style (below) |
| Selectable views | `selectable_view.rs` | One selection across the texts of a `selectable_view` view's subtree (`nsh_core::selection`'s model; depth-first order, an area inside another is part of it), driven from `input.rs`'s pointer handlers, so simulated drags select too: a mouse press in an area presses the model (GTK's double-click time and distance count clicks, Shift+click extends), a drag past 3 pt (10 pt over a press target, which then does not fire) drags it, dragging past a scroll view's edge around the area scrolls it; texts draw their part with the `selectable` highlight and run no selection of their own; the area view takes the focus while it has a selection (Ctrl+A / Ctrl+C / Ctrl+Insert / Escape, the menu's Copy and Select All), any press elsewhere or losing the focus clears it (one selection per surface), a finished drag sets the primary selection |
| Decoration | `decor.rs` | GSK nodes: shadows (React Native's take the box's shape with a fill, the content's without, as iOS), colors, gradients, inset shadows, borders (over the children, as UIKit), outlines, filters |
| Images | `image.rs` | Loaded and decoded on worker threads (GDK's PNG / JPEG / TIFF loaders, the `image` crate for GIF and WebP), textures in an LRU cache per resolved location; animated GIF / WebP play on timers of their frame delays (paused while unmapped); blur and tint at draw time |
| Canvas | `canvas.rs` | The recorded drawing replayed with Cairo into an image surface at the surface's (fractional) scale, shown as 256 px texture tiles; animations redraw only their damage over the kept pixels of the drawing's static part, canvases out of sight wait (`docs/dev/canvas.md`); `fillRect` / `fillText` set the current path aside once (in device space) until an operation uses it; shadows blurred into a mask; conic gradients as mesh patterns |
| Scroll views | `scroll.rs`, `nsh_core::scroll` | Offsets of their own (`ScrollState`, with the physics and gestures in `nsh_core::scroll`, shared with Windows and GPUI; `scroll.rs` draws the indicator and spinner and handles the window's keys), reported as UIKit's `contentOffset`; wheel / touchpad / touchscreen scrolling with UIKit-like deceleration, snapping, paging, sticky cells, rubber banding for touch drags (mouse drags never scroll: they are the app's, for pans, responders and text selection; pull to refresh needs a touchscreen); an indicator that fades (it shows while the mouse moves over the view, as overlay scroll bars do; horizontal views keep it with `scrollbar={false}`, their only scroll bar for a mouse without a horizontal wheel) and that the mouse drags as a scroll bar (a mouse press within 12 pt of the edge on the indicator, faded or not, drags it as a scroll bar's thumb: the content moves the other way, so the thumb follows the pointer); the keyboard (arrows by 40 pt, Page Up / Page Down and Space / Shift+Space by a page, Home / End) scrolls the view around the focused widget or under the pointer while no field has focus; a widget that gets the focus (Tab, a click, `focus()`) is scrolled into view, animated |
| Input | `input.rs`, `nsh_core::input` | Its own hit testing over the views (GTK's `pick` ignores `overflow: hidden`, `hidden` and `box-only`; hosted widgets are picked inside with GTK's; outside a view's bounds only in its `Overflow` area); touches for the responder system, with `panActivation` gates (the scroll views around wait for the pan to fail; `TouchEvent::activated`); native presses, long presses, hover and pressed states, `onHoverIn` / `onHoverOut`; pan / pinch / rotate animated values (Ctrl + wheel pinches); wheel, touchpad and touch scrolling routed to scroll views (only touches drag them): wheels go to views along their axis, and a scroll stays on its view until it ends (touchpad gesture; wheel notches within 200 ms); the decisions over plain data (what a pointer may start, a press's events, hover changes, hit areas, pinches, wheel latching) are `nsh_core::input`'s, shared with the other desktop backends |
| Text inputs | `text_input.rs` | `gtk::Text` / `gtk::TextView` in a `gtk::ScrolledWindow`, hosted at the content box; the view draws the decoration, a per-input style provider clears GTK's (an animated `color` goes to a second one-rule provider, so frames do not reload the sheet); edit counts drop stale JS values; a user edit reports `onChange` once the main loop is idle (or before a submit or blur), so a text view's paste over a selection, undo and redo (a deletion and an insertion) report their result once; offsets converted between UTF-16 and characters; return does what `submitBehavior` says (see "Keyboard") |
| Navigation | `navigation.rs` | The decisions shared with the other desktops (`nsh_core::navigation`: the screens a stack shows and the user popped, transitions' timing, easing and offsets, what going back acts on); pages are child views, only the top one (and the one below during a transition) child-visible; NSH draws no header: a page's `header` (the app's view) is a child of the page that the core places at its top, as wide as the page, with the content below it and kept above it (the system header's items of iOS and Android stay hidden); each page has an opaque backdrop in the window's color under the app's content; departing pages leave as a `gtk::WidgetPaintable` image; Escape (unless a text field has the focus: Escape leaves the field), Alt+Left, the Back key and the mouse's back button send `onBackPress` to the top page when the app listens and pop natively unless its `popOnBack` is false (a stack inside the newest dialog first, else that dialog gets the close attempt, `"cancel"`, and closes when `closeOnEscape`; without a dialog, the app's back listeners hear it before the stacks, and `Command::Back` goes on when none takes it) |
| Dialogs (`Dialog`) | `navigation.rs` | Children of the root above the app's views, at the size of the surface, sliding up or fading in: transparent layers with no look of their own, showing only the app's popup and backdrop (`presentation` is ignored); the views under the newest dialog cannot take the focus (`can-focus` off), and the widget that had it when a dialog opened gets it back when it closes |
| Alerts (`AlertDialog`) | `system.rs` | GTK widgets the root hosts over the app's views (not separate windows: they stay with an embedded surface and never block the main loop) |
| Video | `native.rs` | `gtk::MediaFile` (GStreamer) in a `gtk::Picture`, or `gtk::Video` with `controls` |
| Web views | `native/web.rs` | `WebKitWebView` (WebKitGTK 6.0, feature `webview`) hosted in the node's view like a video (mapped only while the view has a size, and loading only once mapped: with WebKit's DMA-BUF renderer a page loaded before its view is mapped sometimes stays blank for good), so it stacks, clips, fades and transforms with NSH content (dialogs, alerts and later siblings draw over it; departing pages keep its last frame in their `WidgetPaintable`): no composition surfaces. iOS's bridge (`window.nsh.postMessage` through a script message handler), injected scripts as top-frame user scripts, `javaScriptEnabled` as `enable-javascript-markup`, `scrollable: false` as a user style sheet hiding the top document's overflow, `allowsBackForwardNavigationGestures`, user agent; the `webview` capability decided in `decide-policy` (for frames too: WebKitGTK does not tell them apart); responses it cannot show are refused, not downloaded; website data per app id in a `NetworkSession` (`$XDG_DATA_HOME/<app id>/webkit`, cache in `$XDG_CACHE_HOME`); the page's `prefers-color-scheme` follows GTK's settings, which follow the app. Pointer events GTK would send to a clipped-off part of a page are kept from it (`input.rs`); Escape a focused page does not use leaves it, Alt+Left / Alt+Right / Back / Forward and the mouse's side buttons move in the page's history first |
| Native components | `native.rs` | `AppView::register_component(name, factory)`; a `NativeComponent`'s widget fills the node's view; `ComponentContext::emit` / `set_size` from any thread |
| Accessibility | `access.rs` | `GtkAccessible` (AT-SPI): roles from `role` / text / press handlers / labelled images, labels, descriptions, values, states; `accessibilityElementsHidden` and `visibility: hidden` (as in a browser) hide the subtree (`AccessibleState::Hidden`); `testID` as the widget name; live regions emulated with `gtk_accessible_announce` |
| Environment | `system.rs` | Color scheme: the app's appearance (`nsh.json` `"appearance"`, `setColorScheme`) when it forces one, else the XDG settings portal's (`org.freedesktop.appearance color-scheme`, live); hosted GTK widgets, dialogs and the root's background follow it, and a packaged app's window opens in it (`nsh/app.json`). The locale (`Intl`) from `LC_ALL` / `LC_TIME` / `LC_NUMERIC` / `LC_MESSAGES` / `LANG`, else GLib's language names. Font scale from `gtk-xft-dpi`, reduce motion from `gtk-enable-animations`, the surface's (fractional) scale, GTK's text direction, AT-SPI's `ScreenReaderEnabled`; `platform.os` `"linux"`, idiom `desktop`, OS version the kernel's major.minor; safe area and keyboard height 0 |
| Window chrome (`nsh/desktop`) | `chrome.rs` | Title from `Window.setTitle`; the hidden title bar hides the window's header (the owner's `titlebar` or GTK's own `default-decoration` header bar), so GTK's client-side decorations keep their shadows and resize edges without the window being mapped again; a window the window manager decorates (X11, Wayland compositors that prefer server-side decorations, such as Hyprland) gets an empty, hidden `set_titlebar` box instead, which GTK can only apply by mapping the window again (it warns that the window is realized), with `gtk::WindowControls` for both ends over the app in the `AppView`'s overlay (the desktop's `gtk-decoration-layout`), their measured widths and the header's height (46 pt at least) reported as the environment's `title_bar` (0 in full screen). A primary press on a `windowDrag` view moves the window (`gdk::Toplevel::begin_move`), a double press follows `gtk-titlebar-double-click`, a secondary press opens the window menu. The application menu is a `gio::Menu` (separators split sections; checkable items are stateful actions) with its actions in a group on the window (`nsh.item-N`), shown in a `gtk::PopoverMenuBar` above the app (`AppView::widget` is a box holding it and the overlay) unless the title bar is hidden or in full screen; its shortcuts are a capture-phase `gtk::ShortcutController` on the window, which GTK runs before the keymap's (each gives way to a `keymap` binding of the same keystroke that fires: `keymap::claims`; the editing roles' stay the text field's, and run as the focused field's `clipboard.*` / `selection.select-all` / `text.undo` / `text.redo` actions). Context menus are `gtk::PopoverMenu`s parented to the root, which presents its popovers on every allocation (else they keep the size of their first frame and scroll) |
| Clipboard | `system.rs` | The display's `GdkClipboard`; reads are asynchronous (another app's text), `hasText` only looks at the formats on offer |
| Networking | `nsh_engine::net` | ureq (rustls, webpki roots), one thread per request, streaming both ways; only connecting and the response head have deadlines |
| Dev | `dev.rs` | The dev server client on its own thread; status line and error overlay above the surface; Ctrl+R reloads the latest build |

## File drop destinations

Views listening to `onFileDrop` install a root `GtkDropTarget` for `GdkFileList`
while at least one enabled destination is mounted. The controller negotiates
Copy, uses NSH hit testing to choose the closest destination within its modal,
and emits entry/leave as that destination changes. Dropped `GFile`s with absolute
local paths are delivered as file URLs, preserving filename escaping. Removing
the last destination removes the controller; disabling or deleting the current
target clears its drag state. The implementation lives in `file_drop.rs`.

## Keyboard

A key goes through the window's controllers in GTK's order: capture from the window down to the focus widget, then
bubble back up. What NSH adds:

- **Window shortcuts** (`app.rs`, standalone apps only, not an embedded `AppView`): Ctrl+Q quits, Ctrl+W closes the
  window (GtkWindow's `window.close`, a bubble-phase shortcut of the window rather than an application accelerator,
  which would run before everything: the app may bind Ctrl+W), F11 toggles full screen, as GNOME apps do; the dev host's Ctrl+R (`dev.rs`) is a
  global-scope `gtk::ShortcutController`. Application accelerators and shortcut triggers also match the key of the
  layout's Latin group, so they work under Cyrillic or Greek layouts.
- **In a field** (`text_input.rs`), GTK's own bindings edit: Ctrl+arrows, Ctrl+Backspace / Delete, Home / End and their
  Shift variants, Ctrl+A / X / C / V, Ctrl+Z / Ctrl+Shift+Z (a secure field refuses cut and copy; `maxLength`
  clips pasted text in `insert-text`). The editors' capture-phase key controller reports Backspace in an empty input
  and Escape, and takes return in a multiline input whose `InputConfig::submit()` is not `Newline`: a plain return or
  Ctrl+Return submits, Shift+Return and Alt+Return reach the text view and insert a line break. That return goes to
  the input method first (`TextView::im_context_filter_keypress`): one that commits a composition submits nothing. A
  single line submits from `gtk::Text`'s `activate`, which GTK emits only after the input method passed on the return.
- **At the window**, keys nothing focused used: going back (`navigation::key_pressed`: Escape, which leaves a focused
  field instead; Alt+Left and the Back key, also from a field, which does not use them), scrolling (`scroll.rs`, not
  while a field has the focus) and the mouse's back button. A `selectable` text with a selection takes Ctrl+A / Ctrl+C
  / Escape (`text.rs`), and so does a selectable view with one (`selectable_view.rs`, above); without one Escape goes on.
- **The app's shortcuts** (`nsh`'s `keymap`, `keymap.rs`): the mounted table becomes a global-scope, capture-phase
  `gtk::ShortcutController` on the root, which the window runs before the focus widget and its own capture
  controllers (in the bubble phase a field would take Ctrl+A or Ctrl+Return first); one `gtk::Shortcut` per binding
  (newest first, a `<Control><Shift>p` trigger, which GTK also matches on the Latin group's keys; a shifted key other
  than a letter is named by the keyval Shift types on the display's layout, `shift+/` as `<Shift>question`, since
  GTK compares the event's keyval); its action fires only where the binding may (the
  focus in another surface: never; in a text widget or hosted widget: only bindings `in_text`), reports the root's
  `KeyCommand` and stops the key, else lets GTK go on. The application menu's shortcuts (`chrome.rs`) run first but
  give way to a binding that fires (`keymap::claims`), so a binding wins over a menu item of the same keystroke, as on
  macOS and Windows. Ctrl+Q, Alt+F4 and F11 cannot be bound; built with `dev`,
  Ctrl+R gets no shortcut (the dev host reloads). GDK does not mark auto-repeats: a binding without `repeat` fires
  once until the window's capture-phase key controller sees a release.
- **Focus**: Tab / Shift+Tab is GTK's, in screen order (GTK sorts a container's children by position); hidden screens
  are not child visible, and the views under the newest dialog cannot take the focus. Alerts (`system.rs`) move it
  between their own buttons.

`onKeyPress` reports what UIKit's does: the typed text (`"Enter"` for a line break), `"Backspace"` for a deletion (in
an empty input too), and `"Escape"`, as on macOS. Pasted and undone text, and the deletion of a selection typed over,
report nothing: the key being handled is kept until the main loop is idle, and `paste-clipboard` marks the paste.

## Checking a change: `nsh test --target linux`

The development host takes the steps of `nsh/test` tests (`docs/dev/tooling.md`, "On a real platform"): `agent.rs`
implements `nsh_testing::agent::Native`, each call on the GTK main thread (`MainContext::invoke`), with the input
`synth.rs` makes. GTK 4 cannot be handed a made-up event, so the input goes through the handlers real input reaches:

- a press is the mouse's down and up at the view's middle through `input::simulate` (after a hover), and a release on
  a hosted widget (a text field) focuses it, as a real click would;
- typing inserts each character into the focused `GtkText` / `GtkTextView` at its caret (`insert_text`, so the
  field's checks see each one), Return activates a line (a new line in an area), Backspace emits `backspace`, select
  all selects the field's text;
- a scroll is smooth wheel events of at most 20 points, a frame apart;
- back is Escape (`navigation::key_pressed`), twice when a field has the focus (the first only leaves it);
- a dialog's button is the `GtkButton` with that label, clicked; closing it without one is its dismissal (a click
  outside the card);
- a screenshot renders the window's content offscreen at its scale after the next frame is painted
  (`GtkWidgetPaintable`), whatever covers the window; the appearance is the portal's, simulated; the size is the
  window's default size.

`dev.rs` hands the model to the surface on the server's test session (idle sources keep their order, so it comes
before the first bundle). On a machine without a display, the tests run on a virtual one:

```sh
xvfb-run -a ./target/debug/nsh test examples/gallery --target linux
echo 'await app.screenshot("a.png"); await app.press("label:Navigation"); await app.screenshot("b.png")' \
  | xvfb-run -a ./target/debug/nsh test examples/gallery/App.tsx --target linux   # steps from stdin
```

The agent's keys are the field's signals rather than key events (GTK 4 cannot make one). For real key events
(modifiers, input methods, shortcuts) run the host under Xvfb with the X11 backend and drive it with `xdotool` (a
window manager such as openbox makes full screen work):

```sh
Xvfb :77 & export DISPLAY=:77 GDK_BACKEND=x11
./target/debug/nsh-linux-host --bundle out/bundle.qbc & sleep 2
W=$(xdotool search --pid $! | tail -1)
xdotool mousemove --window $W 100 30 click 1; xdotool type --window $W "hi"; xdotool key --window $W shift+Return
```

Without `--bundle` the host connects to the dev server on this machine (`--dev-server ws://…/ws` names another);
`--trace` logs per-commit timings; `--fps` logs the performance monitor's readings once a second (below); `--data-dir <dir>` keeps the apps' data there (`nsh test` gives each app a fresh
one); `--app-id <id>` (which `nsh run` passes from `nsh.json`, as on the macOS,
Windows and GPUI hosts) names the GTK application and the directory of its web view data (the app's storage follows the id
the bundle carries). GTK Inspector (`GTK_DEBUG=interactive`) shows the widget tree, with each view's
`testID` as its name.

## Performance: `--fps`, the renderer

`nsh-linux-host --fps` (`nsh run --target linux --fps`, `nsh test --target linux --fps`; `AppOptions::fps`) logs one
`nsh::perf` line a second (`fps.rs`, on `nsh_engine::perf::PerfMonitor`): frames GTK drew over the display's rate,
the main thread's time per drawn frame from the frame clock's `before-paint` to `after-paint` and its phases
(`update`, `layout`, `paint`, and within `paint` NSH's `snapshot` and the canvases' rasterizing), batches applied per
drain, the engine's commits (JS and core time, mount items), its busy share, and the process' CPU and resident memory.
`examples/gallery/tools/perf.py` runs the gallery under it, idle and scrolling on every demo, and prints a table.

GSK's Vulkan renderer (GTK's default since 4.16) costs the main thread several times what its GL renderer does under
NVIDIA's driver (gallery Animations, 1896×1030 at 120 Hz: ~9.5 ms of `paint` per frame and 73% CPU at 75 fps, against
~1 ms and 14% at 120 fps): `run_app` sets `GSK_RENDERER=ngl` there (`/proc/driver/nvidia/version` exists) unless the
environment chooses one. Memory, release, at rest after 3 s: a GTK 4 window of one label takes ~130–160 MB resident
on this desktop (GTK, Mesa / NVIDIA libraries shared with other processes), ~60 MB of it private under Vulkan or GL;
NSH's Rust template app is ~49 MB private (USS), the TSX counter ~79 MB. `GSK_RENDERER=cairo` halves the private
memory (~28 MB for the Rust app) at a much higher CPU cost for animated content.

## Not implemented, or different

- **Web views** (with the `webview` feature): the `webview` capability also applies to the navigations of frames (an
  `iframe` of a host that is not granted stays empty), as WebKitGTK's `decide-policy` does not say which frame a
  navigation is for; iOS and macOS only check the main frame's. A new window (`target="_blank"`, `window.open`) opens
  nothing, as on iOS. Script dialogs (`alert`, `confirm`) are WebKitGTK's own, drawn inside the page (iOS and macOS show
  none). The test agent's presses focus a page but do not click into it (GTK never sees them). Without the
  feature a `WebView` shows a neutral placeholder and ignores its commands.
- **Video**: GTK streams have no playback rate, so `rate` is ignored (warned once); a looping video never ends, so
  `onEnd` only comes for videos that do not loop. Which formats play depends on the installed GStreamer plugins.
- **Zooming scroll views**: `zoomTo` and the zoom props are ignored.
- **`mixBlendMode` and `backdropFilter`** are not drawn: they need what lies behind the view, which a widget's snapshot
  does not have (the background color still draws). `borderCurve: "continuous"` draws circular corners.
- **Input accessory views** belong over a software keyboard: never shown.
- **`keyboardShouldPersistTaps`** is ignored: it decides what a tap does while the software keyboard is up, and there is
  none (the keyboard height is 0). iOS ignores it with a hardware keyboard too (Mac Catalyst always): taps outside the
  focused field act at once and leave the focus where it is (a click on another field moves it).
- **Accessibility**: `accessible={true}` grouping (children stay separate elements), `accessibilityActions` (GTK has no
  custom actions) and real live regions (emulated by announcements).
- **No desktop equivalent**: the status bar; `AccessibilityFocus` moves keyboard focus when the view can take it.
- **Packaged apps** are a directory and a `.tar.gz` (`embedding.md`); GTK 4, Pango and (with the release runner's
  default `webview` feature) WebKitGTK 6.0 must be installed where they run.

### Programmatic window size

`Window.setFrame` merges supplied dimensions with `gtk::Window::default_size`,
then calls `set_default_size`. GTK applies the request asynchronously, so merging
with the widget allocation would discard earlier partial updates in the same batch.
The window manager controls placement and stacking; resize animation is immediate.
