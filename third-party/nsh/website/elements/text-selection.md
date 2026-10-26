---
title: Text selection
description: "Selectable views: one selection across the texts inside a view, across views, Text elements and TextViews, as a web page's texts select."
order: 10.8
group: primitives
demo: el-text-selection
---

# Text selection

A [`View`](./view.md) with `selectable` makes the texts inside it select together, as a web page's do: one selection
runs from a place in one text to a place in another, across views, [`Text`](./text.md) elements and
[`TextView`](./text-view.md)s, in reading order. Make a chat transcript selectable and a selection can start in one
message and end in the next; Copy puts the selected text on the clipboard, with texts side by side joined by a tab and
the others by a line break. It is the same prop as `Text`'s `selectable`: Rust sets it with `view().selectable(true)`,
TSX with `<View selectable>`.

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
                .child(text("Updated").selectable(false).text_color(rgb(0x737373)))
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
        <Text selectable={false} class="text-neutral-500">Updated</Text>
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

## How a selection is made

| Platform | How a selection is made |
|---|---|
| macOS, Windows, Linux, GPUI | Drag across the texts; a double click selects a word, a triple click a paragraph, and a drag after them goes on by words or paragraphs. Shift+click extends the selection. Ctrl / Cmd+A selects everything in the view, Ctrl / Cmd+C copies, Escape or a press outside clears. |
| Terminal | Drag across text nodes and lines; Shift+click extends the selection. Dragging beyond a Scroll edge scrolls while held. Ctrl+A selects the area, Ctrl+C or Ctrl+Insert copies, Escape clears a nonempty selection, and a press outside clears it. |
| iOS, Android | A long press selects a word; the platform's handles extend it, and its edit menu has Copy and Select All. |
| Web | The browser's own selection, with its gestures, menu and shortcuts. |

On terminal surfaces, a retained background selection receives keys only in the active input scope. A modal or
focused popup suspends that keyboard ownership; closing it makes the selection available again. Copy uses the
same [host clipboard services and OSC 52 output](../docs/tui.md#keyboard-and-mouse) as other clipboard writes.

## What it selects

- **Texts that stay out**: a text with `selectable={false}` (`.selectable(false)` in Rust; a label, a button's
  caption) is skipped by the selection and its gestures.
- **Nested views**: a selectable view inside another is part of the outer one, so one selection covers both.
- **TextView**: a [`TextView`](./text-view.md) with `selectable` selects as one of its own: its paragraphs, list
  items, cells and code blocks select together. Inside a selectable view it joins the outer selection.
- **Single texts**: a `selectable` text in no selectable view selects on its own, as [Text](./text.md#props)
  describes.
- **The look** is the platform's highlight in each text's `selectionColor` (`selection:text-*`).
- **Lists**: in a virtualized [List](./list.md), a selection covers the rows that are mounted; rows recycled out of
  view leave it.

## Related

- [View](./view.md): the `selectable` prop.
- [Text](./text.md): `selectable`, `selectionColor` and the selection of a single text.
- [TextView](./text-view.md): documents whose blocks select as one.
