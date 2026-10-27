# The macOS backend (AppKit)

`crates/nsh-platform-macos` renders NSH apps with AppKit views, Core Animation and CoreText. `crates/nsh-macos-host` is
its development host (`nsh run --target macos`), `crates/nsh-macos-app` the release runner of `nsh package --target
macos`. It follows the Linux backend's desktop design (`linux.md`: NSH picks views itself, scroll views keep offsets of
their own, NSH moves pages and dialogs, draws no header or dialog look of its own, `desktop={{…}}` props apply) with the iOS
backend's Apple drawing (CoreText, Core Graphics, Core Animation layers, ImageIO, `NSURLSession`, AVFoundation, WebKit).
Mac Catalyst (`nsh-platform-ios` on `aarch64-apple-ios-macabi`) is selected with `--target catalyst`: it is
UIKit, phone-style. In a checkout, `cargo run` runs the gallery here (`--target catalyst` for Catalyst). User-facing page: `website/docs/macos.md`.

## Building and checking

The crates need only Xcode's command line tools (the macOS SDK) and, for QuickJS, clang. Off macOS they are empty (like
the other platform crates off their targets). They are built for the machine itself, so the CLI finds them in
`target/<profile>` and builds them first in a checkout; `cargo xtask dist` puts them in `dist/nsh/runtime/macos/`.

```sh
cargo clippy -p nsh-platform-macos -p nsh-macos-host -p nsh-macos-app --all-targets --features nsh-platform-macos/dev
cargo test -p nsh-platform-macos --features dev   # needs no window server: tests do not start AppKit
cargo build -p nsh-macos-host                     # ./target/debug/nsh-macos-host
```

Features: `js` (default; JS apps; without it the crate only runs Rust apps and links no QuickJS) and `dev` (the dev
server client, log forwarding, the error overlay: `dev.rs`). The runtime needs macOS 14 (`NSView`'s display links).

## Architecture

- **One view per node.** Each node is an `NshView` (`view.rs`, a flipped, layer-backed `NSView` subclass holding the
  node's `ViewState`). The core lays everything out: a view sits at its frame (`place()`: the origin, a sticky shift,
  mirrored lists), and its transform, opacity and visibility are its layer's. AppKit resets a layer-backed view's
  anchor, position and transform when it moves the view, so `place()` sets them again every time, with the anchor at
  the top left (transforms are conjugated around the transform origin).
- **Children live in a container** when the view needs one: scroll views always (a moving offset is the
  container layer's `sublayerTransform`, so a scroll frame is one layer write; the container's bounds origin takes
  it, as `NSClipView` scrolls, once the view and the display link rest, as `setBoundsOrigin:` walks the subtree;
  a press and anything that asks AppKit where a view is commit first), and views that clip their children and cast a
  shadow (clipping a layer clips its shadow). Hosted AppKit views (text fields, videos, web views) are
  `ViewState::natives`, above the children; hit testing follows the AppKit order of hosted views and children.
- **Web views and videos are views among the others**, so window composition needs no surfaces of its own (unlike
  Windows' child windows): a `WKWebView` is a layer-backed subview of its node's view, and the layer WebKit's process
  draws into is composited by Core Animation with the rest. What is above it in the view tree draws over it (later
  siblings, dialogs; the dev status line, error overlay and FPS HUD are above the
  root), and its ancestors' clipping (corner radii, masks), opacity, transforms, hiding and scroll offsets apply to
  it. AppKit's input and in-process rendering do not follow the layers: the root's `hitTest:` decides with NSH's
  picking (Input, below), a page under a transformed ancestor is drawn transformed but gets mouse positions as if it
  were not, and `renderInContext:` leaves pages and videos out (leaving pages and dialogs take the live views
  along; the test agent's screenshots show pages, which WebKit draws for `cacheDisplayInRect:`, but not videos). `NSAlert` sheets are windows of their own, above everything.
- **Drawing**: Core Animation draws backgrounds, borders, corners, shadows, gradients and images (`decor.rs`,
  `visual.rs`, `image.rs`, the iOS backend's design). Text and canvas views draw into a **content layer** of their own
  (`NshView::redraw`: a plain `CALayer` sublayer whose delegate draws in `drawLayer:inContext:`, above the decoration
  behind the view and below its children); no view uses `drawRect:`, every view uses `updateLayer` and gets no backing
  store. Implicit animations are off for every change NSH makes (`surface::quiet`; the content layer's delegate
  answers no action).
- **Why not `drawRect:`**: a scroll's commit moves a container's bounds origin, and `setBoundsOrigin:` walks the subtree
  (`NSViewHierarchyInvalidateVisibleRect`) and marks every `drawRect:` view's layer for display
  (`NS_viewVisibleRectDidChange`), clipped or not: every text of a scroll view went through AppKit's display pass on
  every frame of a scroll (~165 `viewWillDraw` and backing-store checks per frame in the gallery's Lists demo, ~70% of
  the frame's main-thread time). Plain sublayers are not visible-rect managed. A content layer is drawn again when
  its content changes and when its size does (`needsDisplayOnBoundsChange`), not when the view moves (transitions
  redrew every moving text on every frame before). Text draws at once, which measured faster than asynchronously.
  A canvas draws at once too until it paints 10 times a second or more (an animation, live data: `canvas.rs`
  `Cadence`), when it draws asynchronously (`drawsAsynchronously`: Core Animation replays the drawing on its
  threads; Stocks idle, main-thread time per frame ~3.3 → ~1.8 ms, process CPU ~60% → ~30%), and at once again after
  a slow second. Drawing asynchronously costs graphics memory (`footprint`'s "Owned physical footprint (unmapped)
  (graphics)", ~50–60 MB for the process while any canvas draws so) and Metal work per layer, which a canvas redrawn
  every few seconds gains nothing from: three 340×40 charts redrawn every 2 s hold ~21 MB at once against ~83 MB
  asynchronously. A canvas whose long static part is kept as a `CGLayer` (`canvas.rs`: a drawing painted unchanged
  30 times) draws at once however often it paints: each frame draws the layer and replays the animated rest, which
  costs less than the drawing threads, their Metal work and their IOSurface backing stores (the gallery's Canvas
  page: CPU 7–10% → 4–6%, GPU 5–6% → 0%, ~210 → ~105 MB).
  Contents stay in the screen's format: 8-bit contents (`kCAContentsFormatRGBA8Uint`) measured slower on the
  ProMotion display, which converts them on every frame.
- **No masks on what scrolls, where avoidable** (`visual.rs`): the window server pays for a mask on every frame its
  layer moves. Outer box shadows under an opaque background (a fill layer, or an opaque gradient, both above them)
  are plain `shadowPath` casters, masked only under translucent ones; inset shadows are clipped by their holder's
  rounded bounds (`masksToBounds`), masked only for differing corners. Measured by screen capture, a scroll of the
  gallery's Lists (a shadow and an inset highlight on every card) was composited at ~55 of 120 Hz with the masks and
  ~107 without, although the app committed every frame in time (Instruments' Animation Hitches: every frame one
  refresh late).
- **Out-of-sight content is not drawn** (`Mounter::draw_when_shown`): text and canvases whose content changes (a
  canvas's animated values on every frame while they run) are drawn only if some of the view can be seen, else when it
  shows (after scrolls, batches and frames; a view out of the tree waits until it is inserted and shows). Seen is
  `NshView::shown`'s walk up the tree, not AppKit's `visibleRect`: only ancestors that clip their children (`overflow:
  hidden`, scroll views, stacks, images, inputs) and the root cut a view off, and what overflows any other ancestor
  shows, as in CSS (a label centered on a zero-width anchor: cut at every ancestor, as `visibleRect` cuts, its text was
  never drawn while its background, a layer property, showed). Lists keep rows out of sight, hidden screens stay
  mounted, and a content layer, unlike AppKit's lazy `drawRect:`, would otherwise draw them all at once (the Stocks
  demo's pulsing sparklines redrew all 22 rows at 120 Hz). A canvas in sight redraws only the area its changed values
  cover (`NshView::redraw_rect`: `setNeedsDisplayInRect:` on the content layer; `docs/dev/canvas.md`, "Partial
  redraws").
- **Trackpad scrolls are shown in step with the display** (`scroll.rs`, `Resampled`): gesture and momentum events come
  at about the display's rate (120 Hz) but not in step with it, so applied as they come some frames moved twice and
  some not at all (up to a quarter of a fling's frames, depending on how the events fell; the frame rate still read
  120). Events record where they put the offset at their timestamp; each display frame shows that path one event
  interval (+2 ms) back, interpolated. It adds ~10 ms of latency, and the main thread does the move once per frame
  instead of once per event (each event committed a Core Animation transaction of its own). Mouse wheels (no phases)
  still move at once. Anything else that moves the view (a drag, an animated scroll, a spring back) first shows where
  the events got to (`settle`).
- **One hop per commit.** The engine runs on its own thread; its sink queues each commit and wakes the main queue once
  (`DispatchQueue::main`), and the main thread applies every queued batch in order (`surface.rs`, `mount.rs`).
  While native animations or the platform's own (a scroll glide, a zoom) run, batches wait for the start of the next
  frame, and each frame applies them for at most 4 ms (`FRAME_BATCHES`, at least one whole batch), carrying the rest:
  a scroll's frames are not delayed by batches landing between them, and a burst of batches spreads over frames. What
  the engine sends after a waiting batch waits behind it, in order. A frame JS asked for alone does not hold batches
  back (what it draws shows in that frame); otherwise a batch is applied as it lands, and a resize applies the waiting
  ones first.
  Dispatched closures must be `Send`, so they find their surface by key in a thread-local map; no globals are shared
  between surfaces.
- **Resizes are shown at once** (`Surface::resized`, the one place the main thread waits for the engine): when the
  window resizes the root, the main thread waits for the layout at the new size (the engine reports it after its
  commit: `MountSink::resized`), at most 16 ms, and applies it before AppKit draws the window. AppKit's animated
  resizes (zoom, the green button, a double click on the title bar) run the run loop in a private mode
  (`_NSMoveTimerRunLoopMode`) where the main queue does not drain: the window grew around the old content for the
  whole animation (~360 ms, 41 of 41 captured frames), its new area white. Now it is laid out on every step (the wait
  is ~0.1–1.5 ms of engine time; mounting what comes into view is the rest); a live resize takes the same path. A capture still shows a few frames one step behind (2–12 of ~60 per zoom and unzoom), as a plain AppKit window
  does (13): the window server shows the window's new frame before the commit that fills it. An engine that misses
  the deadline (JS busy) is not waited for again until it reports a resize done, so a busy app resizes as before.
  Where the app has not drawn yet, the surface's background shows: the app's top view's opaque background when it
  fills the root (`system.rs`), else white / neutral-950 by the scheme.
- **Text is typeset on the engine thread** by CoreText (`text.rs`, the iOS engine with `NSFont`); the main thread
  draws the finished `CTLine`s.
- **Frames**: native animations, JS frame requests, scroll glides and transitions run on the root view's display
  link (`NSView::displayLinkWithTarget_selector`) while something animates. Its `preferredFrameRateRange` asks for the
  screen's `maximumFramesPerSecond` (120 Hz on ProMotion; set again when the link resumes, as the window may have
  moved to another screen); measured, it delivered 120 Hz before that too (refresh gaps p50 8.33 ms). The link does
  not fire while the window is occluded or minimized or the screen is locked; while frames are wanted and it has not
  ticked for 100 ms a 60 Hz
  main-queue timer ticks instead, so animations still end (a transition detaches its views when it does).
- **Embedding**: `AppView` (`app.rs`) is one surface as a view; `run_app` opens one in a window with a standard menu
  (About, Hide, Quit; Edit's undo / redo / cut / copy / paste / select all, which fields answer; Minimize, Zoom, Enter
  Full Screen, Close), titled with `AppOptions::title`: `name_app` sets the main bundle's `CFBundleName` to it, as the
  menu bar shows that (the development host has no bundle; `nsh run` passes it the app's name with `--name`). The window
  opens centered where AppKit centers a new one, or on `AppOptions::display`: a `WindowDisplay::Index` of
  `NSScreen.screens` (the host's one-based `--display <n>`) or `WindowDisplay::Secondary` (`--display secondary`,
  `nsh test`'s default: the first display besides the primary one whose frame is not the primary's, as a mirror's
  is; the primary one when there is no other). With `AppOptions::keep_size` (the host's `--keep-window-size`, which
  `nsh test` passes) the window is an `NshKeptSizeWindow`, whose `constrainFrameRect:toScreen:` returns the frame as
  it is: AppKit would shrink a window taller than its screen when it shows it, and a test's window keeps the size the
  test opens it at on a shorter secondary display. The standalone event loop
  ends when its window closes, a minimized one too; `windowWillClose:` schedules
  its stop after the close callback. `set_ui_sets`
  serves the UI sets beside the runtime's modules (`nsh/base` by default; an app with Rust components of its own passes
  `nsh_base::registry()` and its sets).

## How each area maps to AppKit

| Area | Module | AppKit |
|---|---|---|
| Text | `text.rs` | CoreText on the engine thread, `CTLine`s drawn in `drawRect:`; decorations CoreText lacks drawn by hand (iOS); `selectable` text's range selection, desktop style: drag, double-click word, triple-click paragraph, Shift extends, Cmd+A / Cmd+C (the root's `selectAll:` / `copy:`), Escape clears; selectable views (`selectable_view.rs`, `ViewProps::selectable_view`): the same gestures across the texts of an area's subtree in document order, driving `nsh_core::selection`'s model (frames from the views' origins and container offsets, hit tests on the drawn `CTLine`s), each text highlighting its part as a single text's selection; the texts are listed again after each batch while something is selected; a drag past the edge of a scroll view around the area scrolls it on the display link (0.4 pt per pt past the edge per 60 Hz frame, at most 40), held still too, extending the selection each frame |
| Decoration | `decor.rs`, `visual.rs` | The view's layer for one radius (circular or continuous), shape layers for differing radii and borders whose sides differ or are dashed / dotted; box and inset shadows, gradients, outlines, filters (iOS's `visual.rs`); backdrop blur as an `NSVisualEffectView` subview, with the background moved to a fill layer above it; `apply` caches what it set, so per-frame calls are cheap |
| Images | `image.rs`, `blur.rs` | ImageIO decoding off the main thread, downsampled to the view; an LRU cache (128 MB); `asset:/`, http(s) (`NSURLSession`), `file:`, `data:`; tint as a colored layer masked by the image; animated GIF / APNG / WebP as a keyframe animation of `contents` |
| Canvas | `canvas.rs` | The recorded drawing replayed with Core Graphics (iOS); drawings that clear or composite go into a transparency layer, so they only touch the canvas's own pixels |
| Scroll views | `scroll.rs` | Offsets of their own (the rubber band, deceleration, snap durations, the indicator's geometry and reveal distances are `nsh_core::scroll`'s, the other desktops'), shown by the container layer's `sublayerTransform` and committed to its bounds origin at rest; trackpad scrolls follow the system's phases and momentum (rubber banding while the fingers are down, a spring back after), notched wheels move 10 points per line and stay on their view for 200 ms; mouse drags never scroll (they are the app's: pans, responders, text selection); snapping and paging glide from where the fingers lift; sticky cells; the indicator and refresh spinner in an overlay view that lets the mouse through (the root still lets the mouse drag the indicator as a scroll bar, and the indicator shows and is kept as on Linux); the keyboard scrolls as on Linux; a field that gets the focus is scrolled into view |
| Input | `input.rs`, `nsh_core::input` | The root's `hitTest:` takes every mouse event inside it, and NSH picks the view itself (transforms inverted, `overflow`, `pointerEvents`, hit slop, hidden screens, views animating out); a hosted view gets the event from AppKit only where NSH's picking lands on it, even below `pointerEvents: none` overlays (`native_at`): AppKit's own picking would give a web view the clicks on what NSH draws over it (a menu outside its parent's frame, transformed views) and on web views that are hidden, animating out or under `pointerEvents: none`. Touches for the responder system, `panActivation` gates, presses, long presses, pressed and hovered states, `onHoverIn` / `onHoverOut`, cursors (`NSCursor`), native pans, trackpad pinch and rotation (Control + wheel pinches), the mouse's back button goes back; the decisions over plain data (a press's events, `panActivation` gates, hover changes, hit areas, wheel latching) are `nsh_core::input`'s, shared with the other desktop backends |
| Text inputs | `text_input.rs` | `NSTextField` / `NSSecureTextField`, multiline `NSTextView` in an `NSScrollView`, hosted at the content box in a view that fills the input (`InputPad`: a click on the padding, or beside a field's line, goes to the editor at the nearest point), borderless (the view draws the decoration); edit counts drop stale JS values; offsets are `NSString`'s UTF-16; a click outside a field that edits leaves the focus in it (the root refuses first responder during a mouse press), `blur()` and Escape hand it over; return does what `submitBehavior` says (see "Keyboard") |
| Navigation | `navigation.rs` | The decisions shared with the other desktops (`nsh_core::navigation`: the screens a stack shows and the user popped, transitions' timing, easing and offsets, what going back acts on); pages are child views, only the top one (and the one below during a transition) visible; NSH draws no header: a page's `header` (the app's view) is a child of the page that the core places at its top, as wide as the page, with the content below it and kept above it (the system header's items of iOS and Android stay hidden); each page has an opaque backdrop in the window's color under the app's content; a page the app removes leaves as an image (`renderInContext`), since the core empties it in the next batches, and so does a dialog; the rendering has no web page or video in it (other processes draw them), so their live views are lent to the image where they were, clipped to a rectangle (`native::lend`), and given back or let go when it is gone; Escape (unless a field or a web view has the focus: then it hands the keyboard to the root), Option+Left, Cmd+[ and the mouse's back button send `onBackPress` to the top page when the app listens and pop natively unless its `popOnBack` is false (a stack inside the newest dialog first, else that dialog gets the close attempt, `"cancel"`, and closes when `closeOnEscape`; without a dialog, the app's back listeners hear it before the stacks, and `Command::Back` goes on when none takes it); a focused page sees these keys first, and they reach the root only when it does not use them (WebKit sends unused keys up the responder chain) |
| Dialogs (`Dialog`) | `navigation.rs` | Children of the root above the app's views, at the size of the surface, sliding up or fading in: transparent layers with no look of their own, showing only the app's popup and backdrop (`presentation` is ignored) |
| Transitions | `transition.rs` | `LayoutAnimation`, style transitions and keyframes on frame callbacks (Linux's); curves, interpolation and timing are `nsh_core::transition`'s, and native animation values are written through `nsh_core::animation` (`animation.rs`), as on the other desktops |
| Alerts (`AlertDialog`) | `system.rs` | `NSAlert` as a sheet on the window. NSAlert puts two buttons in a row, its first rightmost, and stacks more, its first on top but the Return button moved above all: up to two alert buttons are added in reverse with the cancel button last (they read in order, cancel leftmost) and the last regular one is the default; more, and action sheets' options, are added in order with the cancel button last and no default (iOS's order). Cancel is Escape; destructive buttons have `hasDestructiveAction`. |
| Video | `native.rs` | AVFoundation (loaded at run time, as on iOS): an `AVPlayerLayer` in a view that lets the mouse through, or AVKit's `AVPlayerView` with `controls` |
| Web views | `native.rs` | `WKWebView` (iOS's bridge: `window.nsh.postMessage`, injected JS, the `webview` capability's navigation policy, every prop, event and command iOS has); a web view is transparent by default (`drawsBackground = false`), a page without a background showing the view behind it; macOS's web view has no scroll view to turn off, so with `scrollable={false}` the root's `hitTest:` keeps wheel and trackpad scrolls from it (`passes_wheel`) and they scroll the app's scroll views around it (the page's own keys and scripts still scroll it; swipes between pages, `allowsBackForwardNavigationGestures`, are scrolls too) |
| Native components | `native.rs` | `AppView::register_component(name, factory)`; a `NativeComponent`'s `NSView` fills the node's view; `ComponentContext::emit` / `set_size` from any thread |
| Accessibility | `access.rs` | `NSAccessibility` setters on the views: roles and subroles, labels, values, states, `testID` as the identifier; `accessible={true}` hides the children, `accessibilityElementsHidden` and `visibility: hidden` the view and its subtree (as in a browser), the view answering `accessibilityChildren` itself; live regions announced |
| Environment | `system.rs` | Color scheme: the app's appearance when it forces one, else the root's effective appearance (the root's appearance is set to the app's, so hosted controls follow); locale and RTL from `NSLocale`, reduce motion and VoiceOver from `NSWorkspace` (live), the backing scale factor (again when the window moves to another screen: `pixelRatio()`), the OS version; `platform.os` `"macos"`, idiom `desktop`, font scale 1, safe area and keyboard height 0 |
| Window chrome (`nsh/desktop`) | `chrome.rs` | `setTitle`; a hidden title bar is `FullSizeContentView` with a transparent, untitled title bar (the traffic lights stay), its area (native frame geometry, including `contentLayoutRect` for a toolbar, and the zoom button's right edge + 8) reported as the environment's `title_bar`, 0 in full screen; a left press on a `windowDrag` view calls `performWindowDragWithEvent:` and a double click does what `AppleActionOnDoubleClick` says (zoom by default), the press never reaching the app; `setFrame` merges the fields given with the window's frame and calls `setFrame:display:animate:` (`x`/`y` are the bottom left corner's screen coordinates; `anchorTop` keeps the top edge when `height` changes without a `y`), `setLevel` maps to an `NSWindowLevel` (`desktopIcon` is `kCGDesktopIconWindowLevel`, and it also makes the window stationary on every space, out of Mission Control and Cmd+`); `orderFront` deminiaturizes, activates the app and makes the window key; the application menu replaces the main menu (its first submenu is the app menu; the replaced one comes back with `null`), context menus are `popUpMenuPositioningItem:atLocation:inView:` from the main queue (they track the mouse in a loop of their own; one the app opens without a place opens where the root's last pointer event was (a move, or a press or release of any button: a right click's menu opens at that click), else at the cursor: the test agent's input leaves the cursor where it is); role items send AppKit's standard actions down the responder chain and are not reported, the others target an `NshMenuTarget` that reports their tag; AppKit validates the items (roles are enabled and titled by the responder chain: `Undo Typing`, `Exit Full Screen`), a disabled item's action is one nothing answers; an app's bar height selects an empty `NSToolbar` (`UnifiedCompact` up to 44pt, `Unified` above), with AppKit laying out the traffic lights on every live-resize frame; `titleBar().height` reports the actual unobscured-content boundary from `contentLayoutRect`, refreshed after deferred layout; a host's existing toolbar and style stay untouched; NSH tracks its own toolbar by object identity and restores the window's previous style when removing it, moving between windows or dropping the surface |

| Clipboard | `system.rs` | `NSPasteboard` |
| Networking | `net.rs` | `NSURLSession` (the iOS backend's) |
| Dev | `dev.rs` | The dev server client on its own thread; a status line and the error overlay above the surface (opaque; code frames keep their lines and scroll sideways; a click that selects no text dismisses it, in an inactive window too; its Copy button copies the error); Cmd+R reloads the latest build |
| Performance monitor | `fps.rs`, `gpu.rs` | `--fps` / `AppOptions::fps` / `AppView::set_fps_monitor`: a panel above the surface that lets the mouse through, redrawn twice a second from the surface's `nsh_engine::perf::PerfMonitor` (see below); GPU time from the IO registry (`accumulatedGPUTime` of the process' accelerator clients) |

## Keyboard

Single-line fields center the native font's line in the input's content box. Their attributed placeholders use
the same natural line height as the field editor, including when `text-base` supplies a larger `lineHeight` for
layout. Multiline text views use the configured paragraph line height.

A key goes to the window's first responder: a field's editor (the window's shared field editor, an `NSTextView`), a
multiline input's `NshTextView`, a hosted view, or the surface's root. Menus' key equivalents (`app.rs`: Cmd+Q / H /
Opt+Cmd+H, the Edit menu's Z / Shift+Z / X / C / V / A, Cmd+M, Ctrl+Cmd+F, Cmd+W) come first, matched by AppKit on
any layout; the dev host's Cmd+R is a local key monitor (`dev.rs`).

- **In a field** (`text_input.rs`), AppKit's key bindings edit: Option / Cmd + arrows, their Shift variants,
  Option+Delete, Cmd+Delete, Ctrl+A / E / K, undo and the Edit menu's commands (a secure field refuses Copy and
  Cut). Changes pass `Ctx::should_change` (one `onKeyPress` per insertion or deletion, `maxLength` clipping, line
  breaks of a single line become spaces: its cell is not in single-line mode, which would replace them in a second
  edit). The delegates' `doCommandBySelector:` (`Ctx::command`) takes return (`insertNewline:`, as
  `InputConfig::submit()` says; Shift+Return breaks the line of a multiline input that submits, and a return with
  marked text only commits the composition), Option+Return and Ctrl+Return (a `\n` in a multiline input, nothing in
  a single line; `insertLineBreak:` alone would insert U+2028), Option+Tab (a tab character in a multiline input
  only), Tab / Shift+Tab / Ctrl+Tab (`tab`: the next field or pressable view on screen within the newest dialog, skipping the clip view
  of a text view, which hands the focus back to it) and Escape (leaves the field). Keys a field uses never reach the
  root, so Option+Left moves the caret and Cmd+[ does nothing there.
- **Input method compositions** (`text_input.rs` `Ctx::composition_changed`): the editing view's marked text is
  followed after each change, selection change and unmark, and reported as `onCompositionChange` (as it starts and
  changes, and as it ends, after the `onChangeText` of the committed text; leaving the field ends it too). A value
  from JS that arrives during a composition is held and applied when the composition ends, if JS has seen every edit
  by then, so the input method's session continues undisturbed.
- **At the root** (`view.rs` `keyDown:` → `input::key`): the selected text's Cmd+A / Cmd+C / Escape (`text.rs`;
  also the root's `selectAll:` / `copy:` for the menu), going back (`navigation::key_pressed`: Escape, Option+Left,
  Cmd+[), Tab / Shift+Tab into fields and pressable views, and scrolling the scroll view around the focused view or under the mouse:
  arrows by a line, Page Up / Down, Option+Up / Down and Space / Shift+Space by a page, Home / End and Cmd+Up / Down
  to the edges. The mouse's back button goes back from `input::event`.
- **The app's shortcuts** (`nsh`'s `keymap`, `keymap.rs`): while the surface has bindings, a local key-down monitor
  matches every key of its window against the mounted table (`Keymap::find`) before AppKit dispatches it, so they
  come before menus' key equivalents, the field editor's key bindings and the root's keys (Escape going back,
  Tab, scrolling); a match is consumed and reported as the root's `KeyCommand`. Quit, Hide, Hide Others, Minimize
  and Full Screen cannot be bound (`Keystroke::reserved`), so the app menu keeps them; Cmd+W, the Edit menu's keys
  give way to a binding (monitors run newest first); built with `dev`, Cmd+R is never matched
  (`Keystroke::reloads`), so the dev host's reload monitor gets it. An auto-repeat (`isARepeat`) of a binding without
  `repeat` is consumed silently. A surface takes the key while the
  window's first responder is inside its root (a field or hosted view there counts as editing: `when`), or is the
  window itself. The key is read as `Keystroke`: virtual key codes for named and function keys, else the character
  without modifiers (`charactersByApplyingModifiers:` with none when Shift is held, so Shift+/ is `shift+/`), the US
  layout's (`input::us_key`) when that is not ASCII. The monitor is removed when the table empties or the app stops.
- Shortcuts NSH matches itself (Cmd+A / C / [ / R) read `input::shortcut_key`: the character without modifiers, or on
  a layout that types none in ASCII the US layout's key, as menus do.

`onKeyPress` reports what React Native's does: the inserted text (`"Enter"` for a line break), `"Backspace"` for a
deletion (in an empty input too), and `"Escape"`; Tab and navigation keys are not reported.

## Measuring: the performance monitor

`nsh-macos-host --fps` (`nsh run --target macos --fps`) shows `fps.rs`'s HUD (rows: `website/docs/macos.md`). What
it reads is `nsh_engine::perf` (`docs/dev/performance.md`):

- The surface measures (`Surface::measure`, `drain`, `frame`) only while a monitor is installed; then the display
  link runs on every refresh, and each refresh closes a frame: the main-thread time since the previous one (batches
  with Core Animation's commit, which is where `drawRect:` content is drawn; ticks; wheel, drag and key handling).
  Refreshes in which nothing changed are not frames. The fallback timer closes frames at 60 Hz while the link is
  stopped (the screen locked).
- Batches carry when the sink got them (only while measuring), for `HOP`.
- The engine records its commits (`EngineControl::set_perf_monitor`).

For checking a change: run a release host with `--fps --trace` (`nsh run --release --target macos --fps --trace`) and
scroll it; the host logs the readings once a second (`nsh::perf fps …`, milliseconds as mean/p50/p95/max: `tick` the
delivered refresh gaps, `frame-gap` the gaps between shown frames, `main` the main-thread time per frame). A frame
rate of 120 does not mean a smooth scroll: check how far each frame moves (fling a few times, as event and display
phases differ from gesture to gesture). For where the time goes, `sample <pid> 5` the host (Instruments' Time Profiler: `xctrace
record --template 'Time Profiler' --attach <pid>`).


## Checking a change: `nsh test --target macos`

The development host takes the steps of `nsh/test` tests (`docs/dev/tooling.md`, "On a real platform"): `agent.rs`
implements `nsh_testing::agent::Native` on the main queue (`exec_sync`). A view's bounds are its `NSView`'s frame in
window coordinates, turned into points from the content's top left; a press is a mouse move, down and up posted to the
application's queue (`synth.rs`), so it takes the path real ones take (and becomes `NSApp.currentEvent`), with the app
made active first (WebKit takes left clicks only in the active app); a scroll is a trackpad gesture (began, changed
events 16 ms apart of at most 20 points, ended), handed to the window, and the root's `hitTest:` sees it as the
current event (it keeps it from pages with `scrollable={false}`); typing posts key events through the application,
as real keys, so key monitors see them; back is Escape, twice when a text field is focused (the first only leaves
it); a dialog's answer presses the `NSAlert`'s button with that title or ends the sheet. `dev.rs`'s `Tester` attaches
the agent's model to the surface when the server says it runs a test session, before the first bundle.

```sh
./target/debug/nsh test examples/gallery --target macos
echo 'await app.screenshot("/tmp/a.png"); await app.press("label:Navigation"); await app.screenshot("/tmp/b.png")' \
  | ./target/debug/nsh test examples/gallery/App.tsx --target macos   # steps from stdin
```

A screenshot renders the window's content in process (`cacheDisplayInRect:`), so it needs no Screen Recording
permission and works while the screen is locked. `cacheDisplayInRect:` draws sublayers in their order and ignores
`zPosition`, so the screenshot first orders every layer's sublayers by `zPosition` (as Core Animation composites them;
the window does not change): without that, a decoration added before a layer it sits above (a border's stroke before
a finish's gradient) looked covered. That rendering is not Core Animation's own: it ignores `maskedCorners`, cuts
masks at their layer's bounds, ignores `shadowPath` and Core Image filters, flattens 3D transforms (perspective,
`rotateX`, `rotateY`), and does not show backdrop blur, sheets or `AVPlayerLayer` content (`WKWebView` pages show:
WebKit draws them for `cacheDisplayInRect:`, as of macOS 27). `decor.rs` avoids the first three (shape layers for
differing corners, masked holders for box shadows), so screenshots match the window closely, except that spread
rings of box shadows are missing from them, and so are outer box shadows under an opaque background (unmasked
`shadowPath` casters, `visual.rs`).

## Not implemented, or different

- **Zooming scroll views**: `zoomTo` and the zoom props are ignored (as on Linux).
- **`mixBlendMode`**, `brightness()` above 1. **`backdropFilter: blur()`** is an `NSVisualEffectView` (within-window
  blending, the popover material) below the view's background: AppKit picks the blur radius and adds the material's
  light tint; in-process screenshots cannot show it.
- **Inputs**: content types / autofill, keyboard types, autocapitalization, letter spacing; input accessory views are
  never shown (there is no software keyboard); `keyboardShouldPersistTaps` is ignored.
- **Accessibility**: `accessibilityActions`.
- **No desktop equivalent**: the status bar, haptics; the safe area and keyboard height are 0.
- **Packaged apps** are signed ad hoc; to distribute one, sign it with a Developer ID and notarize it.

## Standalone shutdown

`run_app` owns the standalone window and engine, while its caller owns process
termination. Closing the window (including a minimized window) stops the engine
and stops the AppKit event loop. Quit follows the same path through
`applicationShouldTerminate:`: the delegate cancels AppKit's process exit and
returns control through `run_app` instead. The helper posts an application-defined
event after `stop:` so a dispatch-driven close wakes the event loop.

This lets a Rust host perform final cleanup or execute an installed update after
`run_app` returns. Embedded `AppView` instances continue to use their host's
delegate and event loop. This change still needs native close, minimized-close,
Command-Q, a test's quit, process-exit status and relaunch validation. No tests
were run for this change at the user's request.

### Retained standalone session design

A standalone host chooses its close policy through
`AppOptions::keep_alive_on_close` (default false). With retention enabled, the
close delegate orders out the existing window and declines its destruction.
`RUNNING` continues owning the same window, AppView and engine. Dock reopen
orders that window front; it creates neither another engine nor another session.

Explicit application Quit and `quit_app()` always take the stop-and-return
path, including while the window is hidden. `quit_app()` dispatches to the main
thread and only affects the standalone runner; an embedded host retains its own
application lifecycle. The Rust core's `close_window()` remains a window-close
request, so hosts using retention must use `quit_app()` for Exit/relaunch.

Acceptance requires visible/hidden/minimized close, Dock reopen preserving
state and transfers, repeated reopen without duplicate windows, Quit while
hidden, a test's quit, and cleanup after run_app returns. Source implementation
and CI compilation alone do not prove those runtime behaviors.

## Keyboard focus for views

A mounted non-input view that is a focus stop participates in AppKit's key
view loop alongside native text inputs (`input::is_key_stop`, from
`ViewProps::focus_stop`): one listening to `onPress`, or any
`focusable={true}` one, which needs no press listener (a chart in a pressable
card). Disabled accessibility state, removed press listeners (of a view not
`focusable={true}`), `focusable={false}` (a backdrop that closes an overlay),
hidden views and views leaving the tree exclude a stop (a focused one gives
the focus to the root).
Tab/Shift+Tab stay within the newest modal and advance from the currently
focused stop. The root and passive layout views stay outside that loop. A
modal remembers the input or Tab stop that had the focus when it was
presented (`ModalNav::focus_before`, held weakly) and gives it back when it
closes, if the focus fell to the root or the window meanwhile: Escape on a
popover returns to its trigger. A field edits in the window's shared field
editor, which leaves the tree when editing ends, so the input that owns the
editor is what is remembered; it comes back through `focus()`, with the caret
at the end and its text not selected. A view that can no longer take the focus
(disabled, no longer a stop, `pointerEvents` none, hidden, detached)
is skipped, and so is one a newer modal still covers: nothing under the
newest modal is focused. When a lower modal closes under a newer one, the
newer one that remembered a view of it remembers the lower one's instead, so
closing it later returns to the view that opened the stack.

Focused stops update the existing `focus:` interaction state and report
`onFocus` / `onBlur`. On a stop that takes presses (`input::is_key_control`),
unmodified Return, keypad Enter and Space emit PressIn/PressOut/Press once on
key-down; auto-repeat and key-up are consumed without another activation. App
keymap monitors let those activation keys reach the control instead of
triggering a global Enter/Space binding. A stop that takes no presses is not
activated: its keys, Return and Space too, go to the app's keymap (the
component binds them while focused), then to keyboard scrolling. Modifier
shortcuts keep their existing priority. Accessibility focus also moves
keyboard focus to Tab stops.

Only root views retain a surface reference. A focused child's keyboard callbacks
resolve its surface through ancestors; pointer and drawing callbacks keep their
existing root-only lookup. This avoids attaching per-button monitors or changing
the public event protocol.

Checked with synthesized keys and clicks (Tab, Return, Space, Escape, a
click): Tab between pressables, Return and Space pressing the focused one, Tab
staying in a transparent modal, and the focus returning to the trigger after
Escape or a click outside; a single-line and a secure field getting it back
with the caret at the end (a character typed after Escape is appended); a
trigger disabled meanwhile staying unfocused; a lower modal closing under a
newer one leaving the focus alone, and the newer one's Escape returning it to
the stack's trigger. Still to check natively: Shift+Tab, mixed inputs and
buttons, disabling or deleting a focused control, repeat suppression, modifier
shortcuts, screen-reader focus and window deactivation.
