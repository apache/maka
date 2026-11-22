---
title: Command
description: "Command: a command palette, a search field over the app's commands filtered as the user types: a Cmd+K palette in a dialog, an inline command menu, a search the app answers. Virtualized, keyboard first, a list box for screen readers. The look of every part is the app's."
group: base
demo: el-command
---

# Command

A command palette is a search field over a list of commands: the user types a few letters, the list narrows to the
commands that match, the arrow keys move the highlight and Return runs the highlighted command. `Command` owns the
behavior of one: filtering, sections, the highlight, the keyboard and what screen readers hear. Filtering runs
natively and the rows are virtualized: only the rows in view are made, so a palette of thousands of commands, files or
emoji filters at every keystroke. The look is the app's: the command draws nothing of its own, the app styles each part
(`itemClass`, `groupClass`, `searchClass`, ...) and draws the rows' content (`renderItem`: an icon, the label, the
shortcut's keys).

```rust tabs
use nsh_base::{CommandEntry, CommandItem, command, theme};
use nsh_core::prelude::*;

fn palette() -> impl IntoElement {
    let items = vec![
        CommandItem::new("new", "New File").group("File").shortcut("mod+n"),
        CommandItem::new("open", "Open…").group("File").shortcut("mod+o"),
        CommandItem::new("theme", "Toggle Theme").group("View").keywords(["dark", "light"]),
        CommandItem::new("settings", "Settings").group("View").shortcut("mod+,"),
    ];
    let chosen = signal(SharedString::from("none"));
    command()
        .items(items)
        .placeholder("Type a command or search…")
        .accessibility_label("Commands")
        .auto_focus(true)
        .on_select(move |id: &SharedString| chosen.set(id.clone()))
        .empty(text("No results.").text_color(move || theme().muted_foreground))
        .h(px(360.0))
        .render_item(|entry: &CommandEntry| {
            view()
                .flex_row()
                .items_center()
                .h_8()
                .px_2()
                .child(text(entry.label.clone()).flex_1())
                .child(
                    text(entry.shortcut_label.clone().unwrap_or_default())
                        .text_color(move || theme().muted_foreground),
                )
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";

const commands: CommandItem[] = [
  { id: "new", label: "New File", group: "File", shortcut: "mod+n" },
  { id: "open", label: "Open…", group: "File", shortcut: "mod+o" },
  { id: "theme", label: "Toggle Theme", group: "View", keywords: ["dark", "light"] },
  { id: "settings", label: "Settings", group: "View", shortcut: "mod+," },
];

function App() {
  const chosen = signal("none");
  return (
    <Command
      items={commands}
      placeholder="Type a command or search…"
      accessibilityLabel="Commands"
      searchAccessibilityLabel="Search commands"
      autoFocus
      onSelect={({ id }) => chosen.set(id)}
      class="w-96 overflow-hidden rounded-lg border border-border bg-popover"
      searchBarClass="flex-row items-center gap-2 border-b border-border px-3"
      searchClass="h-11 flex-1 text-sm text-foreground placeholder:text-muted-foreground"
      listClass="max-h-80 p-1"
      groupClass="px-2 py-1.5 text-xs font-medium text-muted-foreground"
      separatorClass="-mx-1 my-1 h-px bg-border"
      itemClass="group h-8 flex-row items-center rounded-md px-2 focus:bg-accent disabled:opacity-50"
      empty={<Text class="py-6 text-center text-sm text-muted-foreground">No results.</Text>}
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center gap-2">
          <Text class="flex-1 text-sm text-foreground group-focus:text-accent-foreground">{entry.label}</Text>
          <Text class="text-xs text-muted-foreground">{entry.shortcutLabel ?? ""}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Command` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The query is the app's when it
sets `query`, which it updates in `onQueryChange`; without it the search field keeps its own, starting from
`defaultQuery`. Items are identified by their `id`, the app's own, never by their label: `onSelect({ id })` says which
one the user chose. In Rust, `command()` makes it, with a setter per prop (`.items(..)`, `.query(..)`,
`.render_item(..)`), a listener method per event and the typed style methods.

## Items

`items` is the commands, in order, each a `CommandItem`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | What identifies it in `onSelect` and `onHighlightChange`: unique among the items. |
| `label` | `string` | What its row shows unless `renderItem` draws it, what screen readers say and what the query matches. |
| `keywords` | `string[]` | More words the query matches: synonyms, an English name beside a translated label. |
| `group` | `string` | Its section: adjacent items of one group show under a header with this heading. |
| `shortcut` | `string` | The keystroke of the same command, as [`keymap`](../modules/nsh.md#keymap) names it (`"mod+shift+p"`), for its row to show. The app binds it with `keymap.bind`. |
| `disabled` | `boolean` | It cannot be chosen: the keys pass over it, presses do nothing, `disabled:` styles apply. |
| `checked` | `boolean` | It is the one in effect (a theme, a language): `checked:` styles apply and screen readers say it is checked. |

The query matches an item when its label or one of its keywords holds it, ignoring case and the spaces around it. The
items keep their order, and a section with no match goes with its header. `renderItem` gets a `CommandEntry` for each
row in view: the item's fields, and `shortcutLabel`, its `shortcut` as hints show it here (`⇧⌘P` on Apple's platforms,
`Ctrl+Shift+P` elsewhere). It is what the item is, and the highlight is the row's `focus:`: the drawing is made once per
item and keeps its views while the highlight moves.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `CommandItem[]` | `[]` | The commands, in order. |
| `query` | `.query(..)` | `string` | none | The query (controlled), which the app sets in `onQueryChange`. |
| `defaultQuery` | `.default_query(..)` | `string` | none | The query at first, while `query` is not set. |
| `searchable` | `.searchable(..)` | `boolean` | `true` | A search field above the rows. Without it every item shows, and the command is one stop of the keyboard focus with typeahead. |
| `filterable` | `.filterable(..)` | `boolean` | `true` | The query filters the items. Turned off, every item shows: for a search the app answers itself (a server's results set as `items`). A new query still highlights the first item. |
| `loading` | `.loading(..)` | `boolean` | `false` | A search is under way: `empty` waits, and the list is busy for screen readers. Show your indicator in `searchSuffix`. |
| `placeholder` | `.placeholder(..)` | `string` | none | The search field's placeholder. |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | The search field takes the keyboard focus once shown: a palette that opens to be typed in. |
| `separator` | `.separator(..)` | `boolean` | `true` | A separator row between two sections shown, styled by `separatorClass`; never first, last or doubled. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the list ("Commands"), and the search field while `searchAccessibilityLabel` is not set. |
| `searchAccessibilityLabel` | `.search_accessibility_label(..)` | `string` | `accessibilityLabel` | What screen readers call the search field: what it searches ("Search commands"). |
| `header`, `footer` | `.header(..)`, `.footer(..)` | `JSX.Element` | none | What shows above the search field (a title) and below the rows (the keys' hints, a count). |
| `empty` | `.empty(..)` | `JSX.Element` | none | What shows while no item does: a query that matches nothing, no items. |
| `searchPrefix`, `searchSuffix` | `.search_prefix(..)`, `.search_suffix(..)` | `JSX.Element` | none | What shows before and after the search field in its bar: a search icon, a spinner while `loading`. |
| `renderItem` | `.render_item(..)` | `(entry: CommandEntry) => JSX.Element` | none | A row's content, for the rows in view; without it a row shows the item's label. |
| `renderGroup` | `.render_group(..)` | `(group: CommandGroup) => JSX.Element` | none | A section's header (`{ heading }`); without it a header shows its heading. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The command itself: its size, frame and surface. |
| `searchBarClass`, `searchBarStyle` | `.search_bar_class(..)`, `.search_bar_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The row of `searchPrefix`, the search field and `searchSuffix`. |
| `searchClass`, `searchStyle` | `.search_class(..)`, `.search_style(..)` | `string`, `StyleProp<TextStyle>` | none | The search field. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The scroll view of the rows. Give it a height (`max-h-80`, or a sized command): the rows scroll inside it, and only those in view are made. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each item's row and its states (below); its text styles reach the label. |
| `groupClass`, `groupStyle` | `.group_class(..)`, `.group_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each section's header. |
| `separatorClass`, `separatorStyle` | `.separator_class(..)`, `.separator_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each separator: a rule's height and color. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onSelect` | `.on_select(..)` | `{ id: string }` | The user chose an item: Return, or a press on its row. |
| `onHighlightChange` | `.on_highlight_change(..)` | `{ highlighted: string \| null }` | The highlight moved (the keys, the pointer, a new query or new items, `highlight`): to preview what Return would run. |
| `onQueryChange` | `.on_query_change(..)` | `{ query: string }` | The user typed in the search field, or Escape cleared it. |
| `onCancel` | `.on_cancel(..)` | none | Escape with an empty query: close what holds the command (a dialog's `open`). |

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The command | | `class`, `style` | |
| `header` | the command | the app's element | |
| The search bar | the command | `searchBarClass`, `searchBarStyle` | |
| `searchPrefix`, the search field, `searchSuffix` | the search bar | the app's elements; `searchClass`, `searchStyle` | the field's `focus:` |
| The list | the command | `listClass`, `listStyle` | |
| A section's header | the list | `groupClass`, `groupStyle`, `renderGroup` | |
| A separator | the list | `separatorClass`, `separatorStyle` | |
| A row | the list | `itemClass`, `itemStyle` | `focus:` (highlighted), `checked:`, `disabled:`, `hover:`, `active:` |
| A row's content | a row | `renderItem` | `group-focus:`, `group-checked:`, `group-disabled:` under `group` in `itemClass` |
| `empty` | the command | the app's element | |
| `footer` | the command | the app's element | |

Show the highlighted row with `focus:` (see [Design guides](../docs/design-guides.md#interaction-states)).

## Ref

| Method | Description |
|---|---|
| `focus()` | Gives the search field the keyboard focus (without one, the command). |
| `highlight(id)` | Highlights the item of `id` and scrolls its row into view; an item not shown or disabled stays as it is. |
| `matchedCount()` | `Promise<number>`: how many items the query shows, disabled ones included. |

```tsx
let palette: CommandRef | undefined;

<Command ref={(r) => (palette = r)} items={items} />;
palette?.focus();
```

## A palette in a dialog

Put the command in a [`Dialog`](./dialog.md) and open it with the app's shortcut. Escape clears the query first; with
an empty query it is `onCancel`, where the app closes the dialog.

```tsx
import { keymap } from "nsh";

const open = signal(false);
keymap.bind("mod+k", () => open.set(!open()));

<Dialog open={open()} onOpenChange={({ open: next }) => open.set(next)}>
  <Command
    items={commands}
    autoFocus
    onCancel={() => open.set(false)}
    onSelect={({ id }) => {
      open.set(false);
      run(id);
    }}
  />
</Dialog>;
```

## A search the app answers

With `filterable={false}` every item the app gives shows: the app searches in `onQueryChange` (a server, a database)
and sets `items` with the results, `loading` while it waits.

```tsx
<Command
  items={results()}
  filterable={false}
  loading={searching()}
  onQueryChange={({ query }) => search(query)}
  searchSuffix={searching() ? <Spinner /> : undefined}
  empty={<Text>No matches</Text>}
/>
```

## Accessibility

- The list has the role `"listbox"`, named by `accessibilityLabel`; each row is an `"option"` named by its item's
  label, checked and disabled as its item is; a section's header is a `"header"`, a separator is hidden.
- The search field is a text field named by `searchAccessibilityLabel` (else `accessibilityLabel`); its placeholder is
  a hint shown while it is empty.
- The search field keeps the keyboard focus while the arrow keys move the highlight, and screen readers hear the
  highlighted label. Without a search field, the highlighted row takes the screen reader's focus.
- While `loading`, the list is busy.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

| Key | What it does |
|---|---|
| Typing | Filters the items; the first enabled match is highlighted. |
| Down, Up | Highlights the next or the previous item, past disabled ones, from the last to the first and back. |
| Page Down, Page Up | Moves the highlight by the rows in view. |
| Return | Chooses the highlighted item (`onSelect`). |
| Escape | Clears the query; with an empty query, reports `onCancel`. |
| Home, End | Without a search field: the first or the last item (in the field they move its caret). |
| Space, letters, digits | Without a search field: Space chooses, letters and digits highlight by typeahead. |

## Platform notes

- Desktops (macOS, Windows, Linux, GPUI) and the web: the pointer highlights the row it moves over, and a click chooses
  as the button goes down, so the search field keeps the keyboard focus.
- iOS, Android and Mac Catalyst: a tap chooses a row, and the keyboard's return key chooses the highlighted item and
  keeps the field for the next query.
- Every platform draws what the app styles: the command, its search bar, its rows and their content.
