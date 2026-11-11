# Elements and interaction

Every tag is a component in scope (`native-pipeline.md`): the primitives `View`, `Text`, `Scroll`, `Input`, `Overlay`, `Image`,
`List`, `Canvas`, `Shader`, `WebView` and `Video` from `nsh`, `Dialog` (and `NavStack` / `NavPage`) from `nsh/base`,
`InputAccessoryView` from `nsh/mobile`; only `If` and `Each` are globals.

| JSX | Native (Apple) | Notes |
|---|---|---|
| `<View>` | `NshView` (UIView) | `onPress` / `onLongPress` / `onPressDown` / `onPressUp`, `activeStyle` / `hoverStyle` / `focusStyle` / `disabledStyle`, `pan={{x, y}}` + `onPanStart` / `onPanEnd`, `pinch` / `rotation`; `desktop={{ windowDrag }}` (any element: pressing it drags the window; the platforms decide on the main thread from `ViewProps::window_drag`, the nearest view that sets it decides, inputs and views with press / touch handlers nearer than it stay clickable; `nsh/desktop`); `web={{ element }}` (any view or text: the HTML element the web draws it as where `role` cannot say it, `ViewProps::web_element`; headings come from `role="header"` and its level, links from `Link`'s `href`; the other platforms ignore it; [web.md](web.md) "Document elements") |
| `<Text>` | `TextView` (CTFrame) | nested `<Text>` is a span, other elements are inline attachments ([text.md](text.md)); the style keys `numberOfLines` and `textOverflow`, `allowFontScaling`, `maxFontSizeMultiplier`, `adjustsFontSizeToFit` + `minimumFontScale`, the style key `userSelect` (range selection) + `selectionColor` (`selection:text-*`), `onTextLayout` |
| `<Image src>` | UIView + image CALayer | `src` is a URL or `import img from "./a.png"` (an asset descriptor with its size); the `objectFit` style (`object-*`); `placeholder` (a URL or an asset, shown until the image loads), `blurRadius`, `fadeDuration`; `onLoadStart` / `onProgress` (`loaded` / `total` bytes) / `onLoad` (the source's pixel size) / `onError` / `onLoadEnd`; `tintColor`; animated GIF / WebP / APNG; `Image.getSize(src)` / `Image.prefetch(src)` |
| `<Scroll>` | UIScrollView | `horizontal`, `contentStyle` / `contentClass`, `refreshing` + `onRefresh` (with `refreshIndicator` + `pullValue` for an indicator of the app's own), `scrollValue`, `onScrollEnd`, `keyboardDismissMode`, zooming, see [scrolling-and-lists.md](scrolling-and-lists.md) |
| `<Canvas draw>` | `CanvasView` (drawRect replay) | see [canvas.md](canvas.md) |
| `<Shader source>` | `NshView` + a sublayer with the rendered frame | a WGSL `shade(uv)` drawn under the children; `uniforms`, `paused`; see [shaders.md](shaders.md) |
| `<List each>` | UIScrollView + recycled cells | see [scrolling-and-lists.md](scrolling-and-lists.md) |
| `<Input>` | UITextField / UITextView in a container | `value` / `defaultValue` / `onChange` (`{ value }`) / `onSubmit` / `onFocus` / `onBlur`, `placeholder` (its color: the `placeholderColor` style key, `placeholder:text-*`), `masked`, `keyboardType` (React Native's values: `number-pad` digits only, `decimal-pad`, `numeric` = iOS's decimal pad / Android's signed decimal, `numbers-and-punctuation` = iOS's numbers and punctuation / Android's signed decimal, `email-address`, `phone-pad`, `url`), `ios={{ keyboardAppearance }}` (`default` / `light` / `dark`; Android's keyboards follow the system theme), `returnKeyType`, `autoCapitalize`, `autoCorrect`, `multiline`, `maxLength`, `readonly`, `autoFocus`, the `selectionColor` style key (`selection:text-*`), `submitBehavior` (`submit` / `blurAndSubmit` / `newline`, resolved with `multiline` by `InputConfig::submit()`, which is all platforms read; a multiline input that submits takes no line break from return, but does from Shift / Option / Alt+Return on hardware keyboards, and a return that commits an IME composition never submits), `selectedRange` + `onSelectionChange` (UTF-16 `start` / `end`), `onCaretMove` (where the caret is: `bounds` in the input, `pageBounds` in the root view; "Caret" below), `onPaste` + `pasteBehavior` (what was pasted, and whether the input inserts its text; "Paste" below), `onKeyPress` (`key`: the text, `Backspace`, `Enter`), `onCompositionChange` (`composing`, `text`: an input method's composition as it starts, changes and ends, its end after the `onChange` of the committed text; each platform tracks the composition natively and holds a `value` the app sets during one until it ends, since setting the text would end it and commit the text being composed), `autoComplete` (autofill; `ios={{ textContentType }}` for iOS's names), `caret` (`false` hides the caret), `onContentSizeChange` (the value's size, for growing inputs: reported by the core after any layout that follows a change of the text or the content width, one empty line's for an empty input though it is sized by its placeholder); ref `setSelection(start, end)`, `insertText(text)` |
| `<NavStack>` / `<NavPage>` | UINavigationController | `createNavStack(routes)`: `push` / `pop` / `popToRoot` / `replace` / `setRoutes` / `remove`; pages keep their state while stacked; on iOS and Android the system header (content below the header UIKit shows: the platform measures it, `Core::set_screen_header`; `title`, `headerLeft` / `headerRight` / `headerTitle` elements, `headerTransparent`, `headerVisible`, `headerBackVisible`, `headerLargeTitle`, `headerBackTitle`, colors from `headerStyle` / `headerClass`, in Rust `header_style_with(|s| ..)`: typed styles in `headerClass`'s place); on the desktops and the web the page's `header` slot (the app's element, which the core places at the top of the page, full width, with the content below it; NSH draws nothing else there); swipe back (`popOnSwipe`: the interactive gesture only); `statusBar` (below); `popOnBack={false}` keeps the user on a page (no swipe; the back buttons and keys send `onBackPress` instead of popping); `onBackPress` is sent on every back press while the app listens; `onDismiss` after the user popped it |
| `<Dialog>` | presented UIViewController | `open` (default true), `animation`, `onOpen`, `onClose`, `onCancel` (every close attempt), `onOpenChange({ open, reason })` (`"cancel"` / `"backdropPress"` / `"swipe"`); `closeOnEscape` / `closeOnBackdropPress` / `closeOnSwipe` (default true; iOS sheets swipe away, Escape and Android back close natively, then `onCancel` + `onOpenChange({ open: false, reason })` + `onClose`; the renderer keeps a removed dialog's `onClose` until the platform reports it, `dom.rs` `dismissed`); `class` / `style` style the popup (the view holding the children), `backdropClass` / `backdropStyle` add a backdrop part behind it (none otherwise) whose presses are close attempts; `presentation` (iOS: `fullScreen` over a clear background, `pageSheet` / `formSheet` keep the system's sheet background; ignored on Android, the desktops and the web, where a dialog is a transparent layer over the whole window); `statusBar` (below); `ios={{ supportedOrientations }}`, `android={{ statusBarTranslucent }}` (otherwise the content starts below the status bar) |
| `<Overlay>` | a `NshView` in the root view (the surface's, or the dialog's around it) | its children on top of that root view, outside the parent's layout and clipping; `anchor` (a ref, `{ x, y }` or `{ origin, size }`), `placement`, `align`, `offset`, `margin`, `onPosition`, `onPressOutside`, `onCancel` ("Overlays" below) |
| `<InputAccessoryView>` | a NshView set as `inputAccessoryView` | `nativeID`; inputs name it with `ios={{ inputAccessoryViewID }}`. A layout root as wide as the window and as tall as its content; the core resolves the id (`InputConfig::accessory`). Renders nothing on Android |
| `<WebView>` | WKWebView (WebKit loaded on first use) | `src` (a URL) or `html` (inline HTML, shown instead of `src`) + `baseUrl`, `injectedJavaScript(BeforeContentLoaded)`, `onMessage` (pages call `window.nsh.postMessage`), `onLoad*`, `onNavigationStateChange`, `onDownload` (macOS: `WKDownload` into the app's data directory's `downloads/<id>/`, only with a listener), `incognito` (website data of its own, in memory: each platform makes the web view from its first props, and the core keeps the prop from changing afterwards), Rust's `url_scheme(scheme, handler)` (URL schemes the page loads from the app, `nsh_core::web_resource`: the handler is called on the main thread with a request answered once, from any thread; read when the web view is made, as `incognito`; iOS and macOS `WKURLSchemeHandler` in `nsh-platform-apple`, Linux `webkit_web_context_register_uri_scheme`); ref: `reload()`, `goBack()`, `goForward()`, `postMessage(data)`, `injectJavaScript(js)`, `load({ src, headers })` (headers on the document request only: `NSMutableURLRequest` + `loadRequest`) |
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
`#[derive(PropEnum)]` for string unions); `default`, `min` / `max`, `on` (the element groups), `ios` / `android` /
`macos` (names inside `ios={{…}}` / `android={{…}}` / `macos={{…}}`), `with` (a decoder of the whole variant, `js/host_values.rs`), `once`
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
(`List`, `Canvas`, `Shader`, `WebView`, `Video`, `Overlay`; in
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

- **State styles** (native, no JS round trip): `activeStyle`, `hoverStyle`, `focusStyle`, `focusVisibleStyle`, `focusWithinStyle`,
  `disabledStyle`, `checkedStyle`, `indeterminateStyle`, `expandedStyle`, `pressedStyle` (and a `Button`'s
  `selectedStyle`) on any view (declared in `StateStyleProps`), the same as the `active:` / `hover:` / `focus:` /
  `focus-visible:` / `focus-within:` / `disabled:` / `selected:` / `checked:` / `indeterminate:` / `aria-expanded:` / `aria-pressed:`
  classes: the core restyles the view while the platform reports it pressed, hovered or focused, while the focus is on
  it or a view inside it (the content of an overlay is inside the view the overlay is in; `docs/dev/styles.md`), and
  while its accessibility state is selected, checked, mixed,
  expanded (a `Popover`'s or `Menu`'s trigger while its popup is open), pressed (a toggle button that is on) or busy; a Rust component's touch responder stays pressed from its grant until its
  touches end, wherever they go (CSS's `:active` until the button is released: a resize handle dragged off its band
  keeps its `group-active:` look; `Core::hold_pressed`); later
  states win, `disabled` over all (`docs/dev/styles.md`). Press feedback is the app's: the platforms add no fade or
  underlay of their own. Background colors that would be hidden by a gradient replace it (`docs/dev/styles.md`,
  Effects). Safe areas and the keyboard are CSS environment variables in padding and margin
  (`env(safe-area-inset-top)`, `env(keyboard-inset-height)`, `docs/dev/styles.md` "Environment variables"); a view
  with `selectable` makes its texts select together (`text.md` "Selectable views").
- **Platform modules**: `platform` (`nsh`'s environment, a constant: `os`: `ios` / `android` / `macos` / `windows` / `linux` / `web`, from the platform's
  `Environment::os` (`nsh_engine::Os`; the default is the build's mobile OS, so `nsh test` is iOS); `version` (a string,
  Android's API level), `idiom` (`phone` / `pad` / `mac` / `tv` / `desktop` / `terminal`: `Environment::reported_idiom()`, `terminal` in the terminal idiom, else `desktop` exactly where `Environment::desktop()` holds, else the platform's idiom, so a test's `Os::Linux` + `Idiom::Phone` reports `desktop`), `desktop` (`Environment::desktop()`), `catalyst` (`Os::is_catalyst()`: an iOS build for `target_abi = "macabi"`, in the iPad and the Mac idiom alike), `select` (the OS, then `desktop` / `mobile` by `Environment::desktop()`, `native` (not on the web), `default`); NSH's one definition of desktop (`api-naming.md`): `Environment::desktop()`, a desktop OS, the web in the desktop idiom, or the terminal idiom, which `platform.desktop`, the `desktop` idiom (outside a terminal), `select`'s `desktop` and `desktop={{…}}` all follow; Mac Catalyst is mobile (the iOS backend, `ios={{…}}`, its idiom `pad` or `mac`); `nsh/desktop`'s `isAvailable` is `Os::is_desktop()`, where its window and menu APIs work), `pixelRatio()` (an accessor: the window moving to another screen writes it), `nsh`'s
  `announce(message)` and `setAccessibilityFocus(ref)` (Rust, the node passed as `{ $node: id }`), reactive `screenReaderEnabled()` / `reduceMotion()`. The environment carries `pixelRatio`,
  `screenReader`, `osVersion` and `idiom` (VoiceOver / TalkBack changes are observed natively).
- **`disabled`** on any element applies `disabled:` classes and removes its press and `onContextMenu` listeners from what
  is mounted (no press, no feedback; a secondary click goes on to the nearest enabled listener around it).
- **`onMouseEnter` / `onMouseLeave` / `onMouseMove`** (any element; the DOM's `mouseenter` / `mouseleave` / `mousemove`,
  GPUI's `MouseMoveEvent`) tell JS, after the fact, that the mouse came over a view, left it, or moved over it, with or
  without a button down. All three pass a `MouseEvent` (`EventPayload::Mouse`, JS `{ position, pagePosition, modifiers,
  pressedButton }`: the `Point` in the view, its transforms undone, the `Point` in the root view as touches have it, the
  modifier keys as GPUI's `Modifiers`, and the button held down as GPUI's `MouseButton`, `"left"` / `"right"` /
  `"middle"` / `"back"` / `"forward"`, or `null`); `onMouseLeave`'s is where the mouse was last. Rust's
  `.on_mouse_enter` / `.on_mouse_leave` / `.on_mouse_move` receive `&MouseEvent`. On the desktops they follow the same
  hover tracking as `hover:` classes: the views along the chain under the mouse (innermost first) whose classes read
  `HOVERED` or that listen to any of the three are the hovered ones, so ancestors hear `onMouseEnter` too, as with CSS
  `:hover` and the DOM's `mouseenter`; a handler alone makes its view take part (`input.rs` `hoverable`, the view's
  mounted event mask), and a view that does not listen gets no event. When the set changes, the views left hear
  `onMouseLeave` from the inside out, then the views entered `onMouseEnter` from the outside in; then the views under
  the mouse and the views around them that listen to `onMouseMove` hear where it is, from the inside out (the move that
  brings the mouse into a view is its first, after its `onMouseEnter`). There is one path for moves: on the desktops and
  the web a drag (a button down) is also a touch (`onTouchMove`, the responder) and its moves reach `onMouseMove` with
  `pressedButton` set, so a view that shows hover-only feedback ignores those; iOS's and Android's hover reports the
  pointer with no button down. A modifier key pressed or released while the mouse rests with no button down is a move to
  where it is with the new modifiers, so a view hears Control or Command come and go under a still mouse (an `Editor`'s
  definition link): Linux from the root's key events, macOS from a local `flagsChanged` monitor (installed once a view
  hears mouse moves), Windows from the modifiers' `WM_KEYDOWN` / `WM_KEYUP`, GPUI from `on_modifiers_changed`, the web
  from `keydown` / `keyup` of `Control`, `Alt`, `Shift` and `Meta` (`nsh.js` `modifiersChanged`). The mouse leaving the
  window (while no button is down on macOS) unhovers everything; on macOS and GPUI hover is picked again after every
  batch (on macOS also after every scroll), so a view removed or moved from under a still mouse hears `onMouseLeave` and
  one that arrives there `onMouseEnter`; on Linux and Windows that waits for the next mouse move. Content updates and
  scrolling pick hover again without making up mouse moves; touches never hover, and touch and pen moves use the touch
  APIs. The web uses the browser's `pointerenter` / `pointerleave` of mice (`nsh.js` `installMouse`) and the root's
  `pointermove` (`mouseMoved`); iOS a `UIHoverGestureRecognizer` per view (iPad pointers, Mac Catalyst's mouse), Android
  the view's hover listener (mice, styluses): there each view is tracked by the system, not along a chain. The engine
  merges moves (`State::mouse_moves`): the latest per view, delivered at most once per `MOUSE_MOVE_INTERVAL` (8 ms) and
  always before the next other event, so a view hears where the mouse went before it hears it leave; mice report up to
  1000 moves a second, and a crosshair needs one per frame.
- **`onWheel`** (any element; the DOM's `wheel`, GPUI's `ScrollWheelEvent`): a mouse wheel or touchpad scrolled over a
  view. `EventPayload::Wheel` / `WheelEvent { position, page_position, delta, modifiers }`, `delta` a `WheelDelta`
  (`Lines` for notches, `Points` for precise deltas, as GPUI's `ScrollDelta`; positive toward the end, the DOM's sign);
  JS `{ position, pagePosition, delta, deltaMode: "lines" | "points", modifiers }`. The platform decides on the main
  thread, before it scrolls, from the mounted event masks (`input::wheel_listener`): walking out from the view under
  the pointer, the first view that listens hears it; it takes the wheel (no native scroll, Ctrl + wheel zoom or pinch)
  when no scroll view (nor a multiline field on Windows / GPUI, nor a hosted widget scrolling itself on Linux / macOS)
  is nearer or is the listener itself. A listening scroll view, or a listener around one, only observes. There is no
  `preventDefault`: events reach JS after the fact, so the rule is what is mounted, as with `onContextMenu`. Linux
  `scroll_event`, macOS `scroll_event` (momentum included; a gesture going on still ends), Windows `input::wheel`
  (`WM_MOUSEWHEEL` notches as lines of 16 points), GPUI `events.rs` (GPUI's `ScrollDelta` unit), the web `nsh.js`
  `wheelEvent` (`DOM_DELTA_PAGE` as points of the viewport's height). iOS, Android and the terminal raise none.
- **`onMouseUp`** (any element): a mouse button was released over it or a view inside it (the DOM's `mouseup`):
  `button` names it (`"left"`, `"right"`, `"middle"`, `"back"`, `"forward"`), with `position`, `pagePosition` and
  `modifiers` (`EventPayload::Mouse`, `MouseEvent`; Rust `.on_mouse_up`). The primary button's release also
  reports `onPressUp`. The desktops (Win32, AppKit, GDK and the GPUI backend), the terminal and the web walk out from
  the view under the pointer, as a move does, and every listener hears it; iOS and Android never report it (an iPad
  or Android mouse included). On macOS a Control-click's release is the secondary button's (`"right"`), as its press
  is; a right click's release
  is what completes it, so an app that waits for it can open its menu without a timer or a press guess. Only a release
  over the view (or a view inside it) is reported: the event has no pointer capture, so a release after the pointer
  leaves the view or the window is not heard. The headless
  driver's `rightClick` and the desktop test agents (Linux's included) release the secondary button too.
- **`onContextMenu`** (any element): the secondary button was pressed over a view (a right click; Control-click on
  macOS, in GPUI on macOS too; the browser's `contextmenu`), or a context menu was asked for without a pointer (below). The platform
  decides on the main thread from the mounted event masks, walking out from the view under the pointer: the first
  view that listens hears it (`EventPayload::ContextMenu`, the same shape: `position` in it, `pagePosition` in its
  root view, which is where `Menu.popup` takes its point, and the `modifiers`); a text field nearer, or selectable
  text with an edit menu of its own (Windows, GPUI, the web), shows that menu instead and the app hears nothing.
  JS cannot cancel the system's menu after the fact (the main thread never waits for JS), so the rule is what is
  mounted. iOS: a `UITapGestureRecognizer` for the secondary button per listening view (iPad pointers, Mac
  Catalyst's mouse). On touchscreens a menu belongs on `onLongPress`; Android raises `onContextMenu` for no input yet.
  Without a pointer: the keyboard's Menu key and Shift+F10 on the focused view (the web and Linux, `key_focus.rs`, and the headless
  driver's `keyboard.press("shift+f10")` there) and a screen reader's "show menu" action (macOS `AXShowMenu` on a view that
  listens, VoiceOver's VO-Shift-M; Windows UI Automation's `ShowContextMenu`) raise it too, walking out from that
  view as a click does.
  The payload's `pointerType` (`PointerType`: `"mouse"`, `"pen"`, `"touch"`, the DOM's) is `null` then, and the
  positions are the view's bottom-start corner (`nsh_core::input::context_menu_anchor`, by the surface's direction),
  so a menu opened below it starts where the view does; `ContextMenu` puts the keyboard focus on its first enabled
  item then.
- **Keyboard focus**: on macOS, the web and Linux, Tab (the keyboard focus) moves between stops, in tree order; a click
  presses without focusing, so a stop's `FOCUSED` state (`focus:` classes, `.focus(..)`) is keyboard focus; it
  shows (`FOCUS_VISIBLE`: `focus-visible:`, `focusVisibleStyle`, `.focus_visible(..)`) when the keyboard moved it
  there, or the app moved it after a key rather than a press (`docs/dev/styles.md`); a part projected focused (a
  tree's or a list's cursor) shows it too while the control's focus shows. Focus and presses are separate: `ViewProps::focus_stop` decides, from
  `focusable` (`Prop::Focusable`, `ViewProps::focusable`; Rust `.focusable(..)`) and whether the view takes presses,
  and every platform that moves the focus between views asks it (macOS `input::is_key_stop`, the web's
  `updateFocusable`, the headless driver's `Screen::tab_stops`). Unset, the views that take presses are stops.
  `focusable={true}` makes any view one, whether or not it takes presses: a component that takes keys while focused (a
  chart, a slider, a list that moves its selection) sets it on a view that takes no presses, so a pressable around it
  (a card that opens a page) keeps its presses; it must not listen to `onPress` just to be focusable, which would
  swallow them. `focusable={false}` keeps a pressable out: a backdrop that closes a popover, rows a list moves between
  with the arrow keys. A disabled view is never a stop; inputs that edit always are. A stop hears `onFocus` /
  `onBlur` (`EventKind::Focus` / `Blur`, as inputs do) when the keyboard focus reaches and leaves it: AppKit's first
  responder, the browser's `:focus-visible`; the headless driver's Tab moves it the same way there. Return and Space
  press the focused stop only when it takes presses; a stop that takes none hears its keys through the keymap (`on_key`
  / `on_key_with`, bound while it is focused, as `DataTable`'s controller does), Return and Space included. On a stop
  that takes presses, plain Return and Space fire only the focus' own bindings (`KeyOptions::for_focus`: a component's
  keys while its part has the focus or its popup is open, a menu button's Return opening its menu), else they press
  it; an app's other bindings of those keys (a dialog's Return for its main action) give way to the control the user
  moved the focus to, on every platform (`Keymap::find_at`, `input::presses_focused_control`).
  A stop the keyboard or `focus()` reaches scrolls into view in the scroll views around it, as a focused field does
  (macOS `scroll::reveal` unless a click focused it, Linux on any focus widget, the browser's own `focus()`, the
  headless driver's Tab at once); a list keeps the rows beside the focused one rendered, so Tab walks all its rows
  ("Kept rows" in `scrolling-and-lists.md`).
  (`focusable={true}` on a view that takes no presses made nothing focusable before 2026-10-26; with no release
  recorded, it now means what React Native's `focusable` and the web's `tabIndex={0}` mean.) Windows and GPUI
  move the focus between fields and native components only so far; iOS and Android move it between inputs.
  A shown overlay's content is in the Tab order where the app put the overlay, not where its native view is (at the
  end of its root view), as WAI-ARIA's non-modal popups have it: a popover's content right after its trigger, so
  Shift+Tab from it goes back to the trigger and Tab past its last stop goes on to what follows the popover. A list
  of options or a menu (a select's list, a `Menu`) keeps its place: those move the focus with their own keys, and
  Tab leaves them for the control after their trigger. The core
  sets `ViewProps::tab_after` on each shown overlay (the view it follows), and the platforms that order Tab
  themselves walk with `nsh_core::input::tab_order`: the headless driver, Windows and GPUI; the TUI orders Tab by
  `MountItem::TreeOrder`, which has overlays there already. On macOS, Linux and the web the toolkit orders Tab
  (AppKit's key view loop and GTK's focus chain by position on screen, the browser by the DOM, where an overlay's
  view is the last of its root view). Dialogs keep the focus inside them (the newest modal is the focus scope)
  whatever this order.
  A link in text (a nested `<Text>` that takes presses, `AttributedText::links`) is a stop of its own: the core marks
  each `TextLink` with `focus_stop` (the span's `ViewProps::focus_stop(true)`: unless `focusable={false}` or
  disabled), Tab reaches it after its text view, in text order (nested links inside the one around them), the
  platform reports the span's node `FOCUSED` (`set_states`, so `focus:` and `focus-within` follow) and `Focus` /
  `Blur`, and Return presses it (`PressDown` / `PressUp` / `Press` to the span, as a click on its characters). The
  headless driver walks links (`Screen::tab_stops`); the TUI is next; macOS, the web, Windows, Linux and GPUI follow
  in a later change, drawing their focus cue over the link's rects.
  A ref's `focus()` on a stop moves the keyboard focus to it as Tab does (`focus:`, `onFocus`; a popup gives it back to
  its trigger), and `blur()` takes it off: `Command::Focus` / `Blur` reach the platforms for any view, and AppKit makes
  the view first responder (`input::focus_control`, past a field that edits), the browser focuses the element with
  `focusVisible` and treats it as keyboard focus whatever its heuristics say after a click (`focusPressable`), the
  headless driver moves its focus (`focus_calls`); on a view that is not a stop it does nothing. Linux grabs the
  stop's widget (`key_focus::focus`). Windows and
  GPUI leave `focus()` on views to them; iOS and Android focus inputs only.
- **`onPanEnd` / `onPanStart`** carry `value` (`{ x?, y? }`, the axes `pan` binds): the bound pan values at that moment (a drag may grab a value mid
  animation), for snapping.
- **Imperative calls**: nodes have `focus()`, `blur()` (inputs, and views that take presses where they are stops of
  the keyboard focus: "Keyboard focus" above) and `scrollTo({ x, y, animated })` (use `ref`); lists also
  `scrollToIndex({ index, viewPosition, viewOffset, animated })`, `scrollToEnd()`, `scrollToOffset()`; every node
  `reveal({ vertical, horizontal, animated })`; `Keyboard.dismiss()` (`nsh`).
  Commands run after the commit's other mount items; list scrolls and `reveal` are resolved by the core with
  the current layout (`docs/dev/scrolling-and-lists.md`).
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
  the span under the finger (CoreText `CTLineGetStringIndexForPosition` / `Layout.getOffsetForHorizontal`). The web
  wraps a link's characters in a span inside their run (`link_parts`, `nsh.js` `fillRun`), which keeps the run's shaping
  and bidi order, and a press on it goes to the link (`linkPress`), its position in the text, as elsewhere.
- **Raw touches and the responder system**: `onTouchStart/Move/End/Cancel` (+ `Capture`), `onStartShouldSetResponder`,
  `onMoveShouldSetResponder` (+ `Capture`), `onResponderGrant/Reject/Start/Move/End/Release/Terminate/TerminationRequest`, and
  `PanResponder.create` on top. A node with any of them listens to `onTouch` natively; one tracker per root view (surface,
  modals: `touch.rs`, `TouchTracker.java`) observes without recognizing and reports touches whose target or an ancestor
  listens, with the path of listening nodes (`EventPayload::Touch`, sent to the root; moves are merged per engine turn). The
  negotiation runs as in React Native, natively (`nsh-js` `touch.rs`), asking the app's handlers. A grant returning true
  (PanResponder's default) sends `SetJsResponder`: scroll
  views around stop taking the touches (UIKit: their pan recognizer is disabled; Android: `ScrollBox.jsBlocked`), and the
  presses of the views around it end with no long press or press after them (UIKit: their `PressRecognizer`s are
  cancelled; Android: `Box.cancelPress`, `Pressable.cancel`); a native scroll view that starts dragging first cancels the
  JS touches. The `…ShouldSetResponder` handlers also get a
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
- **Accessibility**: `accessible`, `role`, `accessibilityLabel` / `Hint` / `Description` / `State` / `Value` / `Actions` / `Level` +
  `onAccessibilityAction`, `accessibilityElementsHidden`, `importantForAccessibility`, `accessibilityLiveRegion`, `testID`
  (Android: resource id). `accessibilityDescription` (ARIA's `aria-description`, `gpui-base`'s `aria_description`;
  Rust `.accessibility_description(..)`) is read after the name: a dialog's message. Windows has a property of its own
  for it (UIA `FullDescription`); the other platforms have one place for what is read after the name (AppKit's help,
  UIKit's hint, AT-SPI's and AccessKit's description, Android's hint text, the web's `aria-description`), which gets
  the description and then the hint (`Accessibility::help_text`). Roles and states follow ARIA where `gpui-base` (AccessKit) has them: `group`, `region`,
  `navigation`, `tree` / `treeitem`, `menuitemcheckbox` / `menuitemradio`, `dialog` / `alertdialog` (`nsh-base`'s
  `Dialog` is a `dialog` unless the app gives it another role, named by its label; the platforms map it to their own
  dialog roles, and on iOS to a semantic group so a labelled dialog never hides its content); `accessibilityState.pressed` (`aria-pressed`:
  a button that has one is a toggle button) and `current` (`aria-current`: `true`, `page`, `step`, `location`, `date`,
  `time`), `hasPopup` (`aria-haspopup`: the element opens a popup, a menu or a list, and its `expanded` says whether
  it is open; `nsh-base`'s `Popover`, `Menu`, `HoverCard`, `Select`, `Combobox` and `DatePicker` set it on their
  triggers; an `expanded` element without it is a disclosure that shows its content in place; the web sets
  `aria-haspopup`, the terminal marks a disclosure `▸` / `▾` and a popup trigger not; elsewhere it is not exposed yet),
  `invalid` (`aria-invalid`: the content does not pass the app's checks, a rejected field; `aria-invalid:` classes
  style it; a slot's element keeps the app's beside the component's states);
  `accessibilityLevel` (`aria-level`: a heading's level, a tree item's depth). Per platform: macOS a toggle is
  `AXCheckBox` / `AXToggle` with its pressed value, `region` / `navigation` are `AXGroup` with WebKit's landmark
  subroles, a tree is a list of static-text items (as options: AppKit's outline rows need its rows and columns) with
  their disclosure level, `current` and a heading's level are not exposed (AppKit has no attribute for the first, and a
  heading's value is its text, which VoiceOver reads), `invalid` is WebKit's `AXInvalid` attribute, which the view
  answers itself (`view.rs`); iOS a pressed toggle carries the selected trait (UIKit's toggle
  trait is iOS 17's), mixed, `current` and `invalid` are spoken in the value, `group` / `region` / `navigation` / `tree` /
  `toolbar` are semantic-group containers named by their label (never one element hiding their content), no level; Android a toggle
  is a checkable `ToggleButton`, `current` and mixed go in the state description, `invalid` there too and in
  `setContentInvalid`, roles without a widget class in the
  role description, no level; Windows a toggle has the Toggle pattern (and "toggle button"), landmarks
  (`UIA_LandmarkTypePropertyId`), `Tree` / `TreeItem` control types, a heading's `HeadingLevel1`…`9`, a tree item's
  `UIA_LevelPropertyId`, `current` and `invalid` in `AriaProperties`, `invalid` also as `IsDataValidForForm` false;
  Linux GTK's roles, `Pressed` on buttons, `Level`, `Invalid` (AT-SPI's invalid entry); GPUI AccessKit's roles,
  `toggled`, `level`, `aria_current`, `invalid`; the web the ARIA attributes (`aria-invalid` on an input's field
  too). Views without a label read their texts. The props go as one `MountItem::ViewProps`, except
  a label changing alone on mounted props (one that follows app state: a count, a price), which goes as
  `MountItem::AccessibilityLabel`. The `increment` / `decrement` actions make an element adjustable whatever its
  role: iOS adds the adjustable trait to the traits of its role (`native_view.rs` `traits`), so VoiceOver's swipe up /
  down performs them (an `image`, `Plot`'s role, stays an image), Android offers scroll forward / backward, Windows
  makes its range value writable.
- **Frames**: `requestAnimationFrame` / `cancelAnimationFrame` follow the display (CADisplayLink / Choreographer).
- **Back button** (`nsh/mobile`): `BackHandler.on("press", listener)` (returns the function that removes it; a
  listener added while a component renders goes with it, as `keymap.bind`'s bindings do), after modals, the top
  overlay listening to `onCancel` and stacks; the app exits when nothing handles it. Rust components listen with `cx.on_back_press(..)`, before JS's listeners; the root wants
  the button while either side listens (`docs/dev/components.md`).
- **Keyboard shortcuts** (`nsh`'s `keymap`): the root's `Prop::Keymap` mounts the surface's whole table
  (`MountItem::Keymap`); the platform matches a key against it on the spot, consumes it and reports the root's
  `KeyCommand` (the binding's id), so the main thread never waits for JS (`docs/dev/js-modules.md`, the macOS and
  Linux pages' "Keyboard"). A binding that passes its key through (`passThrough`, Rust's
  `KeyOptions::pass_through`; `KeyMatch::Notify`) is reported and the key goes on as if nothing were bound: Tab
  still moves the focus, which is how `Select` and `Combobox` close an open list on Tab. iOS and Android match a hardware keyboard's keys: iOS in `pressesBegan:` of its text
  inputs (before UIKit's text system) and of the root view (presses nothing inside handled), keys named by their HID
  usage (`Key::from_hid_usage`) and the character they type, a `repeat` binding firing on a timer of its own while
  the key is held (UIKit sends a held key's press once); Android in `NshView.dispatchKeyEvent` (before the focused
  view, after the input method) through `Native.keyDown` / `keyUp`, the table kept in Rust (`keymap.rs`), never
  encoded for Java. Both leave a composing input method its keys and consume a taken key's release too. Rust views' bindings (`on_key`) join JS's in that one table, and the core runs
  their handlers (`docs/dev/components.md`).
- **System UI**: the status bar follows UIKit, where the topmost view controller's `preferredStatusBarStyle` decides
  and Info.plist holds the default: a page's or dialog's `statusBar` (`{ foreground, hidden, animated }`, a host prop
  of screens and modals, `ScreenProp::StatusBar`, decoded to a `StatusBarSetting`; `Screen::status_bar` /
  `Modal::status_bar` in Rust) is one entry of the surface's layers while the node is in the tree, over the app's
  default (`nsh.json` `"statusBar"`: the bundler checks it and the entry's `setup` sends `Command::SetStatusBar`; a
  Rust app's `Root::status_bar`). The core layers them (`docs/dev/components.md`); iOS and Android apply the merged
  `Command::StatusBar`, the desktops and the web ignore it. `AlertDialog.show({ title, description, actions, presentation })`
  (`nsh/base`: a promise of `{ action }`, the chosen action's `id` (required: the app's name for it, never its label), `null` when closed without an action;
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
  `colorScheme()`, `fontScale()`, `localeSettings()` (`Environment::locale_settings`, `LocaleSettings`, one value and
  one signal, as the systems change these together; a `computed` of one field reruns only its readers; the
  locale's (it alone as the languages, its region's preferences) in UTC headless unless a test sets them): `languages`
  (`Languages`: the system's preferred languages, most preferred first, at most 8, never empty, an embedding app's own
  language first; the web the browser's), `timeZone` (`TimeZone`: the zone's name as the system gives it, an IANA name
  or an offset zone; the platforms write the system's, the web the browser's, read again when the page shows or gets
  the focus), and the regional preferences `hourCycle`, `firstDayOfWeek`, `measurementSystem`, `temperatureUnit` (the
  system's settings, else the region's, CLDR 48's (`LocaleSettings::of`); `LocaleSettings::parse` reads a platform
  identifier's region and its `-u-` / `@` keywords (`hc`, `fw`, `ms`, `mu`, `rg`); the web the browser's hour cycle
  and first day for its language, its likely region's units; both are `#[doc(hidden)]` plumbing for the platforms, as
  are `Languages::parse` / `one`, `TimeZone::posix` and `HourCycle::of_pattern`), `lifecycle()` (`Environment::lifecycle`, `Lifecycle`: `active` / `inactive` /
  `background`, React Native's states; the platforms write it as the system reports the app's, the web from the
  page's `visibilityState` and focus, iOS from the notifications of the scene of the surface's window
  (`UIScene`'s `didActivate` / `willDeactivate` / `didEnterBackground` / `willEnterForeground`, filtered by the view's
  `window.windowScene`, its `activationState` read when the view moves to a window), UIApplication's
  (`didBecomeActive` / `willResignActive` / `didEnterBackground` / `willEnterForeground`) while it is in no window
  with a scene, by the notification: the scene and `applicationState` still say active during `willDeactivate` /
  `willResignActive`; Android from `NshView`'s activity: resumed is `active`, paused or started again
  `inactive`, stopped `background`, through one `ActivityLifecycleCallbacks` per application, registered by the first
  view attached and kept, which remembers each activity's last state: a view attached again starts from it). The change reaches JS through the engine's thread, and iOS may suspend the
  process seconds after `didEnterBackground` (Android's `onStop` is looser): `background` is for pausing work, and
  the user-facing docs say to save as changes are made. `padding-bottom: env(keyboard-inset-height)` pads a view by the keyboard's height, animated with the keyboard
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
  images and files are never inserted. Inserted text is clipped to what `maxLength` leaves room for, as a browser's
  `maxlength` clips it (iOS cuts between composed character sequences, the other platforms between code points). The event comes before the `onChangeText` of the text it inserts (Linux:
  maybe after, as GTK's own paste and NSH's read of the clipboard are both asynchronous; with `"report"` nothing is
  inserted, so it comes first). An app that decides per paste uses `"report"` and inserts what it allows with the
  ref's `insertText` (`Command::InsertText`): the text in place of the selection as the user's edit, `maxLength`
  and the line rules applied, `onChangeText` reporting it, no key, and a step of the platform's undo history, which a
  new value is not. Linux: the editors' `delete-from-cursor` / `insert-at-cursor` signals (`GtkText`; inserting
  from outside an edit would clear its history) or one user action on the `GtkTextBuffer`; web: `execCommand("insertText")`;
  headless: at the end, as a paste; macOS, Windows, iOS, Android and GPUI insert nothing yet and log a warning.
  During an input method's composition Linux and the web insert nothing and log a warning. With `"insert"` the
  input has inserted the paste already, so an `insertText` from `onPaste` inserts it a second time. Where Paste is offered, it is offered for images and files too while
  the app listens. iOS: `Field` / `Area` override `paste:` (`system::pasted`: strings, `IMAGE_TYPES` data else
  `UIImage` PNGs, file URLs) and `canPerformAction:withSender:`; with a `maxLength` they insert the clipped text
  themselves (`paste_text`, the test agent's paste too) instead of UIKit's `paste:`; Android: `setOnReceiveContentListener` (API 31;
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
- **Edit menu** (internal, for components that draw their own selection: `RichEditor` on touch screens):
  `ElementRef::open_edit_menu(bounds, actions)` on a focused input (`Command::OpenEditMenu`, `bounds` in the root
  view) opens the system's menu there offering `actions`, `close_edit_menu` closes it. The actions are
  `EditAction`s, named as gpui-base's input actions (`Cut`, `Copy`, `Paste`, `SelectAll`); the component leaves out
  what cannot apply rather than disabling it. iOS (`input.rs`): a `UIEditMenuInteraction` on the field
  (`UIMenuController` before iOS 16), its target rect the bounds, preferring above them; while the menu is the
  component's, `canPerformAction:` offers only what it asked for (Paste with something on the pasteboard) and `cut:` /
  `copy:` / `selectAll:` report instead of acting. Android (`InputBox.openEditMenu`): a floating `ActionMode` with
  the system's Cut, Copy, Paste and Select all. Chosen actions come back as `EventKind::EditAction` (`action`: `cut`,
  `copy`, `selectAll`); Paste is the input's own paste (`onPaste`). Other platforms ignore it. Headless, `app.menu()` lists
  it with the platform's labels and `chooseMenuItem` chooses from it (Paste pastes the test's clipboard).

Text, styles, scrolling and lists, animation, canvases and images have their own pages.

## Overlays

`<Overlay>` (`nsh`; Rust `overlay()`) shows its children on top of the root view it is in: the surface, or the
dialog around it (`Modal`). It is the one mechanism popups are built on (`nsh/base`'s `Popover`, `HoverCard`, `Menu`,
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
  moved along the side to stay inside the root view's safe area less `margin`. Rust's `anchor_beside(row, menu)`
  (`OverlayAnchor::Beside`, a submenu's) lines it up with the row along its side and places it outside the menu
  around the row across it, so `offset` is a gap from the menu's edge, not from the row inside its padding. Rust's
  `anchor_content(r)` (`OverlayAnchor::Content`, `Popover`'s, `HoverCard`'s and a desktop `Menu`'s) places it against
  what the view draws: the box around its children with its padding and border, along an axis its style leaves `auto`
  (a wrapper its parent stretches); the element that takes a component's slot goes by its own box, whether a TSX or a
  Rust app passed it (`Core::content_anchor`: the slot's holder is that wrapper). The anchor's frame is
  `Core::measure`'s (scroll offsets and zoom applied, transforms not), so the overlay follows it as it scrolls and moves:
  `place_overlays` places anchored overlays again at the end of every commit (after the lists and the scroll offsets
  the platform reported). `onPosition` reports where it went (`placement`, the frame as `bounds`, `available`:
  the room on that side, what a menu may grow to). An overlay whose max size along its side is the `available` it was
  told (a select's or a date picker's popup, held to the room and scrolling past it) chooses its side at its natural
  size, not the size that room gave it (`Core::natural_extent`, `nsh_core::overlay::place_fitted`): one that grew
  past the room below, or opens again with the last room below still set, goes above when it fits there whole; on
  the side with more room, limited to it, when it fits on neither. The core measures it without that limit only
  while the limit holds it, once per layout. A view inside an overlay measures in the root view's coordinates.
- **Covering the anchor** (`OverlayConfig::cover`, `OverlayProp::Cover`; Rust `overlay().cover(&element_ref, shown)`;
  no JS prop): instead of on a side, the overlay starts where the anchor does, with a view inside it centered on the
  anchor vertically (a select's selected row over its trigger, title on title: shadcn/ui's `item-aligned`), then moved
  to stay inside the safe area less `margin`. The view's frame in the overlay is kept while the overlay keeps its size
  and the view its place in its parent (`Core::covering`, `OverlayState::covered`), so the overlay stays put while
  its rows scroll; without the view (not rendered, nothing selected) the overlay is placed on its side as usual.
- **Dismissal is reported, never decided**: `onPressOutside` (a finger or button went down outside the overlay, its
  anchor and the overlays inside it: while an overlay listens, the shown overlays, its anchor and root view listen to
  touches, and the core reads each touch's path, `overlay_touches`); `onCancel` (Escape, the Android back button or
  VoiceOver's escape gesture on iOS (`RootView`'s `accessibilityPerformEscape`, as the back button), to the top
  overlay listening only: the core binds Escape in the root's table, `overlay::ESCAPE_BINDING`, and takes
  the back button before the views' and JS's listeners). Whether to close is the app's or `nsh/base`'s.
- **Hints (tooltips)**: an overlay with `OverlayConfig::hint` (Rust `overlay().hint(delay)`, `OverlayProp::Hint`; no
  JS prop) is shown by the core, as GPUI's tooltips are. While it is in the view on a desktop (the environment's idiom),
  its anchor (its parent, the nearest node with a layout, when it has none) listens to `onMouseEnter` / `onMouseLeave` and
  touches (`Node::overlay_watched`'s `watch::HINT` bit, mounted with the events JS asked for, hover also while the view
  is disabled). `onMouseEnter` starts a task of the components' executor (`act_after`, `Action::Hint`) that wakes the
  engine after the delay; then the hint shows in the commit (`sync_overlays` leaves a hint the pointer has not asked
  for out of its root view). `onMouseLeave`, a touch down whose path holds the anchor, or the hint leaving the view hide
  it. In every idiom the focus the keyboard moved shows it too (WAI-ARIA's tooltip pattern): `Core::focus_hints`,
  after `update_focus_within`, shows the hint of the nearest anchor on the focus chain (up to the overlay the focus is
  in, so a popup's focus is not on its trigger's hint) at once when the keyboard brought the focus there, and hides it
  when the focus leaves. Which input moved the focus is decided as it is reported (`classes::focus_reported`:
  `Core::focus_by_keyboard`, by `keyboard_moves_focus`: `focus-visible:`'s rule, `styles.md`, without its exception
  for an input that edits), so Tab, a group's arrows, a shortcut and the app's `focus()` after a key show the hint, and
  a press, a tap or a click that focuses the anchor (a click on a stop where the platform focuses it, a tap into a
  field, a component's or the app's `focus()` after a press) leaves the hint to the pointer, as Radix's tooltips do:
  the press hid it, and it stays hidden after the pointer left. A key typed later, the focus staying, shows
  `focus-visible:` and no hint; the hint shows once the keyboard moves the focus to the anchor (a move inside the
  anchor decides nothing again). Before any input the focus counts as the keyboard's (an `autoFocus`), as it
  does for `focus-visible:`. While a hint is shown the core binds Escape (`Overlays::hint_escape`, the same
  `ESCAPE_BINDING`): Escape hides the top shown hint, or goes to `onCancel` when the top overlay is no hint
  (`overlay_escape`); a hint Escape or a press hid shows for the focus again only once the keyboard brings the focus
  back. The overlay hears what the pointer and the focus ask for (`Show`, `Dismiss`: `on_hint_show` /
  `on_hint_hide`, with a `HintReason`: `Pointer`, `Focus`, `Escape`, `View`), and `OverlayConfig::open`
  (`hint_open`) decides instead when its owner does (`nsh/base`'s `Tooltip`, whose own state is controlled or not).
  Touch screens never watch the pointer: a hint shows there for the keyboard's focus (a hardware keyboard) or when
  `open` says so. The overlay should not take the pointer (`pointerEvents: "none"`).
- **A link's hint** (a hint overlay whose parent is a link of a text: a nested span, `AttributedText::links`): the
  span is its anchor (`Core::hint_anchor` takes any span, `is_text_span`, since the watch is what makes it a link;
  `is_link_span`: a span taking presses or watched for a hint). A span taking no presses (`RichEditor`'s link mark,
  whose presses are the editor's) is a link for the pointer only: `MouseEnter` / `MouseLeave`, `focus_stop` false,
  and none inside a span that takes presses (that one keeps the press); the platforms route presses, the pointer
  cursor and Tab only to links whose events take presses (`has_press`; the web's `PRESS_EVENTS`). The span has no
  frame, so
  the platforms report the pointer over its characters: while a hint watches the span (`watch::HINT`), its
  `TextLink::events` carry `MouseEnter` / `MouseLeave` (`collect_text`; `rewatch` merges the block again), and each
  desktop backend sends them to the span's node as the link under the mouse changes (`hover_link` in the macOS,
  Linux, Windows and GPUI `input.rs`, from the pick their cursor or hover already makes; the web's
  `installLinkHover` over the runs' link spans; the headless driver models links as views). The hint is placed
  against where the pointer came over the link (`OverlayState::pointer`, an `OverlayAnchor::Point`), against the
  text block for the keyboard focus; a press on the block hides it (the block listens to touches), and so does a
  scroll of a scroll view or list around the link (`Core::set_scroll_offset` → `overlay_scrolled`: the point would
  stay behind; the pointer coming over a link again shows it there). `nsh-base`'s
  `Link`, `TextView`'s links (and images in them) and `RichEditor`'s link mark show their destination with it
  (`link_hint.rs`: the link's title — Markdown's, HTML
  `<a title>`'s, the mark's `title`, `Link`'s `title` prop — over one row of
  `open_url::hint_url`'s two parts, laid out LTR (`direction`) in every app: a head of scheme, host and port that
  never shrinks or wraps and a rest that alone gives way, one line with a middle ellipsis (`EllipsizeMode::Middle`),
  IDN hosts as punycode; paths and anchors as written, escaped; `Link`'s below the link, by default apart from an app's
  `tooltip` above it, though either may flip near an edge); hint overlays inside an element count
  for none of its positional classes (`is_tooltip_overlay`).
- **`tooltip`** (every element; `Prop::Tooltip`, `TooltipContent`; Rust `Interactive::tooltip`): the core makes a hint
  overlay inside the element itself (`Core::set_tooltip`, odd ids, inserted directly so a component host's children
  placement never moves it), placed on top with a 4 pt gap, holding the element JS made (retained by the node, moved
  into the overlay, detached again when the prop changes). The core takes elements only: it draws no bubble, the look
  is the app's. A function given as the prop (in a development bundle an app's component is its hot proxy's memo) is
  followed by each renderer with a binding of its own (`followed` in nsh-js' `dom.rs`, `prop` in the browser runtime's
  `browser/dom.js`), so the core gets the element it gives, again whenever that changes. An element that is a hint
  overlay itself (`nsh/base`'s `Tooltip`, once its view
  made its root one) replaces the core's overlay, with its own placement, delay, look and events
  (`adopt_hint_tooltips`, each commit before the overlays are shown). Released with the element. It counts for nothing else: text skips overlays, and
  positional classes (`first:`, `last:`) skip a tooltip's overlay. Rust's element tooltips are an overlay child of the
  element (`IntoTooltip for AnyElement`), `nsh_base`'s `TooltipElement` the hint overlay itself.
- **Limits**: one surface (no window of its own); an overlay in a `HeaderItem` or `InputAccessoryView` shows in the
  surface's root view while its anchor is measured in the header's; an anchor in another root view than the overlay's
  is measured in its own. A dialog's native Escape and back handling comes before the overlays inside it.

## WebView evaluation

`WebViewRef.evaluate(script, { timeout })` (TS, `nsh-js` `components.rs`) and Rust's
`ElementRef::evaluate(script, EvaluateOptions)` run through the same request table in
`core/web_evaluation.rs`: it checks `Environment::web_evaluate`, the `webview` grant and
the limits, keeps each request's deadline (`timeout`; it sends `Command::CancelEvaluate`
when it passes), and settles the request from the internal `WebEvaluation` event a
platform replies with, never from page messages. `platform/web_evaluation.rs` and
`web_evaluation.js` hold the page wrapper (JSON result contract, polling of returned
Promises, cleanup) that every platform runs. iOS and macOS share
`nsh-platform-apple`'s `web_evaluation.rs` (WKWebView completions); Android runs it in
`WebBox.java` (`evaluateJavascript`). The platforms abort requests on a new-document
navigation, explicit navigation commands, a reloading source, renderer loss and
disposal; page-initiated same-document history updates keep them. Platforms that leave
`web_evaluate` false reject with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, which
`WebView.evaluateAvailable()` / `web_evaluate_available()` answers beforehand.

