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
cargo test -p nsh-platform-macos --test native -- --ignored # desktop session required
```

Features: `js` (default; JS apps; without it the crate only runs Rust apps and links no QuickJS) and `dev` (the dev
server client, log forwarding, the error overlay: `dev.rs`). The runtime needs macOS 14 (`NSView`'s display links).

## Table accessibility

`Table` and `Grid` roles expose `AXTable`, as WebKit maps tables for VoiceOver. Declared `Row` views expose
`AXRow`, and `Cell` and `ColumnHeader` views expose `AXCell`. Press handlers keep their `AXPress` action without
changing a declared role. Labels and the text children of rows and cells keep their existing behavior.

`access/table.rs` derives the rows, columns, visible rows and cells, selected rows, headers and cell lookup from
the mounted hierarchy when an accessibility client asks. It walks through row groups and layout wrappers, stops
at nested tables, and respects hidden or folded content. Each row's `AXIndex` and each cell's row and column
index range follow tree order, starting at zero and including header rows. Each cell spans one row and column.
Only mounted rows participate, including offscreen rows; a virtualized list's unmounted data has no AX objects.

Columns are stable `NSAccessibilityElement` objects with weak links to their table. They report their cells and
header live, so retained columns follow changes without retaining the surface. The table's header is the first
row containing column headers, and each column and cell links to its column headers. The ordinary-window
`accessibility` test reads these relationships through `NSAccessibility`, including clipping, hiding and row presses.

## Architecture

Web view downloads (`native.rs`) are opt-in through `onDownload`. Response policy uses WebKit's MIME support
flag when it does not select a download, preserving the default cancellation of unshowable types. A response
converted into a download suppresses only its own `WebKitErrorDomain` 102 navigation failure. Downloads are
tracked from adoption through completion or failure; dropping `WebHost` cancels all active `WKDownload`s and
removes their directories in cancellation completion handlers, after WebKit stops writing. Completed files
belong to the app, which owns retention and its storage budget.

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
  `visual.rs`, `image.rs`, the iOS backend's design), and a view's `mixBlendMode` as its layer's `compositingFilter`.
  Text and canvas views draw into a **content layer** of their own
  (`NshView::redraw`: a plain `CALayer` sublayer whose delegate draws in `drawLayer:inContext:`, above the decoration
  behind the view and below its children); no view uses `drawRect:`, every view uses `updateLayer` and gets no backing
  store. Implicit animations are off for every change NSH makes (`surface::quiet`; the content layer's delegate
  answers no action). A backdrop (a material from `macos={{ backdrop }}`, glass or a blur) is the view's first
  subview, below its fill layer and effects; see "Not implemented, or different".
- **Why not `drawRect:`**: `drawRect:` views are redrawn by AppKit's display pass whenever a scroll moves their
  container; plain content layers are not, and are drawn again only when their content or size changes. A canvas
  that paints often draws asynchronously (`canvas.rs` `Cadence`), one with a long static part keeps it as a
  `CGLayer`. Shorter drawings with a small source-over animated suffix can instead keep that suffix in a small
  sibling content layer (`canvas.rs` `layer_split`, `NshView::update_canvas_overlay`). Animated values redraw only
  that surface; a new drawing redraws both. The geometry scan includes every suffix paint, including constant
  shapes after animated ones. Complex compositing, unbounded or large suffixes, and long prefixes use the existing
  path. Both surfaces follow the view's clipping, opacity, scale and visibility. Contents stay in the screen's format.
- **No masks on what scrolls, where avoidable** (`visual.rs`): the window server pays for a mask on every frame its
  layer moves, so shadows and inset shadows avoid masks where their background allows.
- **Out-of-sight content is not drawn** (`Mounter::draw_when_shown`): text and canvases whose content changes (a
  canvas's animated values on every frame while they run) are drawn only if some of the view can be seen, else when it
  shows (after scrolls, batches and the frames in which a view moved, was hidden or shown, or a scroll offset changed:
  `sight.rs`; a view out of the tree waits until it is inserted and shows). Seen is `NshView::shown`'s walk up the
  tree (`sight.rs`; a pass over many views shares what it found of their ancestors), not AppKit's `visibleRect`: only ancestors that clip their children (`overflow:
  hidden`, scroll views, stacks, images, inputs) and the root cut a view off, and what overflows any other ancestor
  shows, as in CSS (a label centered on a zero-width anchor: cut at every ancestor, as `visibleRect` cuts, its text was
  never drawn while its background, a layer property, showed). Lists keep rows out of sight, hidden screens stay
  mounted, and a content layer, unlike AppKit's lazy `drawRect:`, would otherwise draw them all at once (the Stocks
  demo's pulsing sparklines redrew all 22 rows at 120 Hz). A canvas in sight redraws only the area its changed values
  cover (`NshView::redraw_rect`: `setNeedsDisplayInRect:` on the content layer; `docs/dev/canvas.md`, "Partial
  redraws").
- **Trackpad scrolls are shown in step with the display** (`scroll.rs`, `Resampled`): gesture and momentum events
  are resampled to the display's frames. Mouse wheels (no phases) still move at once. Anything else that moves the
  view (a drag, an animated scroll, a spring back) first shows where the events got to (`settle`).
- **One hop per commit.** The engine runs on its own thread; its sink queues each commit and wakes the main queue once
  (`DispatchQueue::main`), and the main thread applies every queued batch in order (`surface.rs`, `mount.rs`).
  While native animations or the platform's own (a scroll glide, a zoom) run, batches are spread over frames so a
  scroll's frames are not delayed (`FRAME_BATCHES`), always in order; a resize applies the waiting ones first.
  Dispatched closures must be `Send`, so they find their surface by key in a thread-local map; no globals are shared
  between surfaces.
- **Resizes are shown at once** (`Surface::resized`, the one place the main thread waits for the engine): when the
  window resizes the root, the main thread waits for the layout at the new size (the engine reports it after its
  commit: `MountSink::resized`), at most 16 ms, and applies it before AppKit draws the window. AppKit's animated
  resizes (zoom, the green button, a double click on the title bar) and live resizes take this path, so the window
  never grows around stale content. An engine that misses the deadline (JS busy) is not waited for again until it
  reports a resize done, so a busy app resizes as before.
  A content layer given a new size is drawn again only once it can be seen (`NshView::content_resized`, then
  `Mounter::revisit`), not by `needsDisplayOnBoundsChange`: Core Animation draws every marked layer, seen or not, so
  each resize would draw again all the text a long page had ever shown.
  During a live resize, the new frames of plain views (`View`, `Text`) out of sight wait in `Mounter::unplaced`:
  each batch places those that can be seen where they are or where they go (`Mounter::place_shown`; where they go is
  the frames the layout gave, `view::Planned`: left in place, a view leaving the screen would stay over what took its place) and
  the resize's end places the rest (`viewDidEndLiveResize`). Moving a view costs the main thread and Core Animation's
  commit whether it shows or not.
  A text's content layer keeps its picture through another width of the same lines (`text::draws_the_same`,
  `kCAGravityTopLeft`); a picture drawn in a layer narrower than its box, a view still waiting to be placed
  (`DrawnText::cut`), draws again once placed.
  Where the app has not drawn yet, the surface's background shows: the app's top view's opaque background when it
  fills the root (`system.rs`), else white / neutral-950 by the scheme.
- **Text is typeset on the engine thread** by CoreText (`text.rs`, the iOS engine with `NSFont`); the main thread
  draws the finished `CTLine`s. A final layout is made when first read (`CoreTextLayout`), so text nothing shows is
  not typeset twice; when that read is the main thread's, it holds the text's lock for the time of one layout. Texts
  with attachments are made at once on the engine.
- **Frames**: native animations, JS frame requests, scroll glides and transitions run on the root view's display
  link (`NSView::displayLinkWithTarget_selector`) while something animates. Its `preferredFrameRateRange` asks for the
  screen's `maximumFramesPerSecond`, or less while everything that wants frames asked for a lower rate (`frameRate`,
  `animationFrameRate`: `animation.md` "Frame rate"): `Surface::frame_rate` folds the graph's rate with the frame
  callbacks that report one (`Surface::cap_frame`, a view's keyframes alone); anything else (a JS frame request, a
  batch waiting, a transition, a scroll glide) wants the screen's highest. The range (`frame_rate_range`) is set when
  the link starts or resumes, whenever the folded rate changes, and when the window's screen refreshes at another
  highest rate than the range was made for (`Surface::follow_screen`, checked each frame). The link does not fire while the window is
  occluded or minimized or the screen is locked. Frame callbacks report what they have left (`Next`: done, drawing
  only, or a deadline), and `Surface::keep_deadline` keeps the earliest deadline (the graph's, a callback's, a batch
  waiting for a frame) with one main-queue timer 50 ms past it: if no frame ran since it came due, it runs one, so
  animations end and report it on time without frames ("Deadlines" in docs/dev/animation.md). Drawing-only work (an
  endless animation, a shader, a JS frame request) waits for the link.
- **Embedding**: `AppView` (`app.rs`) is one surface as a view; `run_app` opens one in a window with a standard menu
  (About, Hide, Quit; Edit's undo / redo / cut / copy / paste / select all, which fields answer; Minimize, Zoom, Enter
  Full Screen, Close), titled with `AppOptions::title`: `name_app` sets the main bundle's `CFBundleName` to it, as the
  menu bar shows that (the development host has no bundle; `nsh run` passes it the app's name with `--name`). The window
  opens centered where AppKit centers a new one, or on `AppOptions::display`: a `WindowDisplay::Index` of
  `NSScreen.screens` (the host's one-based `--display <n>`) or `WindowDisplay::Secondary` (`--display secondary`,
  `nsh test`'s default: the first display besides the primary one whose frame is not the primary's, as a mirror's
  is; the primary one when there is no other). With `AppOptions::keep_size` (the host's `--keep-window-size`, which
  `nsh test` passes) the window's `constrainFrameRect:toScreen:` (it is an `NshWindow`) returns the frame as
  it is: AppKit would shrink a window taller than its screen when it shows it, and a test's window keeps the size the
  test opens it at on a shorter secondary display. nsh.json `window` applies before the window shows (its attributes,
  size, place, display and mode; with `restoreBounds` the placement the engine kept in the app's storage, which the runner reads first).
  The standalone event loop
  ends when its window closes, a minimized one too; `windowWillClose:` schedules
  its stop after the close callback. `set_ui_sets`
  serves the UI sets beside the runtime's modules (`nsh/base` by default; an app with Rust components of its own passes
  `nsh_base::registry()` and its sets). With `AppOptions::transparent` (false by default) a caller of `run_app` gets a
  window that is nonopaque with a clear background, and the surface paints none of its own background under the root,
  so what the app leaves unpainted shows what is behind the window. This is a custom Rust host's initial default;
  explicit main-window attributes and later window updates take precedence. Standard hosts leave this
  option false but can request transparency through their window configuration. A view's `behindWindow` material
  never changes window transparency. An embedded `AppView` does not change its host's `NSWindow`.

## How each area maps to AppKit

| Area | Module | AppKit |
|---|---|---|
| Text | `text.rs` | CoreText on the engine thread, `CTLine`s drawn into the view's content layer (`drawLayer:inContext:`); decorations CoreText lacks drawn by hand (iOS); selectable text's range selection, desktop style: drag, double-click word, triple-click paragraph, Shift extends, Cmd+A / Cmd+C (the root's `selectAll:` / `copy:`), Escape clears; selectable views (`selectable_view.rs`, `ViewProps::selectable_view`): the same gestures across the texts of an area's subtree in document order, driving `nsh_core::selection`'s model (frames from the views' origins and container offsets, hit tests on the drawn `CTLine`s), each text highlighting its part as a single text's selection; the texts are listed again after each batch while something is selected; a drag past the edge of a scroll view around the area scrolls it on the display link (0.4 pt per pt past the edge per 60 Hz frame, at most 40), held still too, extending the selection each frame; `fontFamily` lists (`nsh_core::font_families`): the first family CoreText has is the font, the others it has its cascade list (`kCTFontCascadeListAttribute`), iOS's engine too |
| Decoration | `decor.rs`, `visual.rs` | The view's layer for one radius (circular or continuous), shape layers for differing radii and borders whose sides differ or are dashed / dotted; box and inset shadows, gradients, outlines, filters (iOS's `visual.rs`), `mixBlendMode` as the layer's compositing filter; a backdrop as a subview: an `NSVisualEffectView` with `macos={{ backdrop }}`'s material, blending and state or the blur's popover material, or glass with `glassTintColor`, with the background moved to a fill layer above it; `apply` caches what it set, so per-frame calls are cheap |
| Images | `image.rs`, `blur.rs` | Loaded through the core's shared loader and decoded images (`docs/dev/images.md` "Loading and memory"): ImageIO thumbnails at the view's size bucket, in the process's image budget, downloaded with `NSURLSession` (the core loader's transport hook, so the system's proxies, authentication and ATS apply), leased by the views showing them; blur and color filters baked into variants in the same budget; `asset:/`, http(s), `file:`, `data:`; tint as a colored layer masked by the image; animated GIF / APNG / WebP as a keyframe animation of `contents` |
| Canvas | `canvas.rs` | The recorded drawing replayed with Core Graphics (iOS); drawings that clear or composite go into a transparency layer, so they only touch the canvas's own pixels |
| Scroll views | `scroll.rs` | Offsets of their own (the rubber band, deceleration, snap durations, the indicator's geometry and reveal distances are `nsh_core::scroll`'s, the other desktops'), shown by the container layer's `sublayerTransform` and committed to its bounds origin at rest; trackpad scrolls follow the system's phases and momentum (rubber banding while the fingers are down, a spring back after), notched wheels move 10 points per line and stay on their view for 200 ms; mouse drags never scroll (they are the app's: pans, responders, text selection); snapping and paging glide from where the fingers lift; sticky cells; the indicator and refresh spinner in an overlay view that lets the mouse through (the root still lets the mouse drag the indicator as a scroll bar, and the indicator shows and is kept as on Linux); the keyboard scrolls as on Linux; a field that gets the focus is scrolled into view |
| Input | `input.rs`, `nsh_core::input` | The root's `hitTest:` takes every mouse event inside it, and NSH picks the view itself (transforms inverted, `overflow`, `pointerEvents`, hit slop, hidden screens, views animating out); a hosted view gets the event from AppKit only where NSH's picking lands on it, even below `pointerEvents: none` overlays (`native_at`): AppKit's own picking would give a web view the clicks on what NSH draws over it (a menu outside its parent's frame, transformed views) and on web views that are hidden, animating out or under `pointerEvents: none`. Touches for the responder system, `panActivation` gates, presses, long presses, pressed and hovered states, `onMouseEnter` / `onMouseLeave` / `onMouseMove`, cursors (`NSCursor`), native pans, trackpad pinch and rotation (Control + wheel pinches), the mouse's back button goes back; the decisions over plain data (a press's events, `panActivation` gates, hover changes, hit areas, wheel latching) are `nsh_core::input`'s, shared with the other desktop backends |
| Text inputs | `text_input.rs` | `NSTextField` / `NSSecureTextField`, multiline `NSTextView` in an `NSScrollView`, hosted at the content box in a view that fills the input (`InputPad`: a click on the padding, or beside a field's line, goes to the editor at the nearest point), borderless (the view draws the decoration); edit counts drop stale JS values; offsets are `NSString`'s UTF-16; a click outside a field that edits leaves the focus in it (the root refuses first responder during a mouse press), `blur()` and Escape hand it over; return does what `submitBehavior` says (see "Keyboard") |
| Navigation | `navigation.rs` | The decisions shared with the other desktops (`nsh_core::navigation`: the screens a stack shows and the user popped, transitions' timing, easing and offsets, what going back acts on); pages are child views, only the top one (and the one below during a transition) visible; NSH draws no header: a page's `header` (the app's view) is a child of the page that the core places at its top, as wide as the page, with the content below it and kept above it (the system header's items of iOS and Android stay hidden); each page has an opaque backdrop in the window's color under the app's content; a page the app removes leaves as an image (`renderInContext`), since the core empties it in the next batches, and so does a dialog; the rendering has no web page or video in it (other processes draw them), so their live views are lent to the image where they were, clipped to a rectangle (`native::lend`), and given back or let go when it is gone; Escape (unless a field or a web view has the focus: then it hands the keyboard to the root), Option+Left, Cmd+[ and the mouse's back button send `onBackPress` to the top page when the app listens and pop natively unless its `popOnBack` is false (a stack inside the newest dialog first, else that dialog gets the close attempt, `"cancel"`, and closes when `closeOnEscape`; without a dialog, the app's back listeners hear it before the stacks, and `Command::Back` goes on when none takes it); a focused page sees these keys first, and they reach the root only when it does not use them (WebKit sends unused keys up the responder chain) |
| Dialogs (`Dialog`) | `navigation.rs` | Children of the root above the app's views, at the size of the surface, sliding up or fading in: transparent layers with no look of their own, showing only the app's popup and backdrop (`presentation` is ignored) |
| Shaders | `shader.rs` | `Shader` frames as a sublayer's `CGImage` under the children; effects and transitions draw their children through the shader from `renderInContext:` pictures of their container, masked while the frames show over it; a page's or a dialog's `transitionShader` as a layer over the stack or the root (`NavOverlay`); see [shaders.md](shaders.md) |
| Transitions | `transition.rs` | `LayoutAnimation`, style transitions and keyframes on frame callbacks (Linux's); curves, interpolation and timing are `nsh_core::transition`'s, and native animation values are written through `nsh_core::animation` (`animation.rs`), as on the other desktops |
| Alerts (`AlertDialog`) | `system.rs` | `NSAlert` as a sheet on the window. NSAlert puts two buttons in a row, its first rightmost, and stacks more, its first on top but the Return button moved above all: up to two alert buttons are added in reverse with the cancel button last (they read in order, cancel leftmost) and the last regular one is the default; more, and action sheets' options, are added in order with the cancel button last and no default (iOS's order). Cancel is Escape; destructive buttons have `hasDestructiveAction`. |
| Video | `native.rs` | AVFoundation (loaded at run time, as on iOS): an `AVPlayerLayer` in a view that lets the mouse through, or AVKit's `AVPlayerView` with `controls` |
| Web views | `native.rs` | `WKWebView` (iOS's bridge: `window.nsh.postMessage`, injected JS, the `webview` capability's navigation policy, every prop, event and command iOS has; the URL schemes the app serves, `url_scheme`, through `nsh-platform-apple`'s `web_scheme`, one `WKURLSchemeHandler` per web view set on its configuration before it is made, shared with iOS); a web view is transparent by default (`drawsBackground = false`), a page without a background showing the view behind it; macOS's web view has no scroll view to turn off, so with `scrollable={false}` the root's `hitTest:` keeps wheel and trackpad scrolls from it (`passes_wheel`) and they scroll the app's scroll views around it (the page's own keys and scripts still scroll it; swipes between pages, `allowsBackForwardNavigationGestures`, are scrolls too) |
| Native components | `native.rs` | `AppView::register_component(name, factory)`; a `NativeComponent`'s `NSView` fills the node's view; `ComponentContext::emit` / `set_size` from any thread |
| Accessibility | `access.rs` | `NSAccessibility` setters on the views: roles and subroles, labels, values, states, `testID` as the identifier; `accessible={true}` hides the children, `accessibilityElementsHidden` and `visibility: hidden` the view and its subtree (as in a browser), the view answering `accessibilityChildren` itself; live regions announced; `AXShowMenu` (VoiceOver's VO-Shift-M) on a view that listens to `onContextMenu` raises it with no pointer (`input::accessibility_show_menu`), which is how the keyboard reaches context menus on a Mac (AppKit has no Shift+F10) |
| Environment | `system.rs` | Color scheme: the app's appearance when it forces one, else the root's effective appearance (the root's appearance is set to the app's, so hosted controls follow); locale and RTL from `NSLocale`, reduce motion and VoiceOver from `NSWorkspace` (live), the backing scale factor (again when the window moves to another screen: `pixelRatio()`), the OS version; whether the app is in use (`lifecycle()`: `background` while none of it shows, hidden or `NSApplication.occlusionState` without `visible` (its windows minimized or covered), `active` while it is the active app, else `inactive`; live, from `NSApplication`'s activation, hiding and occlusion notifications, the embedding app's for an embedded surface); the preferred languages (`localeSettings()`'s `languages`: `NSLocale.preferredLanguages`, read again with the other settings); the regional preferences (`localeSettings()`'s `hourCycle` and the like: the hours of `NSDateFormatter`'s `j` format, `NSCalendar.firstWeekday`, `NSLocale`'s measurement system and the `AppleTemperatureUnit` default, over `LocaleSettings::parse` of the locale's identifier; read again with the other settings); the time zone (`localeSettings()`'s `timeZone`: `NSTimeZone.systemTimeZone`'s name, live from `NSSystemTimeZoneDidChangeNotification`, Foundation's cached zone reset first); `platform.os` `"macos"`, idiom `desktop`, font scale 1, safe area and keyboard height 0 |
| Window chrome (`nsh/desktop`) | `chrome.rs` | The `title` attribute; a hidden title bar is `FullSizeContentView` with a transparent, untitled title bar (the traffic lights stay), its area (native frame geometry, including `contentLayoutRect` for a toolbar, and the zoom button's right edge + 8) reported as the environment's `title_bar`, 0 in full screen; a left drag on a `windowDrag` view calls `performWindowDragWithEvent:`, while a click reaches the app (including ancestor press handlers) only if its original view remains under the pointer and draggable; replacing the app cancels the pending press; a double click does what `AppleActionOnDoubleClick` says (zoom by default); `setBounds` merges the fields given with the window's frame and calls `setFrame:display:animate:` (`x`/`y` are the top left corner, down from the primary screen's top as on the other platforms: `appkit_frame` flips `y` at the height of `NSScreen.screens[0]`, whose bottom is the origin of Cocoa's screen coordinates on every display arrangement, and a `height` without a `y` keeps the top edge), the `level` attribute maps to an `NSWindowLevel` (`desktopIcon` is `kCGDesktopIconWindowLevel`, and it also makes the window stationary on every space, out of Mission Control and Cmd+`); `focus()` deminiaturizes, activates the app and makes the window key; the application menu replaces the main menu (its first submenu is the app menu; the replaced one comes back with `null`), context menus are `popUpMenuPositioningItem:atLocation:inView:` from the main queue (they track the mouse in a loop of their own; one the app opens without a place opens where the root's last pointer event was (a move, or a press or release of any button: a right click's menu opens at that click), else at the cursor: the test agent's input leaves the cursor where it is); a menu item's `icon` (`MenuAction::icon`, `MenuItem::Submenu`'s, but not the bar's titles) goes through the images' pipeline (`image::load_menu_icon`, off the main thread, at the largest scale of the screens, since a menu opens on any of them) and arrives as `NSMenuItem.setImage` of an `NSImage` of up to 16pt, with `preferredImageVisibility` `.visible` (from macOS 27 AppKit hides items' images otherwise: `pitfalls.md`); an SVG is a template (`setTemplate`), which AppKit paints in the text's color (dark mode, selection, disabled), and a bitmap keeps its colors; a load is given up with its menu, a failed one warns and leaves the item as it is; role items send AppKit's standard actions down the responder chain and are not reported, the others target an `NshMenuTarget` that reports their tag; AppKit validates the items (roles are enabled and titled by the responder chain: `Undo Typing`, `Exit Full Screen`), a disabled item's action is one nothing answers; with an app's bar height NSH attaches no toolbar (from macOS 26 a toolbar enlarges the window's corners: `pitfalls.md`) and centers the traffic lights itself (`TrafficLights`, per window, the main one and the app's own): the title bar's container (the close button's superview's superview) as tall as the bar at the window's top, the three buttons moved down to its middle with AppKit's `x` (or to the app's `controlsOffset`), placed again from the frame-change notifications of the buttons and the container, inside the layout that moved them (every live-resize frame, another screen, leaving full screen), and given back their frames with the system's bar, in another window or when the window goes; nothing is placed in full screen; `titleBar().height` is the app's height; a host's existing toolbar stays untouched and reports its obscured height, the title bar view's around the traffic lights and the toolbar (`contentLayoutRect` lags the frame during a resize: `pitfalls.md`), refreshed after deferred layout |
| Window state (`nsh/desktop`'s `WindowRef.state()`, `displays`, `setPlacement`) | `window_state.rs` | The window's move, resize, (de)miniaturize, full screen and screen notifications read its state again into the environment, which the engine holds back until a move stops; the displays are `NSScreen.screens`, in NSH's screen coordinates (the primary screen's top left, `y` down), sent before the app starts and again when the screens change, each with an id that stays from one launch to the next; `setPlacement` restores the frame, then zooms or enters full screen |
| Windows (`nsh/desktop`'s `<Window>`, `Window.open`, `WindowRef`) | `window.rs` | Every window renders from the surface's one engine. A window of the app's own is a dialog root the core sends `OpenWindow` for: it leaves the main window's modals and becomes the content of a window of its own, its size the root's, its input routed to the surface with that root as the one events are picked in, shown once its first frame is in. Kinds pick the class: `normal` and `dialog` are `NshWindow`s (a dialog is a child window of its parent; a modal one holds its parent's input), `panel` an `NSPanel` with the small title bar, `popup` and `overlay` borderless non-activating panels (an overlay ignores the mouse). `SetAttributes` maps each attribute onto the window (style mask, content size limits, level, collection behavior, `NSVisualEffectView` backdrops, sharing type, document edited, represented URL, tabbing), the same code for the main window; requests are intents (`setMode` zooms or enters full screen, `requestAttention` asks the app's Dock icon). Each window reports its state (moves and resizes once they settle) and its hidden title bar's area on its root; `SetContentSize` (`sizeToContent`) sizes the content area, keeping the top left corner. Popups the core places in a window's root, and dialogs presented in a window (`ModalConfig.window`), show in that window: their sizing, focus, Escape and back follow the window the key is in, and so do the app's shortcuts, sheets (alerts, open and save panels) and context menus. The close, Escape and blur policies are held natively and answered on the main thread; the app hears of them afterwards (the main window's close press waits briefly for the app's turn). `windowControl` views act as the window's buttons (and read as them to VoiceOver), `windowResize` views resize the window by their edge. AppKit's Dock lists apps, not windows: `taskbar` is the Window menu and Cmd+`, `progress` the app's Dock tile (the last window that set one), and `requestAttention` bounces the app's icon |

| Clipboard | `system.rs` | `NSPasteboard` |
| Networking | `net.rs` | `NSURLSession` (the iOS backend's) |
| Dev | `dev.rs` | The dev server client on its own thread; a status line and the error overlay above the surface (opaque; code frames keep their lines and scroll sideways; a click that selects no text dismisses it, in an inactive window too; its Copy button copies the error); Cmd+R reloads the latest build |
| Performance monitor | `fps.rs`, `gpu.rs` | `--fps` / `AppOptions::fps` / `NSH_FPS=1` / `AppView::set_fps_monitor` / the app's `setFpsEnabled` (`Command::PerfMonitor`, through `Surface::perf_toggle`): a panel above the surface that lets the mouse through, redrawn twice a second from the surface's `nsh_engine::perf::PerfMonitor` (see below); GPU time from the IO registry (`accumulatedGPUTime` of the process' accelerator clients) |

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
  with Core Animation's commit, which is where content layers draw; ticks; wheel, drag and key handling).
  Refreshes in which nothing changed are not frames. While the link is stopped (the screen locked), only the frames
  deadlines run (`Surface::keep_deadline`) are measured.
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
it); a dialog's answer presses the `NSAlert`'s button with that title or ends the sheet. Pointer input goes to the window
the agent targets (the main one or a window of the app's own), keys to the window that has the keyboard (an app run in
the background never activates, so AppKit makes none of its windows key: the window that would be, the one last
shown, focused or pressed, is the focused one in its state and gets the keys), a view's bounds are in its own window's content, a window's state is read
from it as it would be reported, pressing a window's close button clicks its standard close button, so the
window's close policy answers it; a window's screenshot is its content, as the main window's, and dark mode is the
application's appearance, which every window follows but one with a color scheme of its own. `dev.rs`'s `Tester` attaches
the agent's model to the surface when the server says it runs a test session, before the first bundle. A step ends
once the app is quiet and no native animation runs (`Surface::animating`: the animation graph, the platform's own
motion on the display link, batches waiting for a frame); a scroll indicator fading out after a scroll does not count
(`Surface::cosmetic_frame`), so a key that scrolls the page (an arrow on a view that binds none) costs the scroll's
200 ms rather than the indicator's second.

```sh
./target/debug/nsh test examples/gallery --target macos
echo 'await app.screenshot("/tmp/a.png"); await app.press("label:Navigation"); await app.screenshot("/tmp/b.png")' \
  | ./target/debug/nsh test examples/gallery/App.tsx --target macos   # steps from stdin
```

A screenshot is the window as the window server composited it (`synth.rs` `composited`:
`CGWindowListCreateImageFromArray` of the window, its sheets and its child windows, clipped to the content view, at
the backing scale), so it shows what the screen shows: backdrop blur and glass, 3D transforms, Core Image filters,
`maskedCorners`, every box shadow, sheets, `AVPlayerLayer` and web views. An app may take pictures of its own windows
without the Screen Recording permission (checked on macOS 27 with the permission denied), and the picture is of the
window's own surface, so other windows over it do not matter. The function is deprecated and missing from the SDK's
headers since macOS 15 but still exported, so it is looked up at run time. Before the picture, the agent flushes Core
Animation and waits 50 ms (`agent.rs` `PRESENT`): taken at once, the picture was of the frame before the last commit.
In-process rendering cannot do this: `CARenderer` renders a layer tree only in a context of its own, and given the
window's tree (or a keyed-archive copy of it) it rendered and left the window's content blank on screen.

Where the window server gives no picture (the function is missing, the window is not visible, or the picture is all
black or clear, as a locked screen may make it), the screenshot falls back to drawing the window's content in process
(`drawn`: `cacheDisplayInRect:`), logged at debug. `cacheDisplayInRect:` draws sublayers in their order and ignores
`zPosition`, so the fallback first orders every layer's sublayers by `zPosition` (as Core Animation composites them;
the window does not change): without that, a decoration added before a layer it sits above (a border's stroke before
a finish's gradient) looked covered. That rendering is not Core Animation's own: it ignores `maskedCorners`, cuts
masks at their layer's bounds, ignores `shadowPath` and Core Image filters, flattens 3D transforms (perspective,
`rotateX`, `rotateY`), and does not show backdrop blur, sheets or `AVPlayerLayer` content (`WKWebView` pages show:
WebKit draws them for `cacheDisplayInRect:`, as of macOS 27). `decor.rs` avoids the first three (shape layers for
differing corners, masked holders for box shadows), so the fallback matches the window closely, except that spread
rings of box shadows are missing from it, and so are outer box shadows under an opaque background (unmasked
`shadowPath` casters, `visual.rs`). The composited picture also differs from the fallback in two ways a test may
see: the window's rounded bottom corners are clear, and a sheet dims the window under it, as on screen.

Tests run while the screen is locked (an agent can run them while the user is away), as they run unlocked: nothing
the agent does goes through the window server's input or screen capture. Input is posted to the
app's own event queue or handed to its window, keys go to the window whether or not it is key (`synth::key_event`),
screenshots render in process, and frames the display link no longer gives come from the surface's deadline timer,
which a test's app runs as it would on screen (`Surface::keep_deadline`). The agent finds a locked screen, or a
session that is not the console's, with `CGSessionCopyCurrentDictionary` (`system::screen_locked`): with
`--foreground` it does not wait for the app's activation then (the system never gives it), and the app's
`lifecycle()` does not turn `background` because the lock covers its windows. A left button press into a web view
while the app is not active (`--background`, the default, or a locked screen) goes to the `WKWebView` directly,
with its drags and release (`agent::mouse`): AppKit gives an inactive window's first click only to a view that
accepts the first mouse, which WebKit's does not for a click. The agent's mouse is the test window's only one: the
root takes no pointer events but the agent's (`synth::from_agent`, by type and timestamp, which survive the copy
AppKit makes of a posted event), so the user's mouse, and the enters and exits AppKit derives from where it really
is, never change what a test hovers, locked or not, and the user may go on using it while tests run. Lock the screen with `pmset displaysleepnow` (with a
password required right after sleep) to run tests that way.

## Not implemented, or different

- **Zooming scroll views**: `zoomTo` and the zoom props are ignored (as on Linux).
- **`brightness()` above 1** is not drawn. **Blend modes** are the layer's `compositingFilter`
  (`multiplyBlendMode` … `plusD` / `plusL`), set on the view's own layer — its content, fill and clipped-child layers
  are its sublayers — and cleared for `normal`; a change never moves it between layers (`visual.rs`).
- **Backdrops.** `macos={{ backdrop: { material, blending, state } }}` puts an `NSVisualEffectView` below the view with
  that AppKit material, blending and state (AppKit's own roles: titlebar … underPageBackground; defaults popover,
  withinWindow, active), whether or not a `backdropFilter` blur is set. Without it, `glassEffect` puts an
  `NSGlassEffectView` there on macOS 26 and later (looked up at run time, `setStyle:` regular / clear,
  `setCornerRadius:` the shared radius, `glassTintColor` as its `tintColor` where the class has the setter); before,
  the `backdropFilter: blur()` blur stands in (an `NSVisualEffectView` with the popover material and withinWindow
  blending, whose radius AppKit picks, or a radius-exact `PlainBlur` under a mask), and glass alone draws
  nothing. The effect views are the view's first subview and refuse `hitTest:`, so they never take input. A material
  blending `behindWindow` shows what is behind the window only where the window is nonopaque:
  `AppOptions::transparent`, explicit window attributes, or an embedding app's own nonopaque window. The view's
  blending never makes a window transparent. The test agent's composited screenshots show these effects;
  in-process fallback screenshots (`renderInContext:` and `cacheDisplayInRect:`) do not.
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
Command-Q, a test's quit, process-exit status and restart validation. No tests
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
application lifecycle. `WindowRef::close()` (TS `WindowRef.close()`) remains a window-close
request; an Exit or restart uses `quit_app()` from the host, or the app's
`quit()` (TS: `Application.quit()`), which takes the same path. `restart()` (TS: `Application.restart()`) takes it
too (`app.rs` `restart_app`) and marks the run; once `app.run()` returns, `run_app` calls
`nsh_core::restart::spawn_after_exit`, whose shell waits for the process to exit before `open -n` starts the bundle
again (the executable itself outside a bundle). A development host (feature `dev`) only quits: `nsh run` ends with
its host and stops the dev server, so a host started again would be cut off from both.

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

## Shader pictures

Effects, transitions, screen shaders and pages' and dialogs' overlays read pictures of views: `renderInContext:` of
the host's layer tree, on the main thread, at the window's backing scale, into a bitmap context the shader view keeps
(`Canvas`, made again only for a new size), then copied into the renderer's texture. Measured with `nsh test --target
macos` on an Apple silicon Mac (debug build, the gallery's 390 × 844 point window at 2x, 780 × 1688 pixels):

| What | Pictures | Main thread |
|---|---|---|
| A whole-window picture (a screen effect reading the surface) | one | 14 ms median (13.7 to 27), upload 0.6 to 1.7 ms |
| A screen effect running on `nsh.time` over still content, 3 s | none after the first, 363 frames shown | its frames only |
| Scrolling under a screen effect reading the surface | one per frame (50 for 52 frames) | about 14 ms a frame |
| A page pushed through its `transitionShader` (350 ms) | both sides on the first frame (27.7 ms), the live side on the next 11 (about 17 ms each, three settling frames and eight after views under the stack changed), none after | about 215 ms in all |
| The page leaving | both sides, then the live side twice | about 59 ms in all |

The work grows with the pixels pictured, so a larger window costs about as much more as it has pixels. Pictures are
taken only when what they show changed:

- a shader whose program reads its children (`sample_content`, `sample_to`) pictures them on the display frame after
  the core marks them (`MountItem::ShaderInput`) or a view in them changed or scrolled, at most once per frame; one
  that only draws over them, from `nsh.time` and its uniforms, never pictures them again;
- a backdrop reader pictures the window behind it after any change in its surface;
- a screen effect reading the surface pictures the whole window after any change in it, so one over a spinner, a list
  that animates or a scroll pictures every frame that runs;
- a page's or a dialog's overlay pictures both sides once, the live side on the next three frames and after a view
  under its host changed. Before, it pictured the whole stack on every frame of the run.
