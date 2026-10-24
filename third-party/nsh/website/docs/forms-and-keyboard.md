---
title: Forms and the keyboard
description: Text input with the input element - controlled and uncontrolled values, keyboard types, the return key, focus, selection, growing multiline inputs - and keeping content clear of the software keyboard.
order: 42
group: ui
demo: guide-forms
---

# Forms and the keyboard

Text entry is the input element, `input()` in Rust and `<Input>` in TSX: a UITextField or UITextView on iOS, an EditText on Android. Typing, the caret, selection, autocorrection and autofill are the platform's own; your app gets the text through events and can control it. NSH also keeps focused inputs above the software keyboard on its own, and gives you the keyboard's height as a reactive value for the cases it cannot handle by itself.

An input takes styles like any view (typed style methods in Rust, styles and Tailwind classes in TSX), so the fields of a form have your app's own look. A labeled field is a short component of your own:

```rust tabs
use nsh_core::ui::prelude::*;

fn field(label: &'static str, value: Signal<String>, masked: bool) -> impl IntoElement {
    let focused = signal(false);
    view()
        .gap_1()
        .child(text(label).text_sm().text_color(rgb(0x737373)))
        .child(
            input()
                .value(move || value.get())
                .on_change(move |text: &str| value.set(text.to_owned()))
                .masked(masked)
                .on_focus(move || focused.set(true))
                .on_blur(move || focused.set(false))
                .rounded_lg()
                .border_1()
                .px_3()
                .py_2()
                .text_base()
                .border_color(move || if focused.get() { rgb(0x0969da) } else { rgb(0xd0d7de) }),
        )
}
```

```tsx tabs
import { Input, signal, Text, View } from "nsh";

function Field(props: { label: string; value: string; onChange: (text: string) => void; masked?: boolean }) {
  const focused = signal(false);
  return (
    <View class="gap-1">
      <Text class="text-sm text-neutral-500">{props.label}</Text>
      <Input
        value={props.value}
        onChange={props.onChange}
        masked={props.masked}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class="rounded-lg border px-3 py-2 text-base"
        style={{ borderColor: focused() ? "#0969da" : "#d0d7de" }}
      />
    </View>
  );
}
```

## Controlled and uncontrolled inputs

An input is **controlled** when you pass its value (`.value(..)`, TSX `value`): it shows what your signal holds, and you update the signal from the change event (`.on_change(..)`, TSX `onChange`).

```rust tabs
use nsh_core::ui::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let name = signal(String::new());
    view()
        .flex_1()
        .p(px(16.0))
        .pt(px(60.0))
        .gap(px(8.0))
        .child(
            input()
                .value(move || name.get())
                .on_change(move |text: &str| name.set(text.to_owned()))
                .placeholder("Your name")
                .text_size(px(17.0))
                .border_1()
                .border_color(rgb(0xd0d7de))
                .rounded(px(10.0))
                .p(px(12.0)),
        )
        .child(text(move || {
            let name = name.get();
            format!("Hello, {}", if name.is_empty() { "stranger" } else { &name })
        }))
}
```

```tsx tabs
import { Input, mount, signal, Text, View } from "nsh";

function App() {
  const name = signal("");
  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 60, gap: 8 }}>
      <Input
        value={name()}
        onChange={(text) => name.set(text)}
        placeholder="Your name"
        style={{ fontSize: 17, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 10, padding: 12 }}
      />
      <Text>Hello, {name() || "stranger"}</Text>
    </View>
  );
}

mount(App);
```

Because you control the value, you can transform what the user types: `.on_change(move |t: &str| tag.set(t.to_uppercase()))` uppercases, `onChange={(t) => code.set(t.replace(/[^0-9]/g, ""))}` keeps digits only.

### Input methods

Chinese, Japanese and Korean input methods compose text before committing it: pinyin turns into 腾 once a character is chosen. `onCompositionChange` (Rust `.on_composition_change(..)`) reports the composition as it goes, `{ composing: true, text: "teng" }` while the user types and `{ composing: false, text: "" }` when it ends; the committed text reaches `onChange` before the end. On iOS, Android, macOS and the web, `onChange` also reports the text being composed, as those systems keep it in the input; on Windows, Linux and GPUI it reports the committed text. A controlled input keeps the composition going whatever the app does with the value: a `value` set while the user composes is shown once the composition ends, so an input that uppercases or filters its text takes pinyin as typed.

A search box that searches the committed text only:

```rust tabs
let query = signal(String::new());
let composing = signal(false);
input()
    .value(move || query.get())
    .on_change(move |text: &str| {
        query.set(text.to_owned());
        if !composing.get() {
            search(text);
        }
    })
    .on_composition_change(move |e: &Composition| {
        composing.set(e.composing);
        if !e.composing {
            search(&query.get());
        }
    })
```

```tsx tabs
const query = signal("");
let composing = false;
<Input
  value={query()}
  onChange={(text) => {
    query.set(text);
    if (!composing) search(text);
  }}
  onCompositionChange={(e) => {
    composing = e.composing;
    if (!e.composing) search(query());
  }}
/>
```

An input is **uncontrolled** without a value: it keeps its own text, starting at its default value (`.default_value(..)`, TSX `defaultValue`), and you read it from the change or submit event when you need it. Use this for fields you only read on submit, such as a password.

> [!NOTE]
> A controlled input never loses keystrokes. Every native edit carries an edit count, and a `value` coming back from JS is applied only if it answers the latest edit. If JS is slow and the user has typed more in the meantime, the stale value is dropped instead of overwriting the newer text.

## Props

In Rust, each prop is a method of `input()` named in snake case (`.placeholder(..)`, `.masked(true)`, `.max_length(6)`, `.return_key_type(ReturnKeyType::Next)`, `.selected_range((0, 4))`), with these names of their own: `.keyboard_type(KeyboardType::Email)` and the other `KeyboardType` variants, `.auto_fill(AutoFill::Email)` for `autoComplete`, `.keyboard_appearance(..)` and `.input_accessory(..)` for the `ios={{ … }}` props. Each event is an `on_` method: `.on_change(|text: &str| ..)`, `.on_submit(|text: &str| ..)`, `.on_focus(..)`, `.on_blur(..)`, `.on_selection_change(|s: &Selection| ..)`, `.on_key_press(|key: &str| ..)`, `.on_content_size_change(|size: &Size<Points>| ..)`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | | The text, controlled by JS. |
| `defaultValue` | `string` | | The initial text of an uncontrolled input. |
| `placeholder` | `string` | | Shown while the input is empty. |
| `masked` | `boolean` | `false` | Hides the text (passwords). |
| `keyboardType` | `KeyboardType` | `"default"` | The keyboard layout. |
| `returnKeyType` | `ReturnKeyType` | `"default"` | The return key's label. |
| `autoCapitalize` | `"none" \| "sentences" \| "words" \| "characters"` | `"sentences"` | Automatic capitalization. |
| `autoCorrect` | `boolean` | `true` | The system's corrections. |
| `autoComplete` | `AutoComplete` | | What the input holds, for autofill. |
| `multiline` | `boolean` | `false` | Several lines; return inserts a line break unless `submitBehavior` says otherwise. |
| `maxLength` | `number` | | The most characters the user can enter. |
| `readonly` | `boolean` | `false` | The user can select and copy the text but not change it. |
| `autoFocus` | `boolean` | `false` | Focused when it appears. |
| `submitBehavior` | `"submit" \| "blurAndSubmit" \| "newline"` | single line `"blurAndSubmit"`, multiline `"newline"` | What return does: submit and keep the focus, submit and unfocus, or insert a line break (multiline only). |
| `pasteBehavior` | `"insert" \| "report"` | `"insert"` | What a paste does: insert its text, or nothing ([pasting](#pasting-images-and-files)). |
| `caret` | `boolean` | `true` | The caret is drawn; `false` hides it. |
| `ios={{ keyboardAppearance }}` | `"default" \| "light" \| "dark"` | `"default"` | The keyboard's look (iOS). |
| `selectedRange` | `{ start: number; end?: number }` | | The controlled selection, in UTF-16 units. |
| `allowFontScaling` | `boolean` | `true` | Follow the system text size. |
| `maxFontSizeMultiplier` | `number` | | The upper bound of the system scale (0: none). |
| `ios={{ inputAccessoryViewID }}` | `string` | | iOS: the bar shown over the keyboard (see below). |
| `ios={{ textContentType }}` | `TextContentType` | | iOS's names for `autoComplete` values. |

Events:

| Event | Payload | When |
|---|---|---|
| `onChange` | `text: string` | The text changed. |
| `onSubmit` | `{ text }` | The return key was pressed in an input that submits (single line, or `submitBehavior` `"submit"` / `"blurAndSubmit"`). |
| `onFocus` / `onBlur` | | The input gained / lost focus. |
| `onSelectionChange` | `{ start, end }` | The caret or selection moved (UTF-16 units). |
| `onPaste` | `{ text, files, uris }` | The user pasted: text, images as `File`s, local files' URLs ([pasting](#pasting-images-and-files)). |
| `onCaretMove` | `{ bounds, pageBounds }` | The caret moved: where it is in the input and in the window ([the caret](#the-caret)). |
| `onKeyPress` | `{ key }` | Before the text changes: `key` is the typed text, `"Backspace"` or `"Enter"`. |
| `onContentSizeChange` | `{ width, height }` | The text's size changed (at the input's width when multiline), as it is typed; an empty input reports one empty line, whatever its placeholder. |
| `onCompositionChange` | `{ composing, text }` | An input method's composition started, changed or ended (see [Input methods](#input-methods)). |

An input is styled like text: `fontSize`, `color`, `fontFamily`, `textAlign`, `letterSpacing` and the rest of [text styles](./text.md), plus borders, padding and backgrounds. The focus style (`.focus(|s| ..)` in Rust, the `focus:` Tailwind variant or `focusStyle` in TSX) applies while the input has focus. The placeholder's color is `.placeholder_color(..)` (the
`placeholderColor` style key, `placeholder:text-*`), and the caret and selection's color is `.selection_color(..)` (`selectionColor`,
`selection:text-*`):

```rust tabs
input()
    .placeholder("Search")
    .rounded_lg()
    .border_1()
    .border_color(rgb(0xd4d4d8))
    .px_3()
    .py_2()
    .text_base()
    .focus(|s| s.border_color(rgb(0x3b82f6)))
    .placeholder_color(rgb(0xa1a1aa))
    .selection_color(rgb(0x2563eb))
```

```tsx tabs
<Input
  class="rounded-lg border border-zinc-300 px-3 py-2 text-base focus:border-blue-500 placeholder:text-zinc-400 selection:text-blue-600"
  placeholder="Search"
/>
```

## Keyboards and autofill

The keyboard type (`.keyboard_type(..)`, TSX `keyboardType`) picks the layout:

| Rust | TSX | Keyboard |
|---|---|---|
| `KeyboardType::Default` | `"default"` | Text. |
| `KeyboardType::Email` | `"email-address"` | Text with `@` and `.` at hand. |
| `KeyboardType::Url` | `"url"` | Text with `/` and `.com`. |
| `KeyboardType::Number` | `"number-pad"` | Digits only: no sign, no decimal separator (codes, PINs). |
| `KeyboardType::Decimal` | `"decimal-pad"` | Digits and a decimal separator. |
| `KeyboardType::Numeric` | `"numeric"` | As React Native: iOS's decimal pad; on Android digits with a sign and a decimal separator. |
| `KeyboardType::NumbersAndPunctuation` | `"numbers-and-punctuation"` | Digits, a minus sign and punctuation (iOS's numbers and punctuation keyboard; on Android digits with a sign and a decimal separator). Use it for negative numbers on iOS. |
| `KeyboardType::Phone` | `"phone-pad"` | A phone dial pad. |

On iOS, `.keyboard_appearance(KeyboardAppearance::Dark)` (TSX `ios={{ keyboardAppearance: "dark" }}`; or light, default) gives the keyboard a light or dark look regardless of the system's appearance, for a dark app in light mode. Android's keyboards always follow the system's theme.

Autofill (`.auto_fill(AutoFill::Email)`, TSX `autoComplete`) tells the system what the field holds, so it can offer saved names, addresses, passwords and one-time codes from messages. Rust's `AutoFill` has a variant per kind (`Name`, `GivenName`, `FamilyName`, `Email`, `Tel`, `Username`, `Password`, `NewPassword`, `OneTimeCode`, `StreetAddress`, `PostalCode`, `Country`, `CreditCardNumber`, `Url`, `Birthdate`, ..., and `Off`). TSX takes these values: `"name"`, `"given-name"`, `"family-name"`, `"email"`, `"tel"`, `"username"`, `"current-password"`, `"new-password"`, `"one-time-code"`, `"street-address"`, `"postal-code"`, `"country"`, `"cc-number"`, `"cc-exp"`, `"cc-csc"`, `"url"`, `"birthdate-full"` and others, or `"off"`; iOS's own names (`"emailAddress"`, `"oneTimeCode"`, ...) are accepted too, in `autoComplete` or `ios={{ textContentType }}`.

```rust tabs
use nsh_core::ui::AutoFill;

input()
    .keyboard_type(KeyboardType::Email)
    .auto_capitalize(AutoCapitalize::None)
    .auto_correct(false)
    .auto_fill(AutoFill::Email)
    .placeholder("E-mail")
input().masked(true).auto_fill(AutoFill::NewPassword).placeholder("Password")
input()
    .keyboard_type(KeyboardType::Number)
    .auto_fill(AutoFill::OneTimeCode)
    .max_length(6)
    .placeholder("Code")
```

```tsx tabs
<Input keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" placeholder="E-mail" />
<Input masked autoComplete="new-password" placeholder="Password" />
<Input keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} placeholder="Code" />
```

## The return key and moving between fields

The return key type (`.return_key_type(ReturnKeyType::Next)`, TSX `returnKeyType`) labels the return key: default, done, go, next, search or send. The submit behavior (`.submit_behavior(..)`, TSX `submitBehavior`) says what pressing it does:

| Rust | TSX | Return | Default for |
|---|---|---|---|
| `SubmitBehavior::BlurAndSubmit` | `"blurAndSubmit"` | fires the submit event, then the input loses focus | single-line inputs |
| `SubmitBehavior::Submit` | `"submit"` | fires the submit event; the input keeps focus | |
| `SubmitBehavior::Newline` | `"newline"` | inserts a line break (multiline inputs only) | multiline inputs |

A multiline input with `"submit"` or `"blurAndSubmit"` sends on return, as chat composers do, and still wraps its lines; on a hardware keyboard (desktops, a Mac, a tablet's keyboard) Shift+Return or Option / Alt+Return inserts a line break. A return that commits an input method's composition (Chinese or Japanese input, say) only commits it and never submits.

To move to the next field, keep refs to the inputs (`element_ref()` and `.element_ref(&r)` in Rust, `ref` in TSX) and call `focus()`:

```rust tabs
use nsh_core::ui::prelude::*;

pub fn sign_in() -> impl IntoElement {
    let email = signal(String::new());
    let password = element_ref();
    let submit = move || log::info!("sign in {}", email.get());
    view()
        .flex_1()
        .p(px(16.0))
        .pt(px(60.0))
        .gap(px(12.0))
        .child(
            input()
                .value(move || email.get())
                .on_change(move |t: &str| email.set(t.to_owned()))
                .keyboard_type(KeyboardType::Email)
                .auto_capitalize(AutoCapitalize::None)
                .return_key_type(ReturnKeyType::Next)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(move |_: &str| password.focus())
                .placeholder("E-mail"),
        )
        .child(
            input()
                .element_ref(&password)
                .masked(true)
                .return_key_type(ReturnKeyType::Go)
                .on_submit(move |_: &str| submit())
                .placeholder("Password"),
        )
}
```

```tsx tabs
import { Input, mount, signal, View, type YNode } from "nsh";

function SignIn() {
  const email = signal("");
  let password!: YNode;
  const submit = () => console.log("sign in", email());
  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 60, gap: 12 }}>
      <Input
        value={email()}
        onChange={(t) => email.set(t)}
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmit={() => password.focus()}
        placeholder="E-mail"
      />
      <Input ref={password} masked returnKeyType="go" onSubmit={submit} placeholder="Password" />
    </View>
  );
}

mount(SignIn);
```

Submitting without blurring (`SubmitBehavior::Submit`, `submitBehavior="submit"`) on the first field keeps the keyboard up while focus moves, so it does not drop and rise again. A chat input that sends on return and stays focused submits the same way (see the composer [below](#content-outside-scroll-views-keyboardavoidingview)).

Both the maximum length and the submit behavior are enforced natively: the platform asks "may this character be added?" and "should return end editing?" as the user types, and NSH answers from the props without waiting for JS.

## Focus from code

An input's ref has:

| Rust | TSX | Description |
|---|---|---|
| `focus()` | `focus()` | Focuses the input and shows the keyboard. |
| `blur()` | `blur()` | Unfocuses it. |
| `set_selection(start, end)` | `setSelection(start, end?)` | Selects `start..end` (UTF-16 units); a caret when they are equal (TSX: without `end`). |

`dismiss_keyboard()` in Rust and `Keyboard.dismiss()` from `nsh/base` in TSX unfocus whichever input has focus:

```rust tabs
view().on_press(|| dismiss_keyboard())
```

```tsx tabs
import { View } from "nsh";
import { Keyboard } from "nsh/base";

<View onPress={() => Keyboard.dismiss()}>…</View>
```

## Selection

The selection event (`.on_selection_change(..)`, TSX `onSelectionChange`) reports the caret and selection; the ref's `set_selection` or the selected range (`.selected_range(..)`, TSX `selectedRange`) set them. Positions are UTF-16 code units, as JavaScript string indices are, so in TSX `text.slice(start, end)` is the selected text; in Rust, slice the text's UTF-16 units.

```rust tabs
/// `start..end` of `text` in UTF-16 units, as inputs count.
fn utf16_slice(text: &str, start: u32, end: u32) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = (end as usize).min(units.len());
    String::from_utf16_lossy(&units[(start as usize).min(end)..end])
}

let content = signal("Select part of this text".to_owned());
let range = signal(Selection::default());
let field = element_ref();

view()
    .child(
        input()
            .element_ref(&field)
            .value(move || content.get())
            .on_change(move |t: &str| content.set(t.to_owned()))
            .on_selection_change(move |r: &Selection| range.set(*r)),
    )
    .child(text(move || {
        let r = range.get();
        format!("Selected: \"{}\"", content.with(|t| utf16_slice(t, r.start, r.end)))
    }))
    .child(
        view()
            .on_press(move || {
                let len = content.with(|t| t.encode_utf16().count()) as u32;
                field.set_selection(0, len);
            })
            .child(text("Select all")),
    )
```

```tsx tabs
const text = signal("Select part of this text");
const range = signal({ start: 0, end: 0 });
const selection = signal<{ start: number; end?: number } | undefined>(undefined);

<Input
  value={text()}
  onChange={(t) => text.set(t)}
  selectedRange={selection()}
  onSelectionChange={(r) => range.set(r)}
/>
<Text>Selected: "{text().slice(range().start, range().end)}"</Text>
<View onPress={() => selection.set({ start: 0, end: text().length })}><Text>Select all</Text></View>
```

## The caret

The caret event (`.on_caret_move(..)`, TSX `onCaretMove`) says where the caret is, so that what belongs at the
caret can open there: suggestions for an `@` mention, a slash command's menu, an emoji picker. `bounds` is a `Bounds`
in the input (`origin` and `size`, the input's padding and scrolling applied), as wide as the platform draws the
caret and as tall as its line; `pageBounds` is the same box in the window (or the dialog the input is in), which an
overlay takes as its `anchor`. The event comes while the input has the focus, whenever the caret moves: with the
selection, and when the input's text scrolls or wraps onto other lines. In Rust an overlay is placed against a box
with `.anchor_bounds(..)`.

```rust tabs
let draft = signal(String::new());
let end = signal(0u32);
let caret = signal(None::<Bounds<Points>>);

view()
    .child(
        input()
            .multiline(true)
            .value(move || draft.get())
            .on_change(move |t: &str| draft.set(t.to_owned()))
            .on_selection_change(move |s: &Selection| end.set(s.end))
            .on_caret_move(move |e: &CaretEvent| {
                // Suggestions while the word before the caret starts with "@".
                let typed = draft.with(|t| utf16_slice(t, 0, end.get()));
                let word = typed.rsplit(char::is_whitespace).next().unwrap_or("");
                caret.set(word.starts_with('@').then_some(e.page_bounds));
            })
            .p_2(),
    )
    .child(when(
        move || caret.get().is_some(),
        move || {
            overlay()
                .anchor_bounds(move || caret.get().unwrap_or_default())
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(4.0))
                .child(text("@ada"))
                .child(text("@grace"))
        },
    ))
```

```tsx tabs
import { type Bounds, Input, Overlay, Text, View, signal } from "nsh";

const draft = signal("");
const end = signal(0);
const caret = signal<Bounds | null>(null);

<View>
  <Input
    multiline
    value={draft()}
    onChange={(t) => draft.set(t)}
    onSelectionChange={(e) => end.set(e.end)}
    onCaretMove={(e) => {
      // Suggestions while the word before the caret starts with "@".
      const word = draft().slice(0, end()).split(/\s/).pop() ?? "";
      caret.set(word.startsWith("@") ? e.pageBounds : null);
    }}
    class="p-2"
  />
  <If when={caret()}>
    <Overlay anchor={caret()} placement="bottom" align="start" offset={4}>
      <Text>@ada</Text>
      <Text>@grace</Text>
    </Overlay>
  </If>
</View>;
```

`pageBounds` is where the caret was when the event came: a page that scrolls under the input moves the input but
sends no event, so close the suggestions when it scrolls, or anchor them to the input itself.

## Pasting images and files

The paste event (`.on_paste(..)`, TSX `onPaste`) tells what the user pasted, from the keyboard's shortcut, a menu's
Paste or a keyboard's image: `text`, `files` and `uris`. `files` are what the clipboard held as data, such as a
screenshot or an image copied from a page or another app: `File`s whose bytes the app can upload or show, named
`image.png` (or the type it is). `uris` are the `file:` URLs of files copied in a file manager, as a file drop's.
The platform reads the clipboard as the user pastes, and only then.

The input inserts the pasted text by itself, as it always does: the event comes before the `onChange` of that text.
Images and files are never inserted, since an input holds text. With `pasteBehavior` `"report"` the input inserts
nothing, and the app decides what a paste does: send a long text as an attachment, or insert a cleaned-up version.
The input decides at once, from the prop, because the system asks it on the spot.

```rust tabs
let attachments = signal(Vec::<PastedFile>::new());

input()
    .multiline(true)
    .placeholder("Message")
    .on_paste(move |e: &PasteEvent| {
        // A screenshot pasted into the message goes along as an image.
        attachments.update(|a| a.extend(e.files.iter().cloned()));
    })
    .p_2()
```

```tsx tabs
import { Input, signal } from "nsh";

const attachments = signal<File[]>([]);

<Input
  multiline
  placeholder="Message"
  onPaste={(e) => {
    // A screenshot pasted into the message goes along as an image.
    attachments.update((a) => [...a, ...e.files]);
  }}
  class="p-2"
/>;
```

Upload a pasted file as any `File`, with `fetch` and `FormData` (`form.append("image", file)`); its bytes stay
native until they are sent. On Android, keyboards that insert images (GIFs, stickers) report them the same way. On
Linux the clipboard is read asynchronously, so the event may come after the `onChange` of the text it inserts.
Masked inputs on macOS keep AppKit's own paste and report nothing.

## Multiline inputs that grow

A multiline input (`.multiline(true)`, TSX `multiline`) scrolls its text inside its own height. To grow it with its content, feed the content size event's height (`.on_content_size_change(..)`, TSX `onContentSizeChange`) back into its style, with a limit:

```rust tabs
let height = signal(px(0.0));

input()
    .multiline(true)
    .placeholder("Write a comment")
    .on_content_size_change(move |e: &Size<Points>| height.set(e.height.min(px(120.0))))
    .text_size(px(16.0))
    .p(px(10.0))
    .border_1()
    .border_color(rgb(0xd0d7de))
    .rounded(px(10.0))
    .h(move || height.get().max(px(20.0)) + px(20.0))
```

```tsx tabs
const height = signal(0);

<Input
  multiline
  placeholder="Write a comment"
  onContentSizeChange={(e) => height.set(Math.min(e.height, 120))}
  style={{ fontSize: 16, padding: 10, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 10, height: Math.max(height(), 20) + 20 }}
/>
```

The reported height is the text's (at the input's width), so add the vertical padding yourself, as above.

## Keeping inputs above the keyboard

### Inside scroll views: automatic

When the keyboard appears over a focused input that is inside a scroll view or a list, NSH gives the scroll view a bottom inset as tall as the keyboard and scrolls the input into view. This is native and needs no code. A long form is simply a scroll view of inputs:

```rust tabs
scroll()
    .flex_1()
    .keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)
    .keyboard_taps(KeyboardTaps::Handled)
    .child(view().p(px(16.0)).gap(px(12.0)) /* inputs */)
```

```tsx tabs
<Scroll style={{ flex: 1 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
  <View style={{ padding: 16, gap: 12 }}>
    {/* inputs */}
  </View>
</Scroll>
```

The dismiss mode (`.keyboard_dismiss_mode(..)`, TSX `keyboardDismissMode`: none, on drag, interactive) lets dragging the form hide the keyboard; handled taps (`.keyboard_taps(KeyboardTaps::Handled)`, TSX `keyboardShouldPersistTaps="handled"`) let a tap on a button go through while the keyboard is up instead of only dismissing it. See [Scrolling](./scrolling.md#scroll-views-and-the-keyboard).

### Content outside scroll views: KeyboardAvoidingView

A message bar pinned to the bottom of a screen is not in a scroll view, so nothing moves it. Wrap the screen in `KeyboardAvoidingView` from `nsh_base` (TSX: `nsh/base`): it makes room at the bottom as tall as the keyboard, animated with the keyboard.

```rust tabs
use nsh_base::keyboard_avoiding_view;
use nsh_core::ui::prelude::*;

pub fn chat_screen() -> impl IntoElement {
    let draft = signal(String::new());
    let send = move || {
        let text = draft.get();
        if !text.trim().is_empty() {
            log::info!("send {text}");
        }
        draft.set(String::new());
    };
    keyboard_avoiding_view()
        .flex_1()
        .child(scroll().flex_1().keyboard_dismiss_mode(KeyboardDismissMode::Interactive) /* messages */)
        .child(
            view()
                .flex_row()
                .p(px(8.0))
                // Above the home indicator, unless the keyboard covers it.
                .pb(move || {
                    px(8.0) + if keyboard_height() > px(0.0) { px(0.0) } else { safe_area().bottom }
                })
                .child(
                    input()
                        .value(move || draft.get())
                        .on_change(move |t: &str| draft.set(t.to_owned()))
                        .multiline(true)
                        .submit_behavior(SubmitBehavior::Submit)
                        .return_key_type(ReturnKeyType::Send)
                        .on_submit(move |_: &str| send())
                        .placeholder("Message")
                        .flex_1()
                        .max_h(px(120.0)),
                ),
        )
}
```

```tsx tabs
import { Input, Scroll, signal, View } from "nsh";
import { keyboardFrame, KeyboardAvoidingView, safeAreaInsets } from "nsh/base";

function ChatScreen() {
  const insets = safeAreaInsets();
  const draft = signal("");
  const send = () => {
    if (draft().trim()) console.log("send", draft());
    draft.set("");
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
        {/* messages */}
      </Scroll>
      <View
        style={{
          flexDirection: "row",
          padding: 8,
          // Above the home indicator, unless the keyboard covers it.
          paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
        }}
      >
        <Input
          value={draft()}
          onChange={(t) => draft.set(t)}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          onSubmit={send}
          placeholder="Message"
          style={{ flex: 1, maxHeight: 120 }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
```

In Rust each prop is a setter of `keyboard_avoiding_view()` (`.behavior(AvoidBehavior::Height)`, `.offset(px(49.0))`, `.enabled(move || ..)`):

| Prop | Type | Default | Description |
|---|---|---|---|
| `behavior` | `"padding" \| "height"` | `"padding"` | `padding` pads the bottom by the keyboard's height; `height` shrinks the view (its background ends at the keyboard). |
| `enabled` | `boolean` | `true` | Avoid the keyboard. |
| `offset` | `number` | `0` | Added to the keyboard's height while it shows (a tab bar below the view, say). |

It assumes it reaches the bottom of the surface, as a screen's content does. On an Android host whose window resizes for the keyboard, the window itself shrinks and `KeyboardAvoidingView` has nothing to do. See [KeyboardAvoidingView](../modules/nsh-base.md#keyboardavoidingview).

### The keyboard accessor

`keyboard_height()` and `keyboard_duration()` in Rust, and `keyboardFrame()` from `nsh/base` in TSX (a `{ height, duration }`), are reactive: how far the keyboard reaches into the surface (0 when hidden; the bottom safe area under it included) and its animation's duration in seconds. Read them for anything custom: hide a floating button while typing, or size a panel. A layout that changes with them moves with the keyboard when it animates on the keyboard's curve: `LayoutAnimation.configureNext({ duration: keyboardFrame().duration * 1000, update: { type: "keyboard" } })` (Rust: `LayoutCurve::Keyboard`), as `KeyboardAvoidingView` does.

```rust tabs
view().child(when(
    || keyboard_height() == px(0.0),
    || view().absolute().right(px(16.0)).bottom(px(16.0)), /* … */
))
```

```tsx tabs
import { View } from "nsh";
import { keyboardFrame } from "nsh/base";

<If when={keyboardFrame().height === 0}>
  <View style={{ position: "absolute", right: 16, bottom: 16 }}>…</View>
</If>
```

## A bar over the keyboard (iOS): InputAccessoryView

`input_accessory_view(id)` in Rust and `InputAccessoryView` from `nsh/ios` in TSX show a bar attached to the top of the keyboard while an input that names it has focus: iOS's `inputAccessoryView`. It moves with the keyboard natively, including during interactive dismissal. It takes no room where it is placed in the tree; inputs refer to it by its id (`.input_accessory(id)`, TSX `ios={{ inputAccessoryViewID }}` and `nativeID`):

```rust tabs
use nsh_core::ui::prelude::*;

pub fn note() -> impl IntoElement {
    let content = signal(String::new());
    let field = element_ref();
    view()
        .p(px(16.0))
        .child(
            input()
                .element_ref(&field)
                .value(move || content.get())
                .on_change(move |t: &str| content.set(t.to_owned()))
                .input_accessory("note-bar")
                .placeholder("A note"),
        )
        .child(
            input_accessory_view("note-bar").bg(rgb(0xf6f8fa)).child(
                view()
                    .flex_row()
                    .items_center()
                    .p(px(8.0))
                    .child(
                        text(move || format!("{} characters", content.with(|t| t.chars().count())))
                            .flex_1()
                            .text_color(rgb(0x57606a)),
                    )
                    .child(
                        text("Done")
                            .on_press(move || field.blur())
                            .text_color(rgb(0x0969da))
                            .font_weight(FontWeight::SEMIBOLD),
                    ),
            ),
        )
}
```

```tsx tabs
import { Input, signal, Text, View, type YNode } from "nsh";
import { InputAccessoryView } from "nsh/ios";

function Note() {
  const text = signal("");
  let input!: YNode;
  return (
    <View style={{ padding: 16 }}>
      <Input
        ref={input}
        value={text()}
        onChange={(t) => text.set(t)}
        ios={{ inputAccessoryViewID: "note-bar" }}
        placeholder="A note"
      />
      <InputAccessoryView nativeID="note-bar" style={{ backgroundColor: "#f6f8fa" }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 8 }}>
          <Text style={{ flex: 1, color: "#57606a" }}>{text().length} characters</Text>
          <Text onPress={() => input.blur()} style={{ color: "#0969da", fontWeight: "600" }}>Done</Text>
        </View>
      </InputAccessoryView>
    </View>
  );
}
```

The bar is as wide as the window and as tall as its content. Input accessories are iOS's: on Android the bar is an empty hidden view (`isAvailable` from `nsh/ios` is `false`), so place those controls elsewhere there, for example above the input (`os() == Os::Android` in Rust, `platform.os === "android"` in TSX).

## Related

- [`Input`](../elements/input.md): the element reference.
- [`KeyboardAvoidingView`](../modules/nsh-base.md#keyboardavoidingview) and [`Keyboard`](../modules/nsh-base.md#keyboard).
- [`nsh/ios`](../modules/nsh-ios.md): `InputAccessoryView`.
- [Scrolling](./scrolling.md#scroll-views-and-the-keyboard): keyboard dismissal and taps in scroll views.
