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
| The environment (`nsh` / `nsh/<module>` accessors) | NSH's rules below: a lowercase accessor per value, `set<Value>` beside it |
| React Native | none: a reference for which capabilities exist; the RN-shaped modules frozen as they are (below) |

**Frozen RN-shaped modules.** `nsh/animated` (`Animated`, `Easing`, `LayoutAnimation`), `nsh/gesture`
(`PanResponder`) and the responder props (`onTouch*`, `on*ShouldSetResponder*`, `onResponder*`) keep React Native's
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
| `windowSize()`, `ImageSize`, Image `onLoad`, `onContentSizeChange` | typed `Size` | Geometry | Same fields |
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
| **`nsh/device`** | | | |
| `Platform.OS`, `Platform.Version`, `Platform.constants` | `platform.os`, `platform.version: string` | Environment | A constant object; Android's version is its API level as a string (`"35"`) |
| `Platform.isPad`, `isTV`, `isDesktop`, `isMacCatalyst`, `constants.interfaceIdiom` | `platform.idiom: "phone" \| "pad" \| "mac" \| "tv" \| "desktop"`, `platform.catalyst` | Environment | `isDesktop` becomes `platform.idiom === "desktop" && !platform.isTerminal` for graphical desktop behavior; `platform.renderer` and `platform.isTerminal` distinguish terminal presentation |
| `Platform.select(spec)` | `platform.select(spec)` | Environment | Same spec |
| `PixelRatio.get()` | `pixelRatio(): number` (accessor, reactive) | Environment | Follows the window to another screen |
| `PixelRatio.getFontScale()` | `fontScale()` | Environment | Already exists |
| `PixelRatio.getPixelSizeForLayoutSize`, `roundToNearestPixel` | (dropped) | | `Math.round(x * pixelRatio()) / pixelRatio()` |
| `I18nManager` (`isRTL`, `allowRTL`, `forceRTL`, `doLeftAndRightSwapInRTL`, `getConstants`) | (dropped) | Where names come from | Decided by the user: the layout direction follows the locale, a view's `direction` style overrides it (Rust: `.direction(LayoutDirection::..)`; Rust's `rtl()`, `force_rtl` and `allow_rtl` are dropped too); translations, when NSH has them, come from rust-i18n |
| `OS` (type) | unchanged | | `platform.os`'s type |
| **`nsh/accessibility`** | | | |
| `AccessibilityInfo.isScreenReaderEnabled()`, `isReduceMotionEnabled()`, `addEventListener` | (dropped) | Listening | `screenReaderEnabled()`, `reduceMotion()` |
| `AccessibilityInfo.announceForAccessibility(message)` | `announce(message)` | Environment | A function of the module |
| `AccessibilityInfo.setAccessibilityFocus(node)` | `setAccessibilityFocus(node)` | Environment | A function of the module; `focus()` is the keyboard's |
| **`nsh/android`** | | | |
| `BackHandler.addEventListener("hardwareBackPress", l)` → `{ remove() }` | `BackHandler.onBackPress(l)` → `() => void` | Listening | Removed with the component it was added in; `l` returns `true` when it handled the press. As `NavPage`'s `onBackPress` |
| **`nsh/clipboard`** | | | |
| `getString`, `setString`, `hasString` | `readText()`, `writeText(text): Promise<void>`, `hasText()` | Where names come from | The DOM's `navigator.clipboard`; GPUI's `read_from_clipboard` / `write_to_clipboard` |
| `getImage`, `setImage`, `hasImage`, `getFiles` | `readImage()`, `writeImage(src)`, `hasImage()`, `readFiles()` | Where names come from | |
| `ClipboardImage.uri` | `ClipboardImage.url` | Addresses | |
| **`nsh/storage`** | | | |
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
| `onBackRequest` | `onBackPress` | `DialogChangeReason::*Press`; `nsh/android` `"hardwareBackPress"` | Fires on every back press, before the pop when `popOnBack` allows it |
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
| `android.backgroundColor`; `nsh/android` `setStatusBarBackgroundColor` | (dropped) | | Edge-to-edge (API 35) has no bar color |
| **KeyboardAvoidingView** | | | |
| `behavior="position"`, `contentContainerStyle` | (dropped) | | `behavior: "padding" \| "height"` |
| `keyboardVerticalOffset` | `offset` | `popup.rs` `Popup::offset` | The enclosing name says keyboard and vertical |
| `enabled` | unchanged | *guides* "Name predicates positively" | `disabled` means no presses on a view |
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
| `selectionColor` (Input, Text) | style key `selectionColor`, class `selection:text-*` | CSS `::selection` | |
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
