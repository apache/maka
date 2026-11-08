---
title: Text selection
description: "Selectable views: one selection across the texts inside a view, across views, Text elements and TextViews, as a web page's texts select."
order: 130
group: primitives
demo: el-text-selection
---

# Text selection

A [`View`](./view.md) with `selectable` makes the texts inside it select together, as a web page's do: one selection
runs from a place in one text to a place in another, across views, [`Text`](./text.md) elements and
[`TextView`](./text-view.md)s, in reading order. Make a chat transcript selectable and a selection can start in one
message and end in the next; Copy puts the selected text on the clipboard, with texts side by side joined by a tab and
the others by a line break. Rust sets it with `view().selectable(true)`, TSX with `<View selectable>`; whether a single
text can be selected is its `userSelect` style.

```rust tabs
use nsh_base::text_view;
use nsh_core::prelude::*;

fn release_notes(notes: &'static str) -> impl IntoElement {
    view()
        .selectable(true)
        .gap_3()
        .p_4()
        .child(text("Release notes").font_weight(FontWeight::SEMIBOLD))
        .child(text_view().markdown(notes))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(text("Updated").select_none().text_color(rgb(0x737373)))
                .child(text("October 21")),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { TextView } from "nsh/base";

function ReleaseNotes(props: { notes: string }) {
  return (
    <View selectable class="gap-3 p-4">
      <Text class="font-semibold">Release notes</Text>
      <TextView markdown={props.notes} />
      <View class="flex-row gap-2">
        <Text style={{ userSelect: "none" }} class="text-neutral-500">Updated</Text>
        <Text>October 21</Text>
      </View>
    </View>
  );
}
```

The view's layout and look are the app's styles, and its content is its children. The selection itself is the
platform's: the view draws nothing of its own for it.

## A chat transcript

A transcript in one selectable view selects as one page: a drag starts in one reply and ends in another, and Copy
takes the text of every message in between.

```rust tabs
use nsh_base::text_view;
use nsh_core::prelude::*;

fn transcript(replies: Signal<Vec<SharedString>>) -> impl IntoElement {
    scroll().flex_1().child(
        view().selectable(true).p_4().gap_4().child(each(
            replies,
            |reply: &SharedString| reply.clone(),
            |reply, _index| text_view().markdown(move || reply.get()),
        )),
    )
}
```

```tsx tabs
import { Scroll, View } from "nsh";
import { TextView } from "nsh/base";

<Scroll class="flex-1">
  <View selectable class="gap-4 p-4">
    <Each of={replies}>{(reply) => <TextView markdown={reply()} />}</Each>
  </View>
</Scroll>
```

## Reading the selection

`onSelectionChange` on a selectable view (`.on_text_selection_change(..)` in Rust) hears the selected text each
time the selection changes: `{ text, start }`, what Copy would take and where it starts in the view's whole text, and `""` once nothing is selected (a press elsewhere,
Escape, another view selecting). It reports only changes. In a selectable view inside another, the outer view
reports, as it holds the one selection. A `selectable` [`TextView`](./text-view.md) reports its own the same way
(`onSelectionChange`, `.on_selection_change(..)`). A chat uses it to quote the part of a reply the reader selected:

```rust tabs
use nsh_core::prelude::*;

fn reply(markdown: SharedString, quote: Signal<String>) -> impl IntoElement {
    view()
        .selectable(true)
        .on_text_selection_change(move |e: &TextSelectionEvent| quote.set(e.text.clone()))
        .child(nsh_base::text_view().markdown(markdown))
}
```

```tsx tabs
import { signal, View } from "nsh";
import { TextView } from "nsh/base";

const quote = signal("");

<View selectable onSelectionChange={({ text }) => quote.set(text)}>
  <TextView markdown={reply} />
</View>
```

### As Markdown or HTML

A `selectable` `TextView`'s ref reads its selection when the app asks: `selectedText({ format })` gives the selected
text (`"plain"`, the default, what Copy takes), or the selected part of the document as `"markdown"` or `"html"`,
rebuilt from the nodes it covers, so the marks, links, list items and code blocks around it are kept (a list keeps its
numbers, a table row keeps the table's header). With all of it selected it gives the source as written, when the
document came in that format. `""` when nothing is selected. In Rust it is `TextViewApi::selected_text` with
`TextSelectionOptions::format(TextSelectionFormat::Markdown)`.

```rust tabs
use nsh_base::{TextSelectionFormat, TextSelectionOptions, TextView, TextViewApi, text_view};
use nsh_core::prelude::*;

fn reply(markdown: SharedString, quote: Signal<String>) -> impl IntoElement {
    let doc = component_ref::<TextView>();
    text_view()
        .markdown(markdown)
        .selectable(true)
        .component_ref(&doc)
        .on_selection_change(move |_| {
            if let Some(api) = doc.api::<TextViewApi>() {
                let options = TextSelectionOptions::format(TextSelectionFormat::Markdown);
                quote.set(api.selected_text(Some(options)));
            }
        })
}
```

```tsx tabs
import { signal } from "nsh";
import { TextView, type TextViewRef } from "nsh/base";

let doc: TextViewRef | undefined;
const quote = signal("");

<TextView
  ref={(r) => (doc = r)}
  selectable
  markdown={reply}
  onSelectionChange={async () => quote.set((await doc?.selectedText({ format: "markdown" })) ?? "")}
/>
```

It reads the selection the view holds: in a `selectable` view inside another, the outer view holds it, and the inner
`TextView`'s ref gives `""`.

An [`Input`](./input.md)'s `onSelectionChange` is its own: the caret and selection in its text (`{ start, end }`).

## How a selection is made

| Platform | How a selection is made |
|---|---|
| macOS, Windows, Linux, GPUI | Drag across the texts; a double click selects a word, a triple click a paragraph, and a drag after them goes on by words or paragraphs. Shift+click extends the selection. Ctrl / Cmd+A selects everything in the view, Ctrl / Cmd+C copies, Escape or a press outside clears. |
| iOS, Android | A long press selects a word; the platform's handles extend it, and its edit menu has Copy and Select All. |
| Web | The browser's own selection, with its gestures, menu and shortcuts. |

## What it selects

- **Texts that stay out**: a text with `userSelect: "none"` (`.select_none()` in Rust, the class `select-none`; a
  label, a button's caption) is skipped by the selection and its gestures.
- **Nested views**: a selectable view inside another is part of the outer one, so one selection covers both.
- **TextView**: a [`TextView`](./text-view.md) with `selectable` selects as one of its own: its paragraphs, list
  items, cells and code blocks select together. Inside a selectable view it joins the outer selection.
- **Single texts**: a text with `userSelect: "text"` in no selectable view selects on its own, as
  [Text](./text.md#props) describes.
- **The look** is the platform's highlight in each text's `selectionColor` (`selection:text-*`).
- **A line in several texts**: a Rust component that lays one line out as several texts (a soft-wrapped line of
  code) marks the later parts with `.continues_text(true)`; a copy then gives the line whole, with no line break where
  it was cut, and a triple click selects all of its parts. [`DiffView`](./diff-view.md) does this for its wrapped lines.
- **Lists**: in a virtualized [List](./list.md), a selection covers the rows that are mounted; rows recycled out of
  view leave it.

## Related

- [View](./view.md): the `selectable` prop.
- [Text](./text.md): `userSelect`, `selectionColor` and the selection of a single text.
- [TextView](./text-view.md): documents whose blocks select as one.
