# Elements and interaction

Every tag is a component in scope (`native-pipeline.md`): the primitives `View`, `Text`, `Scroll`, `Overlay`, `Image`,
`List`, `Canvas`, `WebView` and `Video` from `nsh`, `Input`, `Dialog` (and `NavStack` / `NavPage`) from `nsh/base`,
`InputAccessoryView` from `nsh/mobile`; only `If` and `Each` are globals.

| JSX | Native (Apple) | Notes |
|---|---|---|
| `<View>` | `NshView` (UIView) | `onPress` / `onLongPress` / `onPressDown` / `onPressUp`, `activeStyle` / `hoverStyle` / `focusStyle` / `disabledStyle`, `pan={{x, y}}` + `onPanStart` / `onPanEnd`, `pinch` / `rotation`; `desktop={{ windowDrag }}` (any element: pressing it drags the window; the platforms decide on the main thread from `ViewProps::window_drag`, the nearest view that sets it decides, inputs and views with press / touch handlers nearer than it stay clickable; `nsh/desktop`) |
| `<Text>` | `TextView` (CTFrame) | nested `<Text>` is a span, other elements are inline attachments ([text.md](text.md)); the style keys `numberOfLines` and `textOverflow`, `allowFontScaling`, `maxFontSizeMultiplier`, `adjustsFontSizeToFit` + `minimumFontScale`, the style key `userSelect` (range selection) + `selectionColor` (`selection:text-*`), `onTextLayout` |
| `<Image src>` | UIView + image CALayer | `src` is a URL or `import img from "./a.png"` (an asset descriptor with its size); the `objectFit` style (`object-*`); `placeholder` (a URL or an asset, shown until the image loads), `blurRadius`, `fadeDuration`; `onLoadStart` / `onProgress` (`loaded` / `total` bytes) / `onLoad` (the source's pixel size) / `onError` / `onLoadEnd`; `tintColor`; animated GIF / WebP / APNG; `Image.getSize(src)` / `Image.prefetch(src)` |
| `<Scroll>` | UIScrollView | `horizontal`, `contentStyle` / `contentClass`, `refreshing` + `onRefresh` (with `refreshIndicator` + `pullValue` for an indicator of the app's own), `scrollValue`, `onScrollEnd`, `keyboardDismissMode`, zooming, see [scrolling-and-lists.md](scrolling-and-lists.md) |
| `<Canvas draw>` | `CanvasView` (drawRect replay) | see [canvas.md](canvas.md) |
| `<List each>` | UIScrollView + recycled cells | see [scrolling-and-lists.md](scrolling-and-lists.md) |
| `<Input>` | UITextField / UITextView in a container | `value` / `defaultValue` / `onChange` / `onSubmit` / `onFocus` / `onBlur`, `placeholder` (its color: the `placeholderColor` style key, `placeholder:text-*`), `masked`, `keyboardType` (React Native's values: `number-pad` digits only, `decimal-pad`, `numeric` = iOS's decimal pad / Android's signed decimal, `numbers-and-punctuation` = iOS's numbers and punctuation / Android's signed decimal, `email-address`, `phone-pad`, `url`), `ios={{ keyboardAppearance }}` (`default` / `light` / `dark`; Android's keyboards follow the system theme), `returnKeyType`, `autoCapitalize`, `autoCorrect`, `multiline`, `maxLength`, `readonly`, `autoFocus`, the `selectionColor` style key (`selection:text-*`), `submitBehavior` (`submit` / `blurAndSubmit` / `newline`, resolved with `multiline` by `InputConfig::submit()`, which is all platforms read; a multiline input that submits takes no line break from return, but does from Shift / Option / Alt+Return on hardware keyboards, and a return that commits an IME composition never submits), `selectedRange` + `onSelectionChange` (UTF-16 `start` / `end`), `onCaretMove` (where the caret is: `bounds` in the input, `pageBounds` in the root view; "Caret" below), `onPaste` + `pasteBehavior` (what was pasted, and whether the input inserts its text; "Paste" below), `onKeyPress` (`key`: the text, `Backspace`, `Enter`), `onCompositionChange` (`composing`, `text`: an input method's composition as it starts, changes and ends, its end after the `onChange` of the committed text; each platform tracks the composition natively and holds a `value` the app sets during one until it ends, since setting the text would end it and commit the text being composed), `autoComplete` (autofill; `ios={{ textContentType }}` for iOS's names), `caret` (`false` hides the caret), `onContentSizeChange` (the value's size, for growing inputs: reported by the core after any layout that follows a change of the text or the content width, one empty line's for an empty input though it is sized by its placeholder); ref `setSelection(start, end)` |
| `<NavStack>` / `<NavPage>` | UINavigationController | `createNavStack(routes)`: `push` / `pop` / `popToRoot` / `replace` / `setRoutes` / `remove`; pages keep their state while stacked; on iOS and Android the system header (content below the header UIKit shows: the platform measures it, `Core::set_screen_header`; `title`, `headerLeft` / `headerRight` / `headerTitle` elements, `headerTransparent`, `headerVisible`, `headerBackVisible`, `headerLargeTitle`, `headerBackTitle`, colors from `headerStyle` / `headerClass`, in Rust `header_style_with(|s| ..)`: typed styles in `headerClass`'s place); on the desktops and the web the page's `header` slot (the app's element, which the core places at the top of the page, full width, with the content below it; NSH draws nothing else there); swipe back (`popOnSwipe`: the interactive gesture only); `statusBar` (below); `popOnBack={false}` keeps the user on a page (no swipe; the back buttons and keys send `onBackPress` instead of popping); `onBackPress` is sent on every back press while the app listens; `onDismiss` after the user popped it |
| `<Dialog>` | presented UIViewController | `open` (default true), `animation`, `onOpen`, `onClose`, `onCancel` (every close attempt), `onOpenChange(open, reason)` (`"cancel"` / `"backdropPress"` / `"swipe"`); `closeOnEscape` / `closeOnBackdropPress` / `closeOnSwipe` (default true; iOS sheets swipe away, Escape and Android back close natively, then `onCancel` + `onOpenChange(false, reason)` + `onClose`; the renderer keeps a removed dialog's `onClose` until the platform reports it, `dom.rs` `dismissed`); `class` / `style` style the popup (the view holding the children), `backdropClass` / `backdropStyle` add a backdrop part behind it (none otherwise) whose presses are close attempts; `presentation` (iOS: `fullScreen` over a clear background, `pageSheet` / `formSheet` keep the system's sheet background; ignored on Android, the desktops and the web, where a dialog is a transparent layer over the whole window); `statusBar` (below); `ios={{ supportedOrientations }}`, `android={{ statusBarTranslucent }}` (otherwise the content starts below the status bar) |
| `<Overlay>` | a `NshView` in the root view (the surface's, or the dialog's around it) | its children on top of that root view, outside the parent's layout and clipping; `anchor` (a ref, `{ x, y }` or `{ origin, size }`), `placement`, `align`, `offset`, `margin`, `onPosition`, `onPressOutside`, `onCancel` ("Overlays" below) |
| `<InputAccessoryView>` | a NshView set as `inputAccessoryView` | `nativeID`; inputs name it with `ios={{ inputAccessoryViewID }}`. A layout root as wide as the window and as tall as its content; the core resolves the id (`InputConfig::accessory`). Renders nothing on Android |
| `<WebView>` | WKWebView (WebKit loaded on first use) | `src` (a URL) or `html` (inline HTML, shown instead of `src`) + `baseUrl`, `injectedJavaScript(BeforeContentLoaded)`, `onMessage` (pages call `window.nsh.postMessage`), `onLoad*`, `onNavigationStateChange`; ref: `reload()`, `goBack()`, `goForward()`, `postMessage(data)`, `injectJavaScript(js)` |
| `nativeComponent` (`nsh`'s `nativeComponent`) | a `NshView` box filled by the registered component's view; own props may be bound to animated values | see [embedding.md](embedding.md) |
| `<Video>` | AVPlayerLayer / AVPlayerViewController (AVFoundation loaded on first use) | `src` (a URL), `paused`, `muted`, `volume`, `rate`, `repeat`, the `objectFit` style (`object-*`), `controls`, `onLoad` / `onProgress` / `onEnd` / `onBuffer` / `onError`; ref: `seek(seconds)` |

On Android the same elements map to `Box` (ViewGroup), `TextBox`, `ImageBox`, `ScrollBox` (ScrollView), `InputBox` (EditText),
`StackBox` (pages with a Toolbar, predictive back), `ModalHost` (a Dialog), `WebBox` (android.webkit.WebView) and `VideoBox`
(MediaPlayer on a TextureView, MediaController); both are `WidgetBox`es. Every host element and `nsh/base` component is typed in
`.nsh/types/nsh/types.d.ts` and the declarations of the runtime's modules and `nsh/base` (made from the Rust tables: `tooling.md`).

**Host props are one definition.** A host prop is a variant of `nsh_core::Prop` (or of the enum it nests: `ScrollProp`,
`NativeProp`, `AccessibilityProp`, ...) with `#[prop(js = "name", ...)]`: `#[derive(HostProps)]` (`nsh_core::js::host`)
derives from it how `nsh-js` decodes the JS value (straight from QuickJS values, no JSON), the default clearing the
prop sets (`HostProps::reset`, also used when a Rust component's render stops setting it) and its declaration: one
interface per element group and platform (`InputHostProps`, `IOSInputHostProps`, ...) that the element types of
`types.d.ts` and `nsh/base`'s components extend. The payload's type decodes itself (`HostValue`;
`#[derive(PropEnum)]` for string unions); `default`, `min` / `max`, `on` (the element groups), `ios` / `android`
(names inside `ios={{…}}` / `android={{…}}`), `with` (a decoder of the whole variant, `js/host_values.rs`), `once`
(not reset) and `internal` (set by the runtime, untyped) cover the rest. **Events** are a table next to it
(`host::EVENTS`): the event, the element groups whose props declare it and its handler's type, one row per payload
(`onLoad` gives an image its size and a video its duration); the handlers join the same interfaces. An event no
element declares (the root's, the runtime's own) is listed in `INTERNAL_EVENTS`; a test checks every `EventKind` is
in one of them.

The iOS host prop `backdropMaterial` selects the system material of a `backdropFilter` blur:
`ultraThin` (default), `thin`, `regular`, `thick`, or `chrome`. Rust uses
`.backdrop_material(BackdropMaterial::Regular)`. The core keeps the prop separately from the style and
projects it into `ViewStyle::backdrop_material` when mounting, as it does Android elevation.

## Primitives only

NSH's runtime provides the primitives and the capabilities; the look of an app is the app's. Styled components are
the app's own: drawn in TSX with views, classes, canvases and native animations, or Rust components in the app's crate
(its UI set, `docs/dev/components.md`), so they look the same on every platform. Do not add platform-styled widgets
(UISwitch / SeekBar wrappers and the like), and do not add styled widgets or compositions of existing primitives to
the runtime (buttons, section lists, touchables, drawers, ...). React Native is a reference for which capabilities
exist, not an API to be compatible with. Components that need core or native support are primitives of their own
(`List`, `Canvas`, `WebView`, `Video`, `Overlay`; in
`nsh/base` `Input`, `NavStack`, `Dialog`; `InputAccessoryView` in `nsh/mobile`). Tags are PascalCase names
of what is in scope: a host element's primitive is imported from its home (`import { View } from "nsh"`) and compiled
in place, a component is imported (`import { Chart } from "app/native"`) or local; lowercase tags are errors
(`native-pipeline.md`).

## The main thread never waits for JS

Some callbacks are questions the system wants answered on the spot (may this
text change, may the back button pop, may the sheet close, may this gesture begin, may the web view navigate): they are
answered natively from props mounted beforehand, never by asking JS (blocking the main thread drops frames, can deadlock
and reorders fast input). Events tell JS afterwards. Existing answers: input `maxLength` (`shouldChangeCharactersIn`,
`InputFilter`), `submitBehavior` (`textFieldShouldReturn`, `textView:shouldChangeTextInRange:`, Android's `OnEditorActionListener` and input connection, AppKit's `doCommandBySelector:`), `popOnSwipe` / `popOnBack` (`gestureRecognizerShouldBegin`,
`navigationBar:shouldPopItem:`, Android `wantsBack()`: the `OnBackInvokedCallback` registration, or, where the window dispatches the back key instead (below 13, `enableOnBackInvokedCallback` off), taking the key in `NshView`'s unhandled key listener, before the activity's `onBackPressed`), `closeOnEscape` / `closeOnBackdropPress` / `closeOnSwipe`
(`presentationControllerShouldDismiss`, the dialog's back), `pan` / `pinch` / `hitSlop` / the `pointerEvents` style /
`keyboardShouldPersistTaps` / `panActivation` (recognizers), capabilities (`decidePolicyForNavigationAction`, `shouldOverrideUrlLoading`),
`AlertDialog`'s `closeOnEscape` / `closeOnBackdropPress`. A new capability with such a callback gets a prop (a menu's items, a rule, a flag); what a prop cannot
express is let through and corrected in the event afterwards (a controlled `value` in `onChange`). `BackHandler` is
of that kind: with a listener the press is taken, and JS exits the app when no listener handles it.

One exception, bounded: on macOS a window resize waits up to 16 ms for the engine's layout at the new size, so the
window never grows around stale content (AppKit's zoom animation would otherwise show none of it); an engine that
misses the deadline is not waited for again until it catches up (`docs/dev/macos.md`, Architecture).

## Interaction and the environment

- **State styles** (native, no JS round trip): `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle`,
  `checkedStyle`, `indeterminateStyle` (and a `Button`'s `selectedStyle`) on any view (declared in `StateStyleProps`),
  the same as the `active:` / `hover:` / `focus:` / `disabled:` / `selected:` / `checked:` / `indeterminate:` classes:
  the core restyles the view while the platform reports it pressed, hovered or focused, and while its accessibility
  state is selected, checked or mixed; a Rust component's touch responder stays pressed from its grant until its
  touches end, wherever they go (CSS's `:active` until the button is released: a resize handle dragged off its band
  keeps its `group-active:` look; `Core::hold_pressed`); later
  states win, `disabled` over all (`docs/dev/styles.md`). Press feedback is the app's: the platforms add no fade or
  underlay of their own. Background colors that would be hidden by a gradient replace it (`docs/dev/styles.md`,
  Effects). Safe areas and the keyboard are CSS environment variables in padding and margin
  (`env(safe-area-inset-top)`, `env(keyboard-inset-height)`, `docs/dev/styles.md` "Environment variables"); a view
  with `selectable` makes its texts select together (`text.md` "Selectable views").
- **Platform modules**: `platform` (`nsh`'s environment, a constant: `os`: `ios` / `android` / `macos` / `windows` / `linux` / `web`, from the platform's
  `Environment::os` (`nsh_engine::Os`; the default is the build's mobile OS, so `nsh test` is iOS); `version` (a string,
  Android's API level), `idiom` (`phone` / `pad` / `mac` / `tv` / `desktop`), `catalyst`, `renderer` (`native` / `web` / `terminal`, from `Environment::renderer`), `isTerminal`, `select` (terminals: `terminal`, OS, `native`, `default`; graphical surfaces: the OS, then `mobile` / `desktop`, `native` (not on the web), `default`); `desktop` and `desktop={{…}}` follow `Environment::desktop()`: a graphical desktop OS, or the web in the desktop idiom), `pixelRatio()` (an accessor: the window moving to another screen writes it), `nsh`'s
  `announce(message)` and `setAccessibilityFocus(ref)` (Rust, the node passed as `{ $node: id }`), reactive `screenReaderEnabled()` / `reduceMotion()`. The environment carries `pixelRatio`,
  `screenReader`, `osVersion` and `idiom` (VoiceOver / TalkBack changes are observed natively).
- **`disabled`** on any element applies `disabled:` classes and removes its press and `onContextMenu` listeners from what
  is mounted (no press, no feedback; a secondary click goes on to the nearest enabled listener around it).
- **`onMouseMove`** (any element; macOS, Linux, Windows, GPUI and web) reports actual mouse movement,
  including with a button down. Each listening view under the pointer hears `{ x, y }` in its own coordinates
  (points), innermost out. Rust's `.on_mouse_move` receives `Point<Points>`. The engine retains the latest move
  per view per frame and flushes it before later non-motion events. Content updates and scrolling re-pick hover
  state independently; they do not synthesize mouse motion. Touch and pen movement use the touch APIs.
- **`onHoverIn` / `onHoverOut` / `onHoverMove`** (any element) tell JS, after the fact, that the mouse came over a view,
  left it, or moved over it with no button down. On the desktops they follow the same hover tracking as `hover:`
  classes: the views along the chain under the mouse (innermost first) whose classes read `HOVERED` or that listen to
  any of the three are the hovered ones, so ancestors hear `onHoverIn` too, as with CSS `:hover` and the DOM's
  `pointerenter`; a handler alone makes its view take part (`input.rs` `hoverable`, the view's mounted event mask), and
  a view that does not listen gets no event. When the set changes, the views left hear `onHoverOut` from the inside
  out, then the views entered `onHoverIn` from the outside in; then each hovered view with `onHoverMove` hears where
  the mouse is (`EventPayload::Hover`, JS `{ position, pagePosition, modifiers }`: the `Point` in the view, its transforms undone,
  the `Point` in the root view as touches have it, the modifier keys as GPUI's `Modifiers`). A modifier key pressed or
  released while the mouse rests is a move to where it is with the new modifiers, so a view hears Control or Command
  come and go under a still mouse (an `Editor`'s definition link): Linux from the root's key events, macOS from a
  local `flagsChanged` monitor (installed once a view hears hover moves), Windows from the modifiers' `WM_KEYDOWN` /
  `WM_KEYUP`, GPUI from `on_modifiers_changed`, the web from `keydown` / `keyup` of `Control`, `Alt`, `Shift` and
  `Meta` (`nsh.js` `modifiersChanged`). The mouse leaving the window (while no button is down on
  macOS) unhovers everything; on macOS and GPUI hover is picked again after every batch (on macOS also after every
  scroll), so a view removed or moved from under a still mouse hears `onHoverOut` and one that arrives there
  `onHoverIn`; on Linux and Windows that waits for the next mouse move. Moves with a button down are touches
  (`onTouchMove`, the responder), not hovers, and touches never hover. The web uses the browser's `pointerenter` /
  `pointerleave` / `pointermove` of mice (`nsh.js` `installHover`); iOS a `UIHoverGestureRecognizer` per view (iPad
  pointers, Mac Catalyst's mouse), Android the view's hover listener (mice, styluses): there each view is tracked by
  the system, not along a chain. The engine merges moves (`State::hover_moves`): the latest per view, delivered at most
  once per `HOVER_MOVE_INTERVAL` (8 ms) and always before the next other event, so a view hears where the mouse went
  before it hears it leave; mice report up to 1000 moves a second, and a crosshair needs one per frame.
- **`onContextMenu`** (any element): the secondary button was pressed over a view (a right click; Control-click on
  macOS, in GPUI on macOS too; the browser's `contextmenu`, which its keyboard menu key raises too). The platform
  decides on the main thread from the mounted event masks, walking out from the view under the pointer: the first
  view that listens hears it (`EventPayload::ContextMenu`, the same shape: `position` in it, `pagePosition` in its
  root view, which is where `Menu.popup` takes its point, and the `modifiers`); a text field nearer, or selectable
  text with an edit menu of its own (Windows, GPUI, the web), shows that menu instead and the app hears nothing.
  JS cannot cancel the system's menu after the fact (the main thread never waits for JS), so the rule is what is
  mounted. iOS: a `UITapGestureRecognizer` for the secondary button per listening view (iPad pointers, Mac
  Catalyst's mouse). On touchscreens a menu belongs on `onLongPress`; Android raises `onContextMenu` for no input yet.
- **Keyboard focus**: on macOS and the web, Tab (the keyboard focus) moves between stops, in tree order; a click
  presses without focusing, so a stop's `FOCUSED` state (`focus:` classes, `.focus(..)`) is keyboard focus, and
  `focus-visible:` is the same variant. Focus and presses are separate: `ViewProps::focus_stop` decides, from
  `focusable` (`Prop::Focusable`, `ViewProps::focusable`; Rust `.focusable(..)`) and whether the view takes presses,
  as used by macOS `input::is_key_stop`, the web's `updateFocusable` and the headless driver's
  `Screen::tab_stops`. The terminal and GPUI backends honor the same explicit view opt-in while retaining their
  native controls, selectable text, scroll stops and popup scope rules. Native components still need their
  own focus capability; an explicit view opt-in does not invent a native focus handle. Unset, views that take
  presses are stops.
  `focusable={true}` makes any view one, whether or not it takes presses: a component that takes keys while focused (a
  chart, a slider, a list that moves its selection) sets it on a view that takes no presses, so a pressable around it
  (a card that opens a page) keeps its presses; it must not listen to `onPress` just to be focusable, which would
  swallow them. `focusable={false}` keeps a pressable out: a backdrop that closes a popover, rows a list moves between
  with the arrow keys. A disabled view is never a stop. Inputs are stops by default; terminal and GPUI also honor
  `focusable={false}` on inputs. A stop hears `onFocus` /
  `onBlur` (`EventKind::Focus` / `Blur`, as inputs do) when the keyboard focus reaches and leaves it: AppKit's first
  responder, the browser's `:focus-visible`; the headless driver's Tab moves it the same way there. Return and Space
  press the focused stop only when it takes presses; a stop that takes none hears its keys through the keymap (`on_key`
  / `on_key_with`, bound while it is focused, as `DataTable`'s controller does), Return and Space included.
  (`focusable={true}` on a view that takes no presses made nothing focusable before 2026-10-26; with no release
  recorded, it now means what React Native's `focusable` and the web's `tabIndex={0}` mean.) Windows and Linux
  move the focus between fields and native components only so far; iOS and Android move it between inputs.
  A ref's `focus()` on a stop moves the keyboard focus to it as Tab does (`focus:`, `onFocus`; a popup gives it back to
  its trigger), and `blur()` takes it off: `Command::Focus` / `Blur` reach the platforms for any view, and AppKit makes
  the view first responder (`input::focus_control`, past a field that edits), the browser focuses the element with
  `focusVisible` and treats it as keyboard focus whatever its heuristics say after a click (`focusPressable`), the
  headless driver moves its focus (`focus_calls`); on a view that is not a stop it does nothing. Windows, Linux and
  GPUI leave `focus()` on views to them; iOS and Android focus inputs only.
- **`onPanEnd` / `onPanStart`** carry `valueX` / `valueY`: the bound pan values at that moment (a drag may grab a value mid
  animation), for snapping.
- **Imperative calls**: nodes have `focus()`, `blur()` (inputs, and views that take presses where they are stops of
  the keyboard focus: "Keyboard focus" above) and `scrollTo({ x, y, animated })` (use `ref`); lists also
  `scrollToIndex({ index, viewPosition, viewOffset, animated })`, `scrollToEnd()`, `scrollToOffset()`; `Keyboard.dismiss()` (`nsh`).
  Commands run after the commit's other mount items; list scrolls are resolved by the core with the current item sizes.
- **`measure()`** (on any node's ref) resolves, once the turn's changes are laid out, to `{ bounds, pagePosition }`
  or `null` (not in the tree, never shown). `bounds` is the frame in the parent, as
  `onLayout` reports it; `pagePosition` the top left corner in the root view the node is in: the surface, or the modal
  it is shown in (screens fill their stack, so a screen's views are in the surface's coordinates). Those are the
  coordinates of touches' `pageX` / `pageY`, so `e.pageX - m.pagePosition.x` is a touch's position in the measured view whatever
  view the finger went down on (`locationX` is relative to that one). The core answers it from its layout
  (`Command::Measure`, `Core::measure`: the frames it mounted, summed up the tree), never by asking the platform: the
  scroll views and lists around subtract their content offsets (as the platforms last reported them, `set_scroll_offset`)
  and apply their zoom scales; transforms, native animations included, are not applied, nor is the mirroring of
  right-to-left horizontal lists (scaleX −1). The answer settles the promise from the core's events
  (`JsEvent::Reply`), like a module call's (`nsh-js` `components.rs`). There is no `measureInWindow`: the root view is the window for a full-screen surface, and
  an embedding app knows where it put the surface.
- **Touch** (React Native semantics): the `pointerEvents` style key (`none` inherited as CSS's, `box-none` / `box-only`
  React Native's, for the view alone), `hitSlop`, `delayLongPress`, `android={{ ripple }}`
  (`{ color, borderless, radius, foreground }`, Android only); press-in waits ~130ms inside scroll views; only the innermost
  pressable view responds. Children placed outside their parent (`position: "absolute"`, `overflow` visible: a
  dropdown under its field) can be touched where they are drawn: UIKit and Android only look for a touch's target
  inside a view's bounds, so the core mounts, for each view whose descendants reach outside it, the area they cover
  (`MountItem::Overflow`, in the view's coordinates, from the layout frames, only when it changes; clipping views,
  scroll views, lists and stacks have none). `NshView`'s `hitTest` looks in its subviews when the point is outside its
  bounds (and hit slop) but in that area, and never returns the view itself there; Android's `Box` delivers the touch
  (and the rest of the gesture) to the child whose area holds it, which passes it on to its children only, and the touch
  tracker's hit test (`TouchTracker.deepest`) descends the same way. `pointerEvents` keeps its meaning (`box-only` and
  `none` views are not entered). Views whose children stay inside pay nothing; transforms that move a child out are
  not covered. What must show above everything whatever clips it (a popover, a menu) is an `<Overlay>` (below). Nested `<Text>` spans with press handlers
  are links: the core lists them in `AttributedText::links` (UTF-16 ranges) and the block's press recognizer routes a press to
  the span under the finger (CoreText `CTLineGetStringIndexForPosition` / `Layout.getOffsetForHorizontal`).
- **Raw touches and the responder system**: `onTouchStart/Move/End/Cancel` (+ `Capture`), `onStartShouldSetResponder`,
  `onMoveShouldSetResponder` (+ `Capture`), `onResponderGrant/Reject/Start/Move/End/Release/Terminate/TerminationRequest`, and
  `PanResponder.create` on top. A node with any of them listens to `onTouch` natively; one tracker per root view (surface,
  modals: `touch.rs`, `TouchTracker.java`) observes without recognizing and reports touches whose target or an ancestor
  listens, with the path of listening nodes (`EventPayload::Touch`, sent to the root; moves are merged per engine turn). The
  negotiation runs as in React Native, natively (`nsh-js` `touch.rs`), asking the app's handlers. A grant returning true
  (PanResponder's default) sends `SetJsResponder`: scroll
  views around stop taking the touches (UIKit: their pan recognizer is disabled; Android: `ScrollBox.jsBlocked`); a native
  scroll view that starts dragging first cancels the JS touches. The `…ShouldSetResponder` handlers also get a
  `gestureState` (`ResponderGestureState`: `dx`, `dy`, `vx`, `vy`, `moveX`, `moveY`, `x0`, `y0`, `numberActiveTouches`,
  since the first finger went down; `nsh_core::element::PanGesture`, the same the core gives Rust claims). Rust components'
  nodes on the path hear the same event first and negotiate their own responder in the core (`claim_touches`,
  `docs/dev/components.md`); the core sends both sides' blocks.
- **Pans that coexist with scroll views** (`panActivation={{ activeOffsetX, activeOffsetY, failOffsetX, failOffsetY }}`,
  react-native-gesture-handler's offsets; Rust: `TouchClaim::on_pan(PanActivation)`): a JS decision to claim a touch
  comes a turn late, when the scroll view may have taken it, and claiming on start blocks the scroll view from the
  first pixel. So the platform decides, on the main thread, from the mounted offsets (`ViewProps::pan_activation`,
  `PanActivation::decide`: a fail offset passed first fails, an active offset passed activates; no active offsets: 10
  points in any direction). iOS: a `PanGate` recognizer on the view (`touch.rs`); the pans of the scroll views around
  it must wait for it to fail (`shouldBeRequiredToFailByGestureRecognizer:`), so a vertical drag scrolls once it passes
  `failOffsetY` and a horizontal one never scrolls. Android: the root's `TouchTracker` decides on each move before the
  views below see it and, on activation, blocks the `ScrollBox`es around (`gateBlocked`) and disallows their
  interception; a scroll view that intercepts first (past its touch slop) wins as before. Web: `nsh.js` defers its
  drag scrolling while the gate is undecided. The activation travels with the touches (`TouchEvent::activated`; the
  iOS gate hands it to the root's tracker, which reports it with these touches or the next), and the gated view
  becomes the responder (its termination request is honored as for any claim). Its own `…ShouldSetResponder`
  handlers (and a Rust element's other claims) are never asked: the view is a responder exactly when its pan is
  active, so `PanResponder`'s `panHandlers` work unchanged next to the prop.
- **Accessibility**: `accessible`, `role`, `accessibilityLabel` / `Hint` / `State` / `Value` / `Actions` +
  `onAccessibilityAction`, `accessibilityElementsHidden`, `importantForAccessibility`, `accessibilityLiveRegion`, `testID`
  (Android: resource id). Views without a label read their texts. The props go as one `MountItem::ViewProps`, except
  a label changing alone on mounted props (one that follows app state: a count, a price), which goes as
  `MountItem::AccessibilityLabel`. The `increment` / `decrement` actions make an element adjustable whatever its
  role: iOS adds the adjustable trait to the traits of its role (`native_view.rs` `traits`), so VoiceOver's swipe up /
  down performs them (an `image`, `Plot`'s role, stays an image), Android offers scroll forward / backward, Windows
  makes its range value writable.
- **Frames**: `requestAnimationFrame` / `cancelAnimationFrame` follow the display (CADisplayLink / Choreographer).
- **Back button** (`nsh/mobile`): `BackHandler.onBackPress(listener)` (returns the function that removes it; a
  listener added while a component renders goes with it, as `keymap.bind`'s bindings do), after modals, the top
  overlay listening to `onCancel` and stacks; the app exits when nothing handles it. Rust components listen with `cx.on_back_press(..)`, before JS's listeners; the root wants
  the button while either side listens (`docs/dev/components.md`).
- **Keyboard shortcuts** (`nsh`'s `keymap`): the root's `Prop::Keymap` mounts the surface's whole table
  (`MountItem::Keymap`); the platform matches a key against it on the spot, consumes it and reports the root's
  `KeyCommand` (the binding's id), so the main thread never waits for JS (`docs/dev/js-modules.md`, the macOS and
  Linux pages' "Keyboard"). iOS and Android match a hardware keyboard's keys: iOS in `pressesBegan:` of its text
  inputs (before UIKit's text system) and of the root view (presses nothing inside handled), keys named by their HID
  usage (`Key::from_hid_usage`) and the character they type, a `repeat` binding firing on a timer of its own while
  the key is held (UIKit sends a held key's press once); Android in `NshView.dispatchKeyEvent` (before the focused
  view, after the input method) through `Native.keyDown` / `keyUp`, the table kept in Rust (`keymap.rs`), never
  encoded for Java. Both leave a composing input method its keys and consume a taken key's release too. Rust views' bindings (`on_key`) join JS's in that one table, and the core runs
  their handlers (`docs/dev/components.md`).
  Terminals resolve `mod` to Control on every host OS, and reserve Control+Q for quitting; graphical Apple
  backends keep Command. Rust components read the same renderer through `renderer()` / `is_terminal()`.
- **System UI**: the status bar follows UIKit, where the topmost view controller's `preferredStatusBarStyle` decides
  and Info.plist holds the default: a page's or dialog's `statusBar` (`{ foreground, hidden, animated }`, a host prop
  of screens and modals, `ScreenProp::StatusBar`, decoded to a `StatusBarSetting`; `Screen::status_bar` /
  `Modal::status_bar` in Rust) is one entry of the surface's layers while the node is in the tree, over the app's
  default (`nsh.json` `"statusBar"`: the bundler checks it and the entry's `setup` sends `Command::SetStatusBar`; a
  Rust app's `Root::status_bar`). The core layers them (`docs/dev/components.md`); iOS and Android apply the merged
  `Command::StatusBar`, the desktops and the web ignore it. `AlertDialog.show({ title, description, actions, presentation })`
  (`nsh/base`: a promise of the chosen action's `id`, its `label` without one, `null` when closed without an action;
  `presentation: "actionSheet"` is a list dialog on Android; every label is the app's: NSH adds no strings of its
  own, and an iPad / Mac action sheet gets an untitled cancel action). Answers come back as the
  root's `Dialog` event, which the core resolves. Embedding apps forward their controller's status bar to `nsh_status_bar_style()` / `_hidden()` / `_animation()`.
- **Right to left**: the user's language sets the root's direction (again at once when it changes);
  `direction` (`inherit` / `ltr` / `rtl`) overrides it per view. The core resolves each node's direction (inherited, also for
  subtrees built detached), sets taffy's `direction` (rows run from the right), keeps the left and right properties
  where they say (margins, paddings, insets, borders, corners, in classes and style keys alike, as in a browser) and
  places the logical ones (`marginStart`, `start`, `borderTopEndRadius`, `ms-*`, `start-*`, ...). A
  direction change sets the direction in place and restyles the nodes with logical properties or `rtl:` classes. Text:
  `auto`, `start` and `end` alignment follow the direction, `left` / `right` keep their side, `writingDirection` sets
  the base direction (else the content's). Native widgets mirror (`MountItem::LayoutDirection`:
  `semanticContentAttribute`, `View.setLayoutDirection`; Android apps need `android:supportsRtl`). Horizontal scroll views
  are laid out left to right and their children mirrored in the content by the core (a right-to-left row would overflow to
  negative offsets), starting at the right end and keeping their distance from it; horizontal lists are flipped natively
  (`ScrollConfig::mirrored`: the scroll view and each cell get scaleX −1, composed with their transforms), so the list's
  offset logic stays left to right.
- **Environment** (reactive accessors; `nsh` (`safeArea()`, `safeAreaInsets()`, `keyboardFrame()`)): `windowSize()`, `safeArea()`, `keyboardFrame()` (`{ height, duration }`: how
  far the keyboard reaches into the surface, the bottom safe area under it included, on every platform),
  `colorScheme()`, `fontScale()`. `padding-bottom: env(keyboard-inset-height)` pads a view by the keyboard's height, animated with the keyboard
  natively, for content outside scroll views (message bars). Inputs inside a scroll view are kept clear of the keyboard natively (bottom inset + scroll to the
  focused input), with no JS involved.
  Both move as one with the keyboard: `LayoutCurve::Keyboard` (`type: "keyboard"`) is the system keyboard's own curve,
  started when the keyboard started to move, however late the batch arrives. iOS takes the notification's curve (7, a
  spring UIKit has no name for) and moves the layers' new animations back to the notification's time (`beginTime`,
  `KeyboardMotion::aligned`), and runs the scroll view's inset and scroll in one animation of that curve; Android takes
  the IME's `WindowInsetsAnimation` (interpolator, duration, start; API 30+) and fast-forwards its animators to it
  (`Mounter.keyboardAligned`), the scroll to the input included.
- **Controlled inputs**: each native edit carries an edit count; a `value` from JS is applied only if it is based on the latest
  edit, so a slow JS round trip can never overwrite newer typing (React Native's eventCount).
  While an input method composes, a `value` is held natively and applied when the composition ends, if no edit came
  after it: setting a field's text ends its composition on every platform, so an app that uppercases or filters its
  value would otherwise commit the pinyin as typed (#170).
- **Completion edits**: on GPUI and terminal, `ref.replaceRange({ start, end, text, expectedText, expectedSelection })`
  replaces one UTF-16 range through the native editor, retaining its undo history and original caret in a single
  undo step. The focused editable input must still hold `expectedText` and the exact `{ start, end }` selection;
  a newer native edit or an active IME composition rejects the operation. Completion code waits for `onChange`,
  rather than replacing the whole controlled value itself. The replacement is literal, including multiline line breaks.
- **Caret**: `onCaretMove` reports where the caret is, for what opens at it (an `@` mention's suggestions):
  `bounds`, a `Bounds` in the input (its border box: padding, border and the input's own scrolling applied), as wide
  as the platform draws the caret and as tall as its line, at the selection's `end` (on Windows, GPUI and Linux,
  whose editors keep a caret inside a selection, at that caret: `start` for a selection made backwards); and
  `pageBounds`, the same in the root view, which the core adds (`Core::locate_caret`: the input's `measure()`
  position plus `bounds`, as of the event) and an `Overlay` takes as its `anchor`. It is reported while the input
  has the focus, whenever the caret moves: with the selection, and with the selection unchanged when the text scrolled
  (a text area's scroll view, the desktops' wheel) or was laid out again at another size (wrapped elsewhere). A page
  that scrolls under the input does not report it: `pageBounds` is where the caret was then. It is an event of its
  own rather than more of `onSelectionChange`'s payload: that event's payload and when it fires are kept as they
  shipped (`compatibility.md`). Each platform asks its editor: UIKit `caretRectForPosition:` (the shown caret's,
  even with `caret={false}`, through the input classes' `nshCaretRectForPosition:`), converted to the input's
  container; Android the EditText's `Layout` (`getPrimaryHorizontal`, the line's top and bottom, the total padding
  and scroll; Java reports `caretX` / `caretY` / `caretWidth` / `caretHeight`, which `Native.eventMap` folds
  into `bounds`); AppKit the editing text view's `firstRectForCharacterRange:` (the field editor while a field
  edits), from the screen to the input view; GTK `gtk_text_compute_cursor_extents` and
  `gtk_text_view_get_cursor_locations`; Windows and GPUI their own editors' caret (`caret_rect`); the web a hidden
  copy of the field (its font, box and wrapping) holding the text up to the caret; `nsh test` the headless model of
  `ApproxTextEngine` (characters `0.55 ×` the font size, lines `1.2 ×`). Empty `bounds` mean the platform
  could not place it (no layout yet). Rust: `on_caret_move` with a `CaretEvent`, and
  `overlay().anchor_bounds(...)`.

- **Paste**: `onPaste` reports what the user pasted (`EventPayload::Paste`, `PasteEvent`): `text`, `html` (the clipboard's `text/html`, read on Linux, UTF-8 or UTF-16 as Firefox
  writes it, and on the web; `RichEditor` parses it into its schema), `files` (data on
  the clipboard, images: `PastedFile`s whose bytes become JS `File`s in `nsh-js` `payload_object`, never a JS string
  or base64) and `uris` (local files' `file:` URLs, as `onFileDrop`'s). The platform reads the clipboard in the
  paste's own handler, on the user's paste only, and only when the app listens. Whether the input inserts the text is
  answered at once from `pasteBehavior` (`InputConfig::paste_behavior`: `"insert"`, the default, or `"report"`);
  images and files are never inserted. The event comes before the `onChangeText` of the text it inserts (Linux:
  after, GTK reads clipboards asynchronously). Where Paste is offered, it is offered for images and files too while
  the app listens. iOS: `Field` / `Area` override `paste:` (`system::pasted`: strings, `IMAGE_TYPES` data else
  `UIImage` PNGs, file URLs) and `canPerformAction:withSender:`; Android: `setOnReceiveContentListener` (API 31;
  the clipboard and keyboards' rich content; images read from their content URIs, through `Native.paste`; the text
  goes back to the EditText while it inserts) and `onTextContextMenuItem` before; macOS: `TextArea` and a field
  editor of NSH's (`FieldEditor`, from `FieldCell`'s `fieldEditorForView:`, one per window; masked fields keep
  AppKit's) override `paste:` / `pasteAsPlainText:` and `validateUserInterfaceItem:`; Windows and GPUI: their own
  editors' paste (the clipboard's PNG or bitmap, `CF_HDROP`; GPUI's `ClipboardEntry::Image` / `ExternalPaths`);
  Linux: the `paste-clipboard` signal (stopped for `"report"`); web: the field's `paste` event (`preventDefault` for
  `"report"`; `clipboardData.files`' bytes handed to `nsh_paste` with a JSON header). `nsh test`'s
  `app.paste(selector, { text, html, files, uris })` pastes as the user does (files are paths whose bytes are read):
  headless, and on macOS and iOS through a pasteboard of the test's own (`TestStep::Paste`), the machine's
  clipboard untouched. `onPaste` is kind 64: `EventMask` has two words.

Text, styles, scrolling and lists, animation, canvases and images have their own pages.

## Overlays

A callback-free tooltip with custom placement and native keyboard focus can use the existing overlay directly:
`tooltip={<Overlay hintDelay={0} hintOnFocus placement="left" pointerEvents="none">…</Overlay>}`.
`hintDelay` is milliseconds; `hintOnFocus` also presents it while the anchor owns native keyboard focus. The same
hint owns pointer and focus presentation, without app hover/focus listeners or controlled tooltip state.


`<Overlay>` (`nsh`; Rust `overlay()`) shows its children on top of the root view it is in: the surface, or the
dialog around it (`Modal`). It is the one mechanism popups are built on (`nsh/base`'s `Popover`, `Menu`,
`ContextMenu`, `Tooltip`, `Sheet`: `components.md`); it draws nothing and closes nothing itself.

- **Where it stays and where it shows** (`core/overlay.rs`): the node stays its parent's child for everything but its
  native view: the reactive owner and context, inherited text styles, events and its lifetime (released with the
  parent's subtree, hidden while a view around it is out of the tree, not made natively or `display: none`). Its
  native view is a plain view (`ViewKind::View`), inserted into the root view by the core, above that root view's own
  children (`native_before` puts them below the first overlay) and the overlays shown before it: one shown later is on
  top (nested overlays above the ones around them). Each commit `sync_overlays` works out which overlays are shown and
  where, and moves their views (`Insert` / `Remove`), so the platforms need nothing of their own: they draw and
  hit-test it as any view of the root, with the views' own z order.
- **Layout**: a layout root of its own, laid out in a box the size of its root view (`position: fixed`: its insets,
  size and margins are against that box; `inset-0` covers the root view). With `anchor` (a ref of a view,
  `{ x, y }` in the root view's coordinates, touches' `pageX` / `pageY`, or a `Bounds` there, an input's
  caret, `onCaretMove`'s `pageBounds`: `OverlayAnchor::Bounds`) the core places it on a side of the anchor's
  frame (`nsh_core::overlay::place`): `placement` (`"top"`, `"bottom"` (default), `"left"`, `"right"`), on the other
  side when only that one has room, the side with more room when neither has; `align` along it (`"start"`,
  `"center"` (default), `"end"`; start and end follow the direction above and below); `offset` from the anchor; then
  moved along the side to stay inside the root view's safe area less `margin`. The anchor's frame is
  `Core::measure`'s (scroll offsets and zoom applied, transforms not), so the overlay follows it as it scrolls and moves:
  `place_overlays` places anchored overlays again at the end of every commit (after the lists and the scroll offsets
  the platform reported). `onPosition` reports where it went (`placement`, the frame as `bounds`, `available`:
  the room on that side, what a menu may grow to). A view inside an overlay measures in the root
  view's coordinates.
- **Dismissal is reported, never decided**: `onPressOutside` (a finger or button went down outside the overlay, its
  anchor and the overlays inside it: while an overlay listens, the shown overlays, its anchor and root view listen to
  touches, and the core reads each touch's path, `overlay_touches`); `onCancel` (Escape, the Android back button or
  VoiceOver's escape gesture on iOS (`RootView`'s `accessibilityPerformEscape`, as the back button), to the top
  overlay listening only: the core binds Escape in the root's table, `overlay::ESCAPE_BINDING`, and takes
  the back button before the views' and JS's listeners). Whether to close is the app's or `nsh/base`'s.
- **Hints (tooltips)**: an overlay with `OverlayConfig::hint` (Rust `overlay().hint(delay)`, `OverlayProp::Hint`; no
  JS prop) is shown by the core, as GPUI's tooltips are. While it is in the view on a desktop (the environment's idiom),
  its anchor (its parent, the nearest node with a layout, when it has none) listens to `onHoverIn` / `onHoverOut` and
  touches (`Node::overlay_watched`'s `watch::HINT` bit, mounted with the events JS asked for, hover also while the view
  is disabled). `onHoverIn` starts a task of the components' executor (`act_after`, `Action::Hint`) that wakes the
  engine after the delay; then the hint shows in the commit (`sync_overlays` leaves a hint the pointer has not asked
  for out of its root view). `onHoverOut`, a touch down whose path holds the anchor, or the hint leaving the view hide
  it. The overlay hears what the pointer asks for (`Show`, `Dismiss`: `on_hint_show` / `on_hint_hide`), and
  `OverlayConfig::open` (`hint_open`) decides instead when its owner does (`nsh/base`'s `Tooltip`, whose own state
  is controlled or not). Touch screens never watch: a hint shows there only when `open` says so. The overlay should
  not take the pointer (`pointerEvents: "none"`).
- **`tooltip`** (every element; `Prop::Tooltip`, `TooltipContent`; Rust `Interactive::tooltip`): the core makes a hint
  overlay inside the element itself (`Core::set_tooltip`, odd ids, inserted directly so a component host's children
  placement never moves it), placed on top with a 4 pt gap, holding the element JS made (retained by the node, moved
  into the overlay, detached again when the prop changes). The prop takes elements only: the core draws no bubble, the
  look is the app's. An element that is a hint overlay itself (`nsh/base`'s `Tooltip`, once its view
  made its root one) replaces the core's overlay, with its own placement, delay, look and events
  (`adopt_hint_tooltips`, each commit before the overlays are shown). Released with the element. It counts for nothing else: text skips overlays, and
  positional classes (`first:`, `last:`) skip a tooltip's overlay. Rust's element tooltips are an overlay child of the
  element (`IntoTooltip for AnyElement`), `nsh_base`'s `TooltipElement` the hint overlay itself.
- **Limits**: one surface (no window of its own); an overlay in a `HeaderItem` or `InputAccessoryView` shows in the
  surface's root view while its anchor is measured in the header's; an anchor in another root view than the overlay's
  is measured in its own. A dialog's native Escape and back handling comes before the overlays inside it.
