//! `DataTable`: a table of rows and columns (`nsh/base`) that scrolls both
//! ways over any number of either, selecting rows, columns or cells, with
//! columns that resize, move, sort and stay fixed. `docs/dev/data-table.md`
//! has the design.

mod axis;
mod columns;
mod controller;
mod data;
mod parts;
mod selection;
mod view;

use nsh_core::prelude::*;

use self::controller::Dt;
pub use self::{
    data::DataTableRows,
    parts::{DataTableClasses, DataTablePart, DataTableStyles},
};

/// How a column's cells are aligned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum DataTableAlign {
    /// At the start (the left in left-to-right text).
    #[default]
    Start,
    /// In the middle.
    Center,
    /// At the end: numbers.
    End,
}

/// Which way a column is sorted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum DataTableSortDirection {
    /// Smallest first.
    #[default]
    Ascending,
    /// Largest first.
    Descending,
}

/// A column of a [`DataTable`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableColumn {
    /// Who it is, unique among the columns: the field of the rows' objects
    /// its cells show, and what events and the ref name it by.
    pub key: SharedString,
    /// The text of its title (default its `key`).
    #[prop(skip_none)]
    pub title: Option<SharedString>,
    /// Its width, in points (default 120).
    #[prop(skip_none)]
    pub width: Option<Points>,
    /// The narrowest a drag or a fit makes it (default 20).
    #[prop(skip_none)]
    pub min_width: Option<Points>,
    /// The widest a drag or a fit makes it (default 1200).
    #[prop(skip_none)]
    pub max_width: Option<Points>,
    /// Extra room for the app's padding, icons or badges when fitting the
    /// column, added to the widest title or cell text.
    #[prop(skip_none)]
    pub fit_padding: Option<Points>,
    /// How its cells and title are aligned.
    #[prop(default)]
    pub align: DataTableAlign,
    /// Its title has a sort button, which reports the next sort
    /// (`onSortChange`; the app sorts its data and sets `sort`).
    #[prop(default)]
    pub sortable: bool,
    /// It stays at the left while the other columns scroll under it. Fixed
    /// columns lead the others, in their order.
    #[prop(default)]
    pub fixed: bool,
    /// Whether a drag of its edge resizes it (default the table's
    /// `resizableColumns`).
    #[prop(skip_none)]
    pub resizable: Option<bool>,
    /// Whether a drag of its title moves it (default the table's
    /// `movableColumns`).
    #[prop(skip_none)]
    pub movable: Option<bool>,
    /// Whether it takes part in selection (default true): a column of
    /// buttons or checkboxes sets false, and neither it nor its cells
    /// select.
    #[prop(skip_none)]
    pub selectable: Option<bool>,
    /// Classes of its cells, after the `cell` part's (paddings and
    /// alignment of one column, for instance).
    #[prop(skip_none)]
    pub cell_class: Option<SharedString>,
    /// Classes of its title, after the `headerCell` part's.
    #[prop(skip_none)]
    pub header_class: Option<SharedString>,
    /// Classes of its cells that hold a rise: a number above zero, or a
    /// text starting with `+` (`"text-green-600"` in a quote table).
    #[prop(skip_none)]
    pub positive_class: Option<SharedString>,
    /// Classes of its cells that hold a fall: a number below zero, or a
    /// text starting with `-` or `−`.
    #[prop(skip_none)]
    pub negative_class: Option<SharedString>,
}

/// A label above columns: `span` of them, in order.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableColumnGroup {
    /// The label.
    pub label: SharedString,
    /// How many columns (or lower groups) it spans.
    #[prop(default = 1)]
    pub span: u32,
}

/// What a table is sorted by (`sort`, `onSortChange`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableSort {
    /// The `key` of the column.
    pub key: SharedString,
    /// The direction.
    #[prop(default)]
    pub direction: DataTableSortDirection,
}

/// What is selected: a row alone, a column alone, or a cell (both). Rows
/// count from 0 in the data; a column is its index among the `columns`
/// (whatever order the user moved them to).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct DataTableSelection {
    /// The selected row.
    #[prop(skip_none)]
    pub row: Option<u32>,
    /// The selected column.
    #[prop(skip_none)]
    pub column: Option<u32>,
}

/// A range of rows or columns, `start` up to but not including `end`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct DataTableRange {
    /// The first.
    pub start: u32,
    /// After the last.
    pub end: u32,
}

/// A cell, a row (no `column`) or a column (no `row`) of a [`DataTable`]
/// (`onDoublePress`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct DataTableTarget {
    /// The row.
    #[prop(skip_none)]
    pub row: Option<u32>,
    /// The column, its index among the `columns`.
    #[prop(skip_none)]
    pub column: Option<u32>,
}

/// A press of the body (`onRowPress`): the row, and the column under the
/// pointer (none on a row's number), the clicks in a row and the modifier
/// keys held, for the app's own handling of rows (a selection of several,
/// opening a row).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct DataTablePress {
    /// The row.
    pub row: u32,
    /// The column, its index among the `columns`.
    #[prop(skip_none)]
    pub column: Option<u32>,
    /// The presses in a row: 2 for a double press.
    pub clicks: u32,
    /// Shift was held.
    pub shift: bool,
    /// Control was held.
    pub control: bool,
    /// Option (Apple platforms) or Alt was held.
    pub alt: bool,
    /// Command (Apple platforms) or the Super key was held.
    pub platform: bool,
}

/// Where a context menu was asked for (`onContextMenu`).
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableContextMenu {
    /// The row pressed, none on a title or past the rows.
    #[prop(skip_none)]
    pub row: Option<u32>,
    /// The column pressed, its index among the `columns`.
    #[prop(skip_none)]
    pub column: Option<u32>,
    /// Where, in the root view (`Menu.popup`'s point).
    pub x: Points,
    /// Where, in the root view.
    pub y: Points,
}

/// A column moved by the user (`onColumnMove`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableColumnMove {
    /// The `key` of the column that moved.
    pub key: SharedString,
    /// Where it was among the columns shown, from 0.
    pub from: u32,
    /// Where it is now.
    pub to: u32,
    /// The `key`s of all the columns, in the order shown now.
    pub order: Vec<SharedString>,
}

/// A cell the app draws (`renderCell`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableCell {
    /// Its row, from 0 in the data.
    pub row: u32,
    /// Its column, the index among the `columns`.
    pub column: u32,
    /// The `key` of its column.
    pub key: SharedString,
    /// The text the table would show: the field of its row.
    pub text: SharedString,
    /// Its row or its cell is selected.
    pub selected: bool,
}

/// A title the app draws (`renderHeaderCell`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableHeaderCell {
    /// The index of its column among the `columns`.
    pub column: u32,
    /// Its column's `key`.
    pub key: SharedString,
    /// Its text.
    pub title: SharedString,
    /// Which way the table is sorted by it, none when it is not.
    #[prop(skip_none)]
    pub sort: Option<DataTableSortDirection>,
    /// Its column is selected.
    pub selected: bool,
}

/// Text rows read out of a table (`dump`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DataTableDump {
    /// The titles of the columns, in the order shown.
    pub headers: Vec<String>,
    /// The cells' texts, a list per row.
    pub rows: Vec<Vec<String>>,
}

/// A table of rows and columns that scrolls both ways over any number of
/// either: only the cells in view are made, so a table of a million rows and
/// of ten thousand columns scrolls as a small one does (past a few million
/// points of content the scroll bars span a scaled range, `docs/dev/data-table.md`).
/// Rows are `data`, objects whose fields the columns' `key`s name or arrays
/// the columns index; for more rows than the app holds, `rowCount` is the
/// total and `data` the rows from `dataStart` on, which the app fetches as
/// `onVisibleRowsChange` tells (or `onLoadMore`). Rows, columns or cells
/// select (`rowSelectable`, `columnSelectable`, `cellSelectable`,
/// `selection`, with the arrow keys, Home, End, Page Up and Down, Tab), columns resize, move, stay fixed at the left and
/// sort (the app sorts: `sort`, `onSortChange`), titles can sit under group
/// labels, and a cell or a title can be drawn by the app (`renderCell`,
/// `renderHeaderCell`). The table supplies layout and alignment; the app
/// styles its parts (`classes`, `styles`).
#[derive(Clone, Copy, PartialEq, Props)]
#[props(generic)]
pub struct DataTableProps {
    /// The columns, left to right. Fixed ones lead.
    #[prop(default)]
    pub columns: Prop<Vec<DataTableColumn>>,
    /// The rows: objects whose fields the columns' `key`s name, or arrays
    /// the columns index. Numbers, booleans and strings show as text.
    #[prop(default)]
    pub data: Prop<DataTableRows>,
    /// How many rows there are, when the app holds only some in `data`
    /// (default the rows from `dataStart` that `data` has).
    pub row_count: Prop<Option<u32>>,
    /// The row of the data's first row (default 0): rows outside `data`
    /// are empty until the app supplies them.
    #[prop(default)]
    pub data_start: Prop<u32>,
    /// Classes of the rows given, by their place in `data` (row
    /// `dataStart + i` takes `rowClasses[i]`): a row's own look (a closed
    /// order muted, an alert highlighted) with no call into JS per row.
    #[prop(default)]
    pub row_classes: Prop<Vec<SharedString>>,
    /// The height of a body row, in points (default 32).
    #[prop(default = Points(32.0))]
    pub row_height: Prop<Points>,
    /// The height of a title row, in points (default the row height).
    pub header_height: Prop<Option<Points>>,
    /// Labels above the columns, the lowest level first: each level spans
    /// the columns as the `span`s say (a level's spans add up to the number
    /// of columns, or of the level below).
    #[prop(default)]
    pub groups: Prop<Vec<Vec<DataTableColumnGroup>>>,
    /// What the data is sorted by, shown on the title; the app sorts.
    pub sort: Prop<Option<DataTableSort>>,
    /// Whether rows select (default true): a press of a row (of a cell
    /// when cells do not select) or of its row header, and the vertical
    /// keys.
    #[prop(default = true)]
    pub row_selectable: Prop<bool>,
    /// Whether columns select (default true): a press of a column's title
    /// (a column's `selectable` false keeps it out), and the horizontal keys
    /// when cells do not select.
    #[prop(default = true)]
    pub column_selectable: Prop<bool>,
    /// Whether cells select (default false): a press of a cell selects it,
    /// and the arrow keys, Home, End, Page Up and Down and Tab move between
    /// cells. Without a row header, pressing the selected cell again selects
    /// its row (when `rowSelectable`).
    #[prop(default)]
    pub cell_selectable: Prop<bool>,
    /// Whether a press of a row with Shift or the platform's secondary
    /// modifier (Command on Apple platforms, Control elsewhere) held selects
    /// it (default true). An app that keeps its own selection of several
    /// rows sets false and handles those presses itself (a selected cell
    /// pressed so does not become its row either). It applies where the
    /// platform reports the modifiers of a press.
    #[prop(default = true)]
    pub select_on_modifier_press: Prop<bool>,
    /// What is selected, when the app sets it (a user's selection is
    /// reported by `onSelectionChange` either way). A selection of a kind
    /// that does not select (a column when `columnSelectable` is false, ...)
    /// is cleared.
    pub selection: Prop<Option<DataTableSelection>>,
    /// The arrow keys go around the ends.
    #[prop(default = true)]
    pub loop_selection: Prop<bool>,
    /// A column of row numbers at the left, which selects rows (default
    /// shown when `cellSelectable`, hidden otherwise).
    pub row_header: Prop<Option<bool>>,
    /// What screen readers call the table.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Odd rows get the `rowOdd` part (a faint tint by default).
    #[prop(default)]
    pub stripe: Prop<bool>,
    /// Whether a drag of a column's edge resizes it (default true; a
    /// column's `resizable` wins).
    #[prop(default = true)]
    pub resizable_columns: Prop<bool>,
    /// Whether a drag of a title moves its column (default true; a column's
    /// `movable` wins).
    #[prop(default = true)]
    pub movable_columns: Prop<bool>,
    /// The table is loading: `onLoadMore` waits, and the `loadingView` shows.
    #[prop(default)]
    pub loading: Prop<bool>,
    /// There are more rows to load: `onLoadMore` fires when the rows in
    /// view come within `loadMoreThreshold` of the last.
    #[prop(default)]
    pub has_more: Prop<bool>,
    /// How many rows from the last make `onLoadMore` fire (default 20).
    #[prop(default = 20)]
    pub load_more_threshold: Prop<u32>,
    /// The font family of cells, inherited when omitted. The table uses
    /// this family (or the system's) to measure texts for column fits.
    pub font_family: Prop<Option<SharedString>>,
    /// The font size of cells, in points (default 14).
    #[prop(default = Points(14.0))]
    pub font_size: Prop<Points>,
    /// The scroll bars (default true).
    #[prop(default = true)]
    pub scrollbar: Prop<bool>,
    /// The vertical scroll bar, else as `scrollbar`.
    pub vertical_scrollbar: Prop<Option<bool>>,
    /// The horizontal scroll bar (the desktops' bar under the table), else
    /// as `scrollbar`.
    pub horizontal_scrollbar: Prop<Option<bool>>,
    /// Whether scrolling bounces at the ends where the platform does so
    /// (default true).
    #[prop(default = true)]
    pub bounces: Prop<bool>,
    /// The cells of the app's own, drawn by `renderCell` where a column's
    /// cells are not just text (a badge, a button). It is called for the
    /// cells in view only, with the cell's text; the app looks up its own
    /// data by `row`.
    pub render_cell: Prop<Option<Renderer<DataTableCell>>>,
    /// A title drawn by the app, across its cell.
    pub render_header_cell: Prop<Option<Renderer<DataTableHeaderCell>>>,
    /// What shows when there are no rows.
    pub empty: Prop<Option<Slot>>,
    /// What shows over the rows while `loading`.
    pub loading_view: Prop<Option<Slot>>,
    /// Classes of the table's parts, after their own styles.
    #[prop(default)]
    pub classes: Prop<DataTableClasses>,
    /// Inline styles of the table's parts, over their classes.
    #[prop(default)]
    pub styles: Prop<DataTableStyles>,
}

/// The events of a [`DataTable`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum DataTableEvent {
    /// The user changed the selection (a press, a key): what is selected,
    /// `null` for nothing.
    #[args(selection)]
    SelectionChange(Option<DataTableSelection>),
    /// A row or a cell was pressed (each press, after the selection it
    /// makes): with `selectOnModifierPress` off, the app handles presses
    /// with Shift or the secondary modifier here.
    #[args(event)]
    RowPress(DataTablePress),
    /// A row, cell or title was pressed twice.
    #[args(target)]
    DoublePress(DataTableTarget),
    /// A context menu was asked for (a secondary press, a long press) at a
    /// cell, a row's number or a title: the app opens its `Menu` at the
    /// point.
    #[args(event)]
    ContextMenu(DataTableContextMenu),
    /// The user pressed a sortable title: what to sort by next
    /// (ascending, descending, then unsorted again), `null` to
    /// clear. Sort the data and set `sort`.
    #[args(sort)]
    SortChange(Option<DataTableSort>),
    /// The user resized a column (at every step of a drag, and once more
    /// when a fit sets it): its `key` and width.
    #[args(key, width)]
    ColumnResize(SharedString, Points),
    /// The user moved a column.
    #[args(event)]
    ColumnMove(DataTableColumnMove),
    /// The rows in view changed (scrolling, resizing, other rows). Fast:
    /// fetch the rows from here.
    #[args(range)]
    VisibleRowsChange(DataTableRange),
    /// The scrolling columns in view changed.
    #[args(range)]
    VisibleColumnsChange(DataTableRange),
    /// The rows in view came within `loadMoreThreshold` of the last while
    /// `hasMore` and not `loading`: load more (once for each number of
    /// rows).
    LoadMore,
}

/// The methods of a [`DataTable`]'s ref.
pub struct DataTableApi {
    dt: Dt,
}

#[methods]
impl DataTableApi {
    /// Scrolls row `row` into view.
    pub fn scroll_to_row(&self, row: u32, animated: Option<bool>) {
        self.dt
            .scroll_to_row(row as usize, animated.unwrap_or(false));
    }

    /// Scrolls the column `key` into view.
    pub fn scroll_to_column(&self, key: String, animated: Option<bool>) {
        self.dt.scroll_to_column(&key, animated.unwrap_or(false));
    }

    /// What is selected, `null` for nothing.
    pub fn selection(&self) -> Option<DataTableSelection> {
        self.dt.selection_value()
    }

    /// Selects (`null`: nothing), as a press does but without
    /// `onSelectionChange`, and brings it into view.
    pub fn select(&self, selection: Option<DataTableSelection>) {
        self.dt.select(selection, false);
    }

    /// The rows in view.
    pub fn visible_rows(&self) -> DataTableRange {
        self.dt.visible_rows_range()
    }

    /// The scrolling columns in view.
    pub fn visible_columns(&self) -> DataTableRange {
        self.dt.visible_columns_range()
    }

    /// The widths now, by the columns' order in `columns`.
    pub fn column_widths(&self) -> Vec<Points> {
        self.dt.column_widths()
    }

    /// Sets the width of the column `key` (within its limits).
    pub fn set_column_width(&self, key: String, width: Points) {
        self.dt.set_column_width(&key, width, false);
    }

    /// Sets the column `key` as wide as its widest text in the rows given
    /// (the rows in view, and up to a thousand more around them) and its
    /// title need; the width, `null` for no such column.
    pub fn fit_column(&self, key: String) -> Option<Points> {
        self.dt.fit_column(&key)
    }

    /// The texts of rows `start` to `end` (default all of those given) and
    /// of the titles, as shown: for export.
    pub fn dump(&self, start: Option<u32>, end: Option<u32>) -> DataTableDump {
        self.dt
            .dump(start.map(|r| r as usize), end.map(|r| r as usize))
    }

    /// Puts the selection's text on the clipboard: a row's cells with tabs
    /// between, a column's cells with line breaks, a cell's text.
    pub fn copy(&self) {
        self.dt.copy_selection();
    }

    /// Gives the table the keyboard: the arrow keys, Home, End, Page Up,
    /// Page Down, Tab, Escape and the copy shortcut act on it until another
    /// press or `blur`.
    pub fn focus(&self) {
        self.dt.set_focus(true);
    }

    /// What the last context menu was asked for at (`onContextMenu`), marked
    /// by the `cellActive` / `rowActive` parts until the next press or
    /// [`Self::clear_menu_target`]; `null` for nothing.
    pub fn menu_target(&self) -> Option<DataTableTarget> {
        self.dt.menu_target()
    }

    /// Drops the context menu's mark: call it when the app's menu closes.
    pub fn clear_menu_target(&self) {
        self.dt.clear_menu_target();
    }

    /// Takes the keyboard from the table.
    pub fn blur(&self) {
        self.dt.set_focus(false);
    }
}

/// A table of rows and columns that scrolls both ways over any number of
/// either; only the cells in view are made.
#[component(methods = DataTableApi)]
pub fn DataTable(props: DataTableProps, cx: Scope<DataTableEvent>) -> impl IntoElement {
    let dt = Dt::new(props, cx);
    cx.methods(DataTableApi { dt: dt.clone() });
    view::render(dt)
}
