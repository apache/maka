---
title: Combobox
description: "The Combobox component: one value or several chosen from a searchable list of items, a popup at its trigger on desktops and a sheet on phones, styled by the app."
group: base
demo: el-combobox
---

# Combobox

A combobox chooses values from a list of items, one or, with `multiple`, several: the tags of a post, the members of
a channel, the languages of a document. It is [Select](./select.md)'s sibling and shares its list, presented as each
device expects:

- On the desktops and in desktop browsers, a popup at the trigger, at least as wide as the trigger and as tall as its
  rows up to the room beside it.
- On phones and tablets, a sheet at the bottom of the screen over a backdrop.

The combobox owns the behavior: the value (the app's, or its own), the open state, the keyboard, search, sections,
the highlighted row and what screen readers hear. With `multiple`, a choice toggles the item in the value and the
list stays open, so several are picked in one go. The look is the app's: it styles the trigger, the popup, the list,
the rows, the sections' headers, the search field and the footer, or draws the rows itself.

```rust tabs
use nsh_base::{SelectItem, SelectItemState, combobox, theme};
use nsh_core::prelude::*;

const TAGS: [(&str, &str); 5] = [
    ("bug", "Bug"),
    ("design", "Design"),
    ("docs", "Docs"),
    ("perf", "Performance"),
    ("security", "Security"),
];

fn tag_picker() -> impl IntoElement {
    let tags = signal(Vec::<SharedString>::new());
    let title = move || match tags.get().len() {
        0 => "Add tags".to_string(),
        n => format!("{n} tags"),
    };
    combobox()
        .items(
            TAGS.iter()
                .map(|&(value, title)| SelectItem::new(value, title))
                .collect::<Vec<_>>(),
        )
        .multiple(true)
        .searchable(true)
        .search_placeholder("Find a tag")
        .value(move || Some(tags.get()))
        .on_change(move |next: &Vec<SharedString>| tags.set(next.clone()))
        .accessibility_label("Tags")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .shadow_md()
        })
        .trigger(
            view()
                .h_9()
                .w_48()
                .px_3()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .child(text(title)),
        )
        .render_item(|item: &SelectItemState| {
            view()
                .flex_row()
                .justify_between()
                .px_2()
                .py_1p5()
                .when(item.highlighted, |v| v.bg(move || theme().accent))
                .child(text(item.title.clone()).text_sm())
                .when(item.selected, |v| v.child(text("✓").text_sm()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Combobox } from "nsh/base";

const TAGS = [
  { value: "bug", title: "Bug" },
  { value: "design", title: "Design" },
  { value: "docs", title: "Docs" },
  { value: "perf", title: "Performance" },
  { value: "security", title: "Security" },
];

function App() {
  const tags = signal<string[]>([]);
  return (
    <Combobox
      items={TAGS}
      multiple
      searchable
      searchPlaceholder="Find a tag"
      value={tags()}
      onChange={({ value }) => tags.set(value)}
      accessibilityLabel="Tags"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      searchClass="mb-1 h-8 rounded-md border border-input px-2 text-sm placeholder:text-muted-foreground"
      itemClass="rounded-md px-2 py-1.5 text-sm focus:bg-accent focus:text-accent-foreground"
      trigger={
        <View class="h-9 w-48 justify-center rounded-md border border-input px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text>{tags().length ? `${tags().length} tags` : "Add tags"}</Text>
        </View>
      }
      renderItem={(item) => (
        <View class="flex-row justify-between">
          <Text>{item.title}</Text>
          <Text>{item.selected ? "✓" : ""}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Combobox` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `combobox()` makes
one with a setter per prop (`.items(..)`, `.value(..)`, `.multiple(..)`) and a listener per event (`.on_change(..)`).
Its items are `Select`'s: `SelectItem::new(value, title)`, with `.disabled(..)` and `.group(..)`, in sections as a
select's are (see [Items](./select.md#items)).

## Value

The value is an array of the selected items' values. With `value`, the app owns it: the combobox shows those items
as selected and reports each change with `onChange({ value })`; the app sets `value` to follow it, or keeps its own.
Left out, the combobox keeps its own value, from `defaultValue` at first.

- With `multiple`, a press, Return or Space toggles the highlighted item: in the value if it was out, out if it was
  in. The list stays open.
- Without it, a choice replaces the value with that item's and closes the list; choosing the selected item again only
  closes it.

`onConfirm({ value })` tells the value as the list closes: once per opening, however it closes (a choice, Escape, a
press outside, the trigger), with the value as the user left it. Cmd+Return on a Mac (Ctrl+Return elsewhere) closes
the list and confirms.

`cleanable` adds a clear button while an item is selected: a press empties the value (`onChange({ value: [] })`).
The button comes after the trigger, not inside it, so a press on it never opens the list; the app places it and fills
it, as a [select's clear button](./select.md#value).

## Search

`searchable` puts a search field above the items, as a select's: typing filters them by title, ignoring case, and
`empty` shows while nothing matches. The query is the field's own, starting each opening from `defaultQuery` (else
empty), or the app's with `query`: `onQueryChange({ query })` reports what is typed, and the app sets `query` to
follow it, to filter its own way or to suggest a starting point.

## Footer

`footer` is content below the rows, in a part of its own (`footerClass`, `footerStyle`): an action ("Manage tags"),
a count, a hint. It stays in place while the rows scroll.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `SelectItem[]` | `[]` | The items, in order. |
| `multiple` | `.multiple(..)` | `boolean` | `false` | A choice toggles the item in the value and the list stays open. |
| `value` | `.value(..)` | `string[]` | none | The selected items' values, owned by the app. |
| `defaultValue` | `.default_value(..)` | `string[]` | `[]` | The value at first, without `value`. |
| `open`, `defaultOpen` | `.open(..)`, `.default_open(..)` | `boolean` | `false` | The open state, the app's or the combobox's own. |
| `searchable` | `.searchable(..)` | `boolean` | `false` | A search field above the items filters them by title. |
| `searchPlaceholder` | `.search_placeholder(..)` | `string` | none | The search field's placeholder. |
| `query` | `.query(..)` | `string` | none | The query, owned by the app. |
| `defaultQuery` | `.default_query(..)` | `string` | none | The query each opening starts with, without `query`. |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | A clear button while an item is selected; a press empties the value. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It stays closed and takes no presses or keyboard focus. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What the choice is about, for screen readers. |
| `placement`, `align`, `offset`, `margin` | `.placement(..)`, ... | as `Select`'s | `"bottom"`, `"start"`, 0, 0 | Desktops: where the popup goes against the trigger. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (touch screens). |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The backdrop behind the sheet. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The list, the scroll view of the rows. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each item's row: `focus:` while highlighted, `selected:` while selected, `disabled:` while it cannot be. |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each section's header. |
| `searchClass`, `searchStyle` | `.search_class(..)`, `.search_style(..)` | `string`, `StyleProp<InputStyle>` | none | The search field. |
| `footerClass`, `footerStyle` | `.footer_class(..)`, `.footer_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The footer, below the rows. |
| `clearButtonClass`, `clearButtonStyle` | `.clear_button_class(..)`, `.clear_button_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The clear button (`cleanable`). |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | none | The content of the clear button. |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | none | What screen readers call the clear button. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens the list when pressed; the list is placed against it. |
| `empty` | `.empty(..)` | `JSX.Element` | none | What the list shows while no item does. |
| `footer` | `.footer(..)` | `JSX.Element` | none | What shows below the rows. |
| `renderItem` | `.render_item(..)` | `(item: SelectItemState) => JSX.Element` | none | An item's row, drawn by the app; the item's title otherwise. |
| `renderGroup` | `.render_group(..)` | `(group: SelectGroup) => JSX.Element` | none | A section's header, drawn by the app; its title otherwise. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The view around the trigger. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The value changed (a choice, a toggle, the clear button): `{ value }`, the selected items' values. Set `value` to follow it. |
| `onConfirm` | `.on_confirm(\|value\| ..)` | The list closed: `{ value }` as it is then, once per opening. |
| `onQueryChange` | `.on_query_change(\|query\| ..)` | The user typed in the search field: `{ query }`. Set `query` to follow it. |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | The list opened or closed, with why (`{ open, reason }`). Set `open` to follow it. |
| `onOpen`, `onClose` | `.on_open(..)`, `.on_close(..)` | The list is shown, or gone. |
| `onCancel` | `.on_cancel(..)` | The user closed the list without a choice that closes it (Escape or back, a press outside or on the backdrop). |

They come in this order: `onChange` for a choice, or `onCancel` for a close without one, then `onOpenChange`, then
`onConfirm` as the list closes, then `onOpen` or `onClose` once the list is shown or gone.

## Parts

| Part | Where | Styled with |
|---|---|---|
| The trigger | the combobox's view | the app's own element (`trigger`) |
| The clear button | the combobox's view, after the trigger (`cleanable`, while an item is selected) | `clearButtonClass`, `clearButtonStyle`; its content `clearButton` |
| The popup or sheet | over everything, at the trigger (desktops) or at the bottom (touch screens) | `popupClass`, `popupStyle` |
| The backdrop | behind the sheet (touch screens) | `backdropClass`, `backdropStyle` |
| The search field | the popup, first (`searchable`) | `searchClass`, `searchStyle`, `searchPlaceholder` |
| The list | the popup, after the search field | `listClass`, `listStyle` |
| A section's header | the list, before its items | `groupClass`, `groupStyle`, `renderGroup` |
| An item's row | the list | `itemClass`, `itemStyle`, `renderItem` |
| The empty state | the popup, while no item shows | its own element (`empty`) |
| The footer | the popup, last | `footerClass`, `footerStyle`; its content `footer` |

## Keyboard

The keys are a select's (see [Keyboard](./select.md#keyboard)), with these differences: Return and Space toggle the
highlighted item with `multiple` and keep the list open; Cmd+Return on a Mac (Ctrl+Return elsewhere) closes it and
confirms; and the closed trigger takes no typeahead (its keys only open the list).

## Accessibility

- The trigger is a combobox for screen readers: its label is `accessibilityLabel`, its value the selected items'
  titles, joined with commas, and it says whether the list is expanded. `disabled` dims it.
- The list is a listbox and each row an option, named by its title; the selected options are selected and a disabled
  one dimmed. Sections' headers are headers.
- The clear button is a button named by `clearButtonAccessibilityLabel`; it is no stop of Tab.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
