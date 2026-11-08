---
title: Combobox
description: "The Combobox component: one value or several chosen from a list of items filtered by typing into its input, a popup under the field on desktops and a sheet on phones, styled by the app."
group: base
demo: el-combobox
---

# Combobox

A combobox chooses values from a list of items, one or, with `multiple`, several: the tags of a post, the members of
a channel, the languages of a document. Its trigger is an input: typing opens the list and filters it, as shadcn/ui's
combobox does. It is [Select](./select.md)'s sibling and shares its list, presented as each device expects:

- On the desktops and in desktop browsers, a popup under the field, as wide as the field (the app's `popupStyle` / `popupClass` width sets another) and as tall as its rows up
  to the room beside it.
- On phones and tablets, a sheet at the bottom of the screen over a backdrop.

The combobox owns the behavior: the value (the app's, or its own), the open state, the keyboard, search, sections,
the highlighted row and what screen readers hear. With `multiple`, a choice toggles the item in the value and the
list stays open, so several are picked in one go. The look is the app's: it styles the field, the popup, the list,
the rows, the sections' headers, the input and the footer, or draws the rows itself.

```rust tabs
use nsh_base::{SelectEntry, SelectItem, combobox, theme};
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
        .placeholder(title)
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
        .h_9()
        .w_48()
        .px_3()
        .flex_row()
        .items_center()
        .rounded_md()
        .border_1()
        .border_color(move || theme().input)
        .input_style(|s| s.flex_1().text_sm())
        .trigger_button(text("⌄"))
        .item_class("rounded-md focus:bg-accent selected:font-medium disabled:opacity-50")
        .render_item(|item: &SelectEntry| view().px_2().py_1p5().child(text(item.title.clone()).text_sm()))
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
      placeholder={tags().length ? `${tags().length} tags` : "Add tags"}
      value={tags()}
      onChange={({ value }) => tags.set(value)}
      accessibilityLabel="Tags"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      class="h-9 w-48 flex-row items-center rounded-md border border-input px-3"
      inputClass="flex-1 text-sm placeholder:text-muted-foreground"
      itemClass="group rounded-md px-2 py-1.5 text-sm focus:bg-accent focus:text-accent-foreground"
      triggerButton={<Text class="px-1 text-muted-foreground">⌄</Text>}
      renderItem={(item) => (
        <View class="flex-row justify-between">
          <Text>{item.title}</Text>
          <Text class="opacity-0 group-selected:opacity-100">✓</Text>
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
press outside, the trigger button, Tab or Shift+Tab from the open list, `reason: "focus"`), with the value as the user
left it. Cmd+Return on a Mac (Ctrl+Return elsewhere) closes
the list and confirms.

`cleanable` adds a clear button while an item is selected: a press empties the value (`onChange({ value: [] })`).
The button comes after the input, before the trigger button; a press on it never opens the list. The app fills it, as
a [select's clear button](./select.md#value).

## Input

The trigger is a text input in the combobox's row (its `class` and `style`: the field's border and fill), with the
app's `prefix` before it (the chosen items as chips, an icon) and, after it, the clear button, the app's
`triggerButton` (a chevron) and `suffix`.

- Typing opens the list and filters the items by title, ignoring case; `empty` shows while nothing matches. Down and
  Up open it too, and a press on the input or the trigger button opens and closes it; on touch screens the tap that
  focuses the input opens it.
- With one value, the input shows the chosen item's title (`placeholder` while there is none). It is selected when
  the input gets the focus, so what is typed replaces it.
- With `multiple`, the input shows the query; the app shows the chosen items, in `prefix` or beside the combobox.

The query is the combobox's own, starting each opening from `defaultQuery` (else empty), or the app's with `query`:
`onQueryChange({ query })` reports what is typed, and the app sets `query` to follow it, to filter its own way or to
suggest a starting point.

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
| `placeholder` | `.placeholder(..)` | `string` | none | The input's placeholder, while it is empty. |
| `query` | `.query(..)` | `string` | none | The query, owned by the app. |
| `defaultQuery` | `.default_query(..)` | `string` | none | The query each opening starts with, without `query`. |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | A clear button while an item is selected; a press empties the value. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It stays closed and takes no presses or keyboard focus. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What the choice is about, for screen readers. |
| `placement`, `align`, `offset`, `margin` | `.placement(..)`, ... | as `Select`'s | `"bottom"`, `"start"`, 0, 0 | Desktops: where the popup goes against the field. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (touch screens). |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The backdrop behind the sheet. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The list, the scroll view of the rows. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each item's row: `focus:` while highlighted, `selected:` while selected, `disabled:` while it cannot be. |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each section's header. |
| `inputClass`, `inputStyle` | `.input_class(..)`, `.input_style(..)` | `string`, `StyleProp<InputStyle>` | none | The input: `focus:` while it edits, `disabled:` with the combobox. |
| `footerClass`, `footerStyle` | `.footer_class(..)`, `.footer_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The footer, below the rows. |
| `clearButtonClass`, `clearButtonStyle` | `.clear_button_class(..)`, `.clear_button_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The clear button (`cleanable`). |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | none | The content of the clear button. |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | none | What screen readers call the clear button. |
| `triggerButton` | `.trigger_button(..)` | `JSX.Element` | none | A button after the input (a chevron): a press opens and closes the list. |
| `prefix` | `.prefix(..)` | `JSX.Element` | none | Content before the input: chips, an icon. |
| `suffix` | `.suffix(..)` | `JSX.Element` | none | Content after the trigger button. |
| `empty` | `.empty(..)` | `JSX.Element` | none | What the list shows while no item does. |
| `footer` | `.footer(..)` | `JSX.Element` | none | What shows below the rows. |
| `renderItem` | `.render_item(..)` | `(item: SelectEntry) => JSX.Element` | none | An item's row, drawn by the app from what the item is, never its state: the content follows the row's `group-focus:`, `group-selected:` and `group-disabled:` (`group` in `itemClass`), so a move of the highlight or a toggle draws nothing again; the item's title otherwise. |
| `renderGroup` | `.render_group(..)` | `(group: SelectGroup) => JSX.Element` | none | A section's header, drawn by the app; its title otherwise. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The field: the row of the prefix, the input, the buttons and the suffix; the list is as wide as it. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The value changed (a choice, a toggle, the clear button): `{ value }`, the selected items' values. Set `value` to follow it. |
| `onConfirm` | `.on_confirm(\|value\| ..)` | The list closed: `{ value }` as it is then, once per opening. |
| `onQueryChange` | `.on_query_change(\|query\| ..)` | The user typed in the input: `{ query }`. Set `query` to follow it. |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | The list opened or closed, with why (`{ open, reason }`). Set `open` to follow it. |
| `onOpen`, `onClose` | `.on_open(..)`, `.on_close(..)` | The list is shown, or gone. |
| `onCancel` | `.on_cancel(..)` | The user closed the list without a choice that closes it (Escape or back, a press outside or on the backdrop). |

They come in this order: `onChange` for a choice, or `onCancel` for a close without one, then `onOpenChange`, then
`onConfirm` as the list closes, then `onOpen` or `onClose` once the list is shown or gone.

## Parts

| Part | Where | Styled with |
|---|---|---|
| The field | the combobox's view, a row | `class`, `style` |
| The prefix | the field, first | the app's own element (`prefix`) |
| The input | the field, after the prefix | `inputClass`, `inputStyle`, `placeholder` |
| The clear button | the field, after the input (`cleanable`, while an item is selected) | `clearButtonClass`, `clearButtonStyle`; its content `clearButton` |
| The trigger button | the field, after the clear button | the app's own element (`triggerButton`) |
| The suffix | the field, last | the app's own element (`suffix`) |
| The popup or sheet | over everything, under the field (desktops) or at the bottom (touch screens) | `popupClass`, `popupStyle` |
| The backdrop | behind the sheet (touch screens) | `backdropClass`, `backdropStyle` |
| The list | the popup | `listClass`, `listStyle` |
| A section's header | the list, before its items | `groupClass`, `groupStyle`, `renderGroup` |
| An item's row | the list | `itemClass`, `itemStyle`, `renderItem` (`group-focus:`, `group-selected:`, `group-disabled:` inside, under `group` in `itemClass`) |
| The empty state | the popup, while no item shows | its own element (`empty`) |
| The footer | the popup, last | `footerClass`, `footerStyle`; its content `footer` |

## Keyboard

The keys are a select's (see [Keyboard](./select.md#keyboard)) while the input keeps the focus, with these
differences: letters and digits are typed into the input, which filters the list, rather than typeahead; Down and Up
open the closed list; Return toggles the highlighted item with `multiple` and keeps the list open; Cmd+Return on a
Mac (Ctrl+Return elsewhere) closes it and confirms. Tab and Shift+Tab close the open list and move the focus to the
next or previous control. When the list closes otherwise on the desktops, the input keeps the focus.

## Accessibility

- The input is a combobox for screen readers: its label is `accessibilityLabel`, its value the selected items'
  titles, joined with commas, and it says whether the list is expanded. `disabled` dims it.
- The list is a listbox and each row an option, named by its title; the selected options are selected and a disabled
  one dimmed. Sections' headers are headers.
- The clear button is a button named by `clearButtonAccessibilityLabel`; it is no stop of Tab. The trigger button
  is hidden from screen readers, as the input says whether the list is open, and is no stop of Tab either.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
