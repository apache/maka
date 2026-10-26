---
title: SelectionArea
description: "The SelectionArea component: one selection across the texts inside it, across views, Text elements and TextViews, as a web page's texts select."
order: 27
group: base
demo: el-selection-area
---

# SelectionArea

`SelectionArea` makes the texts inside it select together, as a web page's do: one selection runs from a place in one
text to a place in another, across views, [`Text`](./text.md) elements and [`TextView`](./text-view.md)s, in reading
order. Wrap a chat transcript in it and a selection can start in one message and end in the next; Copy puts the
selected text on the clipboard, with texts side by side joined by a tab and the others by a line break. Rust makes one
with `nsh_base::selection_area()`, TSX with `<SelectionArea>` from `nsh/base`.

```rust tabs
use nsh_base::{selection_area, text_view};
use nsh_core::ui::prelude::*;

fn release_notes(notes: &'static str) -> impl IntoElement {
    selection_area()
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
import { SelectionArea, TextView } from "nsh/base";

function ReleaseNotes(props: { notes: string }) {
  return (
    <SelectionArea class="gap-3 p-4">
      <Text class="font-semibold">Release notes</Text>
      <TextView markdown={props.notes} />
      <View class="flex-row gap-2">
        <Text selectable={false} class="text-neutral-500">Updated</Text>
        <Text>October 21</Text>
      </View>
    </SelectionArea>
  );
}
```

`SelectionArea` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. It is a view: its
layout and look are the app's styles, and its content is its children. The selection itself is the platform's: the
area draws nothing of its own.

## A chat transcript

A transcript in one area selects as one page: a drag starts in one reply and ends in another, and Copy takes the text
of every message in between.

```rust tabs
use nsh_base::{selection_area, text_view};
use nsh_core::ui::prelude::*;

fn transcript(replies: Signal<Vec<SharedString>>) -> impl IntoElement {
    scroll().flex_1().child(
        selection_area().p_4().gap_4().child(each(
            replies,
            |reply: &SharedString| reply.clone(),
            |reply, _index| text_view().markdown(move || reply.get()),
        )),
    )
}
```

```tsx tabs
import { Scroll } from "nsh";
import { SelectionArea, TextView } from "nsh/base";

<Scroll class="flex-1">
  <SelectionArea class="gap-4 p-4">
    <Each of={replies}>{(reply) => <TextView markdown={reply()} />}</Each>
  </SelectionArea>
</Scroll>
```

## How a selection is made

| Platform | How a selection is made |
|---|---|
| macOS, Windows, Linux, GPUI | Drag across the texts; a double click selects a word, a triple click a paragraph, and a drag after them goes on by words or paragraphs. Shift+click extends the selection. Ctrl / Cmd+A selects everything in the area, Ctrl / Cmd+C copies, Escape or a press outside clears. |
| Terminal | Drag across text nodes and lines; Shift+click extends the selection. Dragging beyond a Scroll edge scrolls while held. Ctrl+A selects the area, Ctrl+C or Ctrl+Insert copies, Escape clears a nonempty selection, and a press outside clears it. |
| iOS, Android | A long press selects a word; the platform's handles extend it, and its edit menu has Copy and Select All. |
| Web | The browser's own selection, with its gestures, menu and shortcuts. |

On terminal surfaces, a retained background selection receives keys only in the active input scope. A modal or
focused popup suspends that keyboard ownership; closing it makes the selection available again. Copy uses the
same [host clipboard services and OSC 52 output](../docs/tui.md#keyboard-and-mouse) as other clipboard writes.

## What it selects

- **Texts that stay out**: a text with `selectable={false}` (`.selectable(false)` in Rust; a label, a button's
  caption) is skipped by the selection and its gestures.
- **Nested areas**: an area inside another is part of the outer one, so one selection covers both.
- **TextView**: a [`TextView`](./text-view.md) with `selectable` is a selection area of its own: its paragraphs, list
  items, cells and code blocks select together. Inside a `SelectionArea` it joins the outer selection.
- **Outside areas**: a `selectable` text that is in no area selects on its own, as [Text](./text.md#props) describes.
- **The look** is the platform's highlight in each text's `selectionColor` (`selection:text-*`).
- **Lists**: in a virtualized [List](./list.md), a selection covers the rows that are mounted; rows recycled out of
  view leave it.

## Props

| Prop | Rust | Type | Description |
|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | The content: any views, with texts at any depth. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | Its layout and look, as a [View](./view.md)'s. |

## Related

- [Text](./text.md): `selectable`, `selectionColor` and the selection of a single text.
- [TextView](./text-view.md): documents whose blocks select as one.
- [`nsh/base`](../modules/nsh-base.md): the other base components.
