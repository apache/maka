---
title: NumberInput
description: "The NumberInput component: a number typed in a field or stepped with buttons, the arrow keys and screen readers, kept to its step's decimals and to min and max, with a field, buttons and a controls column the app styles."
group: base
demo: el-number-input
---

# NumberInput

A number input holds a number the user types or steps: a quantity, a price, a size. It owns its behavior: its field
takes a number, or the text on the way to one (`-`, `1.`), and refuses anything else, other keyboards' digits and signs
included; its buttons, Up and Down and a screen reader's increment and decrement step the number by `step`, keeping its
decimals, and stop at `min` and `max`; leaving the field holds a typed number to them. The look is the app's: a
`NumberInput` has no colors, sizes, borders, icons or strings of its own. It is made of the decrement button, the field
between the app's `prefix` and `suffix`, and the increment button (or the field between them and a column with both
buttons, `controlsRight`), and the app styles each part and fills the buttons.

```rust tabs
use nsh_base::{number_input, theme};
use nsh_core::prelude::*;

fn tickets(count: Signal<Option<f64>>) -> impl IntoElement {
    number_input()
        .value(move || count.get())
        .min(1.0)
        .max(10.0)
        .accessibility_label("Tickets")
        .on_change(move |next: &Option<f64>| count.set(*next))
        .h(px(32.0))
        .flex_row()
        .rounded(px(8.0))
        .border_1()
        .border_color(move || theme().input)
        .input_style(|s| s.flex_1().text_center().text_color(move || theme().foreground))
        .decrement_button_style(|s| s.w(px(32.0)).items_center().justify_center())
        .increment_button_style(|s| s.w(px(32.0)).items_center().justify_center())
        .decrement_button(text("−"))
        .increment_button(text("+"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { NumberInput } from "nsh/base";

function App() {
  const tickets = signal<number | null>(2);
  return (
    <NumberInput
      value={tickets()}
      onChange={({ value }) => tickets.set(value)}
      min={1}
      max={10}
      accessibilityLabel="Tickets"
      class="h-8 flex-row overflow-hidden rounded-lg border border-input bg-field focus-within:outline-2 focus-within:outline-ring"
      inputClass="flex-1 text-center text-foreground"
      decrementButtonClass="w-8 items-center justify-center enabled:hover:bg-accent active:bg-muted disabled:opacity-40"
      incrementButtonClass="w-8 items-center justify-center enabled:hover:bg-accent active:bg-muted disabled:opacity-40"
      decrementButton={<Text>−</Text>}
      incrementButton={<Text>+</Text>}
    />
  );
}

mount(App);
```

`NumberInput` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `number_input()`
makes one with a setter per prop (`.value(..)`, `.input_style(..)`), a listener method per event (`.on_change(..)`), the
typed style methods for the input itself, and `.prefix(..)` / `.suffix(..)` for what goes around the field. Its value is
an `Option<f64>`.

## Value

The value is a number, or `null` for an empty field. The app owns it with `value` and sets the one `onChange` reports,
as for every control of `nsh/base`; or it leaves the value to the input with `defaultValue`, and hears the changes all
the same.

The field's text and the value are kept apart where they must be, so the user can type freely:

- `onChange` reports the number the text reads as whenever that number changes: `null` while the text reads as none
  (empty, `-`, `.`); typing `1.` after `1`, or `1.50` after `1.5`, reports nothing.
- The text stays as the user types it while it reads as the value the input holds, so a controlled input that passes
  each reported value back keeps `1.` and `2.50`. A value the app sets that the input did not report shows in the
  field, as the shortest text that reads as it (`0.3`, `12`).
- While typing, a number may be outside `min` and `max` (1 on the way to 15 with `min={10}`), and is reported as typed.
  When the field is left, or on Return / Enter, it is held to the range and that is reported; a text that reads as no
  number stays as it is.
- A step (a button, a key, a screen reader's action) asks for the next value with `onChange`; with a controlled value
  the field moves when the app passes it back, keeping the step's decimals (`99.5` up to `max={100}` shows `100.0`), so
  an app that refuses a step keeps the field where it is. An edit the app refuses stays in the field while it edits, and
  goes when the field is left.

```tsx
const price = signal<number | null>(19.95);

<NumberInput
  value={price()}
  onChange={({ value }) => price.set(value)}
  onSubmit={({ value }) => save(value)}
  min={0}
  step={0.05}
  placeholder="Price"
  accessibilityLabel="Price"
/>;
```

The field takes:

- Digits, one decimal point and a sign first (`+` or `-`); a letter, a second point or sign, or a sign elsewhere is
  refused, and the field goes back to its text.
- Full-width digits, signs and point, the minus sign (U+2212) and the ideographic full stop (`。`), read as their ASCII
  forms, as Chinese and Japanese input methods type them.
- A comma as the decimal point while the text has no point (`3,25` is 3.25), as the decimal key of many languages'
  keyboards types it.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `number \| null` | none | The value (controlled): a number, or `null` for an empty field. The app sets the one `onChange` reports. |
| `defaultValue` | `.default_value(..)` | `number \| null` | none | The value at first while `value` is not set; the input then keeps its own. |
| `min` | `.min(..)` | `number` | none | The smallest value: steps stop at it, a typed value below it is held to it when the field is left. |
| `max` | `.max(..)` | `number` | none | The largest value, as `min` from above; one below `min` is `min`. |
| `step` | `.step(..)` | `number` | `1` | How far a step goes (Page Up / Page Down: ten steps); one that is not a positive number is `1`. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No typing, steps or focus; `disabled:` classes apply to the input and its parts. |
| `readonly` | `.readonly(..)` | `boolean` | `false` | The text can be selected and copied but not changed, by typing or by steps; the buttons are disabled. |
| `placeholder` | `.placeholder(..)` | `string` | none | Shown while the field is empty. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the field, when no visible label names it. |
| `controlsRight` | `.controls_right(..)` | `boolean` | `false` | Both buttons in a column on the right of the field, the increment over the decrement. Read when the input is made. |
| `inputClass`, `inputStyle` | `.input_style(\|s\| ..)` | `string`, `StyleProp<InputStyle>` | none | The field: its box and its text (`color`, `fontSize`, `textAlign`, `placeholderColor`, `caretColor`). |
| `decrementButtonClass`, `decrementButtonStyle` | `.decrement_button_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The decrement button. |
| `incrementButtonClass`, `incrementButtonStyle` | `.increment_button_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The increment button. |
| `decrementButton`, `incrementButton` | `.decrement_button(..)`, `.increment_button(..)` | `JSX.Element` | none | The content of the buttons: a sign, an icon. |
| `controlsClass`, `controlsStyle` | `.controls_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The column that holds both buttons with `controlsRight`. |
| `prefix` | `.prefix(..)` | `JSX.Element` | none | What goes before the field, after the button on its left: a currency sign, an icon. |
| `suffix` | `.suffix(..)` | `JSX.Element` | none | What follows the field, before the buttons on its right: a unit, a currency. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The input itself: the row around the field and the buttons. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &Option<f64>\| ..)` | `{ value: number \| null }` | The number the field reads as changed (typing, a step, a screen reader's increment or decrement, the field left with a value out of range). |
| `onSubmit` | `.on_submit(\|value: &Option<f64>\| ..)` | `{ value: number \| null }` | Return / Enter in the field: the value, held to `min` and `max`. |
| `onFocus` | `.on_focus(..)` | none | The field took the keyboard focus. |
| `onBlur` | `.on_blur(..)` | none | The field lost the keyboard focus (its value held to `min` and `max` first). |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The input | | `class`, `style` |
| The decrement button | the input, first (with `controlsRight`: the controls column, second) | `decrementButtonClass`, `decrementButtonStyle`; its content `decrementButton` |
| The field | the input | `inputClass`, `inputStyle` |
| The prefix | the input, before the field | its own elements (`prefix`) |
| The suffix | the input, after the field | its own elements (`suffix`) |
| The increment button | the input, last (with `controlsRight`: the controls column, first) | `incrementButtonClass`, `incrementButtonStyle`; its content `incrementButton` |
| The controls column | the input, last, with `controlsRight` | `controlsClass`, `controlsStyle` |

The input is a row the app lays out: `flex-row` on `class`, and `flex-1` on the field to give it the room the buttons
leave. States the parts show:

- The input: `focus-within:` while its field edits (a ring around the whole input), `disabled:`.
- The field: `focus:` while it edits, `disabled:`.
- A button: `hover:` under the pointer, `active:` while pressed, `disabled:` while the input is disabled or read-only and
  where a step would do nothing (the decrement at `min`, the increment at `max`). Put the hover behind `enabled:`
  (`enabled:hover:bg-accent`) so a disabled button does not light up.

Motion of the states is the app's choice (`transition-colors`), and `motion-reduce:` keeps it still for people who ask
for less motion.

## Keyboard

While the field edits, the input takes WAI-ARIA's spin button keys, which repeat while held:

| Key | Does |
|---|---|
| Up | One step up. |
| Down | One step down. |
| Page Up, Page Down | Ten steps up or down. |

Home and End stay the field's: they move the caret in the text. The buttons are not stops of the keyboard focus: Tab
goes from the field to what follows the input, and a press on a button leaves the focus in the field (on the desktops
a press moves the focus to the field when it was elsewhere; on touch screens it leaves it, so no keyboard comes up).

## Accessibility

- The field is a spin button (`"spinbutton"`) with its label, its value (the number it reads as, between `min` and
  `max`) and its text.
- A screen reader's increment and decrement actions (VoiceOver's swipe up and down) step it, as Up and Down do.
- The buttons are hidden from screen readers, as a browser's number field's are: the field's own increment and
  decrement step it.
- While `disabled`, screen readers say the field is dimmed.

See [Accessibility](../docs/accessibility.md) for labels, roles and actions in general.

## Platform notes

- The field is the platform's text field ([Input](./input.md)): the keyboard, the caret, selection, copy and paste,
  input methods are the system's. Phones show a decimal keyboard, with a sign when `min` is below 0 or unset.
- Every platform draws what the app styles. Up / Down and Page Up / Page Down reach the input from a hardware keyboard
  on every platform.
