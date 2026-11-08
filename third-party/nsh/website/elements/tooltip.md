---
title: Tooltip
description: "The Tooltip component: a hint about the element it is in, shown on the desktops when the pointer rests on it, styled by the app."
group: base
demo: el-tooltip
---

# Tooltip

A tooltip is a short hint next to what it is about: what an icon button does, the full text of a truncated label.
On the desktops and in desktop browsers it shows once the pointer has rested on its trigger for `delay` (500 ms), and
hides when the pointer leaves or presses the trigger. On every device it also shows at once while the keyboard focus
is on its trigger, and hides when the focus leaves or Escape is pressed, so keyboard users read the same hints. Phones
and tablets otherwise show a tooltip only when the app opens it (`open`). It never takes the pointer or presses, so the
trigger works exactly as it does without it.

`Tooltip` from [`nsh/base`](../modules/nsh-base.md) is given as the `tooltip` prop every element has
([Common props](index.md#tooltips)), as GPUI's `.tooltip(..)`: the element is what the pointer rests on and what it
is placed against. The tooltip itself is the bubble: style it with `class` / `style`, and its children are what it says.

```rust tabs
use nsh_base::tooltip;
use nsh_core::prelude::*;

fn save_button(on_save: impl Fn() + 'static) -> impl IntoElement {
    view()
        .on_press(on_save)
        .accessibility_label("Save")
        .p_2()
        .child(text("💾"))
        .tooltip(
            tooltip()
                .placement(Placement::Bottom)
                .rounded_md()
                .bg(rgb(0x111827))
                .px_2()
                .py_1()
                .child(text("Save the document").text_color(white())),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";

function SaveButton(props: { onSave: () => void }) {
  return (
    <View
      onPress={props.onSave}
      accessibilityLabel="Save"
      class="p-2"
      tooltip={
        <Tooltip placement="bottom" class="rounded-md bg-gray-900 px-2 py-1">
          <Text class="text-white">Save the document</Text>
        </Tooltip>
      }
    >
      <Text>💾</Text>
    </View>
  );
}
```

It goes above its trigger by default (`placement`), on the other side when there is no room, and stays inside the safe
area. With `open` the app decides when it shows: it follows `onOpenChange`, which reports the pointer resting on the
trigger or leaving it and the keyboard focus coming and going, and can show it on any device.

In a terminal a tooltip is a line, as terminal apps show a hint: what it says shows at once on the bottom row of
the screen, in the terminal's own colors, while the keyboard focus or the pointer is on its trigger, and the row clears
when they leave. The pointer's hint shows over the focus's while the pointer is on its trigger; a toast's message takes
the row while it shows. `delay` is not waited for there (`Infinity` still keeps it to the app's `open`), and the
tooltip's own look and transitions apply only to the bubble the other devices show; its children, a shortcut's `Kbd`
included, show as they are.

It comes and goes with your transitions: `startingClass` is its look in its first frame and `endingClass` its look
once hidden, which it keeps while the `transition-*` classes of its `class` run; `onClose` follows.

```tsx
<Tooltip
  class="rounded-md bg-gray-900 px-2 py-1 transition-opacity duration-100"
  startingClass="opacity-0"
  endingClass="opacity-0"
>
  <Text class="text-white">Save the document</Text>
</Tooltip>
```

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | none | What it says. |
| `class`, `style` | `.app_class(..)`, `Styled` methods | `string`, `StyleProp<ViewStyle>` | none | The look of the bubble: the tooltip itself. |
| `startingClass`, `startingStyle` | `.starting_class(..)`, `.starting_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Its look in its first frame: its transitions run from it. |
| `endingClass`, `endingStyle` | `.ending_class(..)`, `.ending_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Its look once hidden: it stays while its transitions run. |
| `open` | `.open(..)` | `boolean` | none | Shown, controlled by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Shown at first, without `open`. |
| `delay` | `.delay(..)` | `number` | `500` | Milliseconds the pointer rests on the trigger before it shows (the keyboard focus shows it at once); `Infinity`: never by itself, neither for the pointer nor the focus, only when the app opens it. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It never shows. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"top"` | The side of the trigger it goes on. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | How it lines up with the trigger along that side. |
| `offset` | `.offset(..)` | `number` | `4` | The gap between the trigger and the tooltip. |
| `margin` | `.margin(..)` | `number` | `4` | The distance it keeps from the edges of the safe area. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | The pointer rested on the trigger, or left or pressed it (`reason` `"hover"`); the keyboard focus came to it or left it (`"focus"`); Escape was pressed while it showed (`"cancel"`). |
| `onOpen` | `.on_open(\|\| ..)` | It is shown. |
| `onClose` | `.on_close(\|\| ..)` | It is gone, after its exit; also when the app hid it. |

## Accessibility

A tooltip repeats what its trigger says to screen readers: give the trigger an `accessibilityLabel` too, so the
hint is there for everyone.
