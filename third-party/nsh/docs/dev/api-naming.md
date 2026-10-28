# API naming

NSH's TSX names follow `gpui-base`'s (`nsh-base` is its counterpart, `architecture.md` "Layers"): the names GPUI Kit
settled, translated to TSX. Before naming anything apps use, look for the term in `gpui-base`
(`gpui-kit/crates/base/src`), then GPUI, then `gpui-component`, then macOS / Windows / UIKit controls; React Native
is a reference for which capabilities exist, never for names. GPUI Kit's own rules are "Vocabulary is part of the
API", "Use precise domain words" and "Callback and event wording" in `gpui-kit/website/docs/coding-guides.md`
(cited below as *guides*). The table at the end lists the renames decided so far; until they land, the code still has
the old names.

## Where names come from

Each part of the API takes its names from one source, so an app's code never mixes vocabularies:

| Part | Source |
|---|---|
| Components and their behavior (`nsh/base`, the interaction props of elements) | `gpui-base`, then GPUI, `gpui-component` (this page) |
| What primitives show and the web APIs (`src`, `html`, styles, Tailwind, `fetch`, `window`'s events, the clipboard, storage) | HTML, the DOM and CSS, as a browser has them |
| The standard modules (`process`, `os`, `fs/promises`, ...) | Node's names; values as Rust's `std::env::consts` gives them (`process.platform` is `"macos"`, `arch` `"aarch64"`; decided by the user, 2026-10-21), documented on each |
| The environment (`nsh`'s accessors) | NSH's rules below: a lowercase accessor per value, `set<Value>` beside it |
| React Native | none: a reference for which capabilities exist; the RN-shaped modules frozen as they are (below) |

**Frozen RN-shaped APIs.** `nsh`'s animation API (`Animated`, `Easing`, `LayoutAnimation`) and `PanResponder` and the responder props (`onTouch*`, `on*ShouldSetResponder*`, `onResponder*`) keep React Native's
names and semantics as a whole, as they shipped (decided by the user, 2026-10-21): they are consistent in themselves
and ported from React Native code as they are. The rules of this page do not apply inside them, and new capabilities
go elsewhere under these rules rather than into them.

## Translation

- `snake_case` → `camelCase`: `on_open_change` → `onOpenChange`, `close_on_escape` → `closeOnEscape`,
  `accessibility_label` → `accessibilityLabel`.
- A builder flag (`.disabled(bool)`, `.open(bool)`) is a boolean prop of the same name; readers (`is_open`) have no
  TSX form.
- A builder taking a part (`Dialog::backdrop(element)`) is a part prop (below); a closure builder of state styles
  (`.active(|s| ..)`, `ButtonStyles::selected(..)`) is a `<state>Style` prop and a `<state>:` class.
- A Rust enum's variants are a string union of the same words (`DialogChangeReason::BackdropPress` →
  `"backdropPress"`).
- One word stays one word: `readonly`, never `readOnly` (*guides* "readonly"; `docs/READONLY-NAMING-RESEARCH.md`).

## Conventions

- **Open state**: `open` + `onOpenChange(open, reason)`, `defaultOpen` when uncontrolled (`Dialog::open`,
  `Dialog::on_open_change`, `Popover::default_open`). The reason is the variant that closed it (`DialogChangeReason`).
  Never `visible` / `onRequestClose`. *open/close* is an overlay's state, *show/hide* a transient request, *expand /
  collapse* structure (*guides*).
- **Value state**: `value` + `onChange(next)`, `defaultValue` when uncontrolled (`Slider::default_value`,
  `Switch::on_change`); a second value of one component is `on<Value>Change` (`onSelectionChange`).
- **Dismissal flags**: `closeOn<Trigger>`, positive, default `true` (`Dialog::close_on_escape`,
  `Dialog::close_on_backdrop_press`). Escape is also Android's back button. A flag is read natively when the user
  acts (the main thread never waits for JS); the trigger is reported either way (next rule), so a flag set to `false`
  lets the app confirm and close itself. A stack's screens use `popOn<Trigger>` the same way.
- **Events**: `on<Event>` with a present-tense verb or noun, never past tense (`on_click`, `on_close`, `on_dismiss`,
  `on_confirm`); *guides*: `on_change` observes, `on_confirm` commits, `on_dismiss` closes a transient surface,
  `on_will_change` may veto (NSH has no veto: the main thread never waits for JS). Lifecycle pairs are `onOpen` /
  `onClose` (`DialogTrigger::on_open`, `Dialog::on_close`). A user's attempt is named after the act (`onCancel`,
  `onBackPress`: `Dialog::on_cancel`, `DialogChangeReason::*Press`), never `on<Noun>Request`.
- **Press, not click**: `onPress`, `onPressDown`, `onPressUp`, `onLongPress` (below, Button). `gpui-base` itself says
  *press* for pointer-independent activation (`DialogChangeReason::TriggerPress`, `close_on_backdrop_press`).
- **States**: `disabled` blocks interaction, `readonly` allows selecting but not editing, `selected` is membership /
  the current item, `checked` / `pressed` the value of a checkbox / toggle (*guides*; `Selectable`, `Disableable`,
  `Toggle::pressed`). Booleans are named after the state, positively (`open`, `hidden`), with no `is` prefix and no
  `Enabled` suffix when a state word exists: what the user may do is `gpui-kit`'s adjective (`scrollable`,
  `zoomable`, `selectable`, `resizable`), and only a feature with no adjective is `<feature>Enabled`
  (`pagingEnabled`, `javaScriptEnabled`; *guides* "a positive `enabled` / `visible` contract"); what something
  blocks is `disabled` (a menu item too, `PopupMenu::disabled`). Whether a part shows is a boolean named after the
  part, default `true` (`scrollbar`, `caret`: `scrollbar={false}`; decided by the user, 2026-10-21); where that name
  is already a slot it is `<part>Visible` (`headerVisible`, `headerBackVisible`: `header` is a page's slot), never
  `<part>Shown`, `<part>Hidden` or `shows<Part>`. What only reads a
  boolean (a constant, a payload's field) is `is<Adjective>` / `has<Noun>`, as `gpui-kit`'s readers (`isAvailable`,
  `isViewable`, `isBuffering`); props never are (*guides*: builders `disabled(bool)`, readers `is_disabled()`).
- **Begin and end**: a phase is `<act>Start` / `<act>End` (`gpui-kit`'s `on_start` / `on_end`: `onPanStart`,
  `onLoadStart`, `onScrollDragStart`, `onMomentumEnd`), never `Begin`. A pointer over a view is `onHoverIn` /
  `onHoverOut` (decided by the user, 2026-10-21), a file drag over it `onFileDragEnter` / `onFileDragLeave` (the DOM's
  `dragenter`).
- **Geometry**: shapes are GPUI's, the types Rust already has (`nsh_core::geometry`, `geometry.md`), exported by
  `nsh` with the same fields: `Point { x, y }`, `Size { width, height }`, `Bounds { origin: Point, size: Size }`,
  `Edges { top, right, bottom, left }` (decided by the user, 2026-10-21). A position and an extent together are a
  `Bounds` (`onLayout(bounds)`), an extent beside other fields is a `size` (`ImageAsset.size`), insets are `Edges`
  (`safeArea()`, `hitSlop`, `contentInset`; inputs take `Partial<Edges>`); never flat `x` / `y` / `width` / `height`
  together, `<prefix>Width` / `<prefix>X` fields or another name for one shape (`Insets`).
- **Points**: a position is a `Point` (`{ x, y }`, GPUI's `Point<Pixels>`, Rust `Point<Points>`), never separate
  `<prefix>X` / `<prefix>Y` fields: `position` in the view, `pagePosition` in the root view (the surface or its dialog),
  and the keys held as `modifiers` (`{ control, alt, shift, platform }`, GPUI's `Modifiers`: `platform` is Command on
  Apple platforms, the Windows / Super key elsewhere), as GPUI's `MouseMoveEvent { position, modifiers }` (decided by
  the user, 2026-10-21). The frozen responder events keep React Native's `locationX` / `pageX`.
- **Units**: one unit per quantity, everywhere, React Native's modules included. A length is points, an image's or a
  video's own size pixels (`PixelSize`, never `Size`: `onLoad`, `Image.getSize`, the clipboard's and the picker's
  images), a time milliseconds (`duration`, `delay`, `timeout`, `keyboardFrame().duration`), a velocity points per
  second (`PanEvent`'s, `PanResponder`'s `vx` / `vy`, an animation's `velocity`), a share a fraction from 0 to 1
  (`viewPosition`, `volume`, `ViewabilityConfig`'s thresholds; no `Percent` in names). Two exceptions keep the
  convention everyone knows: media time is seconds, as HTML's `currentTime` (`Video`'s `seek`, `onProgress`,
  `onLoad`), and a deceleration is the velocity kept per millisecond (`decelerationRate`, `Animated.decay`'s
  `deceleration`: UIKit's `0.998` / `0.99`) (decided by the user, 2026-10-27).
- **Intent over geometry**: an event says what the app should do when the act has a name (`onLoadMore`, as
  `gpui-component`'s `ListDelegate::load_more`), not where the user got to (`onEndReached`). Its counterpart at
  the start is the same act at the other end, `onLoadMoreAtStart` / `loadMoreAtStartThreshold` (React Native's
  `onStartReached`): the edge named as `Start` / `End` are, the act kept, and no `Newer` / `Older` that holds for a
  chat but not for every list.
- **Payloads**: a value's change is `on<Value>Change(next, details?)`, the value first and anything else after it
  (`onChange(text)`, `onOpenChange(open, reason)`); every other event passes one object, even with one field
  (`onLinkPress({ url })`, `onSubmit({ text })`), so a later field is an addition. An event with nothing to report
  passes nothing; it can gain an object later. Never several positional arguments outside the frozen modules.
- **Listening**: a function that starts listening returns a function that stops it (`() => void`), and what is
  registered while a component renders goes away with the component (`keymap.bind`); never React Native's
  `{ remove() }`. An app reads a setting of the system through its accessor (`reduceMotion()`), which is also how it
  follows the changes: no listeners or `Promise` getters beside it. `addEventListener` is only the DOM's, on the web
  globals.
- **Addresses**: what shows a resource takes it as `src` (`Image`, `Video`, `WebView`, `TextViewImage.src`, as HTML's
  `img`, `video` and `iframe`), any other address is a `url` (`ImageAsset.url`, `WebViewNavigation.url`); never
  `source` or `{ uri }` wrappers. `onFileDrop({ uris })` keeps its name (decided by the user, 2026-10-21). Inline content has its own prop (`html`,
  with `baseUrl`, as `srcdoc`).
- **Environment**: a value that can change while the app runs is an accessor (`colorScheme()`, `pixelRatio()`,
  `locale()`), with `set<Value>(value | "system")` when the app may override it (`setColorScheme`); a value fixed for the life of the engine is a constant (`platform.os`). Never React Native's
  static objects (`Platform.OS`, `PixelRatio.get()`, `I18nManager.isRTL`).
- **Parts**: a component's own `class` / `style` style its main part; every other part gets `<part>Class` /
  `<part>Style`, named after `gpui-base`'s part (`Dialog::backdrop` / `Dialog::popup`; `gpui-component`
  `Settings::header_style`). The part name never repeats the component (`contentStyle`, not `contentContainerStyle`:
  *guides* "Let the enclosing name carry the context").
- **Slots**: named after what they are, as `gpui-kit`'s slots are (`header`, `footer`, `trigger`, `content`, `empty`,
  `separator`: *guides*, `gpui-component` `Command::empty` / `header` / `footer`); an element or a component. Never
  React Native's `*Component` suffix.
- **State styles**: `active`, `hover`, `focus`, `disabled`, `selected` as `<state>:` classes and `<state>Style`
  objects (GPUI `InteractiveElement::active` / `hover`, `ButtonStyles::selected` / `disabled`). Later states win, and
  `disabled` wins over all (`state_style.rs` `resolve_style`). No per-feedback props (`activeOpacity`).
- **Roles, not looks**: a choice that means something says what (`role: "cancel" | "destructive"`, as SwiftUI's
  `ButtonRole`); a look is the app's (`gpui-component`'s `ok_variant` has no `nsh-base` counterpart). An element's
  accessibility role is `role` (GPUI `.role(Role::…)`, `Button::role`), its name `accessibilityLabel`
  (`Button::accessibility_label`).
- **Colors are styles**: a color of a part or a pseudo-element is a style key with its class (`placeholderColor`,
  `selectionColor`), not a prop.
- **Platform props only for platform-only things**: something two platforms do is a top-level prop, ignored (and
  documented as such) where it does not apply. One name per concept, never the same prop under `ios` and `desktop`.
- **Accessors** are named after what they read (`safeArea()`, `windowSize()`, `titleBar()`); they never differ from
  a module's name by case only.
- **Navigation verbs** are `gpui-base`'s: `push`, `pop`, `popToRoot`, `replace` (`NavStackState`); replacing all is
  `set<Field>` (*guides* "In-place mutation: `set_<field>`").

## When `gpui-base` is not followed

`gpui-base` is the reference, not a rule above judgment: a name is not taken when it reads worse for TSX apps on
every platform, as the user decided (2026-10-20) for `onSubmit` (a phone's return key is not Enter), `animation`
(`transition` is a style key), `multiline` (one word) and a page's `onDismiss`. Each such row says "not followed" and why.

## Shapes that can grow

Apps built once run on every later release (`compatibility.md`): types only widen and inputs only gain optional
members, so a shape decides what can ever be added to it.

- Options are one object (`scrollTo({ x, y, animated })`), never a third positional parameter.
- A mode is a string union, which gains values; never a boolean that later needs a third state.
- A value has one type: `version: string`, never `string | number`.
- What a function returns is an object, never a tuple (beside `split`'s, Solid's) or a bare value that may need a second field.
- Event payloads and listening follow the rules above (objects, `() => void`).

## Renames before the first compatible release

Decided with the user (2026-10-21), before v0.1.2: these land without `@deprecated` aliases, as no release froze
them yet (`compatibility.md`). The frozen RN-shaped modules keep their names. A name that already follows `gpui-kit` stays, even where another spelling would do
(*guides*: "Preserve established public names when changing them would cause needless churn"): `pagingEnabled`,
`javaScriptEnabled`, `screenReaderEnabled`, `headerBackVisible`, `isAvailable`, `selectable`, `disabled`,
`onHoverIn` / `onHoverOut` and `onFileDrop({ uris })`; and
`StatusBar`'s `hidden`, as the user decided on 2026-10-20 after UIKit's `prefersStatusBarHidden`.

| Now | New | Rule | Notes |
|---|---|---|---|
| **Scroll, List, WebView** | | | |
| `scrollEnabled` | `scrollable` (default `true`) | States | The user's scrolling; `scrollTo` still scrolls |
| `pinchGestureEnabled` | `zoomable` (default `true`) | States | The user's pinch; `zoomTo` still zooms |
| `showsIndicator` | `scrollbar` (default `true`) | States | The part's name, as `caret` |
| `onScrollBeginDrag`, `onScrollEndDrag` | `onScrollDragStart`, `onScrollDragEnd` | Begin and end | `onDrag*` stays free for drag and drop |
| `onMomentumScrollBegin`, `onMomentumScrollEnd` | `onMomentumStart`, `onMomentumEnd` | Begin and end | |
| List `onEndReached`, `onEndReachedThreshold` | `onLoadMore`, `loadMoreThreshold` | Intent over geometry | `ListDelegate::load_more`, `load_more_threshold`; also in `ListItemsProps` |
| List `onViewableItemsChanged` | `onViewableItemsChange` | Events | |
| `ViewabilityConfig` `itemVisiblePercentThreshold`, `viewAreaCoveragePercentThreshold` (0 to 100) | `itemVisibleThreshold`, `viewAreaCoverageThreshold` (0 to 1) | Units | IntersectionObserver's `threshold` |
| **Every element** | | | |
| Input `caretHidden` | `caret` (default `true`) | States | Decided by the user: the part's name, as `scrollbar`; replaces the 2026-10-20 row keeping it |
| `HoverEvent` (`onHoverMove`) `locationX` / `locationY`, `pageX` / `pageY`, `altKey` / `ctrlKey` / `metaKey` / `shiftKey` | `{ position: Point; pagePosition: Point; modifiers: Modifiers }` | Points | GPUI `MouseMoveEvent`; new types `Point`, `Modifiers` in `nsh` |
| `ContextMenuEvent` (`onContextMenu`), the same fields | the same shape | Points | `Menu.popup(items, e.pagePosition)` |
| `onLayout(e: LayoutEvent)` `{ x, y, width, height }` | `onLayout(bounds: Bounds)` | Geometry | `LayoutEvent` dropped |
| `ref.measure()` → `{ x, y, width, height, pageX, pageY }` | `{ bounds: Bounds; pagePosition: Point }` | Geometry | |
| `ScrollEvent` (`onScroll`) `{ x, y, contentWidth, contentHeight, width, height, zoomScale }` | `{ offset: Point; contentSize: Size; size: Size; zoomScale }` | Geometry | The other scroll events' `{ x, y }` is the offset's `Point` already |
| `OverlayPosition` `{ placement, x, y, width, height, availableWidth, availableHeight }` | `{ placement; bounds: Bounds; available: Size }` | Geometry | |
| `TextLayoutLine` `{ text, x, y, width, height, ... }` | `{ text; bounds: Bounds; ... }` | Geometry | `ascender` / `descender` / `capHeight` / `xHeight` stay |
| `Insets` (type) | `Edges` | Geometry | `safeArea()`, `safeAreaInsets()`; `hitSlop` / `contentInset` take `number \| Partial<Edges>` / `Partial<Edges>` |
| `contentOffset`, `Overlay` `anchor`, `Menu.popup`'s `at` | typed `Partial<Point>` / `Point` | Geometry | Same fields |
| `nsh/desktop` `WindowFrame` `{ x, y, width, height, animated, anchorTop }` | `{ origin?: Partial<Point>; size?: Partial<Size>; animated; anchorTop }` | Geometry | |
| `windowSize()`, `ImageSize`, Image `onLoad`, `onContentSizeChange` | typed `Size` | Geometry | Same fields; pixel sizes are `PixelSize` (next row) |
| `ImageSize`, Image and Video `onLoad`'s, `ClipboardImage`'s and `PickedImage`'s `Size` (pixels) | `PixelSize` | Units | Same fields; `Size` is points |
| `PanResponder` `vx` / `vy` (points per millisecond), `keyboardFrame().duration` (seconds) | points per second, milliseconds | Units | |
| `ImageAsset` / `ClipboardImage` `{ url, width, height }`, Video `onLoad` `{ duration, width, height }` | `{ url; size: Size }`, `{ duration; size: Size }` | Geometry | |
| **Image** | | | |
| `src: string \| ImageAsset \| { uri }` | `src: string \| ImageAsset` | Addresses | |
| `defaultSource` | `placeholder: string \| ImageAsset` | Addresses | Shown until `src` loads, as `Input`'s `placeholder` until text |
| `Image.getSize(source)`, `Image.prefetch(source)` | `(src: string \| ImageAsset)` | Addresses | |
| `ImageAsset.uri` | `ImageAsset.url` | Addresses | What `import logo from "./logo.png"` gives |
| **Video** | | | |
| `source: string \| { uri }` | `src: string` | Addresses | |
| **WebView** | | | |
| `source: string \| { uri } \| { html, baseUrl }` | `src?: string`; `html?: string`, `baseUrl?: string` | Addresses | One of `src` and `html` |
| the page's `window.ReactNativeWebView.postMessage(data)` | `window.nsh.postMessage(data)` | Where names come from | Decided by the user: only `window.nsh` is injected |
| **NavPage** | | | |
| `headerShown` | `headerVisible` (default `true`) | States | `header` is the page's slot; as `headerBackVisible`, which stays |
| **TextView** (`nsh/base`) | | | |
| `onLinkPress(url)` | `onLinkPress({ url })` | Payloads | |
| `caret` (a slot: the streaming reply's caret) | `streamingCaret` | States | Input's boolean `caret` is the part's switch; `cursor` is a style key. Rust `streaming_caret` |
| `codeBlockScrollIndicator`, `tableScrollIndicator` | `codeBlockScrollbar`, `tableScrollbar` (default `true`) | States | As `scrollbar`. Rust `code_block_scrollbar`, `table_scrollbar` |
| **`nsh/desktop`** | | | |
| `MenuItem.enabled` | `MenuItem.disabled` | States | |
| **`nsh`: the environment** | | | |
| `Platform.OS`, `Platform.Version`, `Platform.constants` | `platform.os`, `platform.version: string` | Environment | A constant object; Android's version is its API level as a string (`"35"`) |
| `Platform.isPad`, `isTV`, `isDesktop`, `isMacCatalyst`, `constants.interfaceIdiom` | `platform.idiom: "phone" \| "pad" \| "mac" \| "tv" \| "desktop"`, `platform.catalyst` | Environment | `isDesktop` becomes `platform.idiom === "desktop" && !platform.isTerminal` for graphical desktop behavior; `platform.renderer` and `platform.isTerminal` distinguish terminal presentation |
| `Platform.select(spec)` | `platform.select(spec)` | Environment | Same spec |
| `PixelRatio.get()` | `pixelRatio(): number` (accessor, reactive) | Environment | Follows the window to another screen |
| `PixelRatio.getFontScale()` | `fontScale()` | Environment | Already exists |
| `PixelRatio.getPixelSizeForLayoutSize`, `roundToNearestPixel` | (dropped) | | `Math.round(x * pixelRatio()) / pixelRatio()` |
| `I18nManager` (`isRTL`, `allowRTL`, `forceRTL`, `doLeftAndRightSwapInRTL`, `getConstants`) | (dropped) | Where names come from | Decided by the user: the layout direction follows the locale, a view's `direction` style overrides it (Rust: `.direction(LayoutDirection::..)`; Rust's `rtl()`, `force_rtl` and `allow_rtl` are dropped too); translations, when NSH has them, come from rust-i18n |
| `OS` (type) | unchanged | | `platform.os`'s type |
| **`nsh`: accessibility** | | | |
| `AccessibilityInfo.isScreenReaderEnabled()`, `isReduceMotionEnabled()`, `addEventListener` | (dropped) | Listening | `screenReaderEnabled()`, `reduceMotion()` |
| `AccessibilityInfo.announceForAccessibility(message)` | `announce(message)` | Environment | A function of the module |
| `AccessibilityInfo.setAccessibilityFocus(node)` | `setAccessibilityFocus(node)` | Environment | A function of the module; `focus()` is the keyboard's |
| **`nsh/mobile`: `BackHandler`** | | | |
| `BackHandler.addEventListener("hardwareBackPress", l)` → `{ remove() }` | `BackHandler.onBackPress(l)` → `() => void` | Listening | Removed with the component it was added in; `l` returns `true` when it handled the press. As `NavPage`'s `onBackPress` |
| **`nsh`: `Clipboard`** | | | |
| `getString`, `setString`, `hasString` | `readText()`, `writeText(text): Promise<void>`, `hasText()` | Where names come from | The DOM's `navigator.clipboard`; GPUI's `read_from_clipboard` / `write_to_clipboard` |
| `getImage`, `setImage`, `hasImage`, `getFiles` | `readImage()`, `writeImage(src)`, `hasImage()`, `readFiles()` | Where names come from | |
| `ClipboardImage.uri` | `ClipboardImage.url` | Addresses | |
| **`nsh`: `Storage`** | | | |
| `Storage.getAllKeys()` | `Storage.keys()` | Where names come from | `getItem` / `setItem` / `removeItem` / `clear` are the DOM's `Storage`'s |
| **Styles** | | | |
| `experimental_backgroundImage` | (dropped) | Where names come from | React Native's name of `backgroundImage` |

## Renames

Decided with the user (2026-10-20): components take `gpui-base`'s names too, the dismissal flags default to `true`,
and `Input`'s React Native names follow the rules as well.

| Now | New | Precedent | Notes |
|---|---|---|---|
| **Components** | | | |
| `Stack`, `StackProps` (`navigator`) | `NavStack`, `NavStackProps` (`state`) | `nav_stack.rs` `NavStack`, `NavStackState` | |
| `Screen`, `ScreenProps` | `NavPage`, `NavPageProps` | `nav_stack.rs` `NavPage` | |
| `createNavigator`, `Navigator<R>` | `createNavStack(routes: R[])`, `NavStackState<R>` | `NavStackState::new` | |
| `Modal`, `ModalProps` | `Dialog`, `DialogProps` | `dialog.rs` `Dialog` ("a modal surface") | One component, `presentation` picks the native form; `Sheet` stays the name of a future edge panel drawn with primitives (`sheet.rs`) |
| `Alert`, `ActionSheet` | `AlertDialog` | `alert_dialog.rs` `AlertDialog` | Below |
| **Modal** | | | |
| `visible` | `open` (default `true`) | `dialog.rs` `Dialog::open` (default `true` in `Dialog::new`) | |
| `onRequestClose` | `onCancel()` (the attempt) + `onOpenChange(false, reason)` (it closed) | `Dialog::on_cancel`, `Dialog::on_open_change`, `DialogChangeReason` | `reason`: `"backdropPress" \| "cancel" \| "swipe"`; `"swipe"` (an iOS / phone browser sheet pulled down) has no precedent |
| `dismissible` | `closeOnEscape`, `closeOnBackdropPress`, `closeOnSwipe` (default `true` each) | `Dialog::close_on_escape`, `Dialog::close_on_backdrop_press` | `closeOnSwipe` by analogy. Default flips: today nothing closes natively |
| `onShow` | `onOpen` | `DialogTrigger::on_open` | After the entrance transition |
| `onDismiss` | `onClose` | `Dialog::on_close`, `Sheet::on_close` | Also when the app removed it |
| `animationType` | `animation` | none (`NavStack::transition` not followed) | Same prop as NavPage's; values stay. `transition` is a style key (style transitions), and `gpui-base`'s `Transition` is timing, not a preset |
| `transparent` | (dropped) | `Dialog::backdrop` / `Dialog::popup` own no look (*AGENTS* "Base controls are no-style") | Nothing NSH draws has a background; the app styles the popup and the backdrop |
| `ios` / `desktop` / `web` `presentationStyle` | `presentation` | none (UIKit `modalPresentationStyle`) | Top-level; `Style` is reserved for style objects |
| (new) | `class` / `style` style the popup; `backdropClass` / `backdropStyle` | `Dialog::popup`, `Dialog::backdrop` (`DialogPopup`, `DialogBackdrop`) | `Sheet`'s `overlay` / `surface` are the same parts; `Dialog`'s names win as the primary modal host |
| **Screen** | | | |
| `headerTintColor`, `headerBackgroundColor`, `headerTitleColor` | `headerStyle={{ backgroundColor, color, tintColor }}`, `headerClass` | `gpui-component` `Settings::header_style` | `color` is the title's, `tintColor` the buttons'; only these keys |
| `ios` / `desktop` `headerLargeTitle` | `headerLargeTitle` | none | Top-level |
| `ios` / `desktop` `headerBackTitle` | `headerBackTitle` | none | Top-level |
| `onDismiss` | unchanged | `NavStackEvent::Popped` (not followed) | The user popped it (back button, swipe). Decided by the user: a page leaving the stack is dismissed, as UIKit says |
| `preventBack` | `popOnBack` (default `true`; `false` = `preventBack`) | `Dialog::close_on_escape` | By analogy: `popOn<Trigger>` as `closeOn<Trigger>`; covers every back (header, Android back, swipe) |
| `onBackRequest` | `onBackPress` | `DialogChangeReason::*Press`; `BackHandler`'s `"hardwareBackPress"` | Fires on every back press, before the pop when `popOnBack` allows it |
| `gestureEnabled` | `popOnSwipe` (default `true`) | `Dialog::close_on_backdrop_press` | By analogy; the interactive gesture only, the buttons still pop |
| `animation` | unchanged | | As Dialog's |
| (new, desktop / web header) | `header` | *guides* named slots (`header`, `footer`) | Top-level slot: the whole bar where NSH draws it |
| **Navigator** | | | |
| `push`, `pop(count?)`, `replace` | unchanged | `NavStackState::push` / `pop` / `replace` | |
| `popToTop` | `popToRoot` | `NavStackState::pop_to_root` | |
| `reset(routes)` | `setRoutes(routes)` | *guides* `set_<field>` (`set_items`) | `NavStackState::clear` empties, which a stack of screens cannot |
| `remove(route)` | unchanged | none | |
| `createNavigator(initial: R \| R[])` | `createNavigator(routes: R[])` | `NavStackState::new` then `push` | One shape |
| **Alert, ActionSheet** | | | |
| `Alert.alert(title, message, buttons, options)`, `ActionSheet.show(options)` | `AlertDialog.show({ title, description, actions, presentation, closeOnEscape, closeOnBackdropPress })` → `Promise<string \| null>` | `alert_dialog.rs` `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` | Resolves with the action's `id` (its `label` without one), `null` when closed without an action |
| `message` | `description` | `AlertDialogDescription`, `DialogDescription` | |
| `buttons` / `options` (+ `cancelButtonIndex`, `destructiveButtonIndexes`) | `actions: { label, role?, id? }[]` | `AlertDialogAction`; *guides* fluent property `label` | One shape for both |
| `AlertButton.text` | `label` | `gpui-component` `Button::label` | |
| `AlertButton.style: AlertButtonStyle` | `role: "default" \| "cancel" \| "destructive"` | `AlertDialogCancel`; GPUI `Role`; SwiftUI `ButtonRole` | A role, not a look |
| `ActionSheet` (a module) | `presentation: "alert" \| "actionSheet"` | none (UIKit `preferredStyle`) | Default `"alert"`; same word as Modal's `presentation` |
| `AlertOptions.cancelable` | `closeOnEscape` + `closeOnBackdropPress` | `AlertDialog::close_on_escape`; `Dialog::close_on_backdrop_press` | Default `false` for `"alert"` (`AlertDialog` has no backdrop dismissal), `true` for `"actionSheet"` |
| **StatusBar** | | | |
| `StatusBar` (a component; the most recently mounted wins) | `statusBar?: StatusBar` on `NavPage` and `Dialog`; `nsh.json` `"statusBar"` for the default | UIKit: each view controller's `preferredStatusBarStyle` / `prefersStatusBarHidden`, the topmost deciding; Info.plist `UIStatusBarStyle` / `UIStatusBarHidden`; `gpui-base` has none | Decided by the user (2026-10-20): the status bar follows UIKit; pages and dialogs are NSH's view controllers. Rust: `Screen::status_bar`, `Modal::status_bar`, `Root::status_bar` |
| `foreground: "auto" \| "light" \| "dark"` (`Foreground`) | `foreground` of `StatusBar` (`StatusBarForeground`) | none; `gpui-kit` theme `foreground` (the content's color) | Not `style` (the inline style every component takes); `"light"` is light content, for dark backgrounds |
| `hidden`, `animated` | fields of `StatusBar` | `NavMotion::Animated` (UIKit `animated:`) | `nsh.json` takes `foreground` and `hidden` |
| `StatusBar.setBarStyle`, `StatusBar.setHidden`, `BarAnimation` | (dropped) | | The pages and dialogs are the API |
| `android.backgroundColor`; Android's `setStatusBarBackgroundColor` | (dropped) | | Edge-to-edge (API 35) has no bar color |
| **Keyboard** | | | |
| `keyboard` (accessor) | `keyboardFrame` | none (UIKit's `keyboardFrameEndUserInfoKey` and animation duration arrive together) | Differed from `Keyboard` by case only; `Keyboard.dismiss()` unchanged |
| **List, Scroll** | | | |
| `ListHeaderComponent`, `ListFooterComponent` | `header`, `footer` | `gpui-component` `Command::header` / `footer`; *guides* named slots | Also in `ListItemsProps` |
| `ListEmptyComponent` | `empty` | `Command::empty` | |
| `ItemSeparatorComponent` | `separator` | `Command::separator` | |
| List `contentContainerStyle` | `contentStyle` (padding and gaps only), `contentClass` (`p-*`, `gap-*`) | *guides* "Let the enclosing name carry the context" | Same names as Scroll's, a narrower type |
| Scroll `contentContainerStyle`, `contentContainerClass` | `contentStyle`, `contentClass` | as above; *guides* slot `content` | |
| **Input** | | | |
| `blurOnSubmit` | (dropped) | | `submitBehavior` covers it |
| `placeholderTextColor` | style key `placeholderColor`, class `placeholder:text-*` | *guides* `value` vs `presentation`; CSS `::placeholder` | |
| `selectionColor` (Input, Text) | style key `selectionColor` (the highlight), class `selection:text-*` | CSS `::selection` | |
| `cursorColor` (Input) | style key `caretColor`, class `caret-*` | CSS `caret-color` | |
| `editable` | `readonly` (`editable={false}` = `readonly`) | *guides* "readonly"; `gpui-component` `Input::readonly` | `disabled` (no focus, `disabled:` classes) stays separate |
| `onChangeText(text)` | `onChange(text)` | `InputEvent::Change`; `on_change` observes (*guides*) | |
| `onSubmitEditing` | `onSubmit` | `InputEvent::PressEnter` (not followed) | The return key, whatever `returnKeyType` shows: on a phone it says Done / Search / Go, not Enter; HTML's `submit` |
| `secureTextEntry` | `masked` | `gpui-component` `Input::masked` | |
| `multiline` | unchanged | `Input::multi_line` (not followed) | One word, as `readonly` |
| `selection` | `selectedRange` | `Input::selected_range` | `onSelectionChange` stays |
| `autoFocus`, `maxLength`, `keyboardType`, `returnKeyType`, `submitBehavior`, `autoCapitalize`, `autoCorrect`, `autoComplete`, `caretHidden`, `onKeyPress`, `onContentSizeChange`, `allowFontScaling`, `maxFontSizeMultiplier`, `ios.textContentType` | unchanged | none | No `gpui-kit` term differs; `textContentType` stays iOS's |
| **View** | | | |
| `accessibilityRole` | (dropped; `role` stays) | GPUI `.role(Role::…)`; `Button::role` | |
| `activeOpacity` | `activeStyle={{ opacity }}` or `active:opacity-*` | GPUI `InteractiveElement::active` | |
| `underlayColor`, `underlayOpacity` | `activeStyle={{ backgroundColor }}`; children `group-active:opacity-*` | as above | Native while pressed, as today |
| (new) | `hoverStyle`, `focusStyle`, `disabledStyle` | GPUI `hover` / `focus`; `ButtonStyles::disabled` | As the `<state>:` classes |
| `focusable` | unchanged; Rust `.focusable(..)` | GPUI `FocusHandle::tab_stop`; the web's `tabIndex` | React Native's meaning: `true` makes any view a Tab stop, whether or not it takes presses (a chart in a pressable card), `false` keeps a pressable out; unset, the pressables are stops (`ViewProps::focus_stop`). No `tabStop` or `focusStop` beside it: one name for one concept |
| **Button** (`nsh/base`) | | | |
| `disabled`, `selected`, `accessibilityLabel` | unchanged | `button.rs` `Button::disabled`, `selected`, `accessibility_label` | Add `role` (`Button::role`) |
| `onPress` | unchanged | `gpui-base`'s *press* (`DialogChangeReason::TriggerPress`, `close_on_backdrop_press`) over `Button::on_click` | Every view has them: one word for one concept across `nsh` and `nsh/base` (*guides*); touch, pen, mouse and keyboard activation are presses, *click* is a mouse's (*guides* "Use `on_click` only for a genuine click-level contract") |
| `onPressIn`, `onPressOut` (every view, Button) | `onPressDown`, `onPressUp` | UIKit `.touchDown` / `.touchUp*`; GPUI `on_mouse_down` / `on_mouse_up` | Decided by the user: *down* / *up* are both frameworks' words, *press* any input's; `onPressUp` is the press's end (released, moved away or cancelled). Rust `on_press_down` / `on_press_up` |
| `selected` styles | `selectedStyle`, `selected:` classes | `ButtonStyles::selected` | |
| `checked` styles (new) | `checkedStyle`, `checked:` classes | `CheckboxStyles::checked`, `SwitchStyles::checked`, `RadioStyles::checked` | From `accessibilityState.checked`; mixed is not checked |
| `indeterminate` styles (new) | `indeterminateStyle`, `indeterminate:` classes | `CheckboxStyles::indeterminate`, `CheckboxIndicatorStyles::indeterminate`; CSS `:indeterminate`, Tailwind `indeterminate:` | From `accessibilityState.checked` mixed |
| **Switch** (`nsh/base`) | | | |
| `SwitchTrack`, `SwitchThumb` (components the app nests in `Switch`, each given `checked`) | `trackClass` / `trackStyle`, `thumbClass` / `thumbStyle` of `Switch` | `switch.rs` `SwitchTrack`, `SwitchThumb`; `Dialog::backdrop` / `Dialog::popup` → `backdropClass` | Parts, as Dialog's: `Switch` renders the track, the thumb inside it, then its children, and shows its `checked` and `disabled` to them (`Interactive::project_checked` / `project_disabled`), so the app passes the value once and only the switch is an accessibility element |
| `SwitchTrackStyles` / `SwitchThumbStyles` `checked`, `disabled` | `checked:` / `disabled:` in `trackClass` / `thumbClass`; Rust `.checked(..)` / `.disabled_style(..)` in `track_style` / `thumb_style` | `SwitchStyles::checked` → `checkedStyle` | A part takes one class and one style; their state variants are its states |
| `Switch::tab_index`, `tab_stop`, `track_focus` | (left out) | | The keyboard focus follows the view tree, as `Button`'s does |
| **Checkbox** (`nsh/base`) | | | |
| `Checkbox::state(CheckboxState)` (`Unchecked`, `Checked`, `Indeterminate`) | `checked`, `indeterminate` (booleans) | `checkbox.rs` `Checkbox::checked`, `Checkbox::indeterminate` | The two builders `gpui-base` also has, as props; props have no order, so `indeterminate` wins while it holds (as `checked(true).indeterminate(true)` does). No `CheckboxState` type |
| `Checkbox::on_change(CheckboxState, &ClickEvent, ..)` | `onChange(checked: boolean)` | `CheckboxState::activated` | The next state is never indeterminate (`true` from unchecked and indeterminate, `false` from checked), so it is a boolean, as `Switch`'s |
| `CheckboxIndicator` (a component the app nests in `Checkbox`, given `state` and `disabled`, with children) | `indicatorClass` / `indicatorStyle` of `Checkbox`, its children the `indicator` slot | `checkbox.rs` `CheckboxIndicator`; `Switch`'s `trackClass`; `NavPage`'s `header` slot with `headerClass` / `headerStyle` | A part, as `Switch`'s track: `Checkbox` renders the indicator, then its children, and shows its `checked`, `indeterminate` and `disabled` to it (`Interactive::project_checked` / `project_indeterminate` / `project_disabled`); the indicator's children (the mark) are a slot named after the part |
| `CheckboxIndicatorStyles` `checked`, `indeterminate`, `disabled` | `checked:` / `indeterminate:` / `disabled:` in `indicatorClass`; Rust `.checked(..)` / `.indeterminate(..)` / `.disabled_style(..)` in `indicator_style` | `CheckboxStyles::checked` → `checkedStyle` | As `Switch`'s parts |
| `Checkbox::role(RoleOverride)` | `role` (default `"checkbox"`) | `Button::role` | `RoleOverride::Presentational` is `role="none"` |
| `Checkbox::tab_index`, `tab_stop`, `track_focus` | (left out) | | The keyboard focus follows the view tree, as `Button`'s does |
| **Radio** (`nsh/base`) | | | |
| `Radio::on_change(bool, &ClickEvent, ..)` | `onChange(checked: boolean)` | `radio.rs` `Radio::on_change` | Only an unchecked, enabled radio reports, and always `true`: a radio cannot uncheck itself |
| `Radio::set_position(position, size)` | (left out) | | NSH's accessibility state has no position in a set yet; added when every platform can carry it |
| `Radio::id`, `tab_index`, `tab_stop`, `track_focus` | (left out) | | Identity is the element's; the keyboard focus follows the view tree, as `Button`'s does |
| `RadioGroup::axis(Axis)` | (left out) | `radio_group.rs` (`aria_orientation`); `gpui-shell`'s `axis` ("semantic only") | It sets only the orientation screen readers hear, which NSH's accessibility layer does not carry yet; the layout is the app's `class` (`flex-row`) |
| `accessibility_label` on a `RadioGroup` (`gpui-shell`, any element) | (left out) | | A labelled container is one element on iOS, which would hide the radios inside it; added with a container that keeps its children elements |
| **Tabs** (`nsh/base`) | | | |
| `Tab::on_click(&ClickEvent, ..)` | `onPress()` | `tabs.rs` `Tab::on_click`; `Button`'s `onPress` | Press, not click (above), as `Button`'s; every press reports, the selected tab's included, as `Tab::on_click` does |
| `Tab::set_position(position, size)` | (left out) | | As `Radio::set_position`: NSH's accessibility state has no position in a set yet |
| `Tab::id`, `Tabs::new(id)` | (left out) | | Identity is the element's (`testID` for tests), as `Radio::id` |
| A tab outside the keyboard focus until its list has roving focus (`Tab`'s doc comment) | each enabled tab is a focus stop, Space / Return press it | `Button`, `Radio` | The keyboard focus follows the view tree, so keyboard users reach every tab; arrow keys, Home / End and roving focus come with the tab list's keyboard model (`gpui-base`'s TODO) |
| `Tab`'s own layout (`flex`, `items_center`, `justify_center`, a line height of 1) | (none) | `Button` (no layout of its own) | The layout is the app's `class` and `style`, as `Button`'s; centering is `items-center justify-center` |
| **Collapsible** (`nsh/base`) | | | |
| `Collapsible::reveal(id, progress)` (`MotionReveal`: the content kept mounted, its measured height times `progress`, clipped) | (left out) | | NSH's layout has no height that is a fraction of the content's own; until the core has one, the app animates what it shows (opacity, a transform) |
| Children and `content` in the order the builder was called | children first, `content` after them | `gpui-shell`'s `Collapsible` (`materialize/components/collapsible.rs`) | JSX gives a slot no place among the children; what expands goes under what shows always, as in `gpui-shell` |
| **Progress** (`nsh/base`) | | | |
| `ProgressTrack`, `ProgressIndicator` (components the app nests in `Progress`) | `trackClass` / `trackStyle`, `indicatorClass` / `indicatorStyle` of `Progress` | `progress.rs` `ProgressTrack`, `ProgressIndicator`; `Switch`'s `trackClass` | Parts, as `Switch`'s: `Progress` renders the track, the indicator inside it, then its children, so only the progress bar is an accessibility element |
| The indicator's width (the app's, from its own copy of the value) | `value` percent of the track's width while determinate; an app's `w-*` / `width` on the indicator wins | `gpui-component`'s `Progress` (`progress/progress.rs`: the indicator `.w(relative(value / 100))`) | The progress bar renders the indicator, so it sizes it by the value it already has; while `indeterminate` the width is the app's |
| `Progress::new(id)` | (left out) | | Identity is the element's (`testID` for tests), as `Radio::id` |
| **Slider** (`nsh/base`) | | | |
| `SliderState` (an entity the app holds: `default_value`, `set_value`, `value`) passed to `Slider::new(&state)` | `value` (controlled) + `onChange(next)`, `defaultValue` (uncontrolled) | `slider.rs:170`, `:266`, `:273`; Value state | The app owns the value, as every control's; `defaultValue` as `SliderState::default_value` |
| `SliderValue::Single(f32)` / `Range(f32, f32)` | `number \| [number, number]` (`SliderValue`; Rust `f64`) | `slider.rs:29-32` | JS's numbers are `f64`: an `f32` `0.1` reaches JS as `0.10000000149011612` |
| `SliderEvent::Change` on every pointer update (the same value again included) | `onChange(value)` when the value changes | `slider.rs:16-17`, `:391` | A move within one step reports nothing |
| `SliderEvent::Release` | `onChangeEnd(value)` | `slider.rs:18-19`, `:411-417`; Begin and end | The change's phase, `<act>End`: it also ends a key's or a screen reader's change, where nothing is released; once per pointer gesture that set a value, as `handle_release` |
| `Slider::axis(Axis)`, `horizontal()`, `vertical()` | `axis: "horizontal" \| "vertical"` (default `"horizontal"`), read when made | `slider.rs:463-476` | As `ResizablePanelGroup`'s `axis`; a vertical slider has `min` at the bottom (`slider.rs:370`) |
| `SliderTrack`, `SliderIndicator`, `SliderThumb` (components the app nests, given the state) | `trackClass` / `trackStyle`, `indicatorClass` / `indicatorStyle`, `thumbClass` / `thumbStyle` of `Slider` | `slider.rs:564`, `:742`, `:799`; `Switch`'s `trackClass` | Parts, as `Switch`'s: the track takes the presses, the indicator is the rail the values map onto (its bounds, `slider.rs:783-793`), the thumbs sit on it centered on their values |
| The filled stretch (`gpui-component`'s plain `div` in the indicator) | `rangeClass` / `rangeStyle` | `gpui-component` `slider.rs:304-315` | No `gpui-base` part: parts take no children in NSH, so the slider places it (from `min` to the thumb, between a range's thumbs); named after what it shows, Radix's `Range` |
| `(value / step).round() * step` | snapped from `min`, `max` always reachable (the last step shorter), held to the range | `slider.rs:382` | Values of a range starting off the step's grid (`min` 1, `step` 2) fell between its steps, and could pass `max` |
| `SliderScale::Logarithmic` with `min <= 0` panics | `scale="logarithmic"` is linear there | `slider.rs:213-262` | A prop cannot panic the app |
| `Role::Slider` on the root with one value (a range's end), `aria_numeric_value_step`, `aria_orientation` | each thumb an `adjustable` element: its label, its value as text between the values it can take (a range's start up to the end) | `slider.rs:512-524` | A screen reader reaches and sets both thumbs of a range; NSH's accessibility layer carries no step or orientation yet (as `RadioGroup::axis`) |
| `accessibility_label` | `accessibilityLabel` (a range's end thumb) and `startAccessibilityLabel` (its start, default `accessibilityLabel`) | `slider.rs:484`, `SliderThumb::start` (`:824`) | A range has two elements to name, and NSH has no built-in strings |
| Increment / decrement: `set_value(end ± step)` (a range collapses to one value, no event) | the thumb's step, snapped, `onChange` and `onChangeEnd` | `slider.rs:528-547` | Each thumb steps itself, and the app hears it |
| (no keyboard) | each thumb a Tab stop; Right / Up and Left / Down a step, Page Up / Page Down a tenth of the range (on its scale; a step at least), Home / End as far as the thumb goes; each key `onChange` and `onChangeEnd` | WAI-ARIA APG slider pattern | `gpui-base` has none; `nsh-base` owns the behavior since NSH has no styled layer |
| A thumb drag puts the thumb under the pointer | the thumb moves by the pointer's offset | `slider.rs:869-883` | No jump of up to half a thumb when it is grabbed off its center |
| Two thumbs at one value: the dragged one is held by the other (`set_start` / `set_end`) | a drag that starts on them moves the one that can go the pointer's way, and keeps it (it stops at the other) | `slider.rs:106-120`, `:375-379` | They never stick together |
| `gpui-component`'s thumb ring (a spring on hover and press) | `hover:`, `active:` (while dragged), `focus:` on `thumbClass`; `group-*` from the track | `gpui-component` `slider.rs:14-82` | The look and its motion are the app's (`transition-*`, `motion-reduce:`); `gpui-base` has none |
| `gpui-component` `Slider::reverse()` | (left out) | `gpui-component` `slider.rs:141` | A look of the styled layer: the app's `rangeClass` |
| **Plot** (`nsh/base/plot`) | | | |
| `trait Plot` (a struct of the app's that paints its scales and shapes) | `Plot`, a component: `data`, `x`, `y`, `xScale`, `yScale`; the marks its children | `plot/mod.rs:107` `Plot`, `element.rs:30` `PlotElement`; `gpui-component`'s `LineChart` (`chart/line_chart.rs`) | In TSX the chart is a tree, not a `paint` method: `Plot` owns what gpui-base's `paint` builds each frame (the scales from the bounds) and what `PlotElement` tracks (the pointer); the marks read it from context |
| `data` per shape (`shape/line.rs:47`, `shape/area.rs:38`) | `data` of `Plot`, shared by its marks; `data` / `x` of a `Line` or `Area` for a series of its own | `shape/line.rs:47-65`, `shape/area.rs:38-62` | One set of rows and scales per chart is the common case and keeps the hover's row one index; a mark with rows of its own is placed on the same scales |
| `Line::x` / `y`, `Area::x` / `y1` (closures returning pixels) | `x` / `y` / `y1`: a key of the rows (read natively) or the app's function `(d, index) => number`, scaled by the plot | `shape/line.rs:56`, `:65`; `shape/area.rs:47`, `:62` | The scale is the plot's (its range is the plot's size, which the app does not hold); a function is called once per row when the rows or the function change, in the next JS turn, never while drawing or hovering |
| `ScaleLinear::new(domain, range)`, `ScalePoint::new(domain, range)` | `xScale` / `yScale`: `{ type: "linear", domain? }`, `{ type: "point" }` | `scale/linear.rs:8`, `scale/point.rs:10` | The range is the plot's size. A `point` scale places the rows in order (`tick_at`, one entry per row); a `linear` domain is the extent of what the plot draws without one; `padding` is the band scale's (below) |
| A linear domain of one value: no position | its middle | `scale/linear.rs` `tick` (`None` when `domain_diff` is zero); d3's `scaleLinear` (the midpoint) | A flat series is still a line (d3, which `gpui-base` cites as its reference) |
| `Grid::x` / `y` (pixels) | values of the plot's x / y scale (row indices on a `point` scale) | `grid.rs:20`, `:26` | Pixels are the plot's to place, as above |
| `stroke`, `stroke_width`, `fill`, `dash_array` (builders of each shape) | the paint style keys `stroke`, `strokeWidth`, `fill`, `strokeDasharray` (`stroke-*`, `fill-*`), `currentColor` where none is set | `shape/line.rs:74`, `:80`; `shape/area.rs:71`, `:77`; `grid.rs:32`, `:38` | CSS's properties of SVG shapes mean this in a browser, inherit, and take the app's classes and the appearance; no paint of NSH's own |
| `Line::dot`, `dot_size`, `dot_fill`, `dot_stroke` | `dot` and the `dot` part: `dotClass` / `dotStyle` (its width / height, background and border) | `shape/line.rs:92-125` | A part is a view the app styles, as every part of `nsh/base`; a view takes view styles (`size-2 bg-* border-*`), not the paint of a drawn shape |
| `Area::fill(impl Into<Background>)` taking a linear gradient (`linear_gradient(..)`, `gpui-component`'s `AreaChart::fill`, the story's `area_gradient`) | `fill` stays CSS's (a color); a gradient is the `background` part of `Area`: `backgroundClass` / `backgroundStyle` (`bg-linear-to-b from-… to-…`, `backgroundImage: "linear-gradient(…)"`), a box around the area's shape whose background shows inside the shape only; `fill` is `none` where none is set beside it | `shape/area.rs:13`, `:71`; `gpui-component` `chart/area_chart.rs:196`; `story/…/chart_story.rs:485` | In a browser `fill` takes a color or a paint server (`url(#…)`), never `linear-gradient()`, which is an image for a box's `background`; a gradient under a line is that background with `clip-path`, so it takes the app's `bg-*` classes and theme tokens as any view's does (drawn by the core in the area's canvas, `Painter::fill_background_from_view`). The box is the area's bounding box, as SVG's `objectBoundingBox`, so `to-b` runs from its highest point to its baseline. Not `fillClass`: a `fill-*` class there would read as the paint property |
| `Area::y0` (none by default: an open shape) | `y0`, a value of the y scale; none: the bottom edge | `shape/area.rs:56` | An area closes to a baseline; `gpui-component`'s `AreaChart` always passes the bottom |
| `Curve::StepAfter` (the last step ends short of the last point) | the step reaches every point | `plot/mod.rs:230`, `shape/area.rs` `path` | `d3.curveStepAfter`, the curve's reference |
| `Plot::id` (opts in to hover) + `Plot::interactive` (default true) | `interactive` (default true) | `plot/mod.rs:140`, `:149` | Every element has its identity; `interactive={false}` is a sparkline's: no hover tracking or parts |
| `tooltip_state(cursor)` → `TooltipState { index, cross_line, dots }` | `onHoverChange(index)`; the parts `crossLineClass` / `crossLineStyle`, `dotClass` / `dotStyle` (one per mark) | `plot/mod.rs:179`, `hover.rs:19` | The styled layer's tooltip overlay in gpui-base draws them; NSH has no styled layer, so they are parts the app styles, positioned natively |
| `TooltipState::dots`, one per series, each painted in its series' color (`gpui-component`'s `Dot::fill(color(i))`, as `Line::dot_fill` / `dot_stroke` paint a line's own dots) | a mark's `hoverDot` part: `hoverDotClass` / `hoverDotStyle` on `Line` and `Area`, each replacing the plot's `dotClass` / `dotStyle` (the default of the marks that set none) for that mark's dot; `hidden` shows none | `hover.rs:25`; `shape/line.rs:103-114`; `gpui-component` `chart/area_chart.rs:575-581`, `plot/tooltip.rs:191` `Dot` | Each series' dot differs (its color), so the mark styles it, where its stroke is set. Not `Line`'s `dotClass`: those are the dots on every point (`dot`), sized for a line at rest, and an `Area` has none; the hover's dot is a part of its own (`hoverDot`), the plot's `dot` part its default. The class and the style replace the plot's separately (a mark's color over the plot's size and ring); a class list is not merged, as Tailwind gives two `bg-*` of one list no order |
| `Plot::tooltip` | `tooltipContent` (a slot) | `plot/mod.rs:215` | Every view has a `tooltip` prop (the platform's tooltip text), so the slot takes the next name |
| `Plot::tooltip(state, cursor, bounds)` placing the box (`gpui-component`'s `Tooltip::new(cursor, within)`: beside the cursor, flipped toward the middle near each edge; `Tooltip::gap`) | `tooltipPlacement: "top" \| "pointer"` (`TooltipPlacement`, default `"top"`: at the top, centered on the cross line) and `tooltipOffset` (points, default 0); `"top"` kept between the plot's left and right edges (its offset from the top the app's, a tag under the plot too), `"pointer"` inside the plot | `plot/mod.rs:205-224`; `gpui-component` `plot/tooltip.rs:290-294`, `:585-605`; `positioner.rs:145` `Positioner::offset` | `placement` and `offset` are the positioner's words (`Popover`, `Tooltip`); the values are where the tooltip goes, not a side (`Placement`'s `"top"` is the plot's top edge here, `"pointer"` the cursor's place). Placed natively: the layout puts it on its side of a point, the animator moves the point with the cross line's glide and clamps it from the plot's and the tooltip's sizes, so no JS runs as the pointer moves |
| `PlotMotion { pointer, enter, exit, appear }` (`with_pointer`, ...), installed in the theme (`PlotTheme::with_motion`) | `motion: { pointer?: Spring, enter?: Timing, exit?: Timing, appear?: Timing, update?: Timing }` on `Plot`, the timings of `nsh` | `plot/mod.rs:45-105`, `theme.rs:95-117` | The same four, none by default (gpui-base's zero durations); reduced motion completes them at once. A prop rather than a theme value: `nsh-base`'s theme holds design tokens and no motion, `ToastStack` takes its motion as a prop the same way, and a chart and a sparkline on one page can differ (a theme default can come later, the prop overriding it). Not `createMotion`: that plays presets and keyframes on one view's opacity and transform; a plot moves its clip and its hover's parts, so it takes timings |
| (none: `gpui-base` redraws a new shape at once) | `motion.update?: Timing`: a pie's and an arc's radii move to the app's new ones | d3's update transitions, between `enter` and `exit` | Switching a donut and a pie, or resizing a ring, should not jump; replaying `appear` for it draws the chart again from nothing. The plot's size changing moves nothing, only the app's radii |
| `PlotHover` (`progress`, `glide`, `is_entering`) | the parts fade by `enter` / `exit` and glide on `pointer`, taking the first row at once | `hover.rs:46` | Run on the platform's animator, no JS per frame |
| `Plot::appear_generation` (`None`: no appear), `PlotAppear::progress` | `appearGeneration`; the marks clip to the appear's progress from the leading edge | `plot/mod.rs:167`, `appear.rs`; `gpui-component`'s `reveal_mask` (`line_chart.rs:465`) | Lines and areas clip; bars grow (below) |
| `PlotAppearScope` | (later) | `appear.rs` | A plot made again by a list for a row that comes back draws in again; its `appearGeneration` can be the row's key |
| The keyboard moving the hover | (later) | | The core reports keys to inputs and the surface's bindings only, so a plot cannot tell that arrow keys are meant for it (as `ResizeHandle`) |
| `shape::Pie` and `shape::Arc`, generators a chart implementing `Plot` paints with (`Pie::arcs(data)` → `ArcData`, `Arc::paint_cached`; `gpui-component`'s `PieChart`) | `Pie`, a mark of a `Plot` (the plot's rows, hover and motion), drawing a slice per row; `Arc`, a mark drawing one sector between two angles | `shape/pie.rs:8`, `shape/arc.rs:15`, `:49`; `gpui-component` `chart/pie_chart.rs:45`, `:309` | As for `Line`: in TSX the chart is a tree, and `PieChart` is a `Plot` (its `id`, `interactive`, `appear_generation`, `tooltip_state`), so a pie is a mark inside one; `Arc` is the arc a slice is drawn with, for a gauge's track and value |
| `Pie::value(Fn(&T) -> Option<f32>)` (none by default: no slices) | `value`: a key of the rows or the app's function; the plot's `y` without | `shape/pie.rs:18`, `:32` | As `Line`'s `y` (`RowAccessor`) |
| `Pie::start_angle` / `end_angle` / `pad_angle`, `ArcData::start_angle` / `end_angle` (radians, 0 at 12 o'clock, clockwise) | `startAngle`, `endAngle` (default `2 * Math.PI`), `padAngle`: `Radians`, numbers in TS | `shape/pie.rs:19-21`, `:41-56`; `shape/arc.rs:19-21` | The same angles, typed |
| `Arc::inner_radius` / `outer_radius` (pixels; the outer 0 by default, `gpui-component`'s 40% of the height) | `innerRadius`, `outerRadius`: points or a percentage of the largest circle the plot holds (half its smaller side; `DefiniteLength`, ``number \| `${number}%` ``); `outerRadius` `"100%"` by default | `shape/arc.rs:57-77`; `gpui-component` `chart/pie_chart.rs:270` | The plot's size is the layout's, which the app does not hold, so a donut's hole is a share (d3's, Recharts' and ECharts' percentages of the largest radius); the default fills the plot, where `gpui-component` keeps 40% to leave room for its leader-line labels |
| `Arc::path` keeps no pad on a slice of half a turn or more (`da >= PI`: `0.0001`) | the pad applies to every slice but a whole turn | `shape/arc.rs:94-100`; d3's `arc.padAngle` | `gpui-base` keeps a full circle's ends apart this way, which also drops the gaps beside any slice of half the pie or more; the canvas's `arc` draws a whole turn itself |
| `Arc::path` pads by angle at the rim and by `min(pad * r1 / r0, 80%)` at the hole, and a pie's slices end at the center, so its gaps are wedges | each gap keeps its width at the rim at every radius, its edges parallel; a slice ends where its edges meet, or rounds the center at half the gap when wider than a half turn | `shape/arc.rs:107-187`; d3's `arc.padRadius` | Gaps of one width read as cuts between slices, the way chart libraries draw them; a wedge closing at the center draws the slices' points together there |
| `Arc::contains` reads the cursor's angle in `0..TAU` | from the pie's own first angle | `shape/arc.rs:206-208` | A pie that starts before 12 o'clock (a gauge from 9 o'clock) or turns the other way finds its slices |
| `PieChart::color(Fn(&T) -> Hsla)` (the theme's `chart_2` without) | the `slice` part: `sliceClass` (`string \| (d: T, index: number) => string`, `SliceClass`) and `sliceStyle`; each slice paints with `fill` (`currentColor` where none is set) and `stroke` (none) | `gpui-component` `chart/pie_chart.rs:206`, `:291` | A slice is a canvas whose view takes the app's classes, so its fill and stroke are CSS's paint properties with theme tokens and `dark:`, as every mark's; a function of the row as `color` is, called once per row in the next JS turn as a `RowAccessor` is. Not `fillClass`: a slice's stroke draws the gaps in the surface's color |
| `HOVER_LIFT` (6: the hovered slice's outer radius grows), `HOVER_DIM` (0.35: the others' opacity falls by that share), lifted on the theme's `spring_control` | `hoverLift` (points), `hoverDim` (a fraction), 0 by default; the lift on `motion.pointer`, both faded with the hover (`enter`, `exit`) | `gpui-component` `chart/pie_chart.rs:27`, `:30`, `:300-306`, `:496-521` | The constants are `gpui-component`'s look, so they are the app's; the spring is the plot's pointer spring, its only one |
| A pie's `TooltipState::cross_line` at the cursor, no dots; its tooltip follows the cursor (`Tooltip::new(cursor, ..)`) | over a pie, the cross line and the tooltip follow the pointer (`tooltipPlacement="pointer"` puts the tooltip beside it); no hover dots | `gpui-component` `chart/pie_chart.rs:489-493`, `:541-547` | The same; the point the tooltip is placed by is the pointer's, moved with it, not a row's |
| `PieChart`'s appear: the ring sweeps from its first slice, each angle `start + (angle - start) * progress` | the same, with the plot's `appearGeneration` and `motion.appear`; the angles are animated values on the platform's animator while it runs | `gpui-component` `chart/pie_chart.rs:318-334` | |
| `PieChart::label` / `label_line_color` / `label_gap` (leader lines and text around the ring), `Arc::centroid` | (later) | `gpui-component` `chart/pie_chart.rs:214-240`, `:353-453`; `shape/arc.rs:81` | Labels are the app's elements laid over the plot (a donut's center label); leader lines come with a way to read the slices' centroids |
| `RadialLine` | (later) | `shape/radial_line.rs:27` | A radar chart, with a radial scale |
| `Bar` (`data`, `cross`, `band_width`, `base`, `value` as closures returning pixels) | `Bar`, a mark: `value` (a key or the app's function, the plot's `y` without) and `base` (a value, 0 by default), placed by the plot's `band` scale and its value scale; its rows are the plot's | `shape/bar.rs:50`, `:104-134` | As `Line` and `Area`: the plot owns the scales and their range, so a bar names values. A band scale's domain is the plot's rows in order, so a bar has no rows of its own. `base` keeps `gpui-base`'s name (not `Area`'s `y0`): a bar can lie across, its value on x. The default 0 is `gpui-component`'s `BarChart` (bars from the zero line; `chart/bar_chart.rs:550-553`, `:792`), and it counts in the domain |
| `BarAlignment::{Bottom, Top, Left, Right}` (`alignment`) | the axis with bands: a band x scale stands bars up, a band y scale lays them across; each bar grows from `base` toward its value, so a negative one grows the other way | `shape/bar.rs:13` | In `gpui-base` the alignment only sides the labels and the gradient's angle; where bars go is the caller's pixels. Here the scales place them, and which scale has bands says which way they stand. `Top` and `Right` (a baseline on the top or right edge) are a reversed value axis, which comes with a scale's `reverse` (later) |
| `ScaleBand::new(domain, range)` with `padding_inner`, `padding_outer`, `max_band_width`, `band_count` | `{ type: "band", paddingInner?, paddingOuter?, maxBandWidth?, bandCount?, groupPadding? }` (`BandScale`), on either axis; laid out as d3's `scaleBand`, a band narrowed by `maxBandWidth` in the middle of its place | `scale/band.rs:10-122`; d3's `scaleBand` (`@reference` at `band.rs:1`) | Names as the builders. `gpui-base`'s sums take the outer padding as a share of the average band and so leave a different gap at each end once both paddings are set; d3's (which it cites) keep the bands in the middle, equal with `gpui-base`'s where only `padding_inner` is set (its tests hold). A narrowed band keeps the middle of its place (`gpui-base` keeps its start), so the app's label centered in a cell stays under it |
| Grouped bars (`Bar::cross` / `band_width` per series; `ScaleBand`'s domain repeated per series, `band.rs:184`) | bars outside a stack stand side by side in each band, in the order of the marks; `groupPadding` on the band scale is the gap between them (the inner band scale's `paddingInner`) | `scale/band.rs:184-193`; d3's grouped bars (a band scale nested in each band) | The bars of a plot know each other, so the plot shares each band out; the gap is the nested band scale's padding, a property of the bands. One bar in a band fills it |
| `Stack` (`data`, `keys`, `value`; `series()` → `StackPoint { y0, y1 }`) | `stack`, a key on `Bar`: the bars with the same `stack` pile up in the order of the marks, a row's missing value adding nothing (`Stack`'s `None` as 0), from the first bar's `base` | `shape/stack.rs:28-136` | In TSX each series is a mark; the stack is what they share (as Recharts' `stackId`), not a data transform the app runs. d3's default offset (none), as `gpui-base`'s |
| `Bar::fill(Fn(&T, Bounds, BarAlignment) -> Background)` | `fill` (`fill-*`, CSS's: a color) and the `background` part, `backgroundClass` / `backgroundStyle`: each bar's box, its background shown inside the bar | `shape/bar.rs:147` | As `Area`'s background: a gradient is a box's background in CSS, per bar as `gpui-component`'s `fill_gradient` runs from base to tip. A color per row (by its sign) is a `Bar` per color today, its `value` a function that leaves the other rows out |
| `Bar::corner_radii(Corners<Pixels>)` | `cornerRadii: number \| { topLeft?, topRight?, bottomRight?, bottomLeft? }` (`BarCornerRadii`) | `shape/bar.rs:169` | A canvas's `roundRect` draws them; a radius larger than half a bar fits it. The corners are the bar's own, as `gpui-base`'s |
| `Bar::label(Fn(&T, Point) -> Vec<Text>)`, placed by `label_origin` | `label` (a key, its number, or the app's function returning text: `RowText`) and the `label` part `labelClass` / `labelStyle` (`StyleProp<TextStyle>`, `BarLabelStyle`): a text at each bar's value end, centered on the bar, on the side away from the bar | `shape/bar.rs:157`, `:245-290` | A part the app styles, as every part; its distance from the bar is its padding (`TEXT_GAP`). It rides the bar's end as it grows and fades in with it (`gpui-component`'s `label_color(..).opacity(appear)`) |
| `PlotAppear::staggered(index, count, spread)`; `gpui-component`'s bars growing out of the zero line together (`chart/bar_chart.rs:987-989`) | `stagger` on `Bar` (0 by default: together); the appear's time is linear on the platform's animator and each bar eases its own slice of it by `motion.appear`'s curve | `appear.rs:62-76` | `spread` names a share of the appear; `stagger` says what it does to bars. Row by row, as BJORK's and Chart.js's bars |
| `gpui-component`'s `HOVER_DIM` (bars away from the hovered one fade by distance, `chart/bar_chart.rs:26`, `:974`) and its highlight band (`CrossLine::band`) | `inactiveOpacity` on `Bar` (none by default); the plot's cross line as wide as the band on a band scale | `chart/bar_chart.rs:968-985`, `:1143-1156` | No look of NSH's own: how far the other bars fade is the app's. The opacity follows the hover's band as it glides and fades, computed by the animator, so no bar is drawn again. A cross line as wide as the band lets the app's `w-full` tint it and `w-px` keep a line |
| Bars' hover (`tooltip_state` with no dots, `chart/bar_chart.rs:1102`) | a `Bar` shows no hover dot; a band y scale finds the row along y, its cross line across the plot | `chart/bar_chart.rs:1064-1103` | As `gpui-component`'s bar chart |
| `PlotAxis` | (later) | `axis.rs` | With its own pull request |
| **Overlays and popups** (new) | | | |
| `<Overlay>` (`nsh`) | | none (GPUI's `deferred` / `anchored`, the web's top layer) | A primitive: what shows above the root view, not a component with a look |
| `anchor`, `placement`, `align`, `offset`, `margin` | | `positioner.rs` `Positioner::placement` / `align` / `offset` / `margin`, `Placement`, `Align` | `placement`'s values are `Placement`'s (`"top"`, `"bottom"`, `"left"`, `"right"`), `align`'s `Align`'s (`"start"`, `"center"`, `"end"`) |
| `onPosition` | | `Positioner::on_position` (`ResolvedPosition`) | The payload is `OverlayPosition`: the side it went on, its frame, the room on that side |
| `onPressOutside` | | none (`DialogChangeReason::*Press`) | The act, a press, named after where it went down |
| `onCancel` | | `Dialog::on_cancel`, `actions::Cancel` (Escape in `Popover`) | Escape and the Android back button, as for dialogs |
| `Popover`, `Tooltip`, `Sheet` (`nsh/base`) | | `popover.rs`, `tooltip.rs`, `sheet.rs` | Parts as `Dialog`'s: `popupClass` / `popupStyle`, `backdropClass` / `backdropStyle`; `trigger` and `content` slots |
| `Menu`, `ContextMenu`, `MenuItem`, `MenuSeparator`, `Submenu` (`nsh/base`) | | `gpui-component` `PopupMenu`, `ContextMenu` (`gpui-base` has no menu) | `MenuItem::on_select` as `PopupMenu`'s items; `Submenu`'s `back` slot is the row a sheet shows above its items |
| `onOpenChange(open, reason)` of the popups | | `Popover::on_open_change`, `DialogChangeReason` | `OpenChangeReason`: `"triggerPress"`, `"pressOutside"`, `"backdropPress"`, `"cancel"`, `"select"`, `"hover"`, `"longPress"`, `"contextMenu"`; every request of the user, controlled or not |
| `onOpen`, `onClose`, `onCancel` of the popups | | `DialogTrigger::on_open`, `Dialog::on_close`, `Dialog::on_cancel` | One set with `Dialog`'s (`Popover`, `Menu`, `ContextMenu`, `Sheet`; `Tooltip` without `onCancel`): `onOpen` / `onClose` once it is all there / gone, whoever changed `open`; `onCancel` for each attempt of the user to close it (Escape or back, a press outside or on the backdrop), whether or not its `closeOn<Trigger>` let it close |
