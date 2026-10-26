---
title: DataTable
description: "The DataTable component: a table of rows and columns that scrolls both ways over any number of either, with fixed, resizable, movable and sortable columns, row, column and cell selection, rows the app serves a page at a time, group labels, keyboard navigation and cells the app draws."
order: 26.4
group: base
demo: el-data-table
---

# DataTable

`DataTable` shows rows and columns as a spreadsheet does and scrolls both ways over any number of either. Only the
cells in view are made, so a table of a million rows and ten thousand columns scrolls as a small one does. Rows,
columns or cells select, with the pointer and the keyboard; columns have fixed widths, resize with a drag of their
edge, move with a drag of their title, stay at the left while the others scroll, and sort. Titles can sit under group
labels, and a cell or a title can be drawn by the app.

`DataTable` supplies layout, alignment, virtualization and interaction. The app gives its parts their padding,
colors, borders and selection feedback through `classes` and `styles`. Rust makes one with
`nsh_base::data_table()`, TSX with `<DataTable>` from `nsh/base`.

```rust tabs
use nsh_base::{DataTableColumn, data_table};
use nsh_core::prelude::*;

fn column(key: &str, title: &str) -> DataTableColumn {
    let mut column = DataTableColumn::default();
    column.key = key.into();
    column.title = Some(title.into());
    column
}

fn table() -> impl IntoElement {
    data_table()
        .columns(vec![column("name", "Name"), column("city", "City")])
        .flex_1()
}
```

```tsx tabs
import { mount } from "nsh";
import { DataTable, type DataTableColumn } from "nsh/base";

const columns: DataTableColumn[] = [
  { key: "name", title: "Name", width: 160, sortable: true },
  { key: "city", title: "City", width: 120 },
  { key: "score", title: "Score", width: 90, align: "end" },
];

const rows = [
  { name: "Ada", city: "Oslo", score: 91 },
  { name: "Grace", city: "Lima", score: 87 },
  { name: "Linus", city: "Kyoto", score: 78 },
];

function App() {
  return <DataTable columns={columns} data={rows} class="flex-1" />;
}

mount(App);
```

The table fills the box the app gives it (`flex-1`, a height) and scrolls inside: vertically through the rows and
sideways through the columns, with scroll bars (`scrollbar={false}` hides them, `bounces={false}` stops the bounce at the ends where a platform has one).

## Rows and columns

`data` is the rows: objects whose fields the columns' `key`s name, or arrays the columns index by position. Numbers,
booleans and strings show as text. A column is a `DataTableColumn`:

| Field | Description |
|---|---|
| `key` | Who it is, unique among the columns: the field of the rows its cells show, and the name that events and the ref use. |
| `title` | The text of its title. Default its `key`. |
| `width` | Its width, in points. Default `120`. |
| `minWidth`, `maxWidth` | The narrowest and widest a drag or a fit makes it. Default `20` and `1200`. |
| `fitPadding` | Extra room for the app's padding, icons or badges, added to the widest title or cell text when fitting the column. |
| `align` | `"start"` (the default), `"center"` or `"end"`, for numbers. Cells and title alike. |
| `sortable` | Its title has a sort button that asks for a sort (see [Sorting](#sorting)). |
| `fixed` | It stays at the left while the other columns scroll under it. Fixed columns lead the others, in their order. |
| `resizable`, `movable` | Whether a drag of its edge resizes it and a drag of its title moves it. Default the table's `resizableColumns` and `movableColumns`. |
| `selectable` | Whether it takes part in selection. A column of buttons or checkboxes sets `false`. Default `true`. |
| `cellClass` | Classes of the column's cells, after the `cell` part's: paddings or alignment of one column. |
| `headerClass` | Classes of the column's title, after the `headerCell` part's. |
| `positiveClass` | Classes of the column's cells that hold a rise: a number above zero, or a text starting with `+`. |
| `negativeClass` | Classes of the column's cells that hold a fall: a number below zero, or a text starting with `-`. |

`rowHeight` is the height of a body row (default `32`) and `headerHeight` the height of a title row (default the row
height). `rowHeader` adds a column of row numbers at the left, which selects rows. `stripe` gives the odd rows the
`rowOdd` part.

### Group labels

`groups` puts labels above the columns, the lowest level first. Each level is a list of `{ label, span }` whose spans
add up to the number of columns, or of the level below.

```tsx
<DataTable
  columns={columns}
  data={rows}
  groups={[
    [{ label: "Person", span: 2 }, { label: "Result", span: 1 }],
  ]}
  class="flex-1"
/>
```

## Any number of rows

The table asks for rows by position, and the app serves them. `rowCount` is the total number of rows, `data` the rows
the app holds, and `dataStart` the position of the first of them. Rows outside `data` are empty until the app supplies
them. `onVisibleRowsChange` reports the rows in view, `{ start, end }`, at every scroll step, and is the place to fetch
the page around them.

```tsx
const ROWS = 1_000_000;
const page = signal({ start: 0, rows: load(0) });

<DataTable
  columns={columns}
  data={page().rows}
  dataStart={page().start}
  rowCount={ROWS}
  onVisibleRowsChange={({ start, end }) => {
    // Keep the rows in view inside the page held.
    const held = page();
    if (start < held.start || end > held.start + held.rows.length) {
      const first = Math.max(0, start - 200);
      page.set({ start: first, rows: load(first) });
    }
  }}
  class="flex-1"
/>
```

For a list that grows at its end, set `hasMore`: `onLoadMore` fires once for each number of rows when the rows in view
come within `loadMoreThreshold` (default `20`) of the last. While `loading` is true it waits, and the `loadingView`
slot shows over the rows. The `empty` slot shows when there are no rows.

Past a few million points of content the scroll bars span a scaled range, so a million rows still scroll to every row.

## Selection

Three switches decide what a press selects, as in gpui-component:

| Prop | A press selects | `selection` |
|---|---|---|
| `rowSelectable` (default `true`) | A row: any of its cells, or its row header | `{ row }` |
| `columnSelectable` (default `true`) | A column: its title | `{ column }` |
| `cellSelectable` (default `false`) | A cell; the row header (shown by default with it) selects rows | `{ row, column }` |

With `cellSelectable` and the row header hidden (`rowHeader={false}`), pressing the selected cell again selects its
row. A press with Shift or the platform's command key held selects a row only while `selectOnModifierPress` (default
`true`), so an app that keeps its own multi-row selection handles those presses itself: `onRowPress` reports every
press of the body with its row, the column under the pointer, the clicks in a row and the modifier keys held. A column whose `selectable` is
`false` selects neither itself nor its cells.

Rows count from 0 in the data, and a column is its index among `columns`, whatever order the user moved them to.
`onSelectionChange` reports what the user selected (`null` for nothing). The `selection` prop sets the selection from
the app; leave it unset and the table keeps it. `onDoublePress` reports a row, a cell or a title pressed twice, and
`onContextMenu` a secondary or long press with the point to open the app's [`Menu`](./menu.md) at. Both name the
cell under the pointer (its `row` and `column`), a row's number (`row` only) or a title (`column` only). Until the next
press, the cell a menu was asked for has the `cellActive` part, or its row the `rowActive` part where cells do not
select.

Screen readers get a grid (named by `accessibilityLabel`) of column headers and cells, the selected ones said to be
selected.

## Keyboard

Pressing the table, or reaching it with Tab (macOS, the web), gives it the keyboard until another press, the focus
moving elsewhere or `blur()`; `focus()` gives it from the app. The table is one stop of Tab: inside it Tab moves the
selection, and Escape gives the keyboard back.

| Keys | What they do |
|---|---|
| Arrow keys | Move the selection by a row, a column or a cell, scrolling it into view. |
| Tab, Shift+Tab | Move to the next or the previous column. |
| Page Up, Page Down | Move by a page of rows. |
| Home, End | Move to the first or the last. |
| Escape | Clears the selection, then gives the keyboard back. |
| Copy shortcut | Puts the selection's text on the clipboard (`copy()`). |

`loopSelection` (default `true`) makes the arrow keys go around the ends.

## Sorting

A `sortable` column has a sort button at the end of its title, a small ghost button dimmed while the column is unsorted. Pressing it reports the next sort in the cycle of unsorted,
ascending, descending and unsorted again, with `onSortChange({ key, direction })` (`null` to clear). The table does
not reorder the rows: the app sorts its data, or asks its server for rows in the new order, and sets `sort` so the
title shows it. Because the app owns the order, sorting works the same over a million rows the app never holds.

```tsx
<DataTable
  columns={columns}
  data={rows()}
  sort={sort()}
  onSortChange={(next) => {
    sort.set(next ?? undefined);
    rows.set(sorted(people, next));
  }}
  class="flex-1"
/>
```

## Resizing and moving columns

A drag of a column's trailing edge resizes it within its `minWidth` and `maxWidth`, and `onColumnResize(key, width)`
reports every step. Pressing the edge twice in a row fits the column to its widest text and title. A drag of a title moves the column, and a line shows where it will drop; `onColumnMove` reports
`{ key, from, to, order }`, `order` being the `key`s of all the columns in the order shown. Fixed columns stay among
the fixed ones. `resizableColumns` and `movableColumns` turn both off for the table, and a column's `resizable` and
`movable` win over them.

## Live data

A quote table changes many times a second. The app formats the rows in view and a reach around them (it knows them
from `onVisibleRowsChange`) and hands those over as `data` from `dataStart`, so an update costs what is on screen,
whatever the number of rows. Rises and falls take their colors from the column's `positiveClass` and `negativeClass`,
applied natively to the cells whose value is above or below zero (or whose text starts with `+` or `-`).

```tsx
const tone = { positiveClass: "text-green-600", negativeClass: "text-red-600" };
const columns: DataTableColumn[] = [
  { key: "symbol", title: "Symbol", fixed: true },
  { key: "price", title: "Price", align: "end", sortable: true },
  { key: "change", title: "Chg%", align: "end", ...tone },
];
```

Rows and columns are slots the table makes once and keeps: scrolling gives them other rows and columns to show, so a
scroll, however long, changes texts and places only.

## Drawing cells and titles

`renderCell` draws the cells of the app's own where a column is not just text (a badge, a button). It is called for the
cells in view only, with a `DataTableCell`: `row`, `column`, `key`, `text` (what the table would show) and `selected`.
The app looks up its own data by `row`. `renderHeaderCell` draws a title across its cell, told a `DataTableHeaderCell`:
`column`, `key`, `title`, `sort` (the direction, or none) and `selected`.

```tsx
<DataTable
  columns={columns}
  data={rows()}
  renderCell={(cell) =>
    cell.key === "status" ? (
      <View class={cell.text === "open" ? "rounded bg-green-500/20 px-2" : "rounded bg-muted px-2"}>
        <Text class="text-xs">{cell.text}</Text>
      </View>
    ) : (
      <Text class="px-2 text-sm">{cell.text}</Text>
    )
  }
  class="flex-1"
/>
```

`fontFamily` and `fontSize` (default `14`) set the font of the cells, which the table also measures texts in to fit
columns.

## The ref

`ref` gives a `DataTableRef`:

| Method | Description |
|---|---|
| `scrollToRow(row, animated?)` | Scrolls a row into view. |
| `scrollToColumn(key, animated?)` | Scrolls a column into view. |
| `selection()` | What is selected, `null` for nothing. |
| `select(selection)` | Selects (`null`: nothing) and brings it into view, without `onSelectionChange`. |
| `visibleRows()`, `visibleColumns()` | The rows and the scrolling columns in view, as `{ start, end }` (`end` excluded). |
| `columnWidths()` | The widths now, in the order of `columns`. |
| `setColumnWidth(key, width)` | Sets a column's width, within its limits. |
| `fitColumn(key)` | Sets a column as wide as its widest text and its title need, among the rows in view and up to a thousand more around them. It returns the width, `null` for no such column. |
| `dump(start?, end?)` | The texts of the rows given (default all those held) and of the titles, as shown: `{ headers, rows }`, for export. |
| `copy()` | Puts the selection's text on the clipboard: a row's cells with tabs between, a column's with line breaks, a cell's text. |
| `focus()`, `blur()` | Gives the keyboard to the table or takes it. |
| `menuTarget()`, `clearMenuTarget()` | What the last context menu was asked for at (`{ row?, column? }`, marked by `cellActive` / `rowActive`), and dropping that mark when the app's menu closes. |

## Styling the parts

`class` and `style` style the table's box. `classes` takes Tailwind classes by part and `styles` inline styles by part;
parts provide the table's structure and alignment; their classes supply the appearance, and `styles` win over classes.

```tsx
<DataTable
  columns={columns}
  data={rows()}
  stripe
  class="flex-1 rounded-lg border border-border"
  classes={{
    header: "bg-secondary",
    headerCell: "pl-2 pr-1",
    headerContent: "gap-1",
    cell: "px-2",
    resizeHandle: "bg-border group-hover:bg-primary",
    sortAscending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
    sortDescending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
    rowSelected: "bg-primary/10",
    rowHover: "bg-muted/50",
    fixedEdge: "bg-border",
  }}
/>
```

| Part | What it is |
|---|---|
| `root` | The table's box: its border, radius and background |
| `header` | The header across the table, its rows of group labels and titles |
| `groupCell` | A group label above the columns it spans |
| `headerCell` | Every column's title cell |
| `headerContent` | The label and sort button's layout row; set their gap here |
| `headerCellDragging` | The dragged title, after `headerCell` |
| `headerCellSorted` | The title of the column the table is sorted by, after `headerCell` |
| `headerCellSelected` | The title of the selected column, after `headerCell` |
| `sortIndicator` | The sort button of a sortable column |
| `sortAscending`, `sortDescending` | Its two chevrons; `selected:` applies to the sorted direction |
| `resizeHandle` | The line at a column's trailing edge that a drag resizes |
| `moveIndicator` | The line where a dragged column will drop |
| `row` | Every body row |
| `rowOdd` | The odd rows, after `row` (`stripe`) |
| `rowHover` | The row the pointer is over, after `row` |
| `rowSelected` | The selected row, after `row` |
| `rowActive` | The row a context menu was asked for where cells do not select, until the next press, after `row` |
| `cell` | Every body cell |
| `cellSelected` | The selected cell, after `cell` |
| `cellActive` | The cell a context menu was asked for, until the next press, after `cell` |
| `cellColumnSelected` | The cells of the selected column, after `cell` |
| `rowHeader` | The row header cells, the row numbers |
| `rowHeaderCorner` | The corner above the row headers |
| `fixedEdge` | The line at the fixed columns' trailing edge, over the columns that scroll under them |
| `empty` | The box of the `empty` slot |

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `columns` | `.columns(..)` | `DataTableColumn[]` | `[]` | The columns, left to right. Fixed ones lead. |
| `data` | `.data(..)` | `Row[]` | `[]` | The rows: objects by column `key`, or arrays by position. |
| `rowCount` | `.row_count(..)` | `number` | the rows held | How many rows there are in all. |
| `dataStart` | `.data_start(..)` | `number` | `0` | The row of the first row of `data`. |
| `rowClasses` | `.row_classes(..)` | `string[]` | `[]` | Classes of the rows given, by their place in `data`: a row's own look, with no call into JS per row. |
| `rowHeight` | `.row_height(..)` | `number` | `32` | The height of a body row, in points. |
| `headerHeight` | `.header_height(..)` | `number` | the row height | The height of a title row. |
| `groups` | `.groups(..)` | `DataTableColumnGroup[][]` | `[]` | Labels above the columns, lowest level first. |
| `sort` | `.sort(..)` | `DataTableSort` | | What the data is sorted by, shown on the title. |
| `rowSelectable` | `.row_selectable(..)` | `boolean` | `true` | Presses and keys select rows. |
| `columnSelectable` | `.column_selectable(..)` | `boolean` | `true` | A title's press selects its column, and the horizontal keys move between columns. |
| `cellSelectable` | `.cell_selectable(..)` | `boolean` | `false` | Presses and keys select cells. |
| `selectOnModifierPress` | `.select_on_modifier_press(..)` | `boolean` | `true` | A press with Shift or the command key held selects a row. |
| `selection` | `.selection(..)` | `DataTableSelection` | | What is selected, when the app sets it. |
| `loopSelection` | `.loop_selection(..)` | `boolean` | `true` | The arrow keys go around the ends. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the table. |
| `rowHeader` | `.row_header(..)` | `boolean` | shown with `cellSelectable` | A column of row numbers at the left. |
| `stripe` | `.stripe(..)` | `boolean` | `false` | Odd rows get the `rowOdd` part. |
| `resizableColumns` | `.resizable_columns(..)` | `boolean` | `true` | A drag of a column's edge resizes it. |
| `movableColumns` | `.movable_columns(..)` | `boolean` | `true` | A drag of a title moves its column. |
| `loading` | `.loading(..)` | `boolean` | `false` | The table is loading: `onLoadMore` waits and `loadingView` shows. |
| `hasMore` | `.has_more(..)` | `boolean` | `false` | There are more rows to load. |
| `loadMoreThreshold` | `.load_more_threshold(..)` | `number` | `20` | How many rows from the last make `onLoadMore` fire. |
| `fontFamily` | `.font_family(..)` | `string` | inherited | The font of the cells. |
| `fontSize` | `.font_size(..)` | `number` | `14` | The font size of the cells, in points. |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | The scroll bars. |
| `verticalScrollbar`, `horizontalScrollbar` | `.vertical_scrollbar(..)`, `.horizontal_scrollbar(..)` | `boolean` | `scrollbar` | One axis's scroll bar (the horizontal one is the desktops' bar under the table). |
| `bounces` | `.bounces(..)` | `boolean` | `true` | Whether scrolling bounces at the ends, where the platform does so. |
| `renderCell` | `.render_cell(..)` | `(cell: DataTableCell) => JSX.Element` | | Draws the cells in view. |
| `renderHeaderCell` | `.render_header_cell(..)` | `(cell: DataTableHeaderCell) => JSX.Element` | | Draws the titles. |
| `empty` | `.empty(..)` | `JSX.Element` | | What shows when there are no rows. |
| `loadingView` | `.loading_view(..)` | `JSX.Element` | | What shows over the rows while `loading`. |
| `classes` | `.classes(..)` | `DataTableClasses` | `{}` | Tailwind classes by part. |
| `styles` | `.styles(..)` | `DataTableStyles` | `{}` | Inline styles by part, over the classes. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | | The table's box. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onSelectionChange` | `.on_selection_change(\|selection: &Option<DataTableSelection>\| ..)` | The user changed the selection: `{ row?, column? }`, or `null`. |
| `onRowPress` | `.on_row_press(\|event: &DataTablePress\| ..)` | A row or cell was pressed: `{ row, column?, clicks, shift, control, alt, platform }`. |
| `onDoublePress` | `.on_double_press(\|target: &DataTableTarget\| ..)` | A row, cell or title was pressed twice: `{ row?, column? }`. |
| `onContextMenu` | `.on_context_menu(\|event: &DataTableContextMenu\| ..)` | A context menu was asked for: `{ row?, column?, x, y }`, the point in the root view. |
| `onSortChange` | `.on_sort_change(\|sort: &Option<DataTableSort>\| ..)` | A sort button was pressed: the next sort `{ key, direction }`, or `null`. |
| `onColumnResize` | `.on_column_resize(\|key: &SharedString, width: &Points\| ..)` | A column was resized, at every step of a drag and once more when a fit sets it. |
| `onColumnMove` | `.on_column_move(\|event: &DataTableColumnMove\| ..)` | A column was moved: `{ key, from, to, order }`. |
| `onVisibleRowsChange` | `.on_visible_rows_change(\|range: &DataTableRange\| ..)` | The rows in view changed: `{ start, end }`. Fetch rows from here. |
| `onVisibleColumnsChange` | `.on_visible_columns_change(\|range: &DataTableRange\| ..)` | The scrolling columns in view changed. |
| `onLoadMore` | `.on_load_more(\|\| ..)` | The rows in view came within `loadMoreThreshold` of the last while `hasMore` and not `loading`. |

## Related

- [Editor](./editor.md) and [DiffView](./diff-view.md): the other data-heavy base components.
- [Menu](./menu.md): the menu to open from `onContextMenu`.
- [`nsh/base`](../modules/nsh-base.md): the other base components.
