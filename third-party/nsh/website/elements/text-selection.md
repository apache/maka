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
message and end in the next; Copy puts the selected text on the clipboard as a browser does: texts side by side
joined by a tab, texts on the next line by a line break, and separate blocks (paragraphs, messages) by a blank line. A
list item copied from its start keeps its marker (`•`, `2.`), although the marker itself is never highlighted. Rust sets it with `view().selectable(true)`, TSX with `<View selectable>`; whether a single
text can be selected is its `userSelect` style.

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

The view's layout and look are the app's styles, and its content is its children. The selection itself is the
platform's: the view draws nothing of its own for it.

## A chat transcript

A transcript in one selectable view selects as one page: a drag starts in one reply and ends in another, and Copy
takes the text of every message in between.

```tsx tabs
import { Scroll, View } from "nsh";
import { TextView } from "nsh/base";

<Scroll class="flex-1">
  <View selectable class="gap-4 p-4">
    <Each of={replies}>{(reply) => <TextView markdown={reply()} />}</Each>
  </View>
</Scroll>
```

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

## Reading the selection

`onSelectionChange` on a selectable view (`.on_text_selection_change(..)` in Rust) hears the selected text each
time the selection changes: `{ text, start, bounds, pageBounds, anchor, focus }`, what Copy would take, where it starts in the view's whole text
and the box around it in the view and in the root view it is in (on macOS and Windows; an `Overlay` anchored at
`pageBounds` is a bar of actions above the selection), the list items its ends are in (below), and `""` once nothing is selected (a press elsewhere,
Escape, another view selecting). It reports only changes, of the text, of its box or of its ends. In a selectable view inside another, the outer view
reports, as it holds the one selection. A `selectable` [`TextView`](./text-view.md) reports its own the same way
(`onSelectionChange`, `.on_selection_change(..)`). A chat uses it to quote the part of a reply the reader selected:

```tsx tabs
import { signal, View } from "nsh";
import { TextView } from "nsh/base";

const quote = signal("");

<View selectable onSelectionChange={({ text }) => quote.set(text)}>
  <TextView markdown={reply} />
</View>
```

```rust tabs
use nsh_core::prelude::*;

fn reply(markdown: SharedString, quote: Signal<String>) -> impl IntoElement {
    view()
        .selectable(true)
        .on_text_selection_change(move |e: &TextSelectionEvent| quote.set(e.text.clone()))
        .child(nsh_base::text_view().markdown(markdown))
}
```

### Which list items it is in

When the selectable view holds a [`List`](./list.md), the event also says which items the selection starts and ends in,
as the list names them: `anchor` is where the selection started (the press) and `focus` where it goes now, each
`{ key, offset }`. `key` is the item's key (`keyExtractor`, else the item's `key` or `id`, else its index, as in
`onViewableItemsChange`), and `offset` is where the end is in that item's text, as a copy of the whole item gives it
(UTF-16 units). A drag upward has its `focus` in an earlier item than its `anchor`. Two items with the same words stay
apart, and so do items inserted above the selection or replaced while it lasts: each event names the items the ends are
in as of that event (a row that makes its text anew ends the selection, as any text that goes does). An item scrolled
out of view keeps its key while an end is in it. In a list inside another list's item, the end names the innermost
item; a component's own list in an item (a [`Tree`](./tree.md), a `Listbox`) leaves it to the item around it. An end
outside a list item has no field, and neither has one in a row the list has no key for (its `keyExtractor` threw, which
is reported as any exception the app throws, or gave neither a string nor a number). A transcript quotes the selected
part of each message it spans:

```tsx
<View selectable onSelectionChange={({ text, anchor, focus }) => quote.set({ text, from: anchor, to: focus })}>
  <List each={messages()} keyExtractor={(m) => m.id}>
    {(m) => <TextView markdown={m().text} />}
  </List>
</View>
```

In Rust the same ends are `TextSelectionEvent::anchor` and `focus` (`TextSelectionEndpoint { key, offset }`). A Rust
`virtual_list`'s rows go by their index (`"3"`) when no TSX list around names the item, as its `.keys(..)` are any
hashable value. The web reports no ends
yet.

`ref.clearSelection()` on the selectable view, or on a view inside it, clears the selection as a press elsewhere does:
the highlight goes and `onSelectionChange` hears `""`. A bar of actions over the selection calls it once its action is
done. In Rust it is `ElementRef::clear_selection`.

`ref.selectAll()` does the opposite: it selects all the text of the selectable view the node is or is inside, as the
selection menu's Select All does. On phones the handles and the edit menu show, so the user can narrow the selection
and copy part of it. Use it where a long press is already taken, for example a chat message whose long press opens a
menu with "Select text":

```tsx
let message!: ViewRef;

<View ref={message} selectable>
  <Text>
    Prices rose <Text class="font-bold">4%</Text> this quarter.
  </Text>
</View>;

// The menu's "Select text" item:
message.selectAll();
```

The texts keep their styling, which an `Input` would lose. `onSelectionChange` hears the selected text as after a
drag. In Rust it is `ElementRef::select_all`.

### As Markdown or HTML

A `selectable` `TextView`'s ref reads its selection when the app asks: `selectedText({ format })` gives the selected
text (`"plain"`, the default, what Copy takes), or the selected part of the document as `"markdown"` or `"html"`,
rebuilt from the nodes it covers, so the marks, links, list items and code blocks around it are kept (a list keeps its
numbers, a table row keeps the table's header). With all of it selected it gives the source as written, when the
document came in that format. `""` when nothing is selected. In Rust it is `TextViewApi::selected_text` with
`TextSelectionOptions::format(TextSelectionFormat::Markdown)`.

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

It reads the selection the view holds: in a `selectable` view inside another, the outer view holds it, and the inner
`TextView`'s ref gives `""`.

On macOS, Windows and Linux, a right click on a selectable view's text opens the menu of the view's `onContextMenu`
when it listens (or a view inside it around the text does), with the selection kept, even where the text itself is
selectable: the app shows its own menu with `Menu.popup`. On Windows, that menu's `copy` and `selectAll` roles act on
the selection, beside the app's own items for what is selected. Without a listener, the platform's edit menu opens
(Copy and Select All).

An [`Input`](./input.md)'s `onSelectionChange` is its own: the caret and selection in its text (`{ start, end }`).

## How a selection is made

| Platform | How a selection is made |
|---|---|
| macOS, Windows, Linux, GPUI | Drag across the texts; a double click selects a word, a triple click a paragraph, and a drag after them goes on by words or paragraphs. Shift+click extends the selection. Ctrl / Cmd+A selects everything in the view, Ctrl / Cmd+C copies, Escape or a press outside clears. On macOS, Shift with the arrow keys extends a selectable view's selection from where it was pressed, as in a text view: by a character or a line, with Option by a word or a paragraph, with Cmd to the line's or the view's ends (Shift+Home / End too). |
| iOS, Android | A long press selects a word; the platform's handles extend it, and its edit menu has Copy and Select All. |
| Web | The browser's own selection, with its gestures, menu and shortcuts. |

Outside the web, a word is a run of letters, digits and `_`, and a double click selects the word alone. A long press on
iOS and Android keeps a hostname, URL, path or id whole (`demo-app.pages.dev`, `https://x.y/a-b?c=1`, `~/a/b-c.md`,
`v0.5.1`), as the phones' own text views keep a link whole: the punctuation between its words joins them, while
punctuation after it (a sentence's `foo.`) stays out, and so do operators (`a=b`, `x+y`).

## What it selects

- **Texts that stay out**: a text with `userSelect: "none"` (`.select_none()` in Rust, the class `select-none`; a
  label, a button's caption) is skipped by the selection and its gestures.
- **Nested views**: a selectable view inside another is part of the outer one, so one selection covers both.
- **TextView**: a [`TextView`](./text-view.md) with `selectable` selects as one of its own: its paragraphs, list
  items, cells and code blocks select together. Inside a selectable view it joins the outer selection.
- **Single texts**: a text with `userSelect: "text"` in no selectable view selects on its own, as
  [Text](./text.md#props) describes.
- **The look** is the platform's highlight in each text's `selectionColor` (`selection:bg-*`). A text that sets none
  takes the nearest color set on a view around it: the view's `selection:bg-*` class, or `.selection_color(..)` in
  Rust, which wins over the class. Set it once on the selectable view to color the whole selection; on Android the
  selection handles take it too.
- **A line in several texts**: a Rust component that lays one line out as several texts (a soft-wrapped line of
  code) marks the later parts with `.continues_text(true)`; a copy then gives the line whole, with no line break where
  it was cut, and a triple click selects all of its parts. [`DiffView`](./diff-view.md) does this for its wrapped lines.
- **Lists**: in a virtualized [List](./list.md), a selection covers the rows that are mounted; rows recycled out of
  view leave it.

## Related

- [View](./view.md): the `selectable` prop.
- [Text](./text.md): `userSelect`, `selectionColor` and the selection of a single text.
- [TextView](./text-view.md): documents whose blocks select as one.
