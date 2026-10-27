---
title: Checkbox
description: "The Checkbox component: a checked, unchecked or indeterminate control that owns presses, keyboard activation, the disabled state and its role and value for screen readers, with an indicator the app styles and marks."
order: 20.25
group: base
demo: el-checkbox
---

# Checkbox

A checkbox selects an option, an item of a list, or all of them. It is checked, unchecked or indeterminate (neither:
a "select all" over a partial selection). It owns the behavior: presses, keyboard activation, the disabled state, and
the checkbox role and its value for screen readers. The look is the app's: a `Checkbox` has no box, mark, colors,
sizes or label of its own. It is made of an indicator (the box) with the app's mark inside it, then its children (a
label), and the app styles each part, with `checked:`, `indeterminate:` and `disabled:` classes that follow the
checkbox.

```rust tabs
use nsh_base::{checkbox, theme};
use nsh_core::prelude::*;

fn notify() -> impl IntoElement {
    let on = signal(false);
    checkbox()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_2()
        .indicator_style(|s| {
            s.size(px(20.0))
                .items_center()
                .justify_center()
                .rounded_md()
                .border_2()
                .border_color(move || theme().border)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
        })
        .indicator(text(move || if on.get() { "✓" } else { "" }).text_color(move || theme().primary_foreground))
        .child(text("Notify me"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Checkbox } from "nsh/base";

function App() {
  const on = signal(false);
  return (
    <Checkbox
      checked={on()}
      onChange={(next) => on.set(next)}
      class="flex-row items-center gap-2"
      indicatorClass="size-5 items-center justify-center rounded-md border-2 border-border transition-colors checked:border-primary checked:bg-primary"
      indicator={<Text class="text-primary-foreground">{on() ? "✓" : ""}</Text>}
    >
      <Text>Notify me</Text>
    </Checkbox>
  );
}

mount(App);
```

`Checkbox` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the app's: a
press reports the next value with `onChange`, and the checkbox shows the `checked` and `indeterminate` the app passes
back. In Rust, `checkbox()` makes one with a setter per prop (`.checked(..)`, `.indicator_style(..)`), a listener per
event (`.on_change(..)`), the typed style methods for the checkbox itself and `.child(..)` for its label; the
indicator's style takes the state methods (`.checked(..)`, `.indeterminate(..)`, `.disabled_style(..)`) that follow
the checkbox.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | Checked or not. A press reports the next value with `onChange`; the checkbox shows the value the app passes back. |
| `indeterminate` | `.indeterminate(..)` | `boolean` | `false` | Neither checked nor unchecked, over `checked` while it holds: screen readers say it is mixed, and a press asks for checked. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses and no press feedback; `disabled:` styles apply to the checkbox and its indicator, and screen readers say it is dimmed. |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The checkbox's style while checked and not disabled, as `checked:` classes. |
| `indeterminateStyle` | `.indeterminate_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The checkbox's style while indeterminate and not disabled, as `indeterminate:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: what the checkbox selects, when its children have no text that says it. |
| `role` | `.role(..)` | `AccessibilityRole` | `"checkbox"` | What it is for screen readers, when it is something more specific (a checked menu item: `"menuitem"`). |
| `indicatorClass`, `indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The indicator, the box that shows the value. |
| `indicator` | `.indicator(..)` | `JSX.Element` | none | The content of the indicator: the mark (a check, a dash), which the app shows by its value. |
| `children` | `.child(..)` | `JSX.Element` | none | The content after the indicator: a label, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The checkbox itself: the row around the indicator and the label. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The checkbox's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | The checkbox was pressed: a tap, a click, Space or Return while it has the keyboard focus, or a screen reader's activation. It reports the value the checkbox asks for: `true` from unchecked and from indeterminate, `false` from checked. |

A disabled checkbox reports nothing.

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The checkbox | | `class`, `style` | `checked:`, `indeterminate:`, `disabled:`, `active:`, `hover:`, `focus:` (or `checkedStyle`, `indeterminateStyle`, `disabledStyle`, ...) |
| The indicator | the checkbox, first | `indicatorClass`, `indicatorStyle` | `checked:`, `indeterminate:`, `disabled:` follow the checkbox |
| The mark | the indicator | its own elements (`indicator`) | `group-checked:`, `group-indeterminate:` and the other `group-*:` variants with `group` on `indicatorClass` |
| The label | the checkbox, after the indicator | its own elements (`children`) | `group-*:` variants with `group` on the checkbox's `class` |

The mark is the app's content, so it shows what the app decides: a check while checked and a dash while
indeterminate, chosen from the value the app holds, or both marks with `group-checked:` / `group-indeterminate:`
classes picking the one shown.

## Indeterminate

A "select all" checkbox is indeterminate while some items are selected. A press asks for checked, and the app selects
every item:

```tsx
const selected = signal<string[]>([]);
const all = () => selected().length === items.length;
const some = () => selected().length > 0 && !all();

<Checkbox
  checked={all()}
  indeterminate={some()}
  onChange={(next) => selected.set(next ? items.map((i) => i.id) : [])}
  class="flex-row items-center gap-2"
  indicatorClass="group size-5 items-center justify-center rounded-md border-2 border-border checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary"
  indicator={
    <>
      <Text class="hidden text-primary-foreground group-checked:flex">✓</Text>
      <View class="hidden h-0.5 w-2.5 bg-primary-foreground group-indeterminate:flex" />
    </>
  }
>
  <Text>Select all</Text>
</Checkbox>
```

## Disabled

A disabled checkbox takes no presses, and screen readers announce it as dimmed. Its `disabled:` classes and those of
its indicator apply, over their `checked:` and `indeterminate:` ones:

```tsx
<Checkbox
  checked={on()}
  disabled={locked()}
  onChange={(next) => on.set(next)}
  class="flex-row items-center gap-2 disabled:opacity-50"
  indicatorClass="size-5 rounded-md border-2 border-border checked:border-primary checked:bg-primary disabled:border-border disabled:bg-muted"
>
  <Text>Share usage data</Text>
</Checkbox>
```

## Accessibility

- A checkbox is one element for screen readers, with the role `"checkbox"` (or its `role`) and its value: checked,
  unchecked, or mixed while indeterminate. The indicator and the mark are parts of it. Its label is the text of its
  children; give `accessibilityLabel` when it has none.
- `disabled` is announced as the platform announces it (VoiceOver, TalkBack, UI Automation, the browser's accessibility
  tree).
- On macOS and the web a checkbox is a stop of the keyboard focus: Tab reaches it, Space and Return toggle it, and
  `focus:` styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the checkbox, its label included.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Space and Return also
  toggle the checkbox that has the keyboard focus.
- Every platform draws what the app styles: the indicator, the mark and their transitions.
