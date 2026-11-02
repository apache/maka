---
title: Select
description: "The Select component: one value chosen from a list of items, a popup at its trigger on desktops and a sheet on phones, with the keyboard, typeahead, search and sections, styled by the app."
group: base
demo: el-select
---

# Select

A select chooses one value from a list of items: a setting, a filter, a country, a time zone. The app's trigger
opens the list, presented as each device expects:

- On the desktops and in desktop browsers, a popup at the trigger, at least as wide as the trigger and as tall as its
  rows up to the room beside it; the keyboard moves through the items and chooses one.
- On phones and tablets, a sheet at the bottom of the screen over a backdrop.

The select owns the behavior: the value (the app's, or its own), the open state, the keyboard, typeahead, search,
sections, the highlighted row and what screen readers hear. The look is the app's: it styles the trigger, the popup,
the list, the rows, the sections' headers and the search field, or draws the rows itself.

```rust tabs
use nsh_base::{SelectItem, SelectItemState, select, theme};
use nsh_core::prelude::*;

const FRUITS: [(&str, &str); 5] = [
    ("apple", "Apple"),
    ("banana", "Banana"),
    ("blueberry", "Blueberry"),
    ("grapes", "Grapes"),
    ("pineapple", "Pineapple"),
];

fn fruit_select() -> impl IntoElement {
    let fruit = signal(None::<SharedString>);
    let title = move || {
        let chosen = fruit.get();
        FRUITS
            .iter()
            .find(|(value, _)| Some(*value) == chosen.as_deref())
            .map_or("Pick a fruit", |(_, title)| *title)
            .to_string()
    };
    select()
        .items(
            FRUITS
                .iter()
                .map(|&(value, title)| SelectItem::new(value, title).disabled(value == "grapes"))
                .collect::<Vec<_>>(),
        )
        .value(move || fruit.get())
        .on_change(move |next: &Option<SharedString>| fruit.set(next.clone()))
        .accessibility_label("Fruit")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .text_color(move || theme().popover_foreground)
                .shadow_md()
        })
        .item_style(|s| s.rounded_md().overflow_hidden())
        .trigger(
            view()
                .h_9()
                .w_48()
                .flex_row()
                .items_center()
                .justify_between()
                .px_3()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .hover(|s| s.bg(move || theme().accent))
                .child(text(title))
                .child(text("▾").text_color(move || theme().muted_foreground)),
        )
        .render_item(|item: &SelectItemState| {
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .px_2()
                .py_1p5()
                .when(item.highlighted, |v| v.bg(move || theme().accent))
                .when(item.disabled, |v| v.opacity(0.5))
                .child(text(item.title.clone()).text_sm())
                .when(item.selected, |v| v.child(text("✓").text_sm()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Select } from "nsh/base";

const FRUITS = [
  { value: "apple", title: "Apple" },
  { value: "banana", title: "Banana" },
  { value: "blueberry", title: "Blueberry" },
  { value: "grapes", title: "Grapes", disabled: true },
  { value: "pineapple", title: "Pineapple" },
];

function App() {
  const fruit = signal<string | null>(null);
  const title = () => FRUITS.find((f) => f.value === fruit())?.title;
  return (
    <Select
      items={FRUITS}
      value={fruit()}
      onChange={({ value }) => fruit.set(value)}
      accessibilityLabel="Fruit"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      itemClass="rounded-md px-2 py-1.5 text-sm focus:bg-accent focus:text-accent-foreground disabled:opacity-50"
      trigger={
        <View class="h-9 w-48 flex-row items-center justify-between rounded-md border border-input px-3 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text class={fruit() ? "text-foreground" : "text-muted-foreground"}>{title() ?? "Pick a fruit"}</Text>
          <Text class="text-muted-foreground">▾</Text>
        </View>
      }
    />
  );
}

mount(App);
```

`Select` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `select()` makes one
with a setter per prop (`.items(..)`, `.value(..)`, `.item_style(..)`) and a listener per event (`.on_change(..)`);
`SelectItem::new(value, title)` makes an item, with `.disabled(..)` and `.group(..)`.

## Items

`items` is the list as data: each item has a `value` (unique among the items: what choosing it sets), a `title` (what
its row shows, what search and typeahead match and what screen readers say), and optionally `disabled` and a `group`.
Adjacent items of one `group` form a section under a header with that title:

```tsx
<Select
  items={[
    { value: "lisbon", title: "Lisbon", group: "Europe" },
    { value: "london", title: "London", group: "Europe" },
    { value: "tokyo", title: "Tokyo", group: "Asia" },
    { value: "seoul", title: "Seoul", group: "Asia", disabled: true },
  ]}
  groupClass="px-2 pb-1 pt-2 text-xs text-muted-foreground"
  trigger={trigger}
/>
```

The rows are a virtualized list in the popup's scroll view: a list of thousands of items makes only the rows in view,
and the popup scrolls when its rows are taller than the room it has.

## Value

With `value`, the app owns the chosen item: the select shows the item of that value and reports a choice with
`onChange({ value })`; the app sets `value` to follow it, or keeps its own. `value={null}` is nothing chosen. Left out, the
select keeps its own value, from `defaultValue` at first. `onChange` reports changes: choosing the chosen item again
closes the list.

`cleanable` adds a clear button while an item is chosen: a press clears the value, reported as `onChange({ value: null })`, and
the list stays closed. The button comes after the trigger in the select's view, not inside it, so a press on it never
opens the list; the app places it (over the trigger's end with `absolute`, where a chevron would be) and fills it:

```tsx
<Select
  items={fonts}
  value={font()}
  onChange={({ value }) => font.set(value)}
  cleanable
  clearButtonAccessibilityLabel="Clear the font"
  clearButtonClass="absolute right-2 top-2 size-5 items-center justify-center rounded-full hover:bg-accent"
  clearButton={<Text class="text-xs text-muted-foreground">✕</Text>}
  trigger={trigger}
/>
```

The trigger is the app's element, so it shows whatever the app wants for the chosen item: its title, an icon, a
placeholder while nothing is chosen. In TSX it is the element you pass: it is the combobox and takes the presses, the
keyboard focus, the expanded state and `disabled` itself, so its own `active:`, `focus:` and `disabled:` classes
follow the select, its own `onPress` runs too, and the list is placed against it and is at least as wide.

## Open state

Without `open`, the select keeps its own open state (from `defaultOpen`). With `open`, the app owns it and changes it
in `onOpenChange({ open, reason })`: `"triggerPress"` (a press of the trigger, or one of its keys), `"select"` (a choice),
`"pressOutside"`, `"backdropPress"` or `"cancel"` (Escape or back). `onOpen` and `onClose` tell when the list is
shown and gone (a sheet once it came in and once it went), `onCancel` that the user closed it without choosing.

## Search

`searchable` puts a search field above the items: typing filters them by title, ignoring case, and a section with no
match goes with its header. The highlight moves to the first match, the keys keep moving it while the field has the
keyboard, and Return chooses it. `empty` is what the list shows while nothing matches:

```tsx
<Select
  items={zones}
  searchable
  searchPlaceholder="Search time zones"
  searchClass="mx-1 mb-1 rounded-md border border-input px-2 py-1.5 text-sm"
  empty={<Text class="px-2 py-6 text-center text-sm text-muted-foreground">No time zone found</Text>}
  trigger={trigger}
/>
```

On the desktops the search field takes the keyboard as the list opens; on touch screens the keyboard comes up when
the field is pressed. Each opening starts with an empty search.

## Rows the app draws

`itemClass` styles each item's row, which shows the item's title until `renderItem` draws it: `focus:` applies to the highlighted row (where the
keys or the pointer are), `selected:` to the chosen one and `disabled:` to a disabled one. To draw a row, give
`renderItem`: it gets the item and its state ([`SelectItemState`](#types)) and returns the row's content, for the rows
in view. `renderGroup` draws a section's header the same way:

```tsx
<Select
  items={fonts}
  itemClass="rounded-md focus:bg-accent"
  renderItem={(item) => (
    <View class="flex-row items-center gap-2 px-2 py-1.5">
      <Text class="flex-1 text-sm" style={{ fontFamily: item.value }}>{item.title}</Text>
      <Text class="w-4 text-right text-sm">{item.selected ? "✓" : ""}</Text>
    </View>
  )}
  renderGroup={(group) => <Text class="px-2 pt-2 text-xs font-medium text-muted-foreground">{group.title}</Text>}
  trigger={trigger}
/>
```

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `SelectItem[]` | `[]` | The items, in order. |
| `value` | `.value(..)` | `string \| null` | none | The chosen item's `value`, owned by the app; `null` for none. Left out, the select keeps its own. |
| `defaultValue` | `.default_value(..)` | `string` | none | The value at first, without `value`. |
| `open` | `.open(..)` | `boolean` | none | Open, owned by the app. |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | Open at first, without `open`. |
| `searchable` | `.searchable(..)` | `boolean` | `false` | A search field above the items filters them by title. |
| `searchPlaceholder` | `.search_placeholder(..)` | `string` | none | The search field's placeholder. |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | A clear button while an item is chosen; a press clears the value (`onChange({ value: null })`). |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It stays closed: the trigger takes no presses and no keyboard focus, and `disabled:` styles apply to it. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call it: what the choice is about. |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | Desktops: the side of the trigger the list goes on, the other side when only that one has room. |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | Desktops: how it lines up with the trigger. |
| `offset` | `.offset(..)` | `number` | `0` | Desktops: the gap between the trigger and the list. |
| `margin` | `.margin(..)` | `number` | `0` | Desktops: the distance it keeps from the edges of the safe area. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (touch screens) the list is in. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Touch screens: the backdrop behind the sheet. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The list, the scroll view of the rows. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each item's row, its text styles inherited by its title: `focus:` while highlighted, `selected:` while chosen, `disabled:` while it cannot be. |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each section's header. |
| `searchClass`, `searchStyle` | `.search_class(..)`, `.search_style(..)` | `string`, `StyleProp<InputStyle>` | none | The search field: its box and its text (`color`, `fontSize`, `placeholderColor`). |
| `clearButtonClass`, `clearButtonStyle` | `.clear_button_class(..)`, `.clear_button_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The clear button (`cleanable`); `disabled:` with the select. |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | none | The content of the clear button: a cross, an icon. |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | none | What screen readers call the clear button. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens the list when pressed; the list is placed against it. |
| `empty` | `.empty(..)` | `JSX.Element` | none | What the list shows while no item does (a search with no match). |
| `renderItem` | `.render_item(..)` | `(item: SelectItemState) => JSX.Element` | none | An item's row, drawn by the app; the item's title otherwise. |
| `renderGroup` | `.render_group(..)` | `(group: SelectGroup) => JSX.Element` | none | A section's header, drawn by the app; its title otherwise. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The view around the trigger. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The user chose another item (a press, Return or Space, typeahead on the trigger): its `value`; `null` when the clear button cleared it. Set `value` to follow it. |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | The list opened or closed, with why. Set `open` to follow it. |
| `onOpen` | `.on_open(\|\| ..)` | The list is shown; as a sheet, once it came in. |
| `onClose` | `.on_close(\|\| ..)` | The list is gone; as a sheet, once it went. Also when the app closed it. |
| `onCancel` | `.on_cancel(\|\| ..)` | The user closed the list without choosing (Escape or back, a press outside or on the backdrop). |

They come in this order: `onChange` for a choice, or `onCancel` for a close without one, then `onOpenChange`, then
`onOpen` or `onClose` once the list is shown or gone.

<a id="types"></a>

## Types

| Type | Members | Description |
|---|---|---|
| `SelectItem` | `value: string`, `title: string`, `disabled?: boolean`, `group?: string` | An item of `items`. |
| `SelectItemState` | `value`, `title`, `disabled`, `group?` (the item's), `selected: boolean`, `highlighted: boolean`, `index: number` | What `renderItem` gets: the item, whether it is the chosen one, whether the keys or the pointer are on it (Return or a press chooses it), and its index among the `items`. |
| `SelectGroup` | `title: string` | What `renderGroup` gets: the section's `group`. |

In Rust they are `nsh_base::SelectItem`, `SelectItemState` and `SelectGroup`; `value` is a `SelectValue`
(`Controlled(Some(..))` for a value, `Controlled(None)` for `null`), which `.value(..)` makes from an
`Option<SharedString>` or a string.

## Parts

| Part | Where | Styled with |
|---|---|---|
| The trigger | the select's view | the app's own element (`trigger`) |
| The clear button | the select's view, after the trigger (`cleanable`, while an item is chosen) | `clearButtonClass`, `clearButtonStyle`; its content `clearButton` |
| The popup or sheet | over everything, at the trigger (desktops) or at the bottom (touch screens) | `popupClass`, `popupStyle` |
| The backdrop | behind the sheet (touch screens) | `backdropClass`, `backdropStyle` |
| The search field | the popup, first (`searchable`) | `searchClass`, `searchStyle`, `searchPlaceholder` |
| The list | the popup, after the search field | `listClass`, `listStyle` |
| A section's header | the list, before its items | `groupClass`, `groupStyle`, `renderGroup` |
| An item's row | the list | `itemClass`, `itemStyle`, `renderItem` |
| The empty state | the popup, while no item shows | its own element (`empty`) |

The popup is a column: its height follows the search field and the rows, so a `max-h-*` on `popupClass` caps it and
the list scrolls within it.

## Keyboard

On the desktops, Tab reaches the trigger of a select that is not `disabled`. With the list closed, Down, Up, Return
and Space open it on the chosen item (with none chosen, Up on the last enabled item and the others on the first), and
letters and digits choose the item whose title starts with what was typed, as a native select does. With the list
open:

| Key | Action |
|---|---|
| Down, Up | The next or previous enabled item, around the ends. |
| Home, End | The first or last enabled item (the search field's own while it has the keyboard). |
| Page Down, Page Up | A page of rows on, or back. |
| Return | Chooses the highlighted item and closes the list. |
| Space | Chooses the highlighted item (without a search field). |
| Letters, digits | The next item whose title starts with what was typed in the last second (without a search field). |
| Escape | Closes the list without choosing. |

Once the list closes, the keyboard focus returns to the trigger, unless a press outside took it elsewhere. The
pointer highlights the row it moves over; the highlighted row is revealed as the keys move to it.

## On each device

| | Desktops and desktop browsers | Phones and tablets |
| --- | --- | --- |
| The list | a popup at the trigger (`placement`, `align`, `offset`, `margin`), at least as wide as the trigger, as tall as its rows up to the room beside it | a sheet at the bottom over a backdrop, as tall as its rows up to the status bar |
| Closing it | a choice, Escape, a press outside (which goes on to what is under the pointer) | a choice, the backdrop, the Android back button |
| Search | the field takes the keyboard as the list opens | the keyboard comes up when the field is pressed |
| A choice | the press going down chooses, so the search field keeps the keyboard | a tap |

`popupClass` styles the popup on desktops and the sheet on phones; a style that differs between them can compare
`platform.idiom` (`nsh/device`) with `"desktop"`.

## Accessibility

- The trigger is a combobox for screen readers: its label is `accessibilityLabel`, its value the chosen item's title,
  and it says whether the list is expanded. `disabled` dims it.
- The clear button is a button named by `clearButtonAccessibilityLabel`; it is no stop of Tab.
- The list is a listbox and each row an option, named by its title; the chosen option is selected and a disabled one
  dimmed. Sections' headers are headers.
- As the keys move the highlight, the screen reader's focus moves to the highlighted row; while the search field has
  the keyboard, the highlighted item's title is announced instead, so typing goes on.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
