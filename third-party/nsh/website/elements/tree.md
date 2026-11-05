---
title: Tree
description: "Tree: items that hold items, expanded and collapsed, one of them selected: a project's files, a settings sidebar, an outline. Virtualized, one stop of the keyboard focus, a tree for screen readers. The look of every row is the app's."
group: base
demo: el-tree
---

# Tree

A tree shows items that hold items: a project's files and folders, the sections of a settings sidebar, a document's
outline. `Tree` owns the behavior of one: which items are expanded, which one is selected, the keyboard and what
screen readers hear. Its rows are virtualized: only the rows in view are made, and the children of a collapsed item are
never made at all, so a tree of thousands of items opens and scrolls at once. The look is the app's: the tree draws
nothing of its own, the app styles each row (`itemClass`) and draws its content (`renderItem`: an icon, the label
indented by the item's depth, a chevron, a badge).

```rust tabs
use nsh_base::{TreeEntry, TreeItem, theme, tree};
use nsh_core::prelude::*;

fn files() -> impl IntoElement {
    let items = vec![
        TreeItem::new("src", "src")
            .child(TreeItem::new("src/main.rs", "main.rs"))
            .child(TreeItem::new("src/ui", "ui").child(TreeItem::new("src/ui/tree.rs", "tree.rs"))),
        TreeItem::new("Cargo.toml", "Cargo.toml"),
    ];
    let selected = signal(None::<SharedString>);
    tree()
        .items(items)
        .default_expanded(vec!["src".into()])
        .selected(move || selected.get())
        .on_selected_change(move |id: &SharedString| selected.set(Some(id.clone())))
        .accessibility_label("Files")
        .h(px(320.0))
        .list_class("p-1")
        .item_class(
            "group rounded-md hover:bg-accent selected:bg-primary/10 \
             focus:outline-2 focus:-outline-offset-2 focus:outline-ring disabled:opacity-50",
        )
        .render_item(|entry: &TreeEntry| {
            view()
                .flex_row()
                .gap_2()
                .h_8()
                .items_center()
                .rounded_md()
                .pl(px(8.0 + 16.0 * entry.depth as f32))
                .child(text(if entry.folder { "▸" } else { " " }).text_color(move || theme().muted_foreground))
                .child(text(entry.label.clone()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Tree, type TreeItem } from "nsh/base";

const files: TreeItem[] = [
  {
    id: "src",
    label: "src",
    children: [
      { id: "src/main.rs", label: "main.rs" },
      { id: "src/ui", label: "ui", children: [{ id: "src/ui/tree.rs", label: "tree.rs" }] },
    ],
  },
  { id: "Cargo.toml", label: "Cargo.toml" },
];

function App() {
  const expanded = signal(["src"]);
  const selected = signal<string | null>(null);
  return (
    <Tree
      items={files}
      expanded={expanded()}
      selected={selected()}
      onExpandedChange={({ expanded: next }) => expanded.set(next)}
      onSelectedChange={({ selected: next }) => selected.set(next)}
      accessibilityLabel="Files"
      class="h-80 w-64 rounded-lg border border-border"
      listClass="p-1"
      itemClass="group h-8 rounded-md hover:bg-accent selected:bg-primary/10 focus:outline-2 focus:-outline-offset-2 focus:outline-ring disabled:opacity-50"
      renderItem={(entry) => (
        <View class="h-8 flex-row items-center gap-2" style={{ paddingLeft: 8 + entry.depth * 16 }}>
          <Text class="w-3 text-muted-foreground transition-transform group-aria-expanded:rotate-90">
            {entry.folder ? "›" : ""}
          </Text>
          <Text class="text-sm text-foreground">{entry.label}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Tree` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The expanded items and the
selected one are the app's when it sets `expanded` and `selected`, which it updates in `onExpandedChange` and
`onSelectedChange`; without them the tree keeps its own state, starting from `defaultExpanded` and `defaultSelected`.
Items are identified by their `id`, the app's own (a path, a record's key), never by their label. In Rust, `tree()`
makes it, with a setter per prop (`.items(..)`, `.expanded(..)`, `.render_item(..)`), a listener method per event and
the typed style methods.

## Items

`items` is the items at the top, each a `TreeItem`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | What identifies it in `expanded`, `selected` and the events: unique in the tree (an id given twice is logged, and only its first item expands or is selected). |
| `label` | `string` | What its row shows unless `renderItem` draws it, what screen readers say and what typeahead matches. |
| `children` | `TreeItem[]` | The items under it, in order. With any, it is a folder: it expands and collapses. |
| `disabled` | `boolean` | The user cannot select, expand or collapse it: presses and keys pass it by, `disabled:` styles apply. Its children stay as `expanded` says. |

`renderItem` gets a `TreeEntry` for each row in view: the item's `id`, `label` and `disabled`, its `depth` (0 at the
top, 1 under a top item, …) and whether it is a `folder`. It is what the item is, and the row's states are its
classes: the drawing is made once per item and keeps its views while the row is selected, expanded or collapsed, so a
chevron turns with a transition.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `items` | `.items(..)` | `TreeItem[]` | `[]` | The items at the top, each with the items under it. |
| `expanded` | `.expanded(..)` | `string[]` | none | The ids of the expanded items (controlled). An item shows while every item above it is expanded. |
| `defaultExpanded` | `.default_expanded(..)` | `string[]` | `[]` | The expanded items at first, while `expanded` is not set. |
| `selected` | `.selected(..)` | `string \| null` | none | The selected item's id (controlled), `null` for none. |
| `defaultSelected` | `.default_selected(..)` | `string` | none | The selected item at first, while `selected` is not set. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | A read-only tree: no presses or keys, no stop of the keyboard focus, `disabled:` on every row; it shows what `expanded` and `selected` say. |
| `reveal` | `.reveal(..)` | `boolean` | `false` | Expanding and collapsing move the rows after the item to their new places with a spring, run natively. Off with reduced motion. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the tree ("Files"). |
| `renderItem` | `.render_item(..)` | `(entry: TreeEntry) => JSX.Element` | none | A row's content, for the rows in view; without it a row shows the item's label. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each row: its height, padding, surface and states (below); its text styles reach the label. |
| `listClass`, `listStyle` | `.list_class(..)`, `.list_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The scroll view of the rows inside the tree: its padding and gaps. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The tree itself. Give it a height (or `flex-1` in a parent that has one): the rows scroll inside it, and only those in view are made. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onExpandedChange` | `.on_expanded_change(..)` | `{ expanded: string[] }` | The user expanded or collapsed an item (a press, Return, Space, Right or Left, `revealItem`): the expanded ids as they would be. |
| `onSelectedChange` | `.on_selected_change(..)` | `{ selected: string }` | The user selected another item (a press, the arrow keys, Home, End, typeahead). |
| `onExpand` | `.on_expand(..)` | `{ id: string }` | The user expanded the item of `id`, after `onExpandedChange`. |
| `onCollapse` | `.on_collapse(..)` | `{ id: string }` | The user collapsed the item of `id`, after `onExpandedChange`. |
| `onAction` | `.on_action(..)` | `{ id: string }` | The user acted on the item of `id`: Return on the selected item when it has no children, or a double click or double tap on any item, after the press's own events. Disabled items and a disabled tree never report it. |

The selection follows the arrow keys, so a file explorer opens a file in `onAction`, not in `onSelectedChange`:
moving through the files previews them one by one, Return or a double click opens the one the user wants.

```tsx
<Tree
  items={files}
  onSelectedChange={({ selected }) => preview.set(selected)}
  onAction={({ id }) => openFile(id)}
/>
```

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The tree | | `class`, `style` | |
| The list | the tree | `listClass`, `listStyle` | |
| A row | the list | `itemClass`, `itemStyle` | `selected:`, `aria-expanded:` (a folder that is open), `focus:` (while the tree has the keyboard focus, the row the keys act on: the selected row, the collapsed item a hidden selection is under, or the first row while nothing is selected), `disabled:`, `hover:`, `active:` |
| A row's content | a row | `renderItem` | `group-selected:`, `group-aria-expanded:`, `group-focus:`, `group-disabled:` under `group` in `itemClass` |

Show the selected row with `selected:` and the keyboard's place with `focus:` (see
[Design guides](../docs/design-guides.md#interaction-states)). Draw the focus inside the row
(`focus:outline-2 focus:-outline-offset-2`): the list clips what reaches past its sides.

## Ref

| Method | Description |
|---|---|
| `focus()` | Takes the keyboard focus, as Tab reaching the tree does. |
| `revealItem(id)` | Expands the items above the item of `id` (reported with `onExpandedChange` and `onExpand`, the outermost first) and scrolls its row into view once it shows: when the app follows the change, at once; when it does not, the request ends there. |

```tsx
let files: TreeRef | undefined;

<Tree ref={(r) => (files = r)} items={items} />;
files?.revealItem("src/ui/tree.rs");
```

## Disabled

A disabled item takes no presses, the arrow keys pass it by, and screen readers announce it as dimmed. `disabled` on
the tree makes it read-only: it shows what the app's state says and takes no input.

```tsx
<Tree items={items} disabled={locked()} itemClass="h-8 px-2 disabled:opacity-50" />
```

## Accessibility

- The tree has the role `"tree"`, named by `accessibilityLabel`; each row is a `"treeitem"` named by its item's label,
  with its level (its depth + 1), whether it is expanded (folders), selected and disabled.
- As the tree takes the keyboard focus and as the keys move the selection, the row the keys act on takes the screen
  reader's focus.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

On the desktops and the web, where Tab reaches the views that take presses, a `Tree` follows the
[WAI-ARIA tree view pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/):

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Enters the tree in one step, and leaves it in one step; coming back, the keys go on from the selected row. With nothing selected, the focus shows on the first row, which Down selects. |
| Down, Up | Selects the next or the previous row, past disabled items, from the last to the first and back. |
| Right | Expands a collapsed folder; on an expanded one, selects its first enabled child. |
| Left | Collapses an expanded folder; on anything else, selects its parent. |
| Home, End | Selects the first or the last row. |
| Return | Expands or collapses the selected folder; on an item without children, acts on it (`onAction`). |
| Space | Expands or collapses the selected folder. |
| Letters, digits | Selects the next row whose label starts with what was typed. |

While the selection is hidden under a collapsed item (the app collapsed it), the keys act on that item's row: Right
or Return expands it, Down selects the row after it.

In a right-to-left layout the rows run from the right, so Left and Right trade places, as the pattern says: Left
expands a folder and enters it, Right collapses it and selects the parent. Up, Down, Home and End keep theirs.

## Platform notes

- iOS, Android and Mac Catalyst: a tap selects a row and expands or collapses a folder; a double tap acts on the item
  (`onAction`).
- Desktops (macOS, Windows, Linux, GPUI) and the web: a click does the same and gives the tree the keyboard focus, and
  the keys above move in it; a double click acts on the item.
- Every platform draws what the app styles: the tree, its rows and their content.
