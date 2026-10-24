---
title: Elements
description: The primitives and base components every NSH app is built from, in Rust and TSX, and the props, events and ref methods they all share.
order: 1
---

# Elements

Native Shell builds every screen from a small set of elements: primitives such as `View`, `Text` and `Image`, and base
components such as `Button`, `Dialog` and `NavStack`. Each primitive is a native view (a UIView subclass on iOS and Mac
Catalyst, an Android `View`, an AppKit, GTK or Win32 view on the desktops), created and laid out by the NSH runtime.
Everything an app shows is made of them: an app's buttons, cards, rows and screens are its own components, drawn with
these elements and styled by the app, so the app's look is entirely its own.

Every example on these pages comes in Rust and TSX: pick a tab, and every example on the page follows.

```rust tabs
use nsh_core::ui::prelude::*;

fn app() -> impl IntoElement {
    let count = signal(0_u32);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_3()
        .child(text(move || format!("Tapped {} times", count.get())).text_2xl())
        .child(
            view()
                .rounded_lg()
                .bg(rgb(0x2563eb))
                .px_4()
                .py_2()
                .active(|s| s.opacity(0.6))
                .on_press(move || count.update(|n| *n += 1))
                .child(text("Tap").text_color(white())),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Tapped {count()} times</Text>
      <View onPress={() => count.update((n) => n + 1)} class="rounded-lg bg-blue-600 px-4 py-2 active:opacity-60">
        <Text class="text-white">Tap</Text>
      </View>
    </View>
  );
}

mount(App);
```

In Rust, the primitives are functions of `nsh_core::ui::prelude` (`view()`, `text(..)`, `image(..)`) and the base
components come from the `nsh_base` crate. Styles are typed methods (`.flex_1()`, `.gap_3()`, `.px(px(20.0))`,
`.bg(..)`), state styles take a closure (`.active(|s| s.opacity(0.6))`), listeners are closures of their event
(`.on_press(move || ..)`, `.on_change(move |text: &str| ..)`) and `.child(..)` adds children. A piece of UI is a plain function returning
`impl IntoElement`; it runs once, and signals it reads in closures (`text(move || ..)`, `.bg(move || ..)`) update what
they bind. See [Building with Rust](../docs/rust.md).

In TSX, every tag is PascalCase and names a binding in scope: the primitives come from `nsh`, the base components from
`nsh/base`. Only `<If>` and `<Each>` are globals that need no import. A lowercase tag such as `<view>` is a build error,
because TypeScript would check it against one global type per name, and generic components such as `List` and `Each`
could not infer their item types. The compiler recognizes the elements through their imports and makes the native
views in place, so importing them costs nothing at run time. See [JSX and components](../docs/jsx-and-components.md).

```tsx
import { Canvas, Image, Input, List, Overlay, Scroll, Text, Video, View, WebView } from "nsh";
import { Button, Dialog, Menu, NavPage, NavStack, Popover, SafeAreaView, Sheet, Tooltip } from "nsh/base";
```

> [!NOTE]
> Apps built for earlier releases import `Image`, `List`, `Canvas`, `WebView` and `Video` from `nsh/image`,
> `nsh/list`, `nsh/canvas`, `nsh/webview` and `nsh/video`; those imports keep working and name the same elements.

## Primitives

Imported from `nsh` in TSX, from `nsh_core::ui::prelude` in Rust.

| Element | Rust | Native view (iOS / Android) | Page |
|---|---|---|---|
| `<View>` | `view()` | UIView / ViewGroup | [View](./view.md) |
| `<Text>` | `text(content)` | CoreText view / StaticLayout view | [Text](./text.md) |
| `<Image>` | `image(src)` | a view with an image layer / an image view | [Image](./image.md) |
| `<Scroll>` | `scroll()` | UIScrollView / ScrollView | [Scroll](./scroll.md) |
| `<Input>` | `input()` | UITextField or UITextView / EditText | [Input](./input.md) |
| `<List>` | `virtual_list(count, \|at\| row)` | UIScrollView / ScrollView with recycled cells | [List](./list.md) |
| `<Canvas>` | `canvas(painter)` | a view replaying a 2D drawing | [Canvas](./canvas.md) |
| `<WebView>` | `web_view(url)`, `web_view_html(html, base)` | WKWebView / android.webkit.WebView | [WebView](./web-view.md) |
| `<Video>` | `video(url)` | AVPlayerLayer / MediaPlayer on a TextureView | [Video](./video.md) |
| `<Overlay>` | `overlay()` | a view on top of the window (or the dialog it is in), placed against an anchor | [Overlay](./overlay.md) |
| `<If>`, `<Each>` | `when(..)`, `each(..)`, `dynamic(..)` | control flow: the elements they choose | [Control flow](./control-flow.md) |
| `<InputAccessoryView>` (`nsh/ios`) | `input_accessory_view(id)` | a bar over the keyboard on iOS | [nsh/ios](../modules/nsh-ios.md) |

## Base

Imported from `nsh/base` in TSX, from the `nsh_base` crate in Rust. They own behavior, state, focus and accessibility
and take their look from the app.

| Component | Rust | What it does | Page |
|---|---|---|---|
| `<Button>` | `nsh_base::button()` | A pressable control with its states and its role | [Button](./button.md) |
| `<Checkbox>` | `nsh_base::checkbox()` | A checked, unchecked or indeterminate control with an indicator | [Checkbox](./checkbox.md) |
| `<Radio>`, `<RadioGroup>` | `nsh_base::radio()`, `radio_group()` | One option of a set the user picks one of, and the set | [Radio](./radio.md) |
| `<Tab>`, `<Tabs>` | `nsh_base::tab()`, `tabs()` | One tab of a tab list, and the list | [Tabs](./tabs.md) |
| `<Switch>` | `nsh_base::switch()` | An on / off control with a track and a thumb | [Switch](./switch.md) |
| `<Collapsible>` | `nsh_base::collapsible()` | A region whose content expands and collapses | [Collapsible](./collapsible.md) |
| `<Progress>` | `nsh_base::progress()` | A progress bar: how far a task is, or that it is under way | [Progress](./progress.md) |
| `<Dialog>` | `nsh_base::dialog()` | Presents its children over everything else | [Dialog](./dialog.md) |
| `<NavStack>`, `<NavPage>` | `nsh_base::nav_stack()`, `nsh_base::nav_page()` | Native navigation: a stack of pages with the platform's header and back gestures | [NavStack](./nav-stack.md) |
| `<SafeAreaView>` | `nsh_base::safe_area_view()` | Pads its content clear of notches, bars and the home indicator | [SafeAreaView](./safe-area-view.md) |
| `<KeyboardAvoidingView>` | `nsh_base::keyboard_avoiding_view()` | Keeps its content above the software keyboard | [KeyboardAvoidingView](./keyboard-avoiding-view.md) |
| `AlertDialog` | `nsh_base::alert_dialog()` | The system's alert and action sheet | [AlertDialog](./alert-dialog.md) |
| `<TextView>` | `nsh_base::text_view()` | Shows a Markdown or HTML document with texts and views | [TextView](./text-view.md) |
| `<SelectionArea>` | `nsh_base::selection_area()` | Makes the texts inside it select together | [SelectionArea](./selection-area.md) |
| `<Popover>` | `nsh_base::popover()` | Content anchored to a trigger, on top of everything | [Popover](./popover.md) |
| `<Menu>`, `<ContextMenu>`, `<MenuItem>`, `<MenuSeparator>`, `<Submenu>` | `nsh_base::menu()`, ... | Menus: popups with cascading submenus on desktops, sheets on phones | [Menu](./menu.md) |
| `<Tooltip>` | `nsh_base::tooltip()` | A hint next to its trigger, on hover or a held finger | [Tooltip](./tooltip.md) |
| `<Sheet>` | `nsh_base::sheet()` | A panel at an edge of the screen over a backdrop | [Sheet](./sheet.md) |
| `<Toast>`, `<ToastStack>` | `nsh_base::toast()`, `toast_stack()` | A toast's semantic root; toasts laid out as layers from an edge | [Toast](./toast.md) |
| `<ResizablePanelGroup>`, `<ResizablePanel>` | `nsh_base::h_resizable()`, `resizable_panel()` | Panels side by side or stacked, with handles that resize them | [Resizable](./resizable.md) |
| `<DockArea>` | `nsh_base::dock_area()` | A workspace of splits, tab groups and edge docks the user arranges | [Dock](./dock.md) |

> [!NOTE]
> A string is only drawn inside a `Text`. A string child of a `View` creates no native view and takes no part in
> layout.

## Common props

Every primitive accepts the props below (the `CommonProps` type in TSX; the `Styled`, `Interactive` and `Accessible`
traits in Rust). Element pages list only their own props. The Rust column names the builder method.

### Styling

| Prop | Rust | Type | Description |
|---|---|---|---|
| `style` | typed `Styled` methods; `.inline_style(style)` | `StyleProp<ViewStyle>` (`TextStyle` for `<Text>` and `<Input>`, `ImageStyle` for `<Image>`) | Inline style, or an array of styles merged left to right (falsy entries skipped; arrays may nest, so `style={[base, props.style]}` takes a `props.style` that is itself an array). Wins over `class`. See the [style reference](../modules/style-reference.md). |
| `class` | typed `Styled` methods (`.flex_row().gap_2().p_4()`) | `string` | Tailwind classes, resolved natively (`"flex-row gap-2 p-4 dark:bg-zinc-900"`). Later classes win over earlier ones. See [Tailwind](../docs/tailwind.md). |
| `classList` | `.style_when(when, \|s\| ..)` | `Record<string, boolean \| null \| undefined>` | Classes applied while their value is truthy (`{ "opacity-50": busy() }`). |
| `disabled` | `.disabled(..)` | `boolean` | Ignores presses (no press feedback either), applies `disabled:` styles, disables controls such as inputs, and screen readers say it is disabled (`accessibilityState.disabled`). |

### Presses and feedback

Press handling runs natively: the platform recognizes the press and applies the app's press styles, and the app's code
only hears about it afterwards. Only the innermost pressable view responds; inside scroll views a press-in waits about
130 ms so a scroll can start first.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `onPress` | `.on_press(..)` | `() => void` | | A tap ended inside the view. |
| `onLongPress` | `.on_long_press(..)` | `() => void` | | The finger stayed down for `delayLongPress`. |
| `onPressDown` | `.on_press_down(..)` | `() => void` | | A finger went down on the view. |
| `onPressUp` | `.on_press_up(..)` | `() => void` | | The finger lifted or left. |
| `delayLongPress` | `.long_press_delay(ms)` | `number` | `500` | Milliseconds before a press becomes a long press. |
| `hitSlop` | `.hit_slop(EdgeInsets::all(px(8.0)))` | `number \| Partial<Edges>` | | Extends the touch area beyond the bounds, in points. |
| `pointerEvents` | `.pointer_events(PointerEvents::BoxNone)` | `"auto" \| "none" \| "box-none" \| "box-only"` | `"auto"` | Which touches the view and its children receive: `"none"` neither, `"box-none"` only the children, `"box-only"` only the view itself. |

The press feedback is the app's: `activeStyle` (or `active:` classes, `.active(..)` in Rust) applies while the view is
pressed, natively, with no round trip to the app's code (below).

### State styles

Styles that apply while the view is in a state, over its own styles, natively. Each is the object form of a Tailwind
variant. Later states win (selected, checked and indeterminate, then hover, focus, active); `disabledStyle` wins over all, and the others do not
apply while the view is disabled.

| Prop | Rust | Class variant | Applies |
|---|---|---|---|
| `activeStyle` | `.active(\|s\| ..)` | `active:` | While pressed. |
| `hoverStyle` | `.hover(\|s\| ..)` | `hover:` | While a pointer is over the view. |
| `focusStyle` | `.focus(\|s\| ..)` | `focus:` | While the view has focus. |
| `disabledStyle` | `.disabled_style(\|s\| ..)` | `disabled:` | While `disabled`. |
| `checkedStyle` | `.checked(\|s\| ..)`, `.checked_style(style)` | `checked:` | While `accessibilityState.checked` is `true` (a checkbox, a switch, a radio; `"mixed"` is not checked). |
| `indeterminateStyle` | `.indeterminate(\|s\| ..)`, `.indeterminate_style(style)` | `indeterminate:` | While `accessibilityState.checked` is `"mixed"` (a checkbox that is neither checked nor unchecked). |
| | `.selected(\|s\| ..)` | `selected:` | While `accessibilityState.selected` is `true` (a selected `Button`, a tab). |

```rust tabs
view()
    .rounded_lg()
    .bg(rgb(0x2563eb))
    .px_4()
    .py_2()
    .active(|s| s.opacity(0.6))
    .hover(|s| s.bg(rgb(0x1d4ed8)))
    .on_press(save)
    .child(text("Save").text_color(white()))
```

```tsx tabs
<View onPress={save} activeStyle={{ opacity: 0.6 }} hoverStyle={{ backgroundColor: "#1d4ed8" }} class="rounded-lg bg-blue-600 px-4 py-2">
  <Text class="text-white">Save</Text>
</View>
```

### Hover

The app hears the mouse come over a view, move over it and leave it: on macOS, Windows, Linux, the GPUI backend and in
desktop browsers, with an iPad's pointer or a Mac's mouse on iOS, and with a mouse or a stylus on Android. Hover styles
(`hover:`, `.hover(..)`) style hovered views in the same places.

| Prop | Rust | Type | Description |
|---|---|---|---|
| `onHoverIn` | `.on_hover_in(..)` | `() => void` | The mouse came over the view or a view inside it. |
| `onHoverMove` | `.on_hover_move(..)` | `(e: HoverEvent) => void` | The mouse moved over the view (or a view inside it) with no button down. |
| `onHoverOut` | `.on_hover_out(..)` | `() => void` | The mouse left the view and the views inside it, or the window. |

Like CSS `:hover`, a view counts as hovered while the mouse is over it or over anything inside it, so the views around
the one under the mouse hear `onHoverIn` too (from the outside in; `onHoverOut` from the inside out). The events come
after the fact and never on touches; a move with a button down is a touch (`onTouchMove`, the responder). A view removed
from under the mouse hears `onHoverOut`, on Linux and Windows at the next mouse move.

`HoverEvent` says where the mouse is, as GPUI's `MouseMoveEvent` does: `position` in the view (a `Point` in points, its
transforms undone), `pagePosition` in the root view it is in, as touches give it, and the `modifiers` held (`control`,
`alt`, `shift`, `platform`: Command on Apple platforms, the Windows key elsewhere); in Rust `position`, `page_position`
and `modifiers`. Moves
come at most once a frame, the latest one, and always before the `onHoverOut` that follows them, so a handler can
redraw on each move:

```rust tabs
// A crosshair over a chart.
let at = signal(None::<Points>);

view()
    .h(px(200.0))
    .on_hover_move(move |e: &HoverEvent| at.set(Some(e.position.x)))
    .on_hover_out(move || at.set(None))
    .child(when(move || at.get().is_some(), move || {
        view()
            .absolute()
            .left(move || at.get().unwrap_or_default())
            .top_0()
            .bottom_0()
            .w(px(1.0))
            .bg(rgb(0x888888))
    }))
```

```tsx tabs
// A crosshair over a chart.
const at = signal<number | null>(null);

<View onHoverMove={(e) => at.set(e.position.x)} onHoverOut={() => at.set(null)} style={{ height: 200 }}>
  <If when={at() !== null}>
    <View style={{ position: "absolute", left: at()!, top: 0, bottom: 0, width: 1, backgroundColor: "#888" }} />
  </If>
</View>
```

### Tooltips

`tooltip` gives any element a hint, shown above it on the desktops (macOS, Windows, Linux, the GPUI backend and
desktop browsers) once the pointer has rested on it for half a second, until the pointer leaves or presses it. Phones
and tablets show none. The hint never takes the pointer or presses, so the element works exactly as it does without it.

| Prop | Rust | Type | Description |
|---|---|---|---|
| `tooltip` | `.tooltip(..)` | `string \| JSX.Element` | A text, in a small bubble drawn with the theme's `popover` tokens (`bg-popover`, `text-popover-foreground`, `border-border`: the theme decides how it looks), or an element, shown as it is (a `Tooltip` of `nsh/base` is the tooltip itself). |

```rust tabs
view().on_press(save).tooltip("Save the document").child(text("💾"))
```

```tsx tabs
<View onPress={save} tooltip="Save the document">
  <Text>💾</Text>
</View>
```

For a tooltip of its own look, placement, delay or events, give a [`Tooltip`](tooltip.md) of `nsh/base` as the
`tooltip`, as GPUI's `.tooltip(..)` takes one.

### Context menus

`onContextMenu` tells a view that the secondary button was pressed over it: a right click, Control-click on macOS, a
two-finger click on a touchpad, the secondary click of an iPad's pointer; in browsers also the keyboard's menu key.
Open the app's own menu there; in TSX, [`Menu.popup`](../modules/nsh-desktop.md) shows the system's:

```rust tabs
// The app's own menu, placed where the click was.
let menu_at = signal(None::<Point<Points>>);

view()
    .on_context_menu(move |e: &ContextMenuEvent| menu_at.set(Some(e.page_position)))
    .child(text(row.name.clone()))
```

```tsx tabs
import { Menu } from "nsh/desktop";

<View onContextMenu={(e) => Menu.popup(rowMenu(row), e.pagePosition)}>…</View>
```

| Prop | Rust | Type | Description |
|---|---|---|---|
| `onContextMenu` | `.on_context_menu(..)` | `(e: ContextMenuEvent) => void` | The secondary button was pressed over the view or a view inside it. |

`ContextMenuEvent` has `position` in the view, `pagePosition` in its root view (where `Menu.popup` places a menu:
`Menu.popup(items, e.pagePosition)`) and the `modifiers`; in Rust `position`, `page_position` and `modifiers`. The nearest view that listens, from the one under the pointer outwards, hears it. A text input, or
selectable text with an edit menu (Windows, the GPUI backend, browsers), nearer than that view shows its own menu
instead. The platform decides this as the button goes down, from what is mounted, so the handler is told after the fact
and nothing has to be cancelled. A `disabled` view leaves the click to the nearest enabled listener around it. On
touchscreens, a long press opens menus: handle `onLongPress` with the same function.

### Keyboard focus

On macOS and the web, Tab moves the keyboard focus between the views that take presses (and the inputs), Return or
Space presses the focused view, and focus styles (`focus:`, `.focus(..)`) style it. A click presses a view without
focusing it, so focus styles show for keyboard focus only.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `focusable` | `.focusable(..)` | `boolean` | `true` | Whether a view that takes presses is a stop of Tab; `false` leaves it to the pointer (a backdrop that closes a popover, rows the arrow keys move between). |

```rust tabs
view()
    .rounded_lg()
    .p_3()
    .focus(|s| s.bg(rgb(0xe0f2fe)))
    .on_press(open)
    .child(text("Open"))

// An overlay's backdrop: a click closes it, Tab goes past it to the content.
view().absolute().inset_0().focusable(false).on_press(close)
```

```tsx tabs
<View class="rounded-lg p-3 focus:bg-sky-100" onPress={open}>
  <Text>Open</Text>
</View>

{/* An overlay's backdrop: a click closes it, Tab goes past it to the content. */}
<View class="absolute inset-0" focusable={false} onPress={close} />
```

### Layout and identity

| Prop | Rust | Type | Description |
|---|---|---|---|
| `onLayout` | `.on_layout(\|frame: &Bounds<Points>\| ..)` | `(bounds: Bounds) => void` | The view's frame relative to its parent, `{ origin, size }`, after each layout that changes it. |
| `ref` | `.element_ref(&handle)` | `YNode \| (node: YNode) => void` | The native node (see [ref methods](#ref-methods)). `ref={el}` assigns a variable, `ref={fn}` calls a function. |
| `nativeID` | `.native_id(id)` | `string` | Names the view for others, e.g. the `InputAccessoryView` an input refers to. |
| `testID` | `.test_id(id)` | `string` | An identifier for UI tests (on Android, the view's resource id). |
| `key` | `.key(key)` | `string` | The element's identity among its siblings. |

### Gestures driving animated values

These props bind a gesture to [native animated values](../modules/nsh-animated.md) that move on the UI thread, with no
work in the app's code per frame. See [touch and gestures](../docs/touch-and-gestures.md).

| Prop | Rust | Type | Description |
|---|---|---|---|
| `pan` | `.pan_values(Some(&x), Some(&y))` | `{ x?: AnimatedValue; y?: AnimatedValue }` | Drags drive these values (points). |
| `onPanStart` | `.on_pan_start(..)` | `(e: PanEvent) => void` | A drag started. |
| `onPanEnd` | `.on_pan_end(..)` | `(e: PanEvent) => void` | A drag ended, with the release velocity (e.g. to start a `decay`). |
| `pinch` | `.pinch_value(&scale)` | `{ scale?: AnimatedValue }` | Two-finger pinches drive `scale`. |
| `onPinchStart` / `onPinchEnd` | `.on_pinch_start(..)` / `.on_pinch_end(..)` | `(e: { scale: number; velocity: number }) => void` | A pinch started / ended. |
| `rotation` | `.rotation_value(&angle)` | `{ angle?: AnimatedValue }` | Two-finger rotations drive `angle` (degrees). |
| `onRotationStart` / `onRotationEnd` | `.on_rotation_start(..)` / `.on_rotation_end(..)` | `(e: { rotation: number; velocity: number }) => void` | A rotation started / ended. |

`PanEvent` is `{ translationX, translationY, velocityX, velocityY, valueX?, valueY? }` (in Rust `translation`,
`velocity_x`, `velocity_y`, `value_x`, `value_y`): the translation since the start, the velocity in points per second,
and the bound values at that moment (a drag can grab a value mid-animation).

### Raw touches and the responder system

For gestures the props above do not cover, every element takes the touch and responder props:
`onTouchStart`, `onTouchMove`, `onTouchEnd`, `onTouchCancel` (and their `…Capture` forms),
`onStartShouldSetResponder`, `onMoveShouldSetResponder` (and `…Capture`), `onResponderGrant`, `onResponderReject`,
`onResponderStart`, `onResponderMove`, `onResponderEnd`, `onResponderRelease`, `onResponderTerminate` and
`onResponderTerminationRequest`. Each handler gets a `GestureResponderEvent`
(`{ identifier, locationX, locationY, pageX, pageY, target, timestamp, touches, changedTouches, nativeEvent,
stopPropagation() }`); the `…ShouldSetResponder` handlers also get a `gestureState` (`dx`, `dy`, `vx`, `vy`, ...).
Returning `true` from `onResponderGrant` keeps native scroll views from taking the touches. `panActivation`
(`{ activeOffsetX, activeOffsetY, failOffsetX, failOffsetY }`) makes the view the responder only once the platform
activates its pan, so drags inside scroll views leave the other axis to them
([Touch and gestures](../docs/touch-and-gestures.md#pans-inside-scroll-views-panactivation)).
`PanResponder` in [`nsh/gesture`](../modules/nsh-gesture.md) builds on them. In Rust, `.on_touch(..)` hears every touch
(`TouchEvent`), `.claim_touches(..)` decides when the view takes them, and `.on_responder_grant(..)`,
`.on_responder_move(..)`, `.on_responder_release(..)` and the others follow the responder.

### Accessibility

| Prop | Rust | Type | Description |
|---|---|---|---|
| `accessible` | `.accessible(..)` | `boolean` | The view is one element for assistive technologies; its children are not exposed separately. |
| `accessibilityLabel` | `.label(..)` | `string` | What screen readers read. Views without a label read their texts. |
| `accessibilityHint` | `.hint(..)` | `string` | What activating the element does. |
| `role` | `.role(AccessibilityRole::Button)` | `AccessibilityRole` | What the element is (`"button"`, `"header"`, `"link"`, `"switch"`, …). |
| `accessibilityState` | `.accessibility_state(..)` | `{ disabled?, selected?, checked?, busy?, expanded? }` | The state assistive technologies report (`checked` may be `"mixed"`). |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | The value of a range or textual element. |
| `accessibilityElementsHidden` | | `boolean` | Hides the view and its subtree from assistive technologies. |
| `importantForAccessibility` | | `"auto" \| "yes" \| "no" \| "no-hide-descendants"` | Whether the view is exposed. |
| `accessibilityActions` | | `{ name: string; label?: string }[]` | Custom actions offered to assistive technologies. |
| `onAccessibilityAction` | `.on_accessibility_action(..)` | `(e: { actionName: string }) => void` | The user invoked one of `accessibilityActions`. |

See [accessibility](../docs/accessibility.md).

### Platform-only props

Props that exist on one platform go in an object named after it in TSX, so the shared props stay the same everywhere.
Only the current platform's object is sent; the others are ignored. Rust builders take them as methods that apply on
their platform.

| Prop | Description |
|---|---|
| `ios={{…}}` | iOS and Mac Catalyst. `<Input>`, `Dialog` and `WebView` add their own keys. |
| `android={{…}}` | Android. Every element takes `ripple`, `elevation` and `accessibilityLiveRegion` (below). |
| `desktop={{…}}` | Desktop platforms and desktop browsers; ignored on mobile. Every element takes `windowDrag` (below). |
| `web={{…}}` | Browsers; ignored elsewhere. |

| `android` key | Rust | Type | Description |
|---|---|---|---|
| `ripple` | `.ripple(Ripple { .. })` | `{ color?, borderless?, radius?, foreground? }` | The material ripple while pressed. |
| `elevation` | `.elevation(px(2.0))` | `number` | The material shadow (points), from the view's shape. |
| `accessibilityLiveRegion` | | `"none" \| "polite" \| "assertive"` | How changes of the view are announced to TalkBack. |

| `desktop` key | Rust | Type | Description |
|---|---|---|---|
| `windowDrag` | `.window_drag(..)` | `boolean` | Pressing the view drags the window, as its title bar would; `false` keeps a part of a draggable view clickable. See [a title bar of your own](../modules/nsh-desktop.md#a-title-bar-of-your-own). |

```rust tabs
use nsh_core::Ripple;

view()
    .rounded_lg()
    .bg(white())
    .p_4()
    .elevation(px(2.0))
    .ripple(Ripple { color: Some(rgba(0x00000022).into()), ..Ripple::default() })
    .on_press(save)
    .child(text("Save"))
```

```tsx tabs
<View onPress={save} android={{ ripple: { color: "#00000022" }, elevation: 2 }} class="rounded-lg bg-white p-4">
  <Text>Save</Text>
</View>
```

See [platform-specific code](../docs/platform-specific.md).

## Ref methods

`ref` receives a `YNode` in TSX; in Rust, `element_ref()` makes an `ElementRef` handle that `.element_ref(&handle)`
attaches. Their methods send commands to the native view, in order with the changes made before them in the same turn.
Each element page says which apply to it.

| Method | Rust | Applies to | Description |
|---|---|---|---|
| `focus()` / `blur()` | `focus()` / `blur()` | `<Input>` | Focuses (shows the keyboard) / unfocuses. |
| `setSelection(start, end?)` | `set_selection(start, end)` | `<Input>` | Selects `start..end` in UTF-16 units; a caret without `end`. |
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point, animated)` | `<Scroll>`, `List` | Scrolls to an offset. |
| `zoomTo({ scale, x?, y?, animated? })` | `zoom_to(scale, center, animated)` | zoomable `<Scroll>` | Zooms to `scale` around a content point. |
| `scrollToOffset({ offset, animated? })` | `scroll_to_offset(offset, animated)` | `List` | Scrolls to an offset along the list's axis. |
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | `scroll_to_index(index, position, offset, animated)` | `List` | Scrolls an item into view. |
| `scrollToEnd({ animated? })` | `scroll_to_end(animated)` | `List` | Scrolls to the end of the content. |
| `reload()`, `goBack()`, `goForward()`, `stopLoading()`, `injectJavaScript(script)`, `postMessage(data)` | `reload()`, `go_back()`, `go_forward()`, `stop_loading()`, `inject_java_script(..)`, `post_message(..)` | `WebView` | Controls the page. |
| `seek(seconds)` | `seek(seconds)` | `Video` | Jumps to a time. |
| `command(name, args?)` | `command(name, args)` | native components | Calls a command of a registered native component ([`nsh/native`](../modules/nsh-native.md)). |

```rust tabs
let field = element_ref();

view()
    .on_press(move || field.focus())
    .child(input().element_ref(&field).placeholder("Tap the row to type"))
```

```tsx tabs
import { Input, View, type YNode } from "nsh";

let input!: YNode;
<View onPress={() => input.focus()}>
  <Input ref={input} placeholder="Tap the row to type" />
</View>;
```

## Why handlers never block the UI

The main thread never waits for the app's code. When the system needs an answer on the spot (may this text change, may
the back button pop, may this sheet close), NSH answers it natively from props set beforehand (`maxLength`,
`popOnBack`, `closeOnSwipe`, `pointerEvents`, …), and the event reaches the app afterwards. This is why such behavior
is a prop, not a return value of a handler.
