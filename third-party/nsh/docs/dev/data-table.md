# DataTable

`DataTable` (`nsh/base`, `crates/nsh-base/src/data_table/`) is a table that scrolls both ways over any number of rows
and columns: only the cells in view (and a reach around them) exist as views. Its API follows gpui-component's
`DataTable` (columns, selection of rows, columns or cells, sorting, resizing, moving, fixed columns, loading more,
context menus, keyboard) and is adapted to NSH where that one is not: the rows are data the app hands over (`data`,
`dataStart`, `rowCount`), not a delegate the table calls; sorting is the app's (the table reports the next sort and
draws the one the app sets). It supplies a table's layout, alignment, virtualization and interaction; the app
supplies padding, colors, borders and state feedback through `classes` and `styles`. The user-facing page is
`website/elements/data-table.md`; how each module works inside is in its `//!` docs.

| File | What |
|---|---|
| `mod.rs` | The component: `DataTableProps`, `DataTableEvent`, `DataTableApi` (the ref's methods); the values: `DataTableAlign`, `DataTableSortDirection` (`PropEnum`s), `DataTableColumn`, `DataTableColumnGroup`, `DataTableSort`, `DataTableSelection`, `DataTableRange`, `DataTableCell`, ... (`JsObject`s) |
| `parts.rs` | The parts the app styles: one `parts!` list makes `DataTableClasses`, `DataTableStyles` and `DataTablePart` |
| `data.rs` | `DataTableRows`: the rows from JS, arrays or objects by the columns' keys, and each field as a `Cell` |
| `axis.rs` | `Axis`: one axis's real extent against the extent the scroll views get (see "Huge tables") |
| `columns.rs` | `Columns`: the columns' order, widths and prefix sums, the fixed ones, finding the column at an x, resizing, moving |
| `selection.rs` | `Selection`, `Selectable` (gpui-component's `rowSelectable`, `columnSelectable`, `cellSelectable`), and `Nav`: what a key moves the selection to |
| `controller.rs` | `Dt` and `State`: props and the ref's work, revisions bindings subscribe to, presses, keys, resizing, moving, fitting, copying |
| `view.rs` | The view, in layers (below) |

## Layers

The table is a hit layer, a body and a header (`view.rs`):

- the *hit layer* is a vertical scroll view of a horizontal one of an empty box of the content's size. The platforms
  scroll it as they scroll any scroll view (inertia, scroll bars, wheel, touch), and its box takes presses, hovers and
  the context menu;
- the *body* over it receives no pointer and draws the cells of the rows and columns in view, placed where the table
  last scrolled to. Its regions are the row headers, the fixed columns (which move with the rows only) and the scrolling
  columns (which move both ways). The cells a scroll needs come with the next commit, which moves the body with them;
- the *header* above it is interactive: group labels, titles, resize handles and the drop line of a column being moved.

The fixed-column separator sits above each row background and below its cells, so app-supplied cell borders
remain visible at the fixed boundary.

Rows come from `RowWindow` (`window.rs`, `reaching(margin, ahead)`), columns from the same with a reach of 1 and 3, so
a scroll inside the window made commits a few mount items only.

The rows' and the scrolling columns' origins move in whole points (`region`, `view.rs`), as layout rounds frames: at a
fraction, the cells' texts would round to another point in their cells as the origin moves, and every cell's frame would
be sent again at each scroll frame.

The rows and the scrolling columns are *slots* (`Slots`, `view.rs`): views made once, each showing the item of the
window whose index leaves its slot number when divided by their count (the most the window has held). When the window
moves by `k` rows, `k` row slots take other rows: their texts and places change, and no view is made or dropped while
scrolling, however far. This is the retained tree's form of gpui-component's `uniform_list`, which draws the rows in
view each frame: the cost of a scroll is the cells that change, never the views that would have to be built.

## Huge tables

Platforms keep scroll offsets and content sizes in 32-bit floats, so ten million rows (a quarter of a billion points)
cannot be a scroll view's content. Past `MAX_EXTENT` (3 000 000 points) the scroll view gets that extent and its offset
is scaled to the content's (`Axis::ratio`); the table finds the rows from the scaled offset and places them relative to
the first row in view, so what is drawn is exact at any size and the scroll bar still spans the content. The columns
work the same way on the horizontal axis. Offsets the table scrolls to (`scrollToRow`, revealing the selection) are
`Axis::scroll_points`: the 32-bit float that does not stop short of the row, since far down a scaled axis one step of
that float is several content points. Columns hold prefix sums, so finding the column at an x is a binary search.

## Columns' own classes, fitting, bounce

A column's `cellClass` and `headerClass` come after the part's classes (`column_parts`, `view.rs`). Two presses of a
resize handle that moved less than `MOVE_SLOP`, within `DOUBLE_PRESS` (400 ms), fit the column (`Dt::resize_end`).
`bounces` sets the bounce of both scroll views.

A resize handle supplies its hit band and a one-point indicator part. The app colors that part as its column
separator; leaving the title's right border unset gives it one line. `headerContent` styles the layout row of the
label and sort button (for example, their gap), and `headerCellDragging` supplies drag feedback. `examples/nsh-gallery-ui/data-table.ts` supplies the gallery and website demos'
8-point cell padding, 8 points before a title and 4 after its sort button, with a 4-point gap before the button.
Its columns set `fitPadding: 16` for this app-owned spacing; fits add this to the widest title or cell text.

## Data

The app holds as many rows as it likes: `rowCount` is the table's length and `data` holds the rows from `dataStart`.
`onVisibleRowsChange` reports the rows in view, so the app serves the page around them; rows outside `data` show as
empty until it arrives. The demo in the gallery (`DataTableDemo.tsx`) serves a million stocks of sixty columns in pages
of 120 rows, formatting only the rows a new page brings.

## Live data

Rises and falls take their colors natively: a column's `positiveClass` / `negativeClass` apply to the cells whose
number is above / below zero, or whose text starts with `+` / `-` (`Cell::sign`), with no call into JS per cell. The
gallery's demo ticks as gpui-component's data table story does: every 33 ms a third of the rows of the page held move
and only those are formatted again, so a tick over the million stocks costs what is on screen. The stocks it does not
show keep the quote they opened with, computed from their id.

## Performance

Headless, debug build, the gallery's demo (`nsh test examples/gallery/App.tsx --trace`, 390 × 844): a scroll frame
inside the window made commits 4 mount items in ~1.2 ms; a window shift (row slots taking other rows) ~340 items in
~4 ms, with no views made (before the slots: ~2000 items in ~14 ms, every row of the window rebuilt); the first window
~4000 items. A tick commits ~33 items in a median 1.7 ms (at most 2.7 ms); scrolling while it ticks, a frame with a
tick ~44 items in ~3 ms. Before the origins moved in whole points, a scroll frame at a fraction sent ~470 items: every
cell text's frame.

In a GTK window (`nsh test examples/gallery/App.tsx --target linux --fps`, release, 144 Hz): scrolling the million
rows holds 144 of 144 frames, ~2.2 ms a frame on average, none over budget; wheeling the horizontal bar 110–118 frames
a second, ~2 ms a frame, 1–2 % over budget; the ticks redraw at their rate (30 frames a second at 33 ms), ~2 ms a
frame, and scrolling while they tick holds 143 of 144 frames, ~3 ms a frame.

## Keyboard focus

The table is one stop of Tab, as gpui-component's (a `tab_stop` focus handle): its hit layer's content box, whose
`onFocus` / `onBlur` set the table's focus (`Dt::set_focus`), which binds its keys; its rows, titles and sort buttons
are `focusable(false)`. While it has the keyboard Tab moves the selection, as gpui-component's, and Escape gives it
back. A press, `focus()` and `blur()` set the same flag. Tab stops at pressables and `focusable(true)` views on macOS
and the web (`ViewProps::focus_stop`).

## Compared with gpui-component

The API is gpui-component's `DataTable` / `TableState` / `TableDelegate` as data: the delegate's methods are props
(`columns`, `data`, `rowCount`, `renderCell`, `renderHeaderCell`, `groups`, `empty`, `loadingView`), its callbacks
events (`onSortChange` for `perform_sort`, `onColumnMove` for `move_column`, `onLoadMore`, `onVisibleRowsChange`,
`onVisibleColumnsChange`, `onContextMenu` for `context_menu`, whose menu is the app's `Menu`), and `TableState`'s
methods the ref's. Deliberate differences:

- The sort cycle is unsorted, ascending, descending (gpui-component's starts descending): the order users expect.
- `onColumnResize` reports the column's key and width at every step of a drag (gpui-component sends every width,
  keyless, once at the end).
- `onLoadMore` fires once per number of rows and waits while `loading` (gpui-component's `load_more` comes again on
  every range change, for the delegate to guard).
- One `onSelectionChange` with a `{ row?, column? }` value replaces `SelectRow` / `SelectColumn` / `SelectCell` /
  `ClearSelection`; the arrow keys skip columns that do not select (gpui-component's land on them).
- No strings and no fixed look: the empty and loading slots are the app's, and every part (the sort button
  among them) takes the app's classes for its appearance (gpui-component draws an inbox icon, a skeleton
  and a translated "Sort by" label).
- `onRowPress` is gpui-component's `render_tr` click handler, for the app's own selections of several rows;
  `rowClasses`, data beside `data`, is `render_tr`'s per-row look without a call into JS per row.
- A fit measures the cells' texts natively; `fitPadding` adds what the app's drawing adds to them (gpui-component
  asks its delegate to measure).
