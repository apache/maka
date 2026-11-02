# Verified constraints and pitfalls

Things that were found the hard way. Read the section of the area you change before changing it.

## QuickJS and the runtime

- **QuickJS microtasks are run by the host.** Call `Host::run_jobs()` after every call from Rust into JS. `setTimeout` / `console` are our own;
  `queueMicrotask`, `WeakRef` and `FinalizationRegistry` are built into QuickJS-NG.
- **`Host::run_jobs()` is also the end of the turn for unhandled rejections** (`rejections.rs`): QuickJS's rejection
  tracker reports a promise rejected without a handler and one that gets a handler later; the host holds the first
  kind until the job queue is drained, then reports those still unhandled (`Host::set_rejection_handler`, else a
  `js` error log). A handler attached later in the same turn makes no report, as in browsers. A promise the host
  settles or reads natively without `then` (the bundle's evaluation promise, a stream's) is marked handled
  (`JS_PromiseMarkAsHandled`), or it is reported. Interrupts are uncatchable and reject nothing; rejections while
  the heap ran out are dropped, the VM stops with that report.
- **The JS object graph must stay reachable from a GC root.** The renderer holds the root node, which holds its children's
  objects and each node its handlers (`dom.rs`, reported by the classes' GC marks). Without that the whole rendered app (nodes,
  handlers, signals) is an isolated cycle that idle GC collects, and taps stop working. `nsh test App.tsx` runs the steps of stdin after 1.2s of idling
  for that; `crates/nsh-engine/tests/engine/counter.rs` is the regression test.
- **Nodes are released by GC, not by Remove.** A memo may keep removed nodes and insert them again, so `Remove` only detaches;
  `Release` (queued by the node's finalizer) frees the node and its native view.
- **`nsh_js::BUNDLE_NAME` (`bundle.js`)** is the module name of every bundle and is how stacks are matched for symbolication; `BYTECODE_VERSION`
  names the QuickJS-NG release and revision, `BC_VERSION` and the byte order, never the binding. The native
  targets use `quickjs-jit` and must build the same QuickJS-NG as the CLI that compiles their bytecode (the web
  runs no QuickJS). Tests hold it to the linked release, the bytecode's format byte and the `-sys` versions
  in `Cargo.lock` (`ENGINES`): update them together when upgrading either.
- **Encoded operations' codes** (`ANIMATION_*`, `CV_*`) come from `nsh_core::js` (`protocol.rs`, `canvas.rs`): never write a code's value
  by hand in `nsh-js`.
- **rquickjs converts `Option::None` to `undefined`, not `null`**: compare native results with `== null` in JS.
- **`on*` props are event handlers to the renderer** (held on the node, sent to the core as a listener flag): settings must not
  be named `on...` on host elements (`List` sends `loadMoreThreshold` as `loadMoreThreshold`).
- **There is no error boundary**: hot component proxies catch what a component throws, report it and render nothing until the
  fix (`nsh-js` `hot.rs`).
- **Hot proxies return accessors**, not nodes: runtime code that inspects what a component returned (`NavStack` looks for a
  `<NavPage>`, `navigation.rs`) must accept an accessor.

## Core and layout

- **Text nodes outside `<Text>`** (e.g. a string child of a `<View>`) create no native view and take no part in layout. A `<Text>`
  nested in `<Text>` is a span without a native view; the whole block is merged into one `AttributedText`.
- **`TextSpan` offsets are UTF-16**, like NSAttributedString / Android Spannable.
- **Never re-insert a native child that is already in place.** `Insert` of a mounted view is a move: the platform takes it
  out of the window for a moment, which ends its touches and its focus (an Android input loses the keyboard). Child diffs
  (Rust components' `reconcile_children`) move only the children out of order, from the end, with `before` anchors.
- **Taffy 0.15 custom measure callbacks must delegate to `taffy::compute_leaf_layout`** and only compute the content size. Returning the
  content size directly skips resolving the leaf's own style (width / height / padding / min / max), so leaves such as
  `<Image style={{width: 48}}>` end up with a zero size.
- **Taffy 0.15's rounding pass is off; the core rounds layouts itself** (`rounded`, `Core::layout_origin`, the frame walk). Taffy rounds
  absolutely positioned nodes through their containing block's list of "hoisted" children, which it leaves stale: a childless node keeps
  the absolute child it last laid out, a hidden subtree's are never filled, a containing block served from the cache keeps its old ones.
  A freed node still listed made the next pass panic (`invalid SlotMap key`), a hidden one kept its former layout, and an incremental
  layout could round a node from stale values (a frame one point off from a layout from scratch). The core reaches every node through
  its parent, its containing block (there is no `position: static`), and sums the origins from the root down, in Taffy's order, so the
  `f32` sums and the rounding are Taffy's to the bit (`--trace` output is unchanged).
- **Layout rounds to device pixels, not whole points** (`round`, `rounded` and `ceil_to_pixel` in `core/mod.rs`, at the
  environment's `pixelRatio`). Android's densities are not whole numbers (2.625 on a 420 dpi phone), and its views sit on whole
  pixels, each frame rounded in its parent (`Mounter.frame`): rounded to whole points, a box 4 points down (10.5 pixels) and 30
  tall was 78 pixels while a child as tall was 79, so a scroll view cut the child's last row of pixels off; and a text measured
  21⅓ points (56 pixels) laid out at 22 (58), the 2 pixels below its last line. Text measurements are rounded up to a device
  pixel (`MeasureCache` holds the ratio and drops its sizes when the ratio changes, which lays everything out again); at one
  pixel per point this is Taffy's rounding, but for a value within a 64th of a half, which rounds up. Android's `lineHeight` is a whole number of pixels, rounded to the
  nearest as a TextView's dp line height is (`ExactLineHeight`): rounded up, 21 points at 2.625 were 56 pixels, a third of
  a point per line taller than the design. Sizes and offsets are counted in whole pixels before they become points
  (`pixel`, `span`): `round(to) - round(from)` in points differs in its last bits with where the edges are, and a 28 point
  row at 2.625 (73.5 pixels) has every other edge on a half pixel, which an `f32`'s hair rounds either way. As a scroll
  moved DataTable's body a pixel, every frame in it was sent again (460–1000 mount items a frame on a Pixel 10 Pro instead
  of 3); a half pixel is snapped first, so it always rounds up.
- **The core keeps its own layout tree** (`core/layout_tree.rs`: Taffy's algorithms over the core's nodes through Taffy's low-level
  traits, as `TaffyTree` runs them, call for call). `TaffyTree::mark_dirty` stops at the first node whose cache is already empty, taking
  its ancestors for dirty too; nodes of a `display: none` subtree and absolutely positioned ones always have empty caches while the nodes
  above keep theirs, so a view moved in there kept its former layout. `LayoutTree::mark_dirty` clears every cache up to the root, and the
  tree keeps no hoisted children (only Taffy's rounding pass reads them). The frame walk also gives everything under a `display: none`
  view an empty frame and its texts an empty content box (`emit_frames_in`, `flush_text`): a hidden subtree is never read.
- **Relayout boundaries are flex items whose size nothing inside can change** (`LayoutTree::is_boundary`): fixed points both ways, a
  flex basis of `auto`, `flexShrink: 0`, no baseline alignment. A change inside stops dirtying there and the item is laid out again with
  what its parent gave it last (`relayout_boundaries`, before the main pass); only when what it gives back differs (overflow, say) is
  its parent dirtied. Each condition is needed: a percentage basis resolves against a parent of no definite size as `auto` (its
  content), and shrinking is floored at the content's automatic minimum, so either let the content change the size (the layout
  consistency harness found the first). Growing is fine: it takes the free space the parent and siblings leave. A restyled node always
  dirties its parent (`set_style`), a boundary included. Boundaries' frames are emitted after the passes (`commit_round`).
- **A changed text dirties nothing when it measures as before** (`LayoutTree::measures_as_before`, from `rebuild_text`): every
  layout above a leaf was computed from the leaf's answers to the inputs it was asked (Taffy calls it under measuring passes and for
  its final size), so the leaf keeps those answers since its cache was last cleared (`LayoutNode::measured`, at most eight: more come
  of layouts at many sizes) and measures them again; all the same, and only the text is mounted again. The record is cleared with the
  cache, never alone: an answer dropped while a layout above still holds what it was computed from would let a change through
  unseen. Texts with attachments always relayout (their views are placed by the text's final layout).
- **List cells are independent Taffy roots** (not children of the list's Taffy node; their width follows the list's cross axis): scrolling only
  relays out dirty cells and only emits frames for relaid cell subtrees; when the main tree is clean, `compute_layout` and the frame walk of the
  main tree are skipped.
- **Taffy defaults are CSS semantics**; `Style::default()` switches to RN semantics: column, flexShrink 0, alignContent flex-start (stored as `normal` and
  resolved per display by `style::resolve_normal_alignment`, so grids keep CSS's `normal`), position relative,
  and min sizes 0 (an unset or `auto` `minWidth` / `minHeight` is 0). Taffy's `auto` minimum is CSS's automatic minimum size (the
  min-content size); text has no cheap min-content and reports its natural width, so `flex: 1` text in a row could not shrink and
  overflowed instead of wrapping. Yoga has no automatic minimum.
- **`MountItem::Insert` positions by sibling (`before`), not by index**: platforms insert their own subviews into containers
  (`UIRefreshControl` at the bottom, scroll indicators), which would shift indices.
- **Platforms clamp scroll offsets to the content**: UIKit clamps `contentOffset` when `contentSize` shrinks, Android's
  ScrollView clamps `scrollBy` to the child's current size. The core grows the content before a `ScrollBy` and scrolls
  before shrinking it; Android sizes the content view at once in `setContentSize` (not at the next layout pass).
- **Scroll reports can predate the core's own scrolls**: each report carries how many `ScrollBy` / list `ScrollTo` the view
  has applied (`EngineControl::scroll(.., applied)`), and the core adds the ones still pending; otherwise a stale offset
  moves the window (and fires `onLoadMore`) backwards.
- **Unbound list cells still show their last item**: the core moves them out of sight (never with a NaN frame: cells that
  were never placed are skipped; UIKit throws on NaN geometry). Out of sight is not out of reach: the backends'
  accessibility trees go by props, not frames, and a browser keeps such a cell in its accessibility tree, as a Tab
  stop and for test-id lookups. The core hides them too (`Core::set_spare`) until it places them again.
- **Tailwind variant order decides between variants**, not their order in the string: `odd:bg-a last:bg-b` gives an odd last row
  `bg-a` (Tailwind sorts `odd` after `last`), exactly as in CSS.

## Bundler and toolchain

- **rquickjs must not enable the `full` feature.** It pulls in `dyn-load` (dlopen2), which does not compile for iOS / Catalyst. iOS targets
  have no prebuilt bindings and need the `bindgen` feature (and libclang).
- **Use `oxc_sourcemap` 9.x** (matching rolldown / oxc 0.153): source maps are composed with rolldown's types, so never mix in
  another version's.
- **Our plugin's own compile errors** are kept in `NshPlugin.error` and shown directly (clean code frame + relative path) instead of rolldown's
  wrapped report.
- **rolldown CommonJS chunks define reassigned exports as non-configurable getters**: a module run again fills a fresh
  `exports` object and the hot runtime forwards the importers' object to it.
- **`nsh run` installs the host by copying to a temporary file and renaming it**: overwriting in place an executable that another session is
  running makes the kernel SIGKILL the newly launched process for a code signature mismatch.
- **Development hosts never restore windows**: `nsh run` launches the Catalyst host with `-ApplePersistenceIgnoreState YES`;
  after a crash, macOS would otherwise show a modal "reopen windows?" alert over it.
- **IPAs are zipped with `ditto -c -k --norsrc --keepParent`**: `--sequesterRsrc` adds `__MACOSX/` resource forks.
- **Float fields of the dev protocol decode through `nsh_dev::protocol`'s `float`** (`deserialize_with`): rolldown turns
  on serde_json's `arbitrary_precision`, which feature unification can carry into a host's build, and then a number
  with a fraction inside an internally tagged enum (every message, `TestStep`, `SceneQuery`) is buffered as a map
  `{"$serde_json::private::Number": "390.5"}` that a plain `f32` / `f64` field rejects ("invalid type: map, expected
  f64"); integers decode either way. A new float field in a message takes the same attribute.

## iOS, UIKit and Mac Catalyst

- **An input's `pointerEvents` is UIKit's, not `NshView`'s**: inputs are a plain container around a text view, with no
  `hitTest:` of NSH's, so `none` / `box-none` turn the container's user interaction off (`set_view_props`); it can still
  become the first responder and take typed text. Without it a hidden input (the `Editor`'s sink at its caret) takes
  the touches of whatever lies under it. A JS responder that blocks also cancels the `PressRecognizer`s of the views
  around it (`set_js_responder`): they keep tracking a finger a descendant took, and its lift was a press on them.

- **Retained navigation tabs hide the stack's container or an ancestor, not the navigation controller's view**:
  check the entire ancestor chain before a stack updates a shared system tab bar, including from transition
  callbacks. Visibility changes synchronize the newly visible stack after the batch. `TabBar.hidden` and the
  visible stack's request are independent reasons: each updates its own state, and either keeps the bar hidden.

- **A standalone `UITabBar` can establish its natural height before its native component host is sized** (verified on
  the iOS 27 simulator). Flexible-height autoresizing then adds the host's height to that initial height. In
  `system_tab_bar.rs`, fill the immediate host's bounds exactly during layout, and report intrinsic height with
  `sizeThatFits` at the laid-out width. `sizeToFit` changes the frame and must not run on selection updates.

- **Pressed-style observers must leave ancestor clicks working**: a view with only `activeStyle` / `active:`
  has a `PressRecognizer` to report its pressed state, but yields the click to the nearest ancestor with press
  handlers. `handled_deeper` counts handlers and pressable text spans; a style-only recognizer ends as failed
  after reporting its state, so it does not compete with the ancestor's recognizer.

- **UIFont and CTFont are toll-free bridged**: the text engine gets system fonts with `UIFont::systemFontOfSize_weight` and uses them as
  CTFonts (verified by rendering). CoreText attributes must use CT keys (colors are CGColors), not UIKit's NSForegroundColor.
- **Catalyst's Mac idiom does not support `UIRefreshControl`** (attaching one throws `_UICatalystUnsupportedMacIdiomBehavior`): in the Mac
  idiom the pull is detected in the scroll delegate and shown with a spinner + contentInset; iOS uses the native control unless the
  app draws its own indicator (`refreshIndicator`), which `UIRefreshControl` cannot give way to: then it takes the Mac idiom's way,
  without the spinner (`Mounter::sync_refresh`, on the events and on each behavior).
- **Mac idiom custom pull to refresh**: on release, the system's bounce already targets the old inset (back to 0), so changing only
  `contentInset` hides the spinner; once refreshing starts, the offset is animated to the top inset plus the refresh room on the next main-queue turn. Synthetic
  tests need continuous scroll events with phases (began / changed / ended); plain wheel events never overscroll.
- **Set backgrounds on `layer.backgroundColor`, not `UIView.backgroundColor`**: views with `drawRect:` (`TextView`) paint the latter into their
  contents bitmap, where corners cannot round it.
- **Styles arrive before frames** (new views have a zero size): a shared radius goes straight to the layer (Core Animation clamps it itself);
  only paths, shadow paths, the content view and the image layer depend on the size, and they are rebuilt on `Frame` while `Decor::sized()`
  is true. Scaling radii by the CSS rule at a zero size once turned every rounded corner square.
- **Property changes on standalone `CALayer`s animate implicitly for 0.25s** (a UIView's own layer does not): wrap changes to shape / image
  layers in `CATransaction.setDisableActions(true)`.
- **Core Animation always draws `border` above sublayers**, while CSS borders are below children: non-clipping views use a stroke layer below
  the children; when clipping both look the same, so the layer's own border is used.
- **A UIScrollView's sublayers scroll with its content** (`bounds.origin` is the scroll offset), so scroll views cannot use shape layers / masks.
- **UIKit callbacks may fire synchronously while the Mounter applies a batch** (e.g. setting `contentOffset` triggers `scrollViewDidScroll`):
  when `EventTarget::with_mounter` cannot borrow, it defers to the next main-queue turn; never `borrow_mut` directly.
- **Views with a transform must not set `frame`**: always use `bounds` + `center`, keeping the bounds origin (a scroll view's bounds origin is
  its scroll offset).
- **Catalyst**: `UIDeviceFamily` must include 6 (Mac idiom), otherwise the UI is scaled to 77%. Under Catalyst the container extends below the
  title bar, so overlays are constrained to `safeAreaLayoutGuide`. UIDevice reports "iPad" under Catalyst. Use the UIScene lifecycle
  (`UIScreen.mainScreen` and `UIWindow initWithFrame` are deprecated). The window size is fixed to 390×844 through `sizeRestrictions`.
- Methods in `define_class!` that return `Retained<T>` need `#[unsafe(method_id(...))]`. Classes UIKit instantiates by name (AppDelegate,
  SceneDelegate) cannot have ivars; keep their state in statics or thread locals.
- **UIKit implements the `UITextInputTraits` setters of `UITextField` by message forwarding**: objc2's debug-build signature
  check cannot find them on the class and panics, so `input.rs` sends them with a raw `objc_msgSend`.
- **objc2 crates are used with `default-features = false`** and an explicit feature list in the root `Cargo.toml` (one feature per
  header): the defaults link CloudKit, CoreData, CoreImage, CoreLocation, Metal, ... into every app (each one costs dyld time at
  launch). When a method is missing after using a new API, enable the header feature named in its `#[cfg(feature = ...)]`; check
  `otool -L` on a release `nsh-ios-app` afterwards (only UIKit, Foundation, CoreFoundation, CoreGraphics, CoreText, QuartzCore, ImageIO).
- **`TextView` uses `UIViewContentMode::Redraw`**: list cells can get their text before their frame; without redrawing on
  resize the text stays drawn at zero size.
- **UINavigationController breaks transitions started during another one**: stack changes that arrive while
  `transitionCoordinator()` is set wait for the transition's end (`didShow`, or the coordinator's completion: a modal
  presented or dismissed over the stack sets the coordinator too and never reaches `didShow`) and are applied on the next
  main-queue turn (the coordinator outlives those callbacks); only pages the controller actually had count as popped by
  the user.
- **UIKit installs its own interactive-pop delegate while loading a navigation controller's view**: assigning NSH's
  delegate when the stack is created can be overwritten. Bind the current recognizer in `didShow`, after UIKit has
  configured the screen, so hidden headers use NSH's mounted `popOnSwipe` / `popOnBack` policy too. Verify the gesture
  with real system edge input; the in-process test agent does not start UIKit's interactive pop.
- **`UIAlertController` asserts when its presentation controller's delegate is set**; a popover action sheet (iPad, Mac) hides
  its cancel action and runs it on a tap outside, so sheets without one get a hidden, untitled cancel answering "dismissed" (`null`).
- **Catalyst: a mouse drag does not scroll a UIScrollView** (Mac behavior); test scrolling with trackpad-style scroll wheel
  events (with phases), which also produce drag and momentum callbacks. Mouse drags do reach views as touches.
- **Catalyst: the Mac idiom moves a navigation bar's contents into the window's toolbar** (`UINavigationBar.behavioralStyle`
  resolves to `.mac`; macOS 26 does it even with the scene's `titlebar.toolbar` nil): the back button sits next to the traffic
  lights, the title is gone (or is the window's) and the header's colors do not apply. Stacks' bars (and the bar measuring
  the header height) set `preferredBehavioralStyle = .pad` (iOS 16+) to stay in the window, and standalone apps hide the
  window's title and toolbar (`UITitlebar`, which objc2 does not declare: `app.rs` sends its setters by name), so the title
  bar is a transparent strip over the in-window header, like iOS's status bar; apps embedding NSH on Catalyst should hide
  theirs the same way. The core's estimate of a header (the bar's height plus the safe area's top) can still miss what UIKit
  lays out, which showed the screen's root view in a band under the bar: screens report the top of their controller view's
  safe area (the bottom of whatever bar UIKit shows) as their header (`Core::set_screen_header`), and the stack's bar gets
  the screen's appearance as well as its navigation item.
- **Catalyst's Mac idiom presents page / form sheets as macOS sheets** at a default size wider than a 390pt window: they get
  the window's size as `preferredContentSize`. Standalone apps have a white root view (UIKit windows are black).
- **iOS clamps shared corner radii itself** (`rounded-full` is 9999): Core Animation does not reliably clamp a `cornerRadius`
  over half the short side, so `decor.rs` clamps it and clamps again when the size changes.
- **iOS, a side bar's safe area reaches past the bar**: a strip the device keeps along one side of the screen (a
  foldable's vertical bar) is an inset of the window, and `UINavigationController` passes that inset to the screens it
  shows without asking whether the stack still reaches the bar, so a stack laid out in a column well clear of it gives
  its screens the bar's whole width of trailing safe area anyway: UIKit parks scroll indicators that far in from the
  edge, and `safeAreaInsets()` reads that wide inside the module. `clip_side_safe_area` takes the surplus back with a
  negative `additionalSafeAreaInsets` worked out from the window and the stack's frame alone. Deriving what UIKit
  granted by subtracting the compensation already applied looks equivalent and cannot heal: UIKit floors a safe area at
  zero, so after an overshoot that subtraction returns the value already applied, for good.

- **iOS, dismissing a modal that presents another**: `dismissViewControllerAnimated` called on a controller that is
  itself presenting one (a `Sheet` is a transparent modal over the modal it is in) dismisses only that one, and the outer
  modal stays on screen with its content already gone: a blank screen when a sheet and its modal close together.
  `ModalHost::dismiss` dismisses through `presentingViewController`, which takes the modal and everything above it.

- **iOS, presses near the top of the window**: UIKit attaches tap recognizers to the window that skip `UIControl`s, and a
  press is a gesture recognizer, not a control. On iOS 26+ the window's `_UIDoubleTapInteraction` (a single-tap
  recognizer over the top 64 pt, `cancelsTouchesInView`, never simultaneous, action disabled) recognized first and
  prevented every press there, so a navigation bar's back button did nothing (seen on an iPhone foldable simulator; a
  real tap through XCUITest reproduced it). `PressRecognizer` is not preventable by tap recognizers on a `UIWindow`
  (`press.rs`, `is_window_tap`); edge-gesture gates are not taps and still cancel presses.
- **iOS, a hardware keyboard's keys** reach the first responder as presses (`pressesBegan:withEvent:`) before
  UIKit's text system acts on them: a text input that does not call `super` for a press neither moves its caret,
  inserts a line break nor types it, and must not call `super` for that key's release either. A held key's press
  comes once (the text system repeats on its own), so a binding that repeats needs a timer of its own
  (`keymap.rs`). A press's `responder` is the first responder it went to: presses bubbling up to the root view from
  an input were matched there already.

- **iOS, the screen scale**: a `UIView` that draws nothing itself keeps a `contentScaleFactor` of 1 on a 3x screen, and a
  drawn one raises it while zoomed, so neither is the screen's scale. Images decoded at it came out at a third of their
  pixels and blurred; the scale is the trait collection's `displayScale` (`Mounter::display_scale`).

- **iOS, ProMotion**: a `CADisplayLink` left at its default fires at 60 Hz on a 120 Hz iPhone, so native
  animations, `scrollValue` bindings and JS frames moved at half the rate of the system's own scrolling. Both links ask
  for the screen's `maximumFramesPerSecond` (`animation.rs` `full_rate`); an iPhone grants more than 60 Hz only to
  apps whose `Info.plist` sets `CADisableMinimumFrameDurationOnPhone` (`nsh package`, the development host; embedding
  apps set it themselves, `website/docs/ios.md`). iPads ignore the key.
- **iOS, secondary clicks**: `buttonMaskRequired` only holds touches that have buttons. A finger has none, so a tap
  recognizer requiring the secondary button recognized every tap, and as a tap recognizer it cancelled the presses inside
  (a `ContextMenu`'s trigger opened its menu instead of pressing). The `onContextMenu` recognizer allows only
  `UITouchTypeIndirectPointer` touches (`mount.rs`).
- **iOS, VoiceOver's increment / decrement**: VoiceOver calls `accessibilityIncrement` / `accessibilityDecrement`
  (swipe up / down) only on elements with `UIAccessibilityTraitAdjustable`, so an element with those actions gets the
  trait on top of its role's (`native_view.rs` `traits`; an image with them is announced as an adjustable image). It
  reads the element's value as soon as the call returns, while the new value comes from the engine thread in a later
  batch: a step whose value arrives after VoiceOver read the old one announces the new one (`NshView::late_step_value`),
  one that arrives before it asked is read by VoiceOver itself.

## Android

- **Android, JNI**: cache classes and method ids in `JNI_OnLoad`; wrap every call from the (permanently attached) engine thread in
  a local frame (`java::with_env`), or local references pile up.
- **Android, text**: `StaticLayout` ignores `maxLines` without an ellipsis (clip mode counts lines itself and the view clips);
  build layouts from `PrecomputedText` with the same break strategy / hyphenation / text direction as its params, or it
  measures again. A layout of precomputed text does not draw `UnderlineSpan` / `StrikethroughSpan` (even ones set after
  `create`): runs carry a `TextLayouts.Decoration` marker and `TextBox` draws the lines. `Layout.Alignment` is relative to each
  paragraph's direction: absolute left / right alignment sets an `AlignmentSpan` per paragraph from its resolved direction.
- **Android, text hit testing**: `Layout.getOffsetForHorizontal` stops before the last cluster of a wrapped (non-last)
  line, so a hit past its end is snapped to the line's end (`TextLayouts.hitTest`, upstream); `getSelectionPath` adds
  margin rectangles when a range ends at a wrapped line's end, so range boxes come from the run's carets
  (`TextLayouts.rangeRects`), not from the path.
- **Android, view properties set every frame**: `setAlpha`, `setTranslationX`, `setScaleX`, `setRotation` and the like
  return early on an unchanged value, `setCameraDistance` does not: it invalidates the view on every call. Animated
  values and transitions write a view's whole transform each frame, so `Mounter.setPerspective` sets it only when it
  moves (it was a fifth of the UI thread's time on the gallery's Animations demo).
- **Android, shadows moved by fractions of a pixel**: Skia caches a shadow's blurred mask keyed on the subpixel part
  of its position, so a view moved by a fractional offset each frame blurs its shadows again every frame (on the GPU,
  each into a new render target, slow on PowerVR). `StackBox`'s push / pop slides move by whole pixels; going back to
  the gallery's index ran at about half the frame rate before (#519).
- **Android, JNI event maps intern their keys from a fixed list** (`Java_com_longbridge_nsh_Native_eventMap`): a new payload key must be
  added there or it is dropped silently.
- **Android, inputs' `pointerEvents`**: `InputBox` is a `FrameLayout`, not a `Box`: it keeps `pointerEvents` itself and
  refuses touches in `dispatchTouchEvent` for `none` / `box-none`, and `TouchTracker.deepest` reads it as a `Box`'s.
- **Android, inputs**: `EditText` reconfiguration (input type, filters, single line) sets the same text again and fires
  `afterTextChanged`: only text that differs from the last known one counts as an edit, or JS values are rejected as stale.
  Soft keyboards edit through the input connection (`KeyConnection`: composing text, commits, deletes), hardware keys arrive
  as key events; both feed `onKeyPress`. A hardware Enter reports its down and its up — act on the down only and consume the up, or the up advances
  focus again in the next field; blur by focusing the (focusable, highlight-free) `NshView`, as `clearFocus()` hands focus to the
  first focusable view; set the typeface after the input type (password types reset it to monospace). The composition
  (`onCompositionChange`) is read from the composing span (`BaseInputConnection.getComposingSpanStart` / `End`) after every
  edit, connection call and batch end, since keyboards start and end it in many ways (`setComposingRegion` included); a
  value JS sets meanwhile waits for its end (`setText` restarts the keyboard, which commits the pre-edit text), and is
  never applied from inside the text watcher.
- **Android, input selection after attachment**: a navigation screen can be measured while detached. `TextView` then
  caches disabled cursor controllers because its root has no window parameters; attachment alone does not refresh
  them, and another `requestLayout` may reuse the text layout. `InputBox` reapplies the current break strategy on
  attachment when a text layout already exists, discarding it so the next measure refreshes the controllers with a
  valid window. Keep this on every attachment, including reattachment. Do not replace the text or enable
  `textIsSelectable` to force a refresh: those affect selection, input-method state or focus/keyboard behavior.
  Regression checks must cold-start the Android host and long-press a four-line input inside `NavStack`, with explicit
  `lineHeight` and height updated by `onContentSizeChange` ([reproduction](https://github.com/longbridge/nsh/issues/409));
  hot reload can hide the failure. Also check removal/reattachment, editing and the native selection menu.
- **Android, keyboard avoidance**: the keyboard's height becomes bottom padding of the scroll around the focused input, and
  `ScrollBox.reveal` scrolls it into view; `requestRectangleOnScreen` cannot, as ScrollView ignores its padding when it decides
  whether a rectangle is visible. `NshView` is a scroll container (`setScrollContainer(true)`) so that windows without a soft
  input mode resize instead of panning: the system picks the mode at the first layout, before the app's content is mounted,
  and a mode set from code afterwards is overridden. Windows that ask for `adjustPan` are left to the system.
- **Android, passive press feedback**: `activeStyle` / `active:` and `android.ripple` observe a touch without
  consuming it. The root's `TouchTracker` feeds style-only views through `Pressable`; `Box` and leaf views take
  clicks for their press handlers or text spans. Feedback is cancelled when scrolling, panning, pinching or rotation
  takes over, so a styled child leaves its parent's overlay or menu trigger clickable. The walk up from the touched
  view stops at the first press handler, or at a text only when the finger is on one of its pressable spans (as
  iOS's `handled_deeper` checks the link at the touch), so a card around plain text still shows its pressed style.
  While feedback shows, the root claims the gesture as a clickable view would: Android sends the release only to
  the view that took the down, and the release is what ends the feedback.
- **Android, drags that start on a child**: a pannable `Box` intercepts the move that exceeds the slop and starts its pan right
  there; that intercepted move never reaches its `onTouchEvent`, so starting the pan there is what makes a quick flick (few moves)
  pan and end at all.
- **Android, `Dialog` content placement**: `Box.place` lays a view out at its core frame directly, so the status bar offset of a
  non-translucent `Dialog` (no `statusBarTranslucent`) is a content view inside the Android dialog's container, not an offset applied to the root's layout; the dialog
  copies the activity's bar appearance (light / dark icons).
- **Android, nested scrolling**: scroll views enable nested scrolling, or an outer vertical ScrollView intercepts every vertical
  drag meant for an inner one.
- **Android, safe area**: `NshView` reports only the parts of the system bars / keyboard that overlap it (like UIKit's
  `safeAreaInsets`), so embedded views below a toolbar get no top inset. Overlays use the same overlap (`topInset()`).
- **Android, dev assets come over plain HTTP**, which apps block by default (API 28+): the dev host APK and `nsh-dev.aar` set
  `usesCleartextTraffic`; the release AAR does not.
- **Android, activities**: create the decor view (`getDecorView()`) before asking for the insets controller; apps draw edge to edge
  and get the system bars through `safeArea()`.
- **Android, the back key without `OnBackInvokedCallback`** (below 13, or `enableOnBackInvokedCallback` off): the window
  sends `KEYCODE_BACK` down the focus path, then the activity's `onKeyDown` / `onKeyUp` take it (`onBackPressed`), so an
  unfocused view only hears it through `View.addOnUnhandledKeyEventListener` (API 28+, called by the decor view between
  the two, whatever has focus). With the callback in effect the window turns the key into the callback before any view,
  so `NshView` taking the key never doubles its callback (seen on Android 16, both settings).
- **Android widgets**: `MediaPlayer.setPlaybackParams` starts playback (set the rate only while playing) and a paused player draws nothing until
  it seeks; `WebView` JavaScript bridge calls arrive on a binder thread (post to the UI thread).
- **Android, negative letter spacing**: Minikin adds half the spacing on both sides of each glyph and trims the halves at line edges,
  so a line is wider than its sum of advances; `TextLayouts.Prepared.desired` adds the largest negative spacing back, or text laid
  out at its natural width wraps (`tracking-tight`).

- **Android, a hardware keyboard's keys** go to the input method first, then down the window's views
  (`dispatchKeyEvent`, the parents before the focused view): `NshView`, which holds the focus when no input does,
  sees every key meant for the views inside it. Keys with Control come as `dispatchKeyShortcutEvent` first, where a
  text field selects all, copies and pastes, so the app's shortcuts are matched there too.

## Linux, GTK

- **inotify reports reads** (`Access` events), FSEvents does not: file watchers (`nsh dev`, `cargo run`'s xtask) ignore
  `Access` events, or the build's own reads of the sources start the next build, forever. inotify also reports paths
  under the watched one as given: watch a canonical path (a `..` in it makes every path look like a dot entry).
- **GDK frame times are microseconds** (`FrameClock::frame_time`); `nsh_anim::Graph::tick` takes seconds and the
  scroll and transition code milliseconds: convert at each call site.
- **AT-SPI reads widgets, not what NSH draws**: a view `snapshot` skips (`visibility: hidden`) is still presented, with
  its subtree, until its accessible state is `Hidden` (`access.rs`); GTK's AT-SPI bridge then leaves out the widget
  and its subtree (`gtk_accessible_should_present`; checked with an AT-SPI client on GTK 4.14).
- **A widget's accessible role is effectively fixed** once its AT context is realized: GTK refuses to change it (with a
  critical), and nothing tells whether it is. Roles are decided when the view is created, from the batch that creates
  it (`access::prepare`); a later change detaches the view and puts it back.
- **`gtk_snapshot_append_repeating_radial_gradient` does not repeat** on GTK 4.22: append a
  `gsk::RepeatingRadialGradientNode` made with its constructor.
- **Bitmap fonts (color emoji) describe their strike's size**: a run's font description from
  `describe_with_absolute_size` names the bitmap size, not the size asked for; set the absolute size again before the
  main thread loads the font by description.
- **GDK decodes only PNG, JPEG and TIFF by itself**; GIF and WebP need gdk-pixbuf loaders many systems lack, so the
  `image` crate decodes them (their first frame).
- **GTK 4.22 damages a translation with a whole `dx` and a fractional `dy` wrongly**: `gsk_transform_node_diff` tests
  `floorf (dy) != dy` (fixed upstream to `==`) and translates the damage by the truncated offsets, so the pixels of
  what moved or shrank under a fractionally scrolled view stay on screen. `view.rs` places children at whole points
  and moves a remaining translation off that path (`placement`). Check damage on screen (`import -window root`, `grim`),
  not with `shot`, which renders a fresh frame; `GSK_DEBUG=full-redraw` tells a damage bug from a drawing one.
- **GSK's cairo renderer paints text outside its node's bounds**: a text node is bounded by the unhinted ink, cairo
  draws the glyphs hinted with the baseline on the pixel grid, a pixel or so beyond. A view with text (or a text field)
  adds a clear node `TEXT_OVERHANG` around its bounds that changes with each `NshView::changed`, so its damage covers
  that (`ViewState::draw_overhang`).
- **WebKitGTK hands back keys a page did not use, except arrows**: `PageClientImpl::doneWithKeyEvent` puts unused key
  presses back into GTK (so the window's bubble-phase controllers see Escape), but always keeps arrow keys, so Alt+Left
  never reaches the window from a focused page. `native/web.rs` takes the history keys in a capture-phase controller on
  the web view.
- **WebKitGTK's `decide-policy` does not say which frame a navigation is for** (`WebKitNavigationAction` has no main
  frame flag, and subframe navigations come through it too): a policy decided there applies to frames as well.
- **GTK delivers pointer events by allocation**, ignoring NSH's clipping (`overflow: hidden` in `snapshot`), `hidden`
  and `pointerEvents`: a hosted widget (a web view's page) gets clicks and wheels outside what is drawn of it unless
  the root's capture controller stops them (`input.rs`'s `shields_page`).
- **Tiling window managers ignore the host's `--window-size`** (the window's default size): a test's screenshots have the size
  the window got, and so does `app.setViewport` (it resizes on X11 and floating windows).

## iOS, the test agent's input

- **Touches made in process do not move the first responder**: a made-up tap on a text field leaves the keyboard's
  focus where it was, so the agent focuses the input a tap lands in itself (as KIF does).
- **`UITextField.insertText:` skips the field's delegate** (no `shouldChangeCharactersInRange`, so no `maxLength`):
  typing goes through `UIKeyboardImpl`, which asks it, as the software keyboard does. Keys typed faster than a
  controlled input's value comes back lose characters, so keys come at a typist's pace.
- **A finger at rest still reports its position**: a drag that stops sending events before it lifts keeps its last
  velocity and flings. A drag whose path leaves the scroll view moves it much further than the finger.
- **Interactive back needs system-delivered touches**: the agent's IOHID drags can start UIKit's navigation
  gestures in the simulator. Test with `app.drag` from an element at the leading edge; `app.back()` exercises
  the back button instead. On iOS 26 a leading-edge drag can be recognized by
  `interactiveContentPopGestureRecognizer`, so both it and `interactivePopGestureRecognizer` need the stack's
  permission delegate after the navigation view has loaded. A scroll view's glide or bounce is not a Core
  Animation animation: `isDecelerating` says it moves, and a tap during it only stops it.
- **Interactive back and editing**: the outgoing page remains attached while the finger moves, so removing its
  input only ends editing after the pop. The stack's gesture delegate ends editing after the permission, root and
  transition guards allow the gesture. `didShowViewController:` restores that editor if its page returns after
  cancellation and no other control took focus. Rejected gestures keep focus. The regression observes `onBlur` while the
  root's system-delivered touch is still down, rather than checking only after the page has detached.
- **A hardware keyboard's keys are IOHID keyboard events** (`IOHIDEventCreateKeyboardEvent`, usage page 7) handed to
  UIKit the way touches are: they become presses, key commands and typing as a real keyboard's do. Modifiers are
  keys of their own (left Control, Shift, Option, Command), down before the key and up after it.
- **A menu's backdrop covers the header**: on a touch screen a menu is a sheet over a backdrop on the whole window,
  so a tap at the header's back button lands on the backdrop and closes the menu (`backdropPress`) instead of going
  back from a submenu. iOS has no back key, so while the app listens to going back the agent's `back` is VoiceOver's
  escape gesture on the surface (`RootView`'s `accessibilityPerformEscape`), which the core takes as the back button.
- **`-[UIApplication _enqueueHIDEvent:]` takes an `IOHIDEventRef`**: objc2's debug type checks reject an object
  pointer, so the argument has the `^{__IOHIDEvent=}` encoding.

## Android, the test agent's input

- **Ctrl+key presses are shortcuts first**: the window's input stage (`ViewRootImpl`) offers them as
  `dispatchKeyShortcutEvent` before the key event, and a `TextView` selects all only there; key events dispatched
  to the views directly skip it, so the agent offers them as shortcuts itself.
- **A view's motion is not observable as one value**: scroll views fling with a private `OverScroller` and views
  animate with `ViewPropertyAnimator`s, so the agent compares a signature of every shown view's place, offset,
  scroll position and opacity between looks.

## macOS, AppKit

- **Closing a window synchronously calls its delegate**, which stops the surface and clears its mounter.
  Commands applied while the mounter is borrowed defer window closure to the next main-queue turn
  (`system.rs`, `ExitApp`), so teardown can borrow the mounter again.

- **Changing `FullSizeContentView` can leave the content at its old size after `setStyleMask:` returns**:
  a hidden title bar then leaves a strip of window background until the next resize. `chrome::apply_title_bar`
  reconciles the content view's size with `contentRectForFrameRect:` on the next main-queue turn, using the window's
  current frame and style (including any later title bar change in the same batch).

- A layer-backed `NSView`'s layer belongs to AppKit: moving or resizing the view sets its layer's anchor point,
  position and transform again. `NshView::place` sets the frame first, then anchor (top left), position, transform and
  opacity, every time; a transform set elsewhere is lost on the next move.
- Layer contents sit below every sublayer of the view: a fill sublayer (differing corners, gradients) would hide
  content drawn into the view's own layer, so text and canvases draw into a content sublayer (`zPosition` between the
  decoration behind the view and its children).
- `setBoundsOrigin:` (scrolling) marks every `drawRect:` view below it for display (`NS_viewVisibleRectDidChange`),
  clipped or not, on every scroll step; plain sublayers drawn by a delegate are not affected (`view.rs`).
- Trackpad scroll events come at about the display's rate but not in step with it: applied as they come, frames move
  twice or not at all while the frame rate reads 120. Resample them at display frames by their timestamps (`scroll.rs`).
- `NSEvent.timestamp` is on `CACurrentMediaTime`'s clock (`systemUptime`); a `CGEvent` made without a source has
  timestamp 0 until set (nanoseconds). `NSWindow.sendEvent:` drops synthesized momentum-phase scroll events: scripts
  hand them to the view under the pointer.
- Clipping a layer (`masksToBounds`, a mask) clips its shadow too: a view that clips its children and casts a shadow
  moves the children into a container that clips, and keeps the shadow on its own layer.
- `NSView`'s display link does not fire while the window is occluded or minimized, or the screen is locked: a surface
  that wants frames falls back to a main-queue timer after 100 ms without one (`surface.rs`), or transitions never end.
- `window.sendEvent:` delivers an event without making it `NSApp.currentEvent`, and synthesized mouse moves only arrive
  when the window accepts mouse moved events; a window-less `CGEvent`'s location is in screen coordinates. The test
  agent's input posts to the application's queue (`synth.rs`).
- `CALayer.backgroundFilters` (iOS's backdrop blur) do nothing in AppKit windows, `layerUsesCoreImageFilters` or
  not, and Core Image is not even loaded (`CIFilter` is missing) unless something links it. Backdrop blur is an
  `NSVisualEffectView` with within-window blending; it needs `wantsLayer` set when created, or it has no layer to order
  and clip until AppKit makes one.
- `NSView.hitTest:` works on frames: it ignores layer transforms and hidden layers, and does not look into subviews
  outside their superview's frame. The root's `hitTest:` lets NSH's own picking decide inside the surface
  (`input.rs` `native_at`), or a hosted web view gets clicks on what NSH draws over it.
- `-[NSCursor set]` costs ~2.5–3.5 ms per call on macOS 26 with a customized pointer size or color (it renders the
  cursor image again, `_AXFMouseCursorGenerator`), even for the cursor already set; and a view's default
  `cursorUpdate:`, which AppKit calls after views move or are added, sets the arrow. Set the cursor only when it
  changes while the mouse is still (`input::set_cursor_at`), and answer `cursorUpdate:` with NSH's cursor: a scroll
  that mounts rows ten times a second otherwise spends a third of those frames setting the same cursor.
- AppKit's geometry (`hitTest:`, `convertPoint:` / `convertRect:`, `visibleRect`) follows bounds, not a
  `sublayerTransform`: while a scroll offset is only the container layer's transform, AppKit places every view
  below it at the last committed offset. Commit it first (`scroll::commit_pending` on a press,
  `scroll::commit_ancestors` before a conversion); clip and pick by NSH's own placed frames and
  `scroll::bounds_origin`. A view's logical frame (`ViewState::frame`) misses its sticky shift and RTL mirroring:
  clip spaces are the placed frames (`ns().frame()`).
- In `define_class!` methods, an early `return` of a `bool` or `Option<Retained<_>>` does not compile (the macro wraps
  the return type): write the body as one expression.
- VoiceOver reads views, not layers: `visibility: hidden` hides only the view's layer (an `NSView`'s own `hidden` is
  the navigation's, for screens under the top one), so `access.rs` takes such a view and its subtree out as it does
  for `accessibilityElementsHidden`. `setAccessibilityChildren:` cannot be undone: `nil` leaves the view without
  children instead of AppKit's again, so a subtree shown again stayed out of reach; `NshView` answers
  `accessibilityChildren` itself (none while hidden or grouped, else `NSView`'s).
- In-process screenshots (`cacheDisplayInRect:`, `renderInContext:`) ignore `maskedCorners`, `shadowPath`, Core Image
  filters and cut masks at the mask layer's bounds; they show no sheets or `AVPlayerLayer` content, and
  `renderInContext:` no `WKWebView` pages either (`cacheDisplayInRect:`, the test agent's screenshot, shows them: WebKit
  draws them for it). Pages and dialogs that leave as images take their live web views and videos along (`native::lend`).
- `screencapture -l` needs the Screen Recording permission and fails ("could not create image from window") without
  it; while the screen is locked a full-screen capture is black.

## Windows, Win32

- **Git checks files out with CRLF** (`core.autocrlf=true`, Git for Windows' default), and `.rustfmt.toml`'s
  `newline_style = "unix"` then makes `cargo +nightly fmt --all` rewrite every line of every file it touches. The
  repository's `.gitattributes` forces LF; a checkout made before it needs `git add --renormalize .` (or a fresh
  clone).
- **rustc and clippy overflow their stack on the `windows` crate** (its generated bindings are huge): set
  `RUST_MIN_STACK=268435456` when a build or clippy run dies with a stack overflow.
- **Thread-local COM objects released inside `ExitProcess` end the process with a stray exit code**: the main thread's
  thread-local destructors run after the graphics DLLs and their driver threads are gone. `run_app` runs the window on
  a thread of its own and joins it, so the devices, font faces and bitmaps cached per thread go at a plain thread exit.
- **Win32 timers tick at ~15.6 ms** (the default timer resolution) and wake-ups come late on a loaded machine: tests
  must not assume two timers a few milliseconds apart run in separate turns (chain them instead), and a test's waits
  need slack.
- **Child windows cover everything a window draws** (the "airspace" limit): web views are WebView2 composition
  controllers in the window's DirectComposition tree for this reason (`compose.rs`); native components that bring an
  `HWND` of their own still cover NSH content. Offscreen drawings of the window have no web views: the test
  agent's screenshots capture them (`PrintWindow` with `PW_RENDERFULLCONTENT`).
- **`IDCompositionVisual::AddVisual(visual, TRUE, NULL)` puts the visual below all its siblings**, not on top: to
  stack bottom to top, insert each one above the one added before it (`compose.rs`).
- **A focused WebView2 page has the keyboard in a window of its own** (`Chrome_WidgetWin_0`, a child of the
  surface's window): the surface's window gets no keys until it takes the focus back, so alerts and dialogs take it
  (`native::take_keyboard`), and the test agent's typing and keys post to that window while it has the focus. A
  `MoveFocus` right after the click needs a few hundred milliseconds before typed characters reach the page.
- **`std::fs::canonicalize` returns verbatim paths** (`\\?\C:\…`), which rolldown and path prefix comparisons do not
  take: the bundler and the CLI canonicalize with `dunce::canonicalize`, which keeps plain paths when they are valid;
  capability checks, trusted anchors and grant roots all go through `nsh_core::access::canonicalize`, which does the
  same, so both sides of a containment check have one form.
- **Git Bash sets `LANG`** whatever the user's settings: the Windows backend's locale is the user's regional format
  (`GetUserDefaultLocaleName`) and ignores `LANG` / `LC_*`, as Windows programs do.
- **A `:` in a package's asset path is dangerous**: joined onto the assets directory, a `C:` segment replaces it and
  `name:stream` writes an NTFS alternate data stream. `nsh-package` refuses paths with `:`, as with `\` or `..`.

## Web, browsers

- **WebKit does not hand a `<link rel=preload as=fetch>` still in flight to the `fetch` of the same URL**: the
  `fetch` downloads the file again, and only once the preload has finished does it come from the HTTP cache (iOS 26.5
  Safari: the wasm twice in 4 of 11 cold loads on Wi-Fi, each time the runtime asked before the preload was done;
  Chromium hands it over). The published page starts its downloads with `fetch` in a head script instead
  (`web::page`, `fetches`).
- **A scroll view's smooth wheel and key scrolling is nsh's glide, which no browser call cancels**: `wheel` and the
  scroll keys are prevented and `scrollSmoothly` moves the view on animation frames, so an instant `scrollTo` lasted
  one frame and the glide's next one put its offset back (Chromium 141: a 900 px wheel notch, `scrollTo(0)` 50 ms
  later, then 778, 848, … 900). Commands stop the glide first (`stopGlide`) and `op_sb` moves it. A `scrollTo` to
  where the view already is, instant or smooth, sends neither `scroll` nor `scrollend` (Chromium 152): `stopGlide`
  sends the `onScrollEnd` of the scroll it stops then. Headless Chrome (141, 155) scrolls a wheel's delta at once by
  itself: the scroll that animates there is the glide.
- **Fractional scroll targets can move less than half a CSS pixel**: at DPR 2, Chromium rounds a target of 40.4
  to 40.5. A half-pixel stationary tolerance therefore ends the scroll early and duplicates `onScrollEnd`.
  `stopGlide` compares clamped offsets exactly; a quiet-period fallback covers targets rounded back to the
  current offset, for which the browser emits no `scrollend`.
- **A blocking `wheel` listener holds the page's scrolling only over the box of the element that has it**: a
  descendant shown in the top layer (a dialog over the window, `dialogs: "viewport"`) outside the root's box got
  `wheel` events that were not cancelable, and the page scrolled under it although the root's listener prevented
  them (headless Chrome 156: `cancelable: false`, `scrollY` 300 after a 300 px wheel). The layer has a blocking
  listener of its own (`raise`).

## Testing on simulators and emulators

- **A manual clock stands still while a finger holds**: it moves with the frames the app asks for, and a held finger
  asks for none, so a hold the app times itself (a `ContextMenu` on a touch screen) never came due on a real
  platform. The agent's long press moves the clock by the hold, as the headless driver's does.
- **iOS simulator: launch apps only after `simctl bootstatus -b`**; apps launched while the simulator boots are sent to the
  background when SpringBoard comes up.
- **Synthetic clicks on the Simulator / Catalyst windows go to whatever macOS window is on top at that point**: floating windows
  of other apps (e.g. a Slack huddle bar at window level 1001) silently swallow clicks over a band of the app. When a tap does
  nothing, list the windows at the point (`CGWindowListCopyWindowInfo`) before suspecting hit testing.
- **Not supported / not verifiable here**: keeping left and right unswapped right to left (left / right always swap right to left);
  after switching direction at runtime UIKit keeps an existing back button's chevron; Android has no skew transforms
  (as in React Native); Android's stylus handwriting mode (on by default on recent
  emulators) intercepts taps on inputs — turn it off with `adb shell settings put secure stylus_handwriting_enabled 0`.
