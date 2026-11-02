---
title: OtpInput
description: "The OtpInput component: a fixed-length numeric one-time code typed, pasted or autofilled into one native field, shown in cells, groups and a caret the app styles."
group: base
demo: el-otp-input
---

# OtpInput

A one-time-code input takes a fixed number of digits (a verification code from a text message, an authenticator's
code) and shows them in cells. It owns the behavior: one native text field, transparent and over the cells, takes the
keyboard, so typing, input methods, paste, the number pad and the system's code autofill (iOS's "From Messages",
Android's SMS suggestions) are the platform's own, and screen readers find one text field. Digits only go in, up to
`length`; Backspace removes the last one, and `onComplete` tells when the code is full. The look is the app's: an
`OtpInput` has no colors, sizes, borders or label of its own. Its parts are the cells, the groups they are split into
and a caret, and the app styles each.

```rust tabs
use nsh_base::{OtpInputCompleteEvent, otp_input, theme};
use nsh_core::prelude::*;

fn verification(verify: impl Fn(&str) + 'static) -> impl IntoElement {
    let code = signal(SharedString::default());
    otp_input()
        .length(6)
        .groups(2)
        .value(move || Some(code.get()))
        .on_change(move |next: &SharedString| code.set(next.clone()))
        .on_complete(move |e: &OtpInputCompleteEvent| verify(&e.value))
        .accessibility_label("Verification code, 6 digits")
        .flex_row()
        .gap_3()
        .group_style(|s| s.flex_row().gap_2())
        .cell_style(|s| {
            s.w(px(40.0))
                .h(px(48.0))
                .items_center()
                .justify_center()
                .rounded(px(8.0))
                .border_1()
                .border_color(move || theme().input)
                .text_xl()
        })
        // The cell that takes the next digit, while the code has the focus.
        .cell_class("focus:border-ring")
        .caret_style(|s| s.w(px(2.0)).h(px(24.0)).bg(move || theme().foreground))
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { OtpInput } from "nsh/base";

function App() {
  const code = signal("");
  const verify = (value: string) => console.log(`checking ${value}`);
  return (
    <OtpInput
      length={6}
      groups={2}
      value={code()}
      onChange={({ value }) => code.set(value)}
      onComplete={({ value }) => verify(value)}
      accessibilityLabel="Verification code, 6 digits"
      class="flex-row gap-3"
      groupClass="flex-row gap-2"
      cellClass="w-10 h-12 items-center justify-center rounded-lg border border-input text-xl focus:border-ring"
      caretClass="w-0.5 h-6 bg-foreground"
    />
  );
}

mount(App);
```

`OtpInput` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `otp_input()`
makes one with a setter per prop (`.length(..)`, `.cell_style(..)`), a listener method per event (`.on_complete(..)`)
and the typed style methods for the input itself.

## The code

- **Controlled**: pass `value` and set it in `onChange`. The cells show the `value` the app passes, as it is; a value
  the app sets (clearing the code after a wrong one) is never reported.
- **Uncontrolled**: pass `defaultValue` (or nothing), and read the code from `onChange` and `onComplete`.

What the user does is read from the field, with the caret always at its end:

| The user | The code |
|---|---|
| Types a digit | It is added at the end while the code is shorter than `length`; once full, nothing changes. |
| Types a full-width digit (`０`–`９`, an East Asian input method's) | The ASCII digit is added. |
| Types anything else | Nothing changes; the field drops it. |
| Presses Backspace | The last digit is removed. |
| Pastes, or the system autofills a code | Its digits are added the same way; text with `length` digits or more (`123-456`, a message's code) replaces the code with its first `length` digits. |

`onChange` reports each change with the new code, and `onComplete` follows it when the change filled the last cell,
so the app verifies the code there.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `length` | `.length(..)` | `number` | required | How many digits the code has: one cell each. |
| `value` | `.value(..)` | `string` | none | The code, controlled by the app (shown as it is). Without it the input keeps its own. |
| `defaultValue` | `.default_value(..)` | `string` | none | The code at first, while `value` is not set. |
| `masked` | `.masked(..)` | `boolean` | `false` | Filled cells show a bullet instead of their digit, and the field is a secure one: screen readers do not read the code, and the system keeps it out of its suggestions. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No focus and no editing; `disabled:` styles apply to the input and its parts, and screen readers say it is dimmed. |
| `groups` | `.groups(..)` | `number` | `1` | How many groups the cells are split into, as evenly as they go (3 + 3 for six digits in two); at least one, at most one per cell. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the field: what the code is for and how many digits it has. |
| `cellClass`, `cellStyle` | `.cell_class(..)`, `.cell_style(\|s\| ..)` | `string`, `StyleProp<TextStyle>` | none | Each cell: its size, border and text (`color`, `fontSize`, which its digit inherits). |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each group of cells (`flex-row gap-2`). |
| `caretClass`, `caretStyle` | `.caret_class(..)`, `.caret_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The caret: its width, height and color. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The input itself: the row (or column) around its groups. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &SharedString\| ..)` | `(e: { value: string })` | The user changed the code: typed, deleted, pasted or autofilled. |
| `onComplete` | `.on_complete(\|e: &OtpInputCompleteEvent\| ..)` | `{ value }` | The user's change filled the last cell, after its `onChange`. |
| `onFocus` / `onBlur` | `.on_focus` / `.on_blur` | none | The input took / lost the keyboard focus. |

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `focus()` | `focus()` (`OtpInputApi`) | Takes the keyboard focus and shows the software keyboard, as a press on the input does. |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The input | | `class`, `style` |
| A group | the input, one per group | `groupClass`, `groupStyle`; `disabled:` follows the input |
| A cell | its group, one per digit | `cellClass`, `cellStyle`; `focus:` on the cell that takes the next digit while the input has the focus, `disabled:` follows the input |
| The digit | a filled cell | the cell's text styles (`text-xl`, `font-semibold`); `•` while `masked` |
| The caret | the empty cell that takes the next digit, while the input has the focus | `caretClass`, `caretStyle` |

The cell that takes the next digit is the one after the last digit, or the last cell once the code is full. The
caret blinks as a text field's does (half a second on, half off, and steady for a moment after each edit), by its
opacity, natively, while it keeps its place in the layout; with reduced motion it stays still. A press anywhere on the input focuses it: the field lies over the cells.

## Accessibility

- Screen readers find one text field, named by `accessibilityLabel` (say what the code is for and its length:
  "Verification code, 6 digits") with the code as its value; the cells are hidden from them. While `masked` the
  field is a secure one, so the code is not read aloud.
- The keyboard is the platform's: the number pad on phones, any keyboard on desktops (digits only go in), and
  Backspace. Tab reaches the input as any text field.
- While `disabled` it takes no focus, and screen readers say it is dimmed.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS: the field is a code field (`textContentType` `oneTimeCode`), so the QuickType bar offers a code from Messages
  or Mail; the number pad comes up. A `masked` field starts over when typed in again after it lost the focus, as
  iOS's secure fields do.
- Android: `autofillHints` `smsOTPCode` lets the keyboard and the autofill service offer the code of a text message;
  the number keyboard comes up.
- macOS, Windows, Linux and the web: typing and paste go to the field (in the browser, with `inputmode="numeric"`
  for a phone's number keyboard), and the I-beam pointer shows over the cells.
