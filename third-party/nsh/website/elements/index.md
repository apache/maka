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
use nsh_core::prelude::*;

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

In Rust, the primitives are functions of `nsh_core::prelude` (`view()`, `text(..)`, `image(..)`) and the base
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
import { Canvas, Image, List, Overlay, Scroll, Shader, Text, Video, View, WebView } from "nsh";
import { Button, Dialog, Menu, NavPage, NavStack, Popover, Sheet, Tooltip, Input } from "nsh/base";
```

## Primitives

Imported from `nsh` in TSX, from `nsh_core::prelude` in Rust.

| Element | Rust | Native view (iOS / Android) | Page |
|---|---|---|---|
| `<View>` | `view()` | UIView / ViewGroup; with `selectable`, the texts inside it select together | [View](./view.md), [Text selection](./text-selection.md) |
| `<Text>` | `text(content)` | CoreText view / StaticLayout view | [Text](./text.md) |
| `<Image>` | `image(src)` | a view with an image layer / an image view | [Image](./image.md) |
| `<Scroll>` | `scroll()` | UIScrollView / ScrollView | [Scroll](./scroll.md) |
| `<List>` | `virtual_list(count, \|at\| row)` | UIScrollView / ScrollView with recycled cells | [List](./list.md) |
| `<Canvas>` | `canvas(painter)` | a view replaying a 2D drawing | [Canvas](./canvas.md) |
| `<Shader>` | `shader(program)` | a view whose box a WGSL program draws on the GPU, under its children | [Shader](./shader.md) |
| `<WebView>` | `web_view(url)`, `web_view_html(html, base)` | WKWebView / android.webkit.WebView | [WebView](./web-view.md) |
| `<Video>` | `video(url)` | AVPlayerLayer / MediaPlayer on a TextureView | [Video](./video.md) |
| `<Overlay>` | `overlay()` | a view on top of the window (or the dialog it is in), placed against an anchor | [Overlay](./overlay.md) |
| `<If>`, `<Each>` | `when(..)`, `each(..)`, `dynamic(..)` | control flow: the elements they choose | [Control flow](./control-flow.md) |
| `<InputAccessoryView>` (`nsh/mobile`) | `input_accessory_view(id)` | a bar over the keyboard on iOS | [`InputAccessoryView`](../modules/nsh-mobile.md#inputaccessoryview) |

Padding and margin keep content clear of system UI with CSS's `env()`: `env(safe-area-inset-top)` and the other edges ([Safe area](./safe-area.md)) and `env(keyboard-inset-height)` ([Keyboard](./keyboard.md)).

## Base

Imported from `nsh/base` in TSX, from the `nsh_base` crate in Rust. They own behavior, state, focus and accessibility
and take their look from the app.

| Component | Rust | What it does | Page |
|---|---|---|---|
| `<Button>` | `nsh_base::button()` | A pressable control with its states and its role | [Button](./button.md) |
| `<Input>` | `nsh_base::input()` | The native text input (UITextField or UITextView / EditText) | [Input](./input.md) |
| `<OtpInput>` | `nsh_base::otp_input()` | A one-time code of a fixed number of digits, typed, pasted or autofilled into cells | [OtpInput](./otp-input.md) |
| `<Checkbox>` | `nsh_base::checkbox()` | A checked, unchecked or indeterminate control with an indicator | [Checkbox](./checkbox.md) |
| `<Radio>`, `<RadioGroup>` | `nsh_base::radio()`, `radio_group()` | One option of a set the user picks one of, and the set | [Radio](./radio.md) |
| `<Tab>`, `<Tabs>` | `nsh_base::tab()`, `tabs()` | One tab of a tab list, and the list | [Tabs](./tabs.md) |
| `<Switch>` | `nsh_base::switch()` | An on / off control with a track and a thumb | [Switch](./switch.md) |
| `<Select>` | `nsh_base::select()` | One value chosen from a list of items, with the keyboard, search and sections | [Select](./select.md) |
| `<Collapsible>` | `nsh_base::collapsible()` | A region whose content expands and collapses | [Collapsible](./collapsible.md) |
| `<Progress>` | `nsh_base::progress()` | A progress bar: how far a task is, or that it is under way | [Progress](./progress.md) |
| `<NumberInput>` | `nsh_base::number_input()` | A number typed in a field or stepped with buttons and keys | [NumberInput](./number-input.md) |
| `<Slider>` | `nsh_base::slider()` | A value, or a range of two, picked along a track | [Slider](./slider.md) |
| `<Scrollbar>` | `nsh_base::scrollbar()` | A scroll bar of the app's own look for a scroll view or a list | [Scrollbar](./scrollbar.md) |
| `<Plot>`, `<Line>`, `<Area>`, `<Bar>`, `<Grid>`, `<Pie>`, `<Arc>` (`nsh/base/plot`) | `nsh_base::plot::{plot, line, area, bar, grid, pie, arc}` | A chart's frame and its marks, drawn natively from the app's rows | [Plot](./plot.md) |
| `<Dialog>` | `nsh_base::dialog()` | Presents its children over everything else | [Dialog](./dialog.md) |
| `<NavStack>`, `<NavPage>` | `nsh_base::nav_stack()`, `nsh_base::nav_page()` | Native navigation: a stack of pages with the platform's header and back gestures | [NavStack](./nav-stack.md) |
| `AlertDialog` | `nsh_base::alert_dialog()` | The system's alert and action sheet | [AlertDialog](./alert-dialog.md) |
| `<TextView>` | `nsh_base::text_view()` | Shows a Markdown or HTML document with texts and views | [TextView](./text-view.md) |
| `<Editor>` | `nsh_base::editor()` | A code editor with highlighting, several carets, folding and search | [Editor](./editor.md) |
| `<DiffView>` | `nsh_base::diff_view()` | The changes between two texts or of a patch, split or unified | [DiffView](./diff-view.md) |
| `<Table>` and its parts | `nsh_base::table()`, `table_row()`, ... | A table of the app's own rows and cells, with a table's roles | [Table](./table.md) |
| `<DataTable>` | `nsh_base::data_table()` | A table of rows and columns of any number, selectable, sortable, with resizable and movable columns | [DataTable](./data-table.md) |
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
| `onPress` | `.on_press(..)` | `(e: PressEvent) => void` | | A tap ended inside the view. |
| `onLongPress` | `.on_long_press(..)` | `(e: PressEvent) => void` | | The finger stayed down for `delayLongPress`. |
| `onPressDown` | `.on_press_down(..)` | `(e: PressEvent) => void` | | A finger went down on the view. |
| `onPressUp` | `.on_press_up(..)` | `(e: PressEvent) => void` | | The finger lifted or left. |
| `delayLongPress` | `.long_press_delay(ms)` | `number` | `500` | Milliseconds before a press becomes a long press. |
| `hitSlop` | `.hit_slop(EdgeInsets::all(px(8.0)))` | `number \| Partial<Edges>` | | Extends the touch area beyond the bounds, in points. |

`PressEvent` is `{ position, pagePosition, modifiers, clickCount }`: where the pointer was in the view and in its root
view (`Point`s), the modifier keys held when the press began and the consecutive clicks (2 for a double click). Where
the platform reports no pointer, it is the view's origin with no keys and one click.

The style key `pointerEvents` (`.pointer_events(PointerEvents::BoxNone)` in Rust, the classes `pointer-events-*`)
decides which touches the view and the views in it receive: `"none"` neither (a view inside that sets `"auto"` takes
them again), `"box-none"` only the views in it, `"box-only"` only the view itself
([touch and gestures](../docs/touch-and-gestures.md#pointerevents)).

The press feedback is the app's: `activeStyle` (or `active:` classes, `.active(..)` in Rust) applies while the view is
pressed, natively, with no round trip to the app's code (below).

### State styles

Styles that apply while the view is in a state, over its own styles, natively. Each is the object form of a Tailwind
variant. Later states win (selected, checked and indeterminate, then hover, focus, active); `disabledStyle` wins over all, and the others do not
apply while the view is disabled. Each takes the element's own style: a `TextStyle` on a `<Text>`, an `InputStyle` on
an `<Input>`, an `ImageStyle` on an `<Image>`, a `ViewStyle` elsewhere.

| Prop | Rust | Class variant | Applies |
|---|---|---|---|
| `activeStyle` | `.active(\|s\| ..)` | `active:` | While pressed. |
| `hoverStyle` | `.hover(\|s\| ..)` | `hover:` | While a pointer is over the view. |
| `focusStyle` | `.focus(\|s\| ..)` | `focus:` | While the view has focus. |
| `disabledStyle` | `.disabled_style(\|s\| ..)` | `disabled:` | While `disabled`. |
| `checkedStyle` | `.checked(\|s\| ..)`, `.checked_style(style)` | `checked:` | While `accessibilityState.checked` is `true` (a checkbox, a switch, a radio; `"mixed"` is not checked). |
| `indeterminateStyle` | `.indeterminate(\|s\| ..)`, `.indeterminate_style(style)` | `indeterminate:` | While `accessibilityState.checked` is `"mixed"` (a checkbox that is neither checked nor unchecked). |
| `selectedStyle` | `.selected(\|s\| ..)` | `selected:` | While `accessibilityState.selected` is `true` (a selected `Button`, a tab). |
| `expandedStyle` | `.expanded(\|s\| ..)`, `.expanded_style(style)` | `aria-expanded:` | While `accessibilityState.expanded` is `true` (a `Popover`'s or `Menu`'s trigger while its popup is open). |

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
| `onMouseEnter` | `.on_mouse_enter(..)` | `(e: MouseEvent) => void` | The mouse came over the view or a view inside it (the DOM's `mouseenter`). |
| `onMouseMove` | `.on_mouse_move(..)` | `(e: MouseEvent) => void` | The mouse moved over the view (or a view inside it), with or without a button down, or a modifier key was pressed or released while it rests there with none down (the DOM's `mousemove`). |
| `onMouseLeave` | `.on_mouse_leave(..)` | `(e: MouseEvent) => void` | The mouse left the view and the views inside it, or the window; `e` is where it was last (the DOM's `mouseleave`). |

Like CSS `:hover` and the DOM's `mouseenter`, a view counts as hovered while the mouse is over it or over anything
inside it, so the views around the one under the mouse hear `onMouseEnter` too (from the outside in; `onMouseLeave`
from the inside out). The events come after the fact and never on touches. A view removed from under the mouse hears
`onMouseLeave`, on Linux and Windows at the next mouse move.

`MouseEvent` says where the mouse is, as GPUI's `MouseMoveEvent` does: `position` in the view (a `Point` in points, its
transforms undone), `pagePosition` in the root view it is in, as touches give it, the `modifiers` held (`control`,
`alt`, `shift`, `platform`: Command on Apple platforms, the Windows key elsewhere), and `pressedButton`, the button held
down (`"left"`, `"right"`, `"middle"`, `"back"` or `"forward"`, GPUI's `MouseButton`) or `null`; in Rust `position`,
`page_position`, `modifiers` and `pressed_button`. On the desktops and the web a drag is also a touch (`onTouchMove`,
the responder), and its moves reach `onMouseMove` with `pressedButton` set: feedback that only follows the hover skips
those; on iOS and Android the hover reports the pointer with no button down. Moves come at most once a frame, the
latest one, and always before the `onMouseLeave` that follows them, so a handler can redraw on each move:

```rust tabs
// A crosshair over a chart.
let at = signal(None::<Points>);

view()
    .h(px(200.0))
    .on_mouse_move(move |e: &MouseEvent| at.set(Some(e.position.x)))
    .on_mouse_leave(move |_: &MouseEvent| at.set(None))
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

<View onMouseMove={(e) => at.set(e.position.x)} onMouseLeave={() => at.set(null)} style={{ height: 200 }}>
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
| `tooltip` | `.tooltip(..)` | `JSX.Element` | The hint, an element the app styles: a [`Tooltip`](tooltip.md) of `nsh/base` is the tooltip itself, with its placement, delay and events; any other element is shown as it is. |

```rust tabs
view()
    .on_press(save)
    .tooltip(
        tooltip()
            .rounded_md()
            .bg(rgb(0x111827))
            .px_2()
            .py_1()
            .child(text("Save the document").text_color(white())),
    )
    .child(text("💾"))
```

```tsx tabs
<View
  onPress={save}
  tooltip={
    <Tooltip class="rounded-md bg-gray-900 px-2 py-1">
      <Text class="text-white">Save the document</Text>
    </Tooltip>
  }
>
  <Text>💾</Text>
</View>
```

The `Tooltip` sets its own look, placement, delay and events, as GPUI's `.tooltip(..)` takes one. An app with many
tooltips keeps one small component of its own that wraps a text in its `Tooltip`.

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

On macOS and the web, Tab moves the keyboard focus between its stops in tree order: the inputs, the views that take
presses, and every `focusable` view. Focus styles (`focus:`, `.focus(..)`) style the focused view, and Return or Space
presses it when it takes presses. A click presses a view without focusing it, so focus styles show for keyboard focus
only.

Focus and presses are separate. A view that takes keys while it has the focus (a chart, a slider, a list that moves
its selection with the arrow keys) sets `focusable` and binds its keys while focused (`onFocus` / `onBlur` with
[`keymap`](../modules/nsh.md#keymap)); a press on it still reaches a pressable around it, such as a card that
opens a page.

A ref's `focus()` moves the keyboard focus to a stop as Tab does (its focus styles show and `onFocus` fires), say to
give it back to the trigger of a popup that closed, and `blur()` takes it off.

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `focusable` | `.focusable(..)` | `boolean` | `true` for views that take presses | Whether the view is a stop of Tab. `true` makes any view one, whether it takes presses or leaves them to the views around it; `false` leaves a pressable to the pointer (a backdrop that closes a popover, rows the arrow keys move between). |
| `onFocus` | `.on_focus(..)` | `() => void` | | Tab (or `focus()`) gave the view the keyboard focus. |
| `onBlur` | `.on_blur(..)` | `() => void` | | The keyboard focus left the view. |

```rust tabs
view()
    .rounded_lg()
    .p_3()
    .focus(|s| s.bg(rgb(0xe0f2fe)))
    .on_press(open)
    .child(text("Open"))

// An overlay's backdrop: a click closes it, Tab goes past it to the content.
view().absolute().inset_0().focusable(false).on_press(close)

// A chart in a card: Tab stops at the chart, a click opens the card's page.
view().on_press(open_page).child(
    view()
        .h(px(160.0))
        .focusable(true)
        .focus(|s| s.bg(rgb(0xe0f2fe)))
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false)),
)
```

```tsx tabs
<View class="rounded-lg p-3 focus:bg-sky-100" onPress={open}>
  <Text>Open</Text>
</View>

{/* An overlay's backdrop: a click closes it, Tab goes past it to the content. */}
<View class="absolute inset-0" focusable={false} onPress={close} />

{/* A chart in a card: Tab stops at the chart, a click opens the card's page. */}
<View onPress={openPage}>
  <View
    class="h-40 focus:bg-sky-100"
    focusable
    onFocus={() => focused.set(true)}
    onBlur={() => focused.set(false)}
  />
</View>
```

### Layout and identity

| Prop | Rust | Type | Description |
|---|---|---|---|
| `onLayout` | `.on_layout(\|frame: &Bounds<Points>\| ..)` | `(e: { bounds: Bounds }) => void` | `bounds` is the view's frame relative to its parent, `{ origin, size }`, after each layout that changes it. |
| `ref` | `.element_ref(&handle)` | `ViewRef \| (node: ViewRef) => void` | The element's ref (see [ref methods](#ref-methods)): `ViewRef`, or the element's own type over it. `ref={el}` assigns a variable, `ref={fn}` calls a function. |
| `nativeID` | `.native_id(id)` | `string` | Names the view for others, e.g. the `InputAccessoryView` an input refers to. |
| `testID` | `.test_id(id)` | `string` | An identifier for UI tests (on Android, the view's resource id). |
| `key` | `.key(key)` | `string` | The element's identity among its siblings. |

### Gestures driving animated values

These props bind a gesture to [native animated values](../modules/nsh.md#animation) that move on the UI thread, with no
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

`PanEvent` is `{ cancelled, translation, velocity, value? }` (in Rust `cancelled`, `translation`, `velocity_x`,
`velocity_y`, `value_x`, `value_y`): whether the system cancelled the drag, the translation since the start and the
velocity in points per second (`Point`s), and the bound values at that moment, `{ x?, y? }` for the axes `pan` binds
(a drag can grab a value mid-animation).

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
`PanResponder` in [`PanResponder`](../modules/nsh.md#panresponder) builds on them. In Rust, `.on_touch(..)` hears every touch
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

In TSX, `ref` receives the element's ref, whose type is the element's own: `ViewRef` (`focus`, `blur`, `measure`) for
`View`, `Text`, `Image`, `Canvas`, `Overlay` and `Shader`, and a type over `ViewRef` with the element's methods for the
others: `InputRef` (`Input`), `ScrollRef` (`Scroll`), `ListRef` (`List`), `WebViewRef` (`WebView`), `VideoRef`
(`Video`) and `NativeComponentRef` (native components). In Rust, `element_ref()` makes an `ElementRef` handle that
`.element_ref(&handle)` attaches. Their methods send commands to the native view, in order with the changes made
before them in the same turn. Each element page says which apply to it. Type a ref variable with its element's own
type (`let field!: InputRef` for an `<Input>`): a variable typed `ViewRef` does not fit an element whose ref has methods
of its own.

| Method | Rust | Ref | Description |
|---|---|---|---|
| `focus()` / `blur()` | `focus()` / `blur()` | `ViewRef` | Focuses an `<Input>` (shows the keyboard), or gives a view that takes presses the keyboard focus / unfocuses. |
| `measure()` | `measure()` | `ViewRef` | [Where the view is](../docs/touch-and-gestures.md#where-a-view-is-measure). |
| `setSelection(start, end?)` | `set_selection(start, end)` | `InputRef` | Selects `start..end` in UTF-16 units; a caret without `end`. |
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point, animated)` | `ScrollRef`, `ListRef` | Scrolls to an offset. |
| `zoomTo({ scale, x?, y?, animated? })` | `zoom_to(scale, center, animated)` | `ScrollRef` (a zoomable `<Scroll>`) | Zooms to `scale` around a content point. |
| `scrollToOffset({ offset, animated? })` | `scroll_to_offset(offset, animated)` | `ListRef` | Scrolls to an offset along the list's axis. |
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | `scroll_to_index(index, position, offset, animated)` | `ListRef` | Scrolls an item into view. |
| `scrollToEnd({ animated? })` | `scroll_to_end(animated)` | `ScrollRef`, `ListRef` | Scrolls to the end of the content. |
| `reload()`, `goBack()`, `goForward()`, `stopLoading()`, `injectJavaScript(script)`, `postMessage(data)` | `reload()`, `go_back()`, `go_forward()`, `stop_loading()`, `inject_java_script(..)`, `post_message(..)` | `WebViewRef` | Controls the page. |
| `seek(seconds)` | `seek(seconds)` | `VideoRef` | Jumps to a time. |
| `command(name, args?)` | `command(name, args)` | `NativeComponentRef` | Calls a command of a registered native component ([`nativeComponent`](../modules/nsh.md#nativecomponent-and-nativemodule)). |

```rust tabs
let field = element_ref();

view()
    .on_press(move || field.focus())
    .child(input().element_ref(&field).placeholder("Tap the row to type"))
```

```tsx tabs
import { type InputRef, View } from "nsh";
import { Input } from "nsh/base";

let input!: InputRef;
<View onPress={() => input.focus()}>
  <Input ref={input} placeholder="Tap the row to type" />
</View>;
```

## Why handlers never block the UI

The main thread never waits for the app's code. When the system needs an answer on the spot (may this text change, may
the back button pop, may this sheet close), NSH answers it natively from props set beforehand (`maxLength`,
`popOnBack`, `closeOnSwipe`, …), and the event reaches the app afterwards. This is why such behavior
is a prop, not a return value of a handler.
