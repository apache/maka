---
title: Sheet
description: "The Sheet component: a panel at an edge of the screen over a backdrop, closed by the backdrop, Escape and back, styled by the app."
order: 29
group: base
demo: el-sheet
---

# Sheet

A sheet is a panel at an edge of the screen over a backdrop that covers the rest: filters, a share panel, a side
drawer. A press on the backdrop, Escape, the Android back button and VoiceOver's escape gesture close it. It shows on top of everything in its
window, the same on every device, and draws nothing of its own: the panel and the backdrop are the app's.

```rust tabs
use nsh_base::{SheetEvent, sheet};
use nsh_core::prelude::*;

fn filters(open: Signal<bool>) -> impl IntoElement {
    sheet()
        .open(move || Some(open.get()))
        .on_open_change(move |e: &SheetEvent| {
            if let SheetEvent::OpenChange(next, _) = e {
                open.set(*next);
            }
        })
        .child(
            view()
                .gap_3()
                .p_6()
                .rounded_t(px(16.0))
                .bg(white())
                .child(text("Filters").font_weight(FontWeight::SEMIBOLD))
                .child(view().on_press(move || open.set(false)).child(text("Done"))),
        )
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";

function Filters() {
  const open = signal(false);
  return (
    <>
      <View onPress={() => open.set(true)}><Text>Filters</Text></View>
      <Sheet
        open={open()}
        onOpenChange={(next) => open.set(next)}
        popupClass="gap-3 rounded-t-2xl bg-white p-6"
        backdropClass="bg-black/40"
      >
        <Text class="font-semibold">Filters</Text>
        <View onPress={() => open.set(false)}><Text>Done</Text></View>
      </Sheet>
    </>
  );
}
```

`Sheet` comes from [`nsh/base`](../modules/nsh-base.md). Its content is made each time it opens. `side` puts it at
the `"bottom"` (the default) or `"top"` of the screen, as wide as the screen, or at the `"left"` or `"right"`, as tall
as the screen; its size across is the panel's, from its content or `popupClass`.

Its slide follows the panel's measured size as content is created or grows during the entrance. Lazy content and
asynchronous size updates share the same animation progress; the panel settles at its current size.

## Open state

Without `open`, the sheet keeps its own state, starting from `defaultOpen`. With `open`, the app owns it: change it in
`onOpenChange(open, reason)`, which reports each request to close with its reason (`"backdropPress"`, `"cancel"`, `"swipe"`).
`onOpen` and `onClose` follow it in and out, whoever opened or closed it.

`closeOnEscape={false}` keeps it open on Escape and back, `closeOnBackdropPress={false}` on presses on the backdrop;
`onCancel` still hears them, to ask first.

## Dragging a bottom sheet

Set `closeOnSwipe` to let a bottom panel follow downward dragging. Its backdrop fades with the distance; releasing
past 30% of the panel's height, or downward at 800 points per second, requests closing with reason `"swipe"`.
A shorter drag returns smoothly. A controlled owner can keep `open` true to return the panel after a close request.
With reduced motion, release and programmatic opening/closing settle immediately; direct dragging still follows the finger.

The panel fits its content, including short menus; use `popupStyle` or a child's height to constrain taller content.
The app draws its own handle, which can be any view inside the panel. On iOS, an inner vertical `Scroll` or `List`
consumes the drag until its top and hands the remaining downward motion to the panel within the same gesture.
On Android, desktops and the web, dragging the handle or content outside a scroll uses their native pan support;
inner scrolls keep their platform's normal gesture arbitration. Setting `closeOnSwipe` to false keeps the panel
stationary and preserves the mounted content and scroll position. Other sides retain their existing behavior.

## Native sheets

A sheet is drawn by NSH in the app's window, styled by the app. For the platform's own presented sheet (a page sheet
on iOS), use a [Dialog](./dialog.md) with `presentation="pageSheet"`.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `side` | `.side(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | The edge it is on. |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape and the Android back button close it. |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean` | `true` | A press on the backdrop closes it. |
| `closeOnSwipe` | `.close_on_swipe(..)` | `boolean` | `false` | A bottom panel follows downward dragging and closes on a sufficient release. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the panel. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the backdrop, such as a translucent color. |
| `children` | `.child(..)` | `JSX.Element` | none | The content. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | A close request, with why: `"backdropPress"`, `"cancel"` or `"swipe"`. |
| `onOpen` | `.on_open(\|\| ..)` | It came in: it is all there. |
| `onClose` | `.on_close(\|\| ..)` | It went: it is all gone. Also when the app closed it. |
| `onCancel` | `.on_cancel(\|\| ..)` | The user tried to close it (Escape or back, a press on the backdrop, an enabled swipe), whether or not it closed. |
