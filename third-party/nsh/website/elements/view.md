---
title: View
description: "The basic container element: layout, backgrounds, borders, shadows, press handling and gestures."
order: 2
group: primitives
demo: el-view
---

# View

`View` is the building block of every screen: a native container (a UIView on iOS and Mac Catalyst, a ViewGroup on
Android) that lays out its children with flexbox or grid, draws a background, borders, shadows and gradients, and handles
presses. Buttons, cards, rows and screens are all views. Rust makes one with `view()`, TSX with `<View>` from `nsh`.

```rust tabs
use nsh_core::ui::prelude::*;

fn app() -> impl IntoElement {
    let liked = signal(false);
    view()
        .flex_1()
        .p_6()
        .gap_4()
        .bg(rgb(0xf6f8fa))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .p_4()
                .rounded(px(16.0))
                .bg(white())
                .shadow_md()
                .child(view().size(px(40.0)).rounded_full().bg(rgb(0x8250df)))
                .child(text("A card").flex_1().text_base())
                .child(
                    view()
                        .hit_slop(EdgeInsets::all(px(8.0)))
                        .active(|s| s.opacity(0.5))
                        .on_press(move || liked.update(|l| *l = !*l))
                        .child(text(move || if liked.get() { "♥" } else { "♡" }).text_size(px(22.0))),
                ),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function App() {
  const liked = signal(false);
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: "#f6f8fa" }}>
      <View
        style={{
          backgroundColor: "#ffffff",
          borderRadius: 16,
          padding: 16,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#8250df" }} />
        <Text style={{ flex: 1, fontSize: 16 }}>A card</Text>
        <View onPress={() => liked.set(!liked())} activeStyle={{ opacity: 0.5 }} hitSlop={8}>
          <Text style={{ fontSize: 22 }}>{liked() ? "♥" : "♡"}</Text>
        </View>
      </View>
    </View>
  );
}

mount(App);
```

## Layout

A view lays out its children with flexbox, with these defaults: `flexDirection: "column"`, `flexShrink: 0`,
`alignContent: "flex-start"`, `position: "relative"`. `display: "grid"` (`.grid()` in Rust) switches to CSS grid and
`display: "block"` to block layout. Sizes are in points. See [layout](../docs/layout.md) and the
[style reference](../modules/style-reference.md).

The Tailwind `flex` class follows CSS rather than the style default: `class="flex"` is a row. Use `flex-col` for a
column. In Rust, `.flex_row()` and `.flex_col()` say the direction.

## Props

`View` has no props of its own beyond the [common props](./index.md#common-props): its styles (`style`, `class`,
`classList`; the `Styled` methods in Rust), `disabled`, the press props (`onPress`, `onLongPress`, `onPressDown`,
`onPressUp`, `delayLongPress`, `hitSlop`, `pointerEvents`), the state styles (`activeStyle`, `hoverStyle`,
`focusStyle`, `disabledStyle`, `checkedStyle`), `onHoverIn` / `onHoverMove` / `onHoverOut`, `onContextMenu`,
`onFileDragEnter` / `onFileDragLeave` / `onFileDrop`, `focusable`, `onLayout`, `ref`, `nativeID`, `testID`, the
gesture props (`pan`, `pinch`, `rotation` and their events), the touch and responder props, the accessibility props
and `ios` / `android` / `desktop`.

## Press feedback

A pressable view is any view with a press handler. Its feedback is the app's: a style while pressed, applied natively
while the finger is down, with no round trip to the app's code. `hoverStyle`, `focusStyle` and `disabledStyle` do the
same for the other states:

```rust tabs
// Fade the whole view.
view().on_press(open).active(|s| s.opacity(0.6))

// Show a background; group_active styles the children.
view()
    .group()
    .on_press(open)
    .active(|s| s.bg(rgb(0xe5e7eb)))
    .child(text("Open").group_active(|s| s.opacity(0.7)))

// Change any style while pressed.
view().on_press(open).bg(rgb(0x2563eb)).active(|s| s.bg(rgb(0x1e40af)).scale(0.95))
```

```tsx tabs
// Fade the whole view.
<View onPress={open} activeStyle={{ opacity: 0.6 }}>…</View>

// Show a background; group-active: styles the children.
<View onPress={open} class="group" activeStyle={{ backgroundColor: "#e5e7eb" }}>
  <Text class="group-active:opacity-70">Open</Text>
</View>

// Change any style while pressed with active: classes.
<View onPress={open} class="bg-blue-600 active:bg-blue-800 active:scale-95">…</View>
```

On Android, `android={{ ripple: { color: "#0000001f" } }}` (`.ripple(Ripple { .. })` in Rust) adds the material
ripple (`borderless`, `radius` and `foreground` adjust it).

`disabled` removes the press listeners from the native view (no press, no feedback) and applies the disabled styles:

```rust tabs
view()
    .on_press(submit)
    .disabled(move || !valid.get())
    .bg(rgb(0x16a34a))
    .disabled_style(|s| s.opacity(0.4))
```

```tsx tabs
<View onPress={submit} disabled={!valid()} class="bg-green-600 disabled:opacity-40">…</View>
```

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onPress` | `.on_press` | none | A tap ended inside the view. |
| `onLongPress` | `.on_long_press` | none | The finger stayed down for `delayLongPress` (500 ms). |
| `onPressDown` / `onPressUp` | `.on_press_down` / `.on_press_up` | none | A finger went down / lifted or left. |
| `onHoverIn` / `onHoverOut` | `.on_hover_in` / `.on_hover_out` | none | The mouse came over the view (or a view inside it) / left it or the window ([hover](./index.md#hover)). |
| `onHoverMove` | `.on_hover_move` | `HoverEvent` | The mouse moved over the view with no button down: `position`, `pagePosition` (`Point`s) and `modifiers`; at most once a frame. |
| `onMouseMove` | `.on_mouse_move` | TSX `Point`; Rust `Point<Points>` | Mouse movement, including with a button down, on macOS, Linux, Windows, GPUI and web. Local coordinates in points; nested listeners hear it inside out, at most once a frame. |
| `onContextMenu` | `.on_context_menu` | `ContextMenuEvent` | The secondary button was pressed over the view ([context menus](./index.md#context-menus)). |
| `onFileDragEnter` / `onFileDragLeave` | `.on_file_drag_enter` / `.on_file_drag_leave` | none | A local-file drag entered / left the active desktop destination. |
| `onFileDrop` | `.on_file_drop` | `{ uris: string[] }` (`FileDropEvent`) | Local files or directories were dropped on the desktop destination. |
| `onLayout` | `.on_layout` | `Bounds` (`Bounds<Points>`) | The frame relative to the parent changed. |
| `onPanStart` / `onPanEnd` | `.on_pan_start` / `.on_pan_end` | `PanEvent` | A drag bound with `pan` started / ended; `cancelled` is true when the system cancels it. |
| `onPinchStart` / `onPinchEnd` | `.on_pinch_start` / `.on_pinch_end` | `{ scale, velocity }` | A pinch bound with `pinch` started / ended. |
| `onRotationStart` / `onRotationEnd` | `.on_rotation_start` / `.on_rotation_end` | `{ rotation, velocity }` | A rotation bound with `rotation` started / ended. |
| `onAccessibilityAction` | `.on_accessibility_action` | `{ actionName }` | A custom accessibility action ran. |

Touch and responder events: see [common props](./index.md#raw-touches-and-the-responder-system).

## Desktop file drops

On AppKit, GTK and Win32, a view with `onFileDrop` receives local files and directories dragged from another
application. `onFileDragEnter` and `onFileDragLeave` track the active destination; `onFileDrop` receives
`{ uris: string[] }` in the native file-list order. Each entry is an absolute `file:` URL with escaped spaces and
non-ASCII characters. Parse the URL to obtain a filesystem path rather than removing the prefix by hand.

```rust tabs
let hovering = signal(false);
let files = signal(Vec::<String>::new());

view()
    .min_h(px(160.0))
    .p_6()
    .on_file_drag_enter(move || hovering.set(true))
    .on_file_drag_leave(move || hovering.set(false))
    .on_file_drop(move |event: &FileDropEvent| {
        files.set(event.uris.clone());
        hovering.set(false);
    })
    .child(text(move || if hovering.get() { "Release files here" } else { "Drop files here" }))
    .child(text(move || files.get().join("\n")))
```

```tsx tabs
const hovering = signal(false);
const files = signal<string[]>([]);

<View
  onFileDragEnter={() => hovering.set(true)}
  onFileDragLeave={() => hovering.set(false)}
  onFileDrop={(event) => {
    files.set(event.uris);
    hovering.set(false);
  }}
  style={{ minHeight: 160, padding: 24 }}
>
  <Text>{hovering() ? "Release files here" : "Drop files here"}</Text>
  <Text>{files().join("\n")}</Text>
</View>
```

The closest enabled ancestor listening to `onFileDrop` receives the drop. A modal root bounds that search. `disabled`
removes file-drag/drop listeners; leaving, cancellation, completion and destination removal clear the active state.
Acceptance uses the Copy operation and mounted native state. The app decides whether to read, open or transfer the
received files.

## Ref methods

A plain view has no commands of its own. `ref` (`.element_ref(&handle)` in Rust) gives you its node, e.g. to pass to
`setAccessibilityFocus` ([`nsh/accessibility`](../modules/nsh-accessibility.md)), or to measure it
(`handle.measure()` in Rust).

## Views inside text

A view placed inside a text is an inline attachment: it sits on the baseline and wraps with the words, and it takes
presses of its own. See [text](./text.md#inline-views-and-images).

## Platform notes

- `boxShadow` and the shadow props (`shadowColor`, `shadowOpacity`, `shadowRadius`, `shadowOffset`) draw on
  both platforms; `android={{ elevation }}` gives Android's material shadow instead. On Android a shadow needs a
  background color (a view with a transparent background casts none).
- `filter` on views: iOS supports `opacity()`, `brightness()` up to 1 and `drop-shadow()` (images take every color
  filter and `blur()`); Android supports them all from API 31, and the color filters below it.
- `backdropFilter: "blur(…)"` is a system material on iOS (an approximation) and needs API 31 on Android.
- Android draws `translate`, `scale` and `rotate` transforms; `skewX` / `skewY` apply on the other platforms.
- `borderCurve: "continuous"` (`.border_curve(BorderCurve::Continuous)`) draws corners that ease into the edges (as
  iOS app icons), on both platforms.
- The `cursor` style applies where there is a pointer (Mac Catalyst, iPad with a pointer, desktops).
