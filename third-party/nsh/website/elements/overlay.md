---
title: Overlay
description: "The Overlay element: content shown on top of the screen whatever clips its parent, laid out as a fixed box or placed against an anchor that it follows, with presses outside and Escape reported."
order: 10.5
group: primitives
demo: el-overlay
---

# Overlay

An overlay shows its children on top of everything in the root view it is in: the window, or the dialog around it.
Its parent's size, `overflow: hidden` and scroll views do not clip it. It stays where you wrote it for everything
else: it reads the context around it, its handlers are its component's, and it goes away with its parent. Popovers,
menus, tooltips and sheets are built on it; [`nsh/base`](../modules/nsh-base.md) has them ready
([Popover](./popover.md), [Menu](./menu.md), [Tooltip](./tooltip.md), [Sheet](./sheet.md)), and an overlay is what you
use to build your own.

```rust tabs
use nsh_core::ui::prelude::*;

fn more_button() -> impl IntoElement {
    let open = signal(false);
    let anchor = element_ref();
    view()
        .child(
            view()
                .element_ref(&anchor)
                .on_press(move || open.update(|o| *o = !*o))
                .px_3()
                .py_2()
                .child(text("More")),
        )
        .child(when(move || open.get(), move || {
            overlay()
                .anchor(&anchor)
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(6.0))
                .margin(px(8.0))
                .on_press_outside(move |_: &Point<Points>| open.set(false))
                .on_cancel(move || open.set(false))
                .rounded_lg()
                .bg(white())
                .p_3()
                .shadow_lg()
                .child(text("Shown above everything"))
        }))
}
```

```tsx tabs
import { Overlay, signal, Text, View, type YNode } from "nsh";

function MoreButton() {
  const open = signal(false);
  let anchor: YNode | undefined;
  return (
    <View>
      <View ref={anchor} onPress={() => open.set(!open())} class="px-3 py-2">
        <Text>More</Text>
      </View>
      <If when={open()}>
        <Overlay
          anchor={anchor}
          placement="bottom"
          align="start"
          offset={6}
          margin={8}
          onPressOutside={() => open.set(false)}
          onCancel={() => open.set(false)}
          class="rounded-lg bg-white p-3 shadow-lg"
        >
          <Text>Shown above everything</Text>
        </Overlay>
      </If>
    </View>
  );
}
```

`Overlay` comes from `nsh` in TSX and `overlay()` from `nsh_core::ui::prelude` in Rust. It is shown while it is in the
view: put it in an `If` (Rust: `when(..)`) to open and close it. Overlays shown later are on top of earlier ones, and
an overlay inside another is on top of it.

## Placement

Without `anchor`, an overlay is laid out as a `position: fixed` box of its root view: its `top`, `left`, `inset`,
size and margins are against the whole window (or dialog). `class="inset-0"` covers it, which is a backdrop or a
full-window layer; `class="bottom-0 left-0 right-0"` is a bar along the bottom.

With `anchor`, NSH places it next to the anchor:

- `anchor` is a view (a `ref`), a `Point` (`{ x, y }`) in the root view's coordinates, the `pageX` / `pageY` of a touch
  (a menu where the pointer is), or a `Bounds` (`{ origin, size }`) there: an input's caret (`onCaretMove`'s `pageBounds`), where suggestions
  for what is being typed open.
- `placement` is the side it goes on: `"top"`, `"bottom"` (the default), `"left"` or `"right"`. When it does not fit
  there and fits on the other side, it goes there; when it fits on neither, it goes on the side with more room.
- `align` lines it up along that side: `"start"`, `"center"` (the default) or `"end"`. Above and below the anchor,
  start and end follow the layout direction: start is the left edge, or the right edge in a right-to-left layout.
- `offset` is the gap between the anchor and the overlay; `margin` the distance it keeps from the edges of the
  safe area, which it stays inside of: it slides along its side to fit.

An anchored overlay follows its anchor: when the anchor scrolls, moves or changes size, the overlay moves with it in
the same frame NSH lays it out. `onPosition` tells where it went, so an arrow can point at the anchor or a long menu can
limit its height:

```tsx
<Overlay
  anchor={anchor}
  onPosition={(e) => {
    side.set(e.placement); // "top" when it flipped
    maxHeight.set(e.available.height);
  }}
/>
```

## Dismissing

An overlay reports what usually closes a popup and leaves the decision to you:

- `onPressOutside` fires when a finger or a mouse button goes down outside the overlay, its anchor and the overlays
  inside it. The press goes on to what is under it.
- `onCancel` fires on Escape, the Android back button and VoiceOver's escape gesture on iOS, for the top overlay that listens to it only. It takes them
  before the pages and `BackHandler`.

To block the screen behind a popup, put a second overlay under it with `class="inset-0"` and an `onPress` that closes
both: that is how [Sheet](./sheet.md) and the phone presentation of [Popover](./popover.md) work.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `anchor` | `.anchor(&element_ref)`, `.anchor_point(point)`, `.anchor_bounds(bounds)` | `YNode \| Point \| Bounds \| null` | none | The view, the point or the box it is placed against. Without one it is a fixed box of its root view. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | The side of the anchor it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | How it lines up with the anchor along that side. |
| `offset` | `.offset(px(..))` | `number` | `0` | The gap between the anchor and the overlay. |
| `margin` | `.margin(px(..))` | `number` | `0` | The distance it keeps from the edges of the safe area. |
| `children` | `.child(..)` | `JSX.Element` | none | What it shows. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Its look and, without an anchor, where it is. |

It also takes the [common props](./index.md#common-props) of a view.

## Events

| Event | Rust | Description |
|---|---|---|
| `onPressOutside` | `.on_press_outside(\|point\| ..)` | A press went down outside it, its anchor and the overlays inside it (`pagePosition`, a `Point`). |
| `onCancel` | `.on_cancel(\|\| ..)` | Escape, the Android back button or VoiceOver's escape gesture, while it is the top overlay listening. |
| `onPosition` | `.on_position(\|position\| ..)` | NSH placed it: `placement` (the side it went on), `bounds` in the root view, and `available` (a `Size`: the room on that side). |

## Platform notes

- Every platform shows an overlay as a native view of the window's (or the dialog's) root view, drawn and hit-tested
  as the views around it are: UIKit, Android views, AppKit, GTK, Win32, GPUI and the DOM.
- An overlay inside a [Dialog](./dialog.md) shows in that dialog, above its content.
- Overlays stay in their window: a menu that would reach past the window's edge slides back inside it.
