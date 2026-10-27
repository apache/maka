---
title: Switch
description: "The Switch component: an on / off control that owns presses, keyboard activation, the disabled state and its role and value for screen readers, with a track and a thumb the app styles."
order: 20.5
group: base
demo: el-switch
---

# Switch

A switch turns a setting on or off, and the change takes effect at once. It owns the behavior: presses, keyboard
activation, the disabled state, and the switch role and its value for screen readers. The look is the app's: a
`Switch` has no colors, sizes, motion or label of its own. It is made of a track with a thumb inside it, then its
children (a label), and the app styles each part, with `checked:` and `disabled:` classes that follow the switch.

```rust tabs
use nsh_base::{switch, theme};
use nsh_core::prelude::*;

fn wifi() -> impl IntoElement {
    let on = signal(false);
    switch()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_3()
        .track_style(|s| {
            s.w(px(44.0))
                .p(px(2.0))
                .rounded_full()
                .bg(move || theme().muted)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary))
        })
        .thumb_style(|s| {
            s.size(px(20.0))
                .rounded_full()
                .bg(move || theme().background)
                .shadow_sm()
                .transition_transform()
                .checked(|s| s.translate_x(px(20.0)))
        })
        .child(text("Wi-Fi"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Switch } from "nsh/base";

function App() {
  const on = signal(false);
  return (
    <Switch
      checked={on()}
      onChange={(next) => on.set(next)}
      class="flex-row items-center gap-3"
      trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
      thumbClass="size-5 rounded-full bg-background shadow-sm transition-transform checked:translate-x-5"
    >
      <Text>Wi-Fi</Text>
    </Switch>
  );
}

mount(App);
```

`Switch` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the app's: a
press reports the next value with `onChange`, and the switch shows the `checked` the app passes back. In Rust,
`switch()` makes one with a setter per prop (`.checked(..)`, `.track_style(..)`), a listener per event
(`.on_change(..)`), the typed style methods for the switch itself and `.child(..)` for its label; a part's style takes
the state methods (`.checked(..)`, `.disabled_style(..)`) that follow the switch.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | On or off. A press reports the next value with `onChange`; the switch shows the value the app passes back. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply to the switch and its parts, and screen readers say it is dimmed. |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The switch's style while `checked` and not disabled, as `checked:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: what the switch turns on, when its children have no text that says it. |
| `trackClass`, `trackStyle` | `.track_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The track, the part the thumb moves along. |
| `thumbClass`, `thumbStyle` | `.thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The thumb, inside the track. |
| `children` | `.child(..)` | `JSX.Element` | none | The content after the track: a label, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The switch itself: the row around the track and the label. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The switch's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | The switch was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. It reports the value the switch asks for, the opposite of `checked`. |

A disabled switch reports nothing.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The switch | | `class`, `style` | `checked:`, `disabled:`, `active:`, `hover:`, `focus:` (or `checkedStyle`, `disabledStyle`, ...) |
| The track | the switch, first | `trackClass`, `trackStyle` | `checked:`, `disabled:` follow the switch |
| The thumb | the track | `thumbClass`, `thumbStyle` | `checked:`, `disabled:` follow the switch |
| The label | the switch, after the track | its own elements (`children`) | `group-checked:` and the other `group-*:` variants with `group` on the switch's `class` |

The thumb moves by its own `checked:` styles: a translation (`checked:translate-x-5`), or a margin or the track's
alignment (`checked:justify-end` on the track). A `transition-*` class animates the change natively. To place the
label before the track, reverse the row: `class="flex-row-reverse justify-between"`.

## Disabled

A disabled switch takes no presses, and screen readers announce it as dimmed. Its `disabled:` classes and those of
its track and thumb apply, over their `checked:` ones:

```tsx
<Switch
  checked={on()}
  disabled={!online()}
  onChange={(next) => on.set(next)}
  class="flex-row items-center gap-3 disabled:opacity-50"
  trackClass="w-11 rounded-full bg-muted p-0.5 checked:bg-primary disabled:bg-muted"
  thumbClass="size-5 rounded-full bg-background checked:translate-x-5"
>
  <Text>Sync over cellular</Text>
</Switch>
```

## Accessibility

- A switch is one element for screen readers, with the role `"switch"` and its value (on or off); the track and the
  thumb are parts of it. Its label is the text of its children; give `accessibilityLabel` when it has none.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).
- On macOS and the web a switch is a stop of the keyboard focus: Tab reaches it, Space and Return toggle it, and
  `focus:` styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the switch, its label included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  toggle the switch that has the keyboard focus.
- Every platform draws what the app styles; the thumb moves as the app's styles and transitions say.
