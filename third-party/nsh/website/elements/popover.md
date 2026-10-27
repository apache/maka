---
title: Popover
description: "The Popover component: content anchored to a trigger, on top of everything, that the trigger, a press outside, Escape and back close, styled by the app."
order: 26
group: base
demo: el-popover
---

# Popover

A popover shows content next to its trigger, on top of everything else: details, a small form, a color picker.
Pressing the trigger opens and closes it; a press outside, Escape, the Android back button and VoiceOver's escape gesture close it. It is placed
on a side of the trigger, moves to the other side when there is no room, stays inside the safe area and follows the
trigger as it scrolls. It draws nothing of its own: the popup and its content are the app's.

```rust tabs
use nsh_base::{OpenChangeReason, PopoverEvent, popover};
use nsh_core::prelude::*;

fn details() -> impl IntoElement {
    popover()
        .offset(px(6.0))
        .margin(px(8.0))
        .trigger(view().px_3().py_2().rounded_md().bg(rgb(0xe5e7eb)).child(text("Details")))
        .on_open_change(|e: &PopoverEvent| {
            if let PopoverEvent::OpenChange(open, OpenChangeReason::PressOutside) = e {
                log::info!("closed by a press outside: {open}");
            }
        })
        .child(
            view()
                .w(px(240.0))
                .gap_1()
                .p_3()
                .rounded_lg()
                .bg(white())
                .shadow_lg()
                .child(text("Order #1024").font_weight(FontWeight::SEMIBOLD))
                .child(text("Shipped yesterday, arriving Friday.")),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Popover } from "nsh/base";

function Details() {
  return (
    <Popover
      offset={6}
      margin={8}
      popupClass="w-60 gap-1 rounded-lg bg-white p-3 shadow-lg"
      trigger={
        <View class="rounded-md bg-gray-200 px-3 py-2">
          <Text>Details</Text>
        </View>
      }
    >
      <Text class="font-semibold">Order #1024</Text>
      <Text>Shipped yesterday, arriving Friday.</Text>
    </Popover>
  );
}
```

`Popover` comes from [`nsh/base`](../modules/nsh-base.md). Its content is made each time it opens, so state inside it
starts fresh.

## Open state

Without `open`, the popover keeps its own state, starting from `defaultOpen`. With `open`, the app owns it: change it
in `onOpenChange(open, reason)`, which reports every request to open or close with its reason (`"triggerPress"`,
`"pressOutside"`, `"cancel"`).

```tsx
const open = signal(false);

<Popover open={open()} onOpenChange={(next) => open.set(next)} trigger={<Text>Filters</Text>}>
  <FilterForm onApply={() => open.set(false)} />
</Popover>
```

`closeOnEscape={false}` keeps it open on Escape and back (`onCancel` still hears them, to ask first);
`closeOnPressOutside={false}` keeps it open on presses outside.

## A separate anchor

A controlled popover can use `anchor={rowRef}` to follow an element rendered elsewhere, without moving that element
into `trigger`. The ref is a `YNode` in the same root view and takes precedence over the trigger's bounds. Keep the
anchor mounted while the popover is open; close the popup when its virtualized row retires. The anchor controls
placement: keyboard focus returns to the actual opener, such as a list's search field.

## Phones and desktops

A popover is anchored to its trigger on every device: what it shows belongs next to what opened it.

- On the desktops and in desktop browsers, a press outside closes it and goes on to what is under the pointer, so
  one click both closes the popover and presses the button it landed on.
- On phones and tablets, a press outside only closes it: a transparent backdrop takes the press, as the system's
  popovers do.

For a list of actions use a [Menu](./menu.md), which becomes a sheet on phones; for a panel use a [Sheet](./sheet.md).

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | none | Open, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | The side of the trigger it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | How it lines up with the trigger along that side. |
| `offset` | `.offset(..)` | `number` | `0` | The gap between the trigger and the popup. |
| `margin` | `.margin(..)` | `number` | `0` | The distance it keeps from the edges of the safe area. |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape and the Android back button close it. |
| `closeOnPressOutside` | `.close_on_press_outside(..)` | `boolean` | `true` | A press outside closes it. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The look of the popup, the box the content is in. |
| `anchor` | `.anchor(..)` | `YNode \| null` | none | An element rendered elsewhere to place it against, before the trigger's bounds. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens it; it is placed against it. |
| `children` | `.child(..)` | `JSX.Element` | none | The content. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | It opened or closed, with why: `"triggerPress"`, `"pressOutside"` or `"cancel"`. |
| `onOpen` | `.on_open(\|\| ..)` | It is shown. |
| `onClose` | `.on_close(\|\| ..)` | It is gone, also when the app closed it. |
| `onCancel` | `.on_cancel(\|\| ..)` | The user tried to close it (Escape or back, a press outside), whether or not it closed. |

## Accessibility

The trigger tells screen readers whether the popover is expanded. Escape and the back button close it, as users expect
of a popup. In TSX the trigger is the element you pass: it takes the presses and the expanded state itself, so its own
`active:` classes and `activeStyle` show while it is pressed, and its own `onPress` runs too.
