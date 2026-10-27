---
title: Radio
description: "Radio and RadioGroup: a set of options the user picks exactly one of. Each radio owns presses, keyboard activation, the disabled state and its role and checked state for screen readers; the group is the set; the look and the value are the app's."
order: 20.4
group: base
demo: el-radio
---

# Radio

Radios offer a set of options the user picks exactly one of: a plan, a sort order, a theme. Each `Radio` owns the
behavior of one option: presses, keyboard activation, the disabled state, and the radio role and its checked state for
screen readers. A `RadioGroup` around them is the set, which screen readers announce as one group. The look is the
app's: a radio has no circle, dot, colors, sizes or label of its own. Its children are the app's indicator and label,
and `checked:` classes on the radio, or `group-checked:` classes on what is inside it, follow its state.

```rust tabs
use nsh_base::{radio, radio_group, theme};
use nsh_core::prelude::*;

fn plans() -> impl IntoElement {
    let plan = signal("basic");
    let option = move |value: &'static str, label: &'static str| {
        let checked = move || plan.get() == value;
        radio()
            .checked(checked)
            .on_change(move |_: &bool| plan.set(value))
            .flex_row()
            .items_center()
            .gap_2()
            .child(
                view()
                    .size(px(20.0))
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border_2()
                    .border_color(move || theme().border)
                    .child(
                        view()
                            .size(px(10.0))
                            .rounded_full()
                            .bg(move || theme().primary)
                            .opacity(move || if checked() { 1.0_f32 } else { 0.0 }),
                    ),
            )
            .child(text(label))
    };
    radio_group()
        .gap_3()
        .child(option("basic", "Basic"))
        .child(option("pro", "Pro"))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";

function App() {
  const plan = signal("basic");
  const option = (value: string, label: string) => (
    <Radio
      checked={plan() === value}
      onChange={() => plan.set(value)}
      class="group flex-row items-center gap-2"
    >
      <View class="size-5 items-center justify-center rounded-full border-2 border-border group-checked:border-primary">
        <View class="size-2.5 rounded-full group-checked:bg-primary" />
      </View>
      <Text>{label}</Text>
    </Radio>
  );
  return (
    <RadioGroup class="gap-3">
      {option("basic", "Basic")}
      {option("pro", "Pro")}
    </RadioGroup>
  );
}

mount(App);
```

`Radio` and `RadioGroup` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is
the app's: the group holds none. Each radio is told whether it is checked; a press on an unchecked radio reports
`onChange(true)`, the app sets its value, and every radio shows the `checked` the app passes back. In Rust, `radio()`
and `radio_group()` make them, with a setter per prop (`.checked(..)`), a listener per event (`.on_change(..)`), the
typed style methods and `.child(..)` for their content.

## Props

### Radio

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | Checked or not. A press on an unchecked radio reports `true` with `onChange`; the radio shows the value the app passes back. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply, and screen readers say it is dimmed. |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The radio's style while checked and not disabled, as `checked:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: the option, when its children have no text that says it. |
| `children` | `.child(..)` | `JSX.Element` | none | The app's indicator and label, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The radio itself: the row around the indicator and the label. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The radio's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

### RadioGroup

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | none | The radios of the set, and whatever the app lays out between them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The group's layout and look: a column by default, `flex-row` for a row. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` (`Radio`) | `.on_change(\|checked: &bool\| ..)` | An unchecked radio was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. It asks to be checked, so the value is `true`. It runs before anything changes: the radio shows the `checked` the app passes back. |

A checked radio stays checked and reports nothing, as a radio cannot uncheck itself; a disabled radio reports nothing
either.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The group | | `RadioGroup`'s `class`, `style` | |
| The radio | the group | `Radio`'s `class`, `style` | `checked:`, `disabled:`, `active:`, `hover:`, `focus:` (or `checkedStyle`, `disabledStyle`, ...) |
| The indicator and the label | the radio | their own elements (`children`) | `group-checked:`, `group-disabled:` and the other `group-*:` variants with `group` on the radio's `class` |

The indicator is the app's content: a ring with a dot, a check, a highlighted card. With `group` on the radio's
`class`, its `group-checked:` classes show the dot while the radio is checked.

## Disabled

A disabled radio takes no presses, and screen readers announce it as dimmed. Its `disabled:` classes apply over its
`checked:` ones, and `group-disabled:` classes inside it follow:

```tsx
<Radio
  checked={plan() === "team"}
  disabled={!eligible()}
  onChange={() => plan.set("team")}
  class="group flex-row items-center gap-2 disabled:opacity-50"
>
  <View class="size-5 items-center justify-center rounded-full border-2 border-border group-checked:border-primary">
    <View class="size-2.5 rounded-full group-checked:bg-primary" />
  </View>
  <Text>Team</Text>
</Radio>
```

## Accessibility

- A radio is one element for screen readers, with the role `"radio"` and its state: checked or not, and selected while
  checked, since some screen readers read the one and some the other (UI Automation's radios are selection items). Its
  indicator and label are parts of it; its label is the text of its children, or `accessibilityLabel`.
- A `RadioGroup` has the role `"radiogroup"`: screen readers hear the radios inside it as one set, each still an
  element of its own.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).
- On macOS and the web each radio is a stop of the keyboard focus: Tab reaches it, Space and Return check it, and
  `focus:` styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the radio, its label included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  check the radio that has the keyboard focus.
- Every platform draws what the app styles: the indicator, the label and their transitions.
