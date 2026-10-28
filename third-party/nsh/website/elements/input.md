---
title: Input
description: "The native text field: controlled and uncontrolled text, keyboards, autofill, selection, multiline inputs and focus."
order: 20.1
group: base
demo: el-input
---

# Input

`Input` is a native text field: a UITextField (single line) or UITextView (multiline) on iOS and Mac Catalyst, an
EditText on Android. Typing, the caret, selection, autocorrection and autofill are the platform's own. Rust makes one
with `nsh_base::input()`, TSX with `<Input>` from `nsh/base`.

```rust tabs
use nsh_base::input;
use nsh_core::prelude::*;

fn name_field() -> impl IntoElement {
    let name = signal(String::new());
    input()
        .value(name)
        .on_change(move |text: &str| name.set(text.to_string()))
        .placeholder("Your name")
        .auto_capitalize(AutoCapitalize::Words)
        .return_key_type(ReturnKeyType::Done)
        .text_base()
        .p_3()
        .border_1()
        .border_color(rgb(0xd0d7de))
        .rounded(px(8.0))
}
```

```tsx tabs
import { signal } from "nsh";
import { Input } from "nsh/base";

function NameField() {
  const name = signal("");
  return (
    <Input
      value={name()}
      onChange={({ value }) => name.set(value)}
      placeholder="Your name"
      autoCapitalize="words"
      returnKeyType="done"
      style={{ fontSize: 16, padding: 12, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8 }}
    />
  );
}
```

## Controlled and uncontrolled

- **Controlled**: pass `value` and update it in `onChange`. The app can rewrite what the user typed (trim it, format
  it): the text shows the edit at once and is corrected when the new `value` arrives. Each native edit carries a count,
  and a `value` from the app is applied when it is based on the latest edit, so newer typing always wins over a slow
  update.
- **Uncontrolled**: pass `defaultValue` (`.default_value(..)`, or nothing) and read the text from `onChange` or
  `onSubmit`.

Rules that must hold while the user types are props, answered natively: `maxLength` limits the length and
`submitBehavior` decides what return does. See [forms and the keyboard](../docs/forms-and-keyboard.md).

## Props

Besides the [common props](./index.md#common-props) (with `style` typed as `TextStyle`: font, color, alignment and the
view styles apply):

### Text

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | | The text, controlled by the app. |
| `defaultValue` | `.default_value(..)` | `string` | | The initial text. |
| `placeholder` | `.placeholder(..)` | `string` | | Shown while the input is empty. |
| `multiline` | `.multiline(..)` | `boolean` | `false` | Several lines; return inserts a line break unless `submitBehavior` says otherwise. |
| `tokens` | `.tokens(..)` | `InputTokenRule[]` | `[]` | Native styled and optionally atomic source ranges (GPUI and terminal backends). |
| `scrollbar` | `.scrollbar(..)` | `boolean \| ScrollbarTheme` | `true` | A multiline input's scroll bar: the platform's indicator, or the app's built-in bar once it set one ([Scrollbar](./scrollbar.md#built-in-bars)); an object is a theme of its own, `false` none. |
| `maxLength` | `.max_length(..)` | `number` | | The most characters the user can enter. |
| `readonly` | `.readonly(..)` | `boolean` | `false` | The user can select and copy the text but not change it. |
| `masked` | `.masked(..)` | `boolean` | `false` | The text is hidden (passwords). |
| `allowFontScaling` | | `boolean` | `true` | Follow the system text size. |
| `maxFontSizeMultiplier` | | `number` | `0` | The upper bound of the system scale (0 is none). |

### Styled and atomic tokens

The GPUI and terminal editors match `tokens` against their current committed
plain text. A rule uses Rust regular-expression syntax and must have a named
`token` capture; context outside that capture is neither styled nor selected
with the token. The earliest source match wins when rules overlap; declaration
order breaks ties. Empty captures and captures that split a grapheme are ignored.
No replacement label or hidden
text is introduced: copying, `value`, and `onChange` retain the original text.

```tsx
<Input
  multiline
  tokens={[{
    pattern: String.raw`(?:^|\s)(?P<token>#[A-Za-z0-9_-]+)`,
    atomic: true,
    style: { color: "#8ab8f8", backgroundColor: "#8ab8f820", borderRadius: 4 },
  }]}
/>
```

`atomic` defaults to `false`. Confirmed atomic tokens have caret stops only at
their edges; partial selections and replacements expand to the whole token.
Backspace, Delete and Cut use the same native boundaries. A token currently
being typed remains editable until a delimiter, an explicit replacement or
paste, or moving the caret outside it confirms the token. Removing a trailing
delimiter does not reopen a confirmed token. Undo restores text, selection and
the unfinished token together; replaying the same controlled `value` preserves
that native state.

Token styles affect painting only. The Unicode renderer uses foreground and
background colors; GPUI also draws the background radius. Masked inputs do not
show token styles. IME preedit text remains the input method's editable text
and is never matched or styled as a committed token.

### Keyboard

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `keyboardType` | `.keyboard_type(KeyboardType::Email)` | `"default" \| "number-pad" \| "decimal-pad" \| "numeric" \| "numbers-and-punctuation" \| "email-address" \| "phone-pad" \| "url"` | `"default"` | The keyboard layout ([the values](../docs/forms-and-keyboard.md#keyboards-and-autofill); `numbers-and-punctuation` has a minus sign on iOS). |
| `returnKeyType` | `.return_key_type(ReturnKeyType::Next)` | `"default" \| "done" \| "go" \| "next" \| "search" \| "send"` | `"default"` | The label of the return key. |
| `autoCapitalize` | `.auto_capitalize(AutoCapitalize::None)` | `"none" \| "sentences" \| "words" \| "characters"` | `"sentences"` | Automatic capitalization. |
| `autoCorrect` | `.auto_correct(..)` | `boolean` | `true` | The system's corrections. |
| `autoComplete` | `.auto_fill(AutoFill::OneTimeCode)` | `AutoComplete \| TextContentType` | | What the input holds, for autofill: `"username"`, `"current-password"`, `"new-password"`, `"one-time-code"`, `"email"`, `"tel"`, `"postal-code"`, `"cc-number"`, `"off"`, … |
| `pasteBehavior` | `.paste_behavior(PasteBehavior::Report)` | `"insert" \| "report"` | `"insert"` | What a paste does: `"insert"` inserts the pasted text, `"report"` inserts nothing, for the app to handle what `onPaste` reports. Images and files are never inserted. |
| `submitBehavior` | `.submit_behavior(SubmitBehavior::Submit)` | `"submit" \| "blurAndSubmit" \| "newline"` | `"blurAndSubmit"` (single line), `"newline"` (multiline) | What return does: `"submit"` reports `onSubmit` and keeps the focus, `"blurAndSubmit"` also unfocuses, `"newline"` inserts a line break (multiline; a single line submits). A multiline input that submits still takes line breaks from Shift+Return or Option / Alt+Return on hardware keyboards. `"submit"` keeps the keyboard up (e.g. to send several messages). |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | Focused when it appears. |

### Caret and selection

| Prop | Rust | Type | Description |
|---|---|---|---|
| `caret` | `.caret(..)` | `boolean` | The caret is drawn (default `true`; `false` hides it). |
| `selectedRange` | `.selected_range((start, end))` | `{ start: number; end?: number }` | The controlled selection, in UTF-16 units; `end` defaults to `start` (a caret). |

### Colors

The colors of the placeholder, the caret and the selection highlight are style keys, with their Tailwind classes, and
methods in Rust (UIKit tints the caret and the selection with one color, the caret's when set):

| Style key | Rust | Class | Description |
|---|---|---|---|
| `placeholderColor` | `.placeholder_color(..)` | `placeholder:text-*` | The placeholder's color. |
| `caretColor` | `.caret_color(..)` | `caret-*` | The caret's color. |
| `selectionColor` | `.selection_color(..)` | `selection:text-*` | The selection highlight's color. |

```rust tabs
input()
    .placeholder("Search")
    .text_color(rgb(0x18181b))
    .placeholder_color(rgb(0x9ca3af))
    .caret_color(rgb(0x2563eb))
    .selection_color(rgb(0x93c5fd))
```

```tsx tabs
<Input placeholder="Search" class="text-zinc-900 placeholder:text-zinc-400 selection:text-blue-600" />
<Input placeholder="Search" style={{ placeholderColor: "#9ca3af", caretColor: "#2563eb", selectionColor: "#93c5fd" }} />
```

### iOS

| `ios` key | Rust | Type | Description |
|---|---|---|---|
| `textContentType` | `.auto_fill(..)` | `AutoComplete \| TextContentType` | iOS's names for `autoComplete` (`"oneTimeCode"`, `"newPassword"`, …). |
| `inputAccessoryViewID` | `.input_accessory(id)` | `string` | The `nativeID` of an `InputAccessoryView` ([`InputAccessoryView`](../modules/nsh-mobile.md#inputaccessoryview)) shown over the keyboard while the input has focus. |
| `keyboardAppearance` | `.keyboard_appearance(KeyboardAppearance::Dark)` | `"default" \| "light" \| "dark"` | The keyboard's look; `"default"` follows the system's appearance. Android's keyboards follow the system's theme. |

```rust tabs
use nsh_core::element::AutoFill;

input().auto_fill(AutoFill::OneTimeCode).keyboard_type(KeyboardType::Number)
```

```tsx tabs
<Input autoComplete="one-time-code" keyboardType="number-pad" ios={{ textContentType: "oneTimeCode" }} />
```

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onChange` | `.on_change(\|text: &str\| ..)` | `{ value }` | The user changed the text: `value` is the text now. |
| `onSubmit` | `.on_submit(\|text: &str\| ..)` | `{ text }` | The return key was pressed in an input that submits (single line, or `submitBehavior` `"submit"` / `"blurAndSubmit"`). |
| `onFocus` / `onBlur` | `.on_focus` / `.on_blur` | none | The input gained / lost focus. |
| `onSelectionChange` | `.on_selection_change(\|s: &Selection\| ..)` | `{ start, end }` | The caret or selection moved (UTF-16 units). |
| `onPaste` | `.on_paste(\|e: &PasteEvent\| ..)` | `{ text, html, files, uris }` | The user pasted: the text, its formatting as HTML (Linux, web), images (a screenshot) as `File`s, local files' `file:` URLs. Before the `onChange` of the text it inserts ([forms and keyboard](../docs/forms-and-keyboard.md#pasting-images-and-files)). |
| `onCaretMove` | `.on_caret_move(\|e: &CaretEvent\| ..)` | `{ bounds, pageBounds }` | The caret moved, with the selection or as the text scrolled or wrapped: `bounds` is where it is in the input, `pageBounds` in the window, an `Overlay`'s `anchor` ([forms and keyboard](../docs/forms-and-keyboard.md#the-caret)). |
| `onKeyPress` | `.on_key_press(\|key: &str\| ..)` | `{ key }` | Before the text changes: `key` is the typed text, `"Backspace"` or `"Enter"`. |
| `onContentSizeChange` | `.on_content_size_change(\|size: &Size<Points>\| ..)` | `{ size }` | The size of the text changed (at the input's width when multiline), as it is typed; an empty input reports one empty line, whatever its placeholder. |
| `onCompositionChange` | `.on_composition_change(\|e: &Composition\| ..)` | `{ composing, text }` | An input method's composition started, changed or ended: `text` is what is being composed (pinyin before a character is chosen, kana before conversion), `""` once it ends. The committed text reaches `onChange` before the end. |

A multiline input that grows with its text:

```rust tabs
let height = signal(px(40.0));

input()
    .multiline(true)
    .on_content_size_change(move |size: &Size<Points>| {
        height.set(px((size.height.0 + 16.0).clamp(40.0, 120.0)));
    })
    .h(move || height.get())
    .px_3()
    .py_2()
```

```tsx tabs
const height = signal(40);
<Input
  multiline
  onContentSizeChange={({ size }) => height.set(Math.min(120, Math.max(40, size.height + 16)))}
  style={{ height: height(), paddingHorizontal: 12, paddingVertical: 8 }}
/>;
```

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `focus()` | `focus()` | Focuses the input and shows the keyboard. |
| `blur()` | `blur()` | Unfocuses it. |
| `setSelection(start, end?)` | `set_selection(start, end)` | Selects `start..end` (UTF-16 units); a caret when they are equal. |
| `replaceRange({ start, end, text, expectedText, expectedSelection })` | `replace_range(range, text, expected_text, expected_selection)` | GPUI and terminal: replaces a UTF-16 range as one native undo step. Applies only to the focused editable input while its text and selection still match, no IME composition is active, and no newer native edit occurred. The caret moves after the literal replacement; multiline inputs preserve line breaks. |

Moving focus to the next field on return:

```rust tabs
use nsh_core::element::AutoFill;

let password = element_ref();

view()
    .child(input().return_key_type(ReturnKeyType::Next).on_submit(move |_: &str| password.focus()))
    .child(input().element_ref(&password).masked(true).auto_fill(AutoFill::Password))
```

```tsx tabs
let password!: InputRef;
<>
  <Input returnKeyType="next" onSubmit={() => password.focus()} />
  <Input ref={password} masked autoComplete="current-password" />
</>;
```

`Keyboard.dismiss()` from `nsh` (`dismiss_keyboard()` in Rust) hides the keyboard whichever input has it.

## Platform notes

- On macOS, single-line text, placeholders and carets share the native field's font metrics and are centered together
  inside the content box. `lineHeight` participates in layout; multiline editors also use it for paragraph spacing.
- Inputs inside a [scroll view](./scroll.md#keyboard) are kept clear of the keyboard natively. Elsewhere use
  a bottom padding or margin of [`env(keyboard-inset-height)`](./keyboard.md).
- `disabled` disables the input (no focus) as well as applying the disabled styles; a `readonly` input keeps its
  focus and selection.
- `inputAccessoryViewID` applies on iOS, where the keyboard has an accessory bar.
