//! The table's controller: its state (the columns' layout, the selection),
//! the revisions bindings subscribe to, the windows of rows and columns
//! made, and what presses, keys, drags, props and the ref do to them.

use std::{cell::RefCell, ops::Range, rc::Rc, time::Duration};

use nsh_core::{
    element::{ElementRef, Os},
    keymap::{Modifiers, When},
    prelude::*,
};

use super::{
    DataTableColumn, DataTableContextMenu, DataTableDump, DataTableEvent, DataTablePress,
    DataTableProps, DataTableRange, DataTableSelection, DataTableSort, DataTableSortDirection,
    DataTableTarget,
    axis::Axis,
    columns::{Columns, Spec},
    selection::{self, Move, Nav, Selectable, Selection},
};
use crate::window::RowWindow;

/// A column's width unless it says another.
const DEFAULT_WIDTH: f32 = 120.0;
/// The narrowest and widest a column is unless it says otherwise.
const MIN_WIDTH: f32 = 20.0;
const MAX_WIDTH: f32 = 1200.0;
/// The room a sortable title keeps for its indicator.
pub(crate) const SORT_WIDTH: f32 = 20.0;
/// Rows around the view that fitting a column measures, at most.
const FIT_ROWS: usize = 500;
/// Rows copied from a selected column, at most.
const COPY_ROWS: usize = 100_000;
/// A drag of a title moves its column once the pointer is this far from
/// where it went down.
pub(crate) const MOVE_SLOP: f32 = 4.0;
/// The longest between two presses of a resize handle that fit its column.
const DOUBLE_PRESS: Duration = Duration::from_millis(400);

/// What the layout and the windows need of the table, read at one moment.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Geo {
    pub(crate) row_height: f32,
    /// The height of all the title rows.
    pub(crate) header: f32,
    /// The width of the row header column.
    pub(crate) lead: f32,
    /// The width of the fixed columns.
    pub(crate) fixed: f32,
    /// The rows' axis: the rows' extent and the height below the titles.
    pub(crate) y: Axis,
    /// The scrolling columns' axis: their extent and the width right of the
    /// fixed columns.
    pub(crate) x: Axis,
    /// The content offsets (the scroll offsets, scaled).
    pub(crate) cx: f64,
    pub(crate) cy: f64,
}

/// The state that is not a signal.
pub(crate) struct State {
    pub(crate) columns: Columns,
    pub(crate) defs: Vec<DataTableColumn>,
    pub(crate) selection: Selection,
    /// The row and column a context menu was asked for.
    pub(crate) active: Option<(Option<usize>, Option<usize>)>,
    /// The width of a digit in the font, for the row header's width.
    digit: Option<(String, f32)>,
    reported_rows: Option<Range<usize>>,
    reported_cols: Option<Range<usize>>,
    /// The row count `onLoadMore` fired for last.
    load_more_at: Option<usize>,
}

/// A drag of a title that moves its column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MoveDrag {
    /// The display index of the column.
    pub(crate) from: usize,
    /// The display index it would drop at.
    pub(crate) to: usize,
    /// Moved far enough to be a drag.
    pub(crate) moving: bool,
}

#[derive(Clone)]
pub(crate) struct Dt {
    pub(crate) props: DataTableProps,
    pub(crate) cx: Scope<DataTableEvent>,
    pub(crate) st: Rc<RefCell<State>>,
    /// The columns, their widths or the sizes changed.
    pub(crate) layout_rev: Signal<u64>,
    /// The data or what is drawn over it (selection, hover) changed.
    pub(crate) data_rev: Signal<u64>,
    pub(crate) scroll_x: Signal<Points>,
    pub(crate) scroll_y: Signal<Points>,
    pub(crate) viewport: Signal<Size<Points>>,
    pub(crate) hover: Signal<Option<usize>>,
    pub(crate) focused: Signal<bool>,
    pub(crate) column_drag: Signal<Option<MoveDrag>>,
    pub(crate) vscroll: ElementRef,
    pub(crate) hscroll: ElementRef,
    pub(crate) strip: ElementRef,
    rows_window: RowWindow,
    cols_window: RowWindow,
    /// The width a resize drag started from.
    resizing: Rc<RefCell<Option<(usize, f32)>>>,
    /// The column whose handle was last pressed without a drag, and when:
    /// a second press within `DOUBLE_PRESS` fits the column.
    handle_tap: Rc<RefCell<Option<(usize, nsh_core::time::Instant)>>>,
}

fn spec_of(column: &DataTableColumn) -> Spec {
    let min = column.min_width.map_or(MIN_WIDTH, |w| w.0).max(0.0);
    let max = column.max_width.map_or(MAX_WIDTH, |w| w.0).max(min);
    Spec {
        width: column.width.map_or(DEFAULT_WIDTH, |w| w.0),
        min,
        max,
        fixed: column.fixed,
    }
}

impl Dt {
    pub(crate) fn new(props: DataTableProps, cx: Scope<DataTableEvent>) -> Dt {
        let dt = Dt {
            props,
            cx,
            st: Rc::new(RefCell::new(State {
                columns: Columns::default(),
                defs: Vec::new(),
                selection: Selection::None,
                active: None,
                digit: None,
                reported_rows: None,
                reported_cols: None,
                load_more_at: None,
            })),
            layout_rev: signal(0),
            data_rev: signal(0),
            scroll_x: signal(Points::ZERO),
            scroll_y: signal(Points::ZERO),
            viewport: signal(Size::default()),
            hover: signal(None),
            focused: signal(false),
            column_drag: signal(None),
            vscroll: element_ref(),
            hscroll: element_ref(),
            strip: element_ref(),
            // Rows are short, columns wide: a window of columns reaches
            // less far.
            rows_window: RowWindow::default(),
            cols_window: RowWindow::reaching(1, 3),
            resizing: Rc::default(),
            handle_tap: Rc::default(),
        };
        dt.sync_columns();
        dt.sync_selection();
        dt.report();
        dt.bind_keys();
        dt
    }

    // Revisions.

    pub(crate) fn bump_layout(&self) {
        self.layout_rev.update(|r| *r += 1);
    }

    pub(crate) fn bump_data(&self) {
        self.data_rev.update(|r| *r += 1);
    }

    // Props to state.

    /// The columns follow the app's `columns`: the widths a user dragged
    /// and the order they moved to stay for the columns that stay.
    fn sync_columns(&self) {
        let dt = self.clone();
        effect(move || {
            let defs = dt.props.columns.with(Clone::clone);
            untracked(|| {
                let specs: Vec<Spec> = defs.iter().map(spec_of).collect();
                {
                    let mut st = dt.st.borrow_mut();
                    let old = std::mem::take(&mut st.defs);
                    let index: std::collections::HashMap<&str, usize> = old
                        .iter()
                        .enumerate()
                        .map(|(i, d)| (d.key.as_str(), i))
                        .collect();
                    let by_key = |new: usize| index.get(defs[new].key.as_str()).copied();
                    st.columns = st.columns.updated(specs, by_key);
                    // A selected column keeps being the column of its key.
                    let kept = |c: usize| {
                        old.get(c)
                            .and_then(|d| defs.iter().position(|n| n.key == d.key))
                    };
                    st.selection = match st.selection {
                        Selection::Column(c) => kept(c).map_or(Selection::None, Selection::Column),
                        Selection::Cell(r, c) => {
                            kept(c).map_or(Selection::None, |c| Selection::Cell(r, c))
                        }
                        other => other,
                    };
                    st.defs = defs;
                }
                dt.bump_layout();
                dt.bump_data();
            });
        });
    }

    /// The selection follows the app's `selection`, and stays within the
    /// rows and columns there are and of a kind the table selects.
    fn sync_selection(&self) {
        let dt = self.clone();
        effect(move || {
            let given = dt.props.selection.get();
            let allowed = dt.selectable_kinds();
            untracked(|| {
                if let Some(given) = given {
                    dt.st.borrow_mut().selection = from_public(given);
                }
                dt.clamp_selection(allowed);
            });
        });
        let dt = self.clone();
        effect(move || {
            dt.row_count();
            dt.layout_rev.get();
            let allowed = dt.selectable_kinds();
            untracked(|| dt.clamp_selection(allowed));
        });
    }

    /// What presses and keys select (tracked).
    pub(crate) fn selectable_kinds(&self) -> Selectable {
        Selectable {
            rows: self.props.row_selectable.get(),
            columns: self.props.column_selectable.get(),
            cells: self.props.cell_selectable.get(),
        }
    }

    /// Whether the row header shows (tracked): `rowHeader`, else when cells
    /// select (as gpui-component's table).
    pub(crate) fn row_header_shown(&self) -> bool {
        self.props
            .row_header
            .get()
            .unwrap_or_else(|| self.props.cell_selectable.get())
    }

    fn clamp_selection(&self, allowed: Selectable) {
        let rows = self.row_count();
        let changed = {
            let mut st = self.st.borrow_mut();
            let columns = st.columns.len();
            let next = selection::clamp(st.selection, allowed, rows, columns);
            let changed = next != st.selection;
            st.selection = next;
            changed
        };
        if changed {
            self.bump_data();
        }
    }

    // Counts and cells.

    /// How many rows there are (tracked).
    pub(crate) fn row_count(&self) -> usize {
        match self.props.row_count.get() {
            Some(n) => n as usize,
            None => self.props.data_start.get() as usize + self.props.data.with(|d| d.len()),
        }
    }

    /// The text of the cell of `row` in column `def`: empty outside the
    /// rows given (tracked).
    pub(crate) fn cell_text(&self, row: usize, def: usize) -> SharedString {
        let start = self.props.data_start.get() as usize;
        let Some(at) = row.checked_sub(start) else {
            return SharedString::default();
        };
        let st = self.st.borrow();
        let Some(column) = st.defs.get(def) else {
            return SharedString::default();
        };
        self.props.data.with(|d| {
            if at >= d.len() {
                return SharedString::default();
            }
            d.cell(at, &column.key, def).text()
        })
    }

    /// Row `row`'s own class (`rowClasses`, tracked).
    pub(crate) fn row_class(&self, row: usize) -> Option<SharedString> {
        let at = row.checked_sub(self.props.data_start.get() as usize)?;
        self.props
            .row_classes
            .with(|c| c.get(at).filter(|c| !c.is_empty()).cloned())
    }

    /// Whether the cell holds a rise or a fall (tracked).
    pub(crate) fn cell_sign(&self, row: usize, def: usize) -> Option<bool> {
        let start = self.props.data_start.get() as usize;
        let at = row.checked_sub(start)?;
        let st = self.st.borrow();
        let column = st.defs.get(def)?;
        self.props
            .data
            .with(|d| (at < d.len()).then(|| d.cell(at, &column.key, def).sign())?)
    }

    fn write_cell(&self, row: usize, def: usize, out: &mut String) {
        let start = self.props.data_start.get_untracked() as usize;
        let Some(at) = row.checked_sub(start) else {
            return;
        };
        let st = self.st.borrow();
        let Some(column) = st.defs.get(def) else {
            return;
        };
        self.props.data.with_untracked(|d| {
            if at < d.len() {
                d.cell(at, &column.key, def).write_to(out);
            }
        });
    }

    /// The title of the column `def`.
    pub(crate) fn title(&self, def: usize) -> SharedString {
        self.st
            .borrow()
            .defs
            .get(def)
            .map(|c| c.title.clone().unwrap_or_else(|| c.key.clone()))
            .unwrap_or_default()
    }

    // Geometry.

    pub(crate) fn row_height(&self) -> f32 {
        self.props.row_height.get().0.max(1.0)
    }

    /// The height of one title row.
    fn header_row_height(&self) -> f32 {
        self.props
            .header_height
            .get()
            .map_or_else(|| self.row_height(), |h| h.0.max(1.0))
    }

    /// How many title rows there are: the group levels and the titles.
    pub(crate) fn header_levels(&self) -> usize {
        self.props.groups.with(|g| g.len()) + 1
    }

    pub(crate) fn font_css(&self) -> String {
        let family = self
            .props
            .font_family
            .get()
            .unwrap_or_else(|| "system-ui".into());
        let size = self.props.font_size.get().0;
        let generic = matches!(
            family.as_str(),
            "monospace" | "sans-serif" | "serif" | "system-ui" | "ui-monospace"
        );
        if generic {
            format!("{size}px {family}")
        } else {
            format!("{size}px \"{}\"", family.replace('"', ""))
        }
    }

    /// The width of the row header column (tracked): wide enough for the
    /// biggest row number.
    pub(crate) fn lead_width(&self) -> f32 {
        if !self.row_header_shown() {
            return 0.0;
        }
        let digits = self.row_count().max(1).ilog10() as usize + 1;
        let css = self.font_css();
        let digit = {
            let mut st = self.st.borrow_mut();
            match &st.digit {
                Some((c, w)) if *c == css => *w,
                _ => {
                    let w = measure_text(&css, "0000000000").0 / 10.0;
                    st.digit = Some((css, w));
                    w
                }
            }
        };
        (digit * digits as f32).max(40.0)
    }

    /// The sizes and offsets now (tracked).
    pub(crate) fn geo(&self) -> Geo {
        self.layout_rev.get();
        let size = self.viewport.get();
        let (width, height) = (size.width.0.max(0.0), size.height.0.max(0.0));
        let row_height = self.row_height();
        let header = self.header_row_height() * self.header_levels() as f32;
        let lead = self.lead_width();
        let rows = self.row_count();
        let (fixed, scroll_width) = {
            let st = self.st.borrow();
            (st.columns.fixed_width() as f32, st.columns.scroll_width())
        };
        let y = Axis::new(
            rows as f64 * row_height as f64,
            (height - header).max(0.0) as f64,
        );
        let x = Axis::new(scroll_width, (width - lead - fixed).max(0.0) as f64);
        let cx = x.content_offset(self.scroll_x.get().0 as f64);
        let cy = y.content_offset(self.scroll_y.get().0 as f64);
        Geo {
            row_height,
            header,
            lead,
            fixed,
            y,
            x,
            cx,
            cy,
        }
    }

    /// The rows in view (tracked).
    pub(crate) fn visible_rows(&self) -> Range<usize> {
        let g = self.geo();
        let rows = self.row_count();
        let rh = g.row_height as f64;
        let first = ((g.cy / rh).floor().max(0.0) as usize).min(rows);
        let last = (((g.cy + g.y.viewport) / rh).ceil().max(0.0) as usize).min(rows);
        first..last.max(first)
    }

    /// The display indexes of the scrolling columns in view (tracked).
    pub(crate) fn visible_cols(&self) -> Range<usize> {
        let g = self.geo();
        let st = self.st.borrow();
        let from = st.columns.fixed_width() + g.cx;
        st.columns.visible(from, from + g.x.viewport)
    }

    /// The rows to make (tracked): those in view and a reach around them.
    pub(crate) fn row_window(&self) -> Vec<usize> {
        let rows = self.row_count();
        self.rows_window.rows(self.visible_rows(), rows).collect()
    }

    /// The scrolling columns to make, as definition indexes (tracked).
    pub(crate) fn col_window(&self) -> Vec<usize> {
        let visible = self.visible_cols();
        let st = self.st.borrow();
        let n = st.columns.len();
        let fixed = st.columns.fixed_len();
        if visible.is_empty() {
            return Vec::new();
        }
        let window = self.cols_window.rows(visible, n);
        (window.start.max(fixed)..window.end)
            .map(|d| st.columns.def(d))
            .collect()
    }

    /// Where the scrolling column at `display` starts, from the scrolling
    /// columns' start.
    pub(crate) fn scroll_start(&self, display: usize) -> f64 {
        let st = self.st.borrow();
        st.columns.start(display) - st.columns.fixed_width()
    }

    // Reporting what is in view, and loading more.

    fn report(&self) {
        let dt = self.clone();
        effect(move || {
            let rows = dt.visible_rows();
            let cols = dt.visible_cols();
            let total = dt.row_count();
            let loading = dt.props.loading.get();
            let has_more = dt.props.has_more.get();
            let threshold = dt.props.load_more_threshold.get() as usize;
            untracked(|| {
                let (rows_changed, cols_changed, load) = {
                    let mut st = dt.st.borrow_mut();
                    let rows_changed = st.reported_rows.as_ref() != Some(&rows);
                    if rows_changed {
                        st.reported_rows = Some(rows.clone());
                    }
                    let cols_changed = st.reported_cols.as_ref() != Some(&cols);
                    if cols_changed {
                        st.reported_cols = Some(cols.clone());
                    }
                    let near = has_more && !loading && total > 0 && rows.end + threshold >= total;
                    let load = near && st.load_more_at != Some(total);
                    if load {
                        st.load_more_at = Some(total);
                    }
                    (rows_changed, cols_changed, load)
                };
                if rows_changed {
                    dt.cx
                        .emit(DataTableEvent::VisibleRowsChange(range_of(&rows)));
                }
                if cols_changed {
                    dt.cx
                        .emit(DataTableEvent::VisibleColumnsChange(range_of(&cols)));
                }
                if load {
                    dt.cx.emit(DataTableEvent::LoadMore);
                }
            });
        });
    }

    pub(crate) fn visible_rows_range(&self) -> DataTableRange {
        range_of(&untracked(|| self.visible_rows()))
    }

    pub(crate) fn visible_columns_range(&self) -> DataTableRange {
        range_of(&untracked(|| self.visible_cols()))
    }

    // Selection.

    pub(crate) fn selection(&self) -> Selection {
        self.data_rev.get();
        self.st.borrow().selection
    }

    pub(crate) fn selection_value(&self) -> Option<DataTableSelection> {
        to_public(self.st.borrow().selection)
    }

    /// Whether column `def` can be selected.
    pub(crate) fn selectable(&self, def: usize) -> bool {
        self.st
            .borrow()
            .defs
            .get(def)
            .is_none_or(|c| c.selectable.unwrap_or(true))
    }

    /// Makes `next` the selection; reports it to the app when `report`.
    fn set_selection(&self, next: Selection, report: bool) {
        let changed = {
            let mut st = self.st.borrow_mut();
            let changed = st.selection != next;
            st.selection = next;
            changed
        };
        if changed {
            self.bump_data();
            if report {
                self.cx
                    .emit(DataTableEvent::SelectionChange(to_public(next)));
            }
        }
    }

    pub(crate) fn select(&self, given: Option<DataTableSelection>, report: bool) {
        let next = given.map_or(Selection::None, from_public);
        let allowed = untracked(|| self.selectable_kinds());
        let rows = self.row_count();
        let columns = self.st.borrow().columns.len();
        self.set_selection(selection::clamp(next, allowed, rows, columns), report);
        self.reveal_selection();
    }

    fn selectable_columns(&self) -> Vec<usize> {
        let st = self.st.borrow();
        st.columns
            .order()
            .iter()
            .copied()
            .filter(|&d| st.defs.get(d).is_none_or(|c| c.selectable.unwrap_or(true)))
            .collect()
    }

    fn page_rows(&self) -> usize {
        let g = untracked(|| self.geo());
        ((g.y.viewport / g.row_height as f64).floor() as usize).max(1)
    }

    /// Moves the selection by a key.
    fn key_move(&self, movement: Move) {
        let columns = self.selectable_columns();
        let nav = Nav {
            selectable: untracked(|| self.selectable_kinds()),
            rows: self.row_count(),
            columns: &columns,
            page: self.page_rows(),
            wrap: self.props.loop_selection.get_untracked(),
        };
        let from = self.st.borrow().selection;
        if let Some(next) = nav.step(from, movement) {
            self.set_selection(next, true);
            self.reveal_selection();
        }
    }

    fn bind_keys(&self) {
        let dt = self.clone();
        effect(move || {
            if !dt.focused.get() {
                return;
            }
            let moves = [
                ("up", Move::Up, true),
                ("down", Move::Down, true),
                ("left", Move::Left, true),
                ("right", Move::Right, true),
                ("shift+tab", Move::Left, false),
                ("tab", Move::Right, false),
                ("pageup", Move::PageUp, true),
                ("pagedown", Move::PageDown, true),
                ("home", Move::First, true),
                ("end", Move::Last, true),
            ];
            for (keys, movement, repeat) in moves {
                let dt = dt.clone();
                on_key_with(
                    keys,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat,
                    },
                    move |_| dt.key_move(movement),
                );
            }
            // Escape clears the selection, and with nothing selected gives
            // up the keyboard.
            let esc = dt.clone();
            on_key_with("escape", KeyOptions::default(), move |_| {
                if esc.st.borrow().selection == Selection::None {
                    esc.set_focus(false);
                } else {
                    esc.set_selection(Selection::None, true);
                }
            });
            let copy = dt.clone();
            on_key_with(
                "mod+c",
                KeyOptions {
                    when: When::NotEditing,
                    repeat: false,
                },
                move |_| copy.copy_selection(),
            );
        });
    }

    pub(crate) fn set_focus(&self, focused: bool) {
        if self.focused.get_untracked() != focused {
            self.focused.set(focused);
        }
    }

    /// Scrolls the selection into view.
    fn reveal_selection(&self) {
        let sel = self.st.borrow().selection;
        if let Some(row) = sel.row() {
            self.reveal_row(row);
        }
        if let Some(def) = sel.column() {
            self.reveal_column(def);
        }
    }

    fn reveal_row(&self, row: usize) {
        let g = untracked(|| self.geo());
        let top = row as f64 * g.row_height as f64;
        let to = g.y.reveal(g.cy, top, top + g.row_height as f64);
        if to != g.cy {
            let y = g.y.scroll_points(to);
            self.vscroll.scroll_to(Point { x: Points::ZERO, y }, false);
        }
    }

    fn reveal_column(&self, def: usize) {
        let g = untracked(|| self.geo());
        let target = {
            let st = self.st.borrow();
            let Some(display) = st.columns.display_of(def) else {
                return;
            };
            // Fixed columns never scroll out.
            if display < st.columns.fixed_len() {
                return;
            }
            let start = st.columns.start(display) - st.columns.fixed_width();
            (start, start + st.columns.display_width(display) as f64)
        };
        let to = g.x.reveal(g.cx, target.0, target.1);
        if to != g.cx {
            let x = g.x.scroll_points(to);
            self.hscroll.scroll_to(Point { x, y: Points::ZERO }, false);
        }
    }

    pub(crate) fn scroll_to_row(&self, row: usize, animated: bool) {
        let g = untracked(|| self.geo());
        let rows = self.row_count();
        if rows == 0 {
            return;
        }
        let top = row.min(rows - 1) as f64 * g.row_height as f64;
        let y = g.y.scroll_points(top);
        self.vscroll
            .scroll_to(Point { x: Points::ZERO, y }, animated);
    }

    pub(crate) fn scroll_to_column(&self, key: &str, animated: bool) {
        let g = untracked(|| self.geo());
        let start = {
            let st = self.st.borrow();
            let Some(def) = st.defs.iter().position(|c| c.key == key) else {
                return;
            };
            let Some(display) = st.columns.display_of(def) else {
                return;
            };
            if display < st.columns.fixed_len() {
                return;
            }
            st.columns.start(display) - st.columns.fixed_width()
        };
        let x = g.x.scroll_points(start);
        self.hscroll
            .scroll_to(Point { x, y: Points::ZERO }, animated);
    }

    // Presses.

    /// What a press at `position` in the scrolled content is on.
    fn target_at(&self, position: Point<Points>) -> Hit {
        let g = untracked(|| self.geo());
        let vx = (position.x - self.scroll_x.get_untracked()).0 as f64;
        let vy = (position.y - self.scroll_y.get_untracked()).0 as f64;
        let row = {
            let at = ((g.cy + vy) / g.row_height as f64).floor();
            (at >= 0.0 && (at as usize) < self.row_count()).then_some(at as usize)
        };
        if vx < g.lead as f64 {
            return Hit {
                row,
                column: None,
                header: true,
            };
        }
        let column = {
            let st = self.st.borrow();
            st.columns
                .display_at(vx - g.lead as f64, g.cx)
                .map(|d| st.columns.def(d))
        };
        Hit {
            row,
            column,
            header: false,
        }
    }

    /// A press (or tap) of the body at `position` with the modifier keys
    /// held; `clicks` counts the presses in a row.
    pub(crate) fn press_with(&self, position: Point<Points>, clicks: u32, modifiers: Modifiers) {
        let hit = self.target_at(position);
        self.press_hit(hit, clicks, modifiers);
    }

    /// A press of a made row, the views that show the cells (a platform's
    /// pointer reaches the hit layer instead; assistive technologies and
    /// tests press what they see). `x` is in the row, whose left is where
    /// the region's cells start from: for the scrolling columns, the first
    /// of the chunk they are placed from (`origin`).
    pub(crate) fn press_row_with(
        &self,
        row: usize,
        region: PressRegion,
        x: Points,
        clicks: u32,
        modifiers: Modifiers,
    ) {
        let hit = self.row_hit(row, region, x);
        self.press_hit(hit, clicks, modifiers);
    }

    /// A context menu asked for at `x` in row `row`'s `region`, at `page`
    /// in the root (as [`Dt::press_row_with`]).
    pub(crate) fn row_context_menu(
        &self,
        row: usize,
        region: PressRegion,
        x: Points,
        page: Point<Points>,
    ) {
        let hit = self.row_hit(row, region, x);
        self.open_context_menu(hit, page);
    }

    /// A context menu asked for at column `def`'s title, at `page` in the
    /// root.
    pub(crate) fn header_context_menu(&self, def: usize, page: Point<Points>) {
        let hit = Hit {
            row: None,
            column: Some(def),
            header: false,
        };
        self.open_context_menu(hit, page);
    }

    /// What is at `x` in row `row`'s `region`.
    fn row_hit(&self, row: usize, region: PressRegion, x: Points) -> Hit {
        let column = {
            let st = self.st.borrow();
            let at = match region {
                PressRegion::Lead => None,
                PressRegion::Fixed => st.columns.display_at_table(x.0 as f64),
                PressRegion::Scroll { origin } => st
                    .columns
                    .display_at_table(st.columns.start(origin.min(st.columns.len())) + x.0 as f64),
            };
            at.map(|d| st.columns.def(d))
        };
        Hit {
            row: Some(row).filter(|&r| r < self.row_count()),
            column,
            header: region == PressRegion::Lead,
        }
    }

    /// Whether a press with `modifiers` held selects a row
    /// (`selectOnModifierPress`).
    fn selects_on(&self, modifiers: Modifiers) -> bool {
        let secondary = if matches!(os(), Os::Ios | Os::MacOs) {
            modifiers.cmd
        } else {
            modifiers.ctrl
        };
        self.props.select_on_modifier_press.get_untracked() || !(secondary || modifiers.shift)
    }

    /// What a press selects, as gpui-component's table: a cell when cells
    /// select (the selected cell again, without a row header, its row); a
    /// row when rows select, of a press of its row header or of a row whose
    /// cells do not select; with Shift or the secondary modifier only when
    /// `selectOnModifierPress`.
    fn press_hit(&self, hit: Hit, clicks: u32, modifiers: Modifiers) {
        self.set_focus(true);
        self.st.borrow_mut().active = None;
        let Some(row) = hit.row else {
            self.bump_data();
            return;
        };
        let allowed = untracked(|| self.selectable_kinds());
        let double = clicks == 2;
        let cell = hit.column.filter(|_| !hit.header && allowed.cells);
        let next = match cell {
            // A cell of a column that does not select: nothing.
            Some(c) if !self.selectable(c) => None,
            Some(c) => {
                let again = self.st.borrow().selection == Selection::Cell(row, c);
                let escalate = !untracked(|| self.row_header_shown())
                    && allowed.rows
                    && again
                    && !double
                    && self.selects_on(modifiers);
                Some(if escalate {
                    Selection::Row(row)
                } else {
                    Selection::Cell(row, c)
                })
            }
            None if allowed.rows && self.selects_on(modifiers) => Some(Selection::Row(row)),
            None => None,
        };
        if let Some(next) = next {
            self.set_selection(next, true);
        } else {
            self.bump_data();
        }
        self.cx.emit(DataTableEvent::RowPress(DataTablePress {
            row: row as u32,
            column: hit.column.filter(|_| !hit.header).map(|c| c as u32),
            clicks,
            shift: modifiers.shift,
            control: modifiers.ctrl,
            alt: modifiers.alt,
            platform: modifiers.cmd,
        }));
        if double {
            self.cx.emit(DataTableEvent::DoublePress(DataTableTarget {
                row: Some(row as u32),
                column: hit.column.filter(|_| !hit.header).map(|c| c as u32),
            }));
        }
    }

    /// The context menu's mark (the ref's `menuTarget`).
    pub(crate) fn menu_target(&self) -> Option<DataTableTarget> {
        self.st
            .borrow()
            .active
            .map(|(row, column)| DataTableTarget {
                row: row.map(|r| r as u32),
                column: column.map(|c| c as u32),
            })
    }

    /// Drops the context menu's mark.
    pub(crate) fn clear_menu_target(&self) {
        if self.st.borrow_mut().active.take().is_some() {
            self.bump_data();
        }
    }

    /// A context menu asked for at `position`.
    pub(crate) fn context_menu(&self, position: Point<Points>, page: Point<Points>) {
        let hit = self.target_at(position);
        self.open_context_menu(hit, page);
    }

    /// Marks what `hit` names as the menu's and tells the app
    /// (`onContextMenu`).
    fn open_context_menu(&self, hit: Hit, page: Point<Points>) {
        self.set_focus(true);
        let column = hit.column.filter(|_| !hit.header);
        // Where rows select and cells do not, the row is the menu's, as
        // gpui-component marks it.
        let cells = untracked(|| self.selectable_kinds()).cells;
        let mark = if hit.row.is_some() && !cells {
            None
        } else {
            column
        };
        self.st.borrow_mut().active = Some((hit.row, mark));
        self.bump_data();
        self.cx
            .emit(DataTableEvent::ContextMenu(DataTableContextMenu {
                row: hit.row.map(|r| r as u32),
                column: column.map(|c| c as u32),
                x: page.x,
                y: page.y,
            }));
    }

    /// The pointer moved over the body at `position`.
    pub(crate) fn hover_at(&self, position: Point<Points>) {
        let row = self.target_at(position).row;
        if self.hover.get_untracked() != row {
            self.hover.set(row);
        }
    }

    /// A title was pressed: it selects its column when columns select and
    /// the column does (sorting is the sort button's).
    pub(crate) fn header_press(&self, def: usize, clicks: u32) {
        self.set_focus(true);
        if self.props.column_selectable.get_untracked() && self.selectable(def) {
            self.set_selection(Selection::Column(def), true);
        }
        if clicks == 2 {
            self.cx.emit(DataTableEvent::DoublePress(DataTableTarget {
                row: None,
                column: Some(def as u32),
            }));
        }
    }

    /// The sort indicator was pressed: the next sort.
    pub(crate) fn sort_next(&self, def: usize) {
        let key = {
            let st = self.st.borrow();
            match st.defs.get(def) {
                Some(c) => c.key.clone(),
                None => return,
            }
        };
        let current = self.props.sort.get_untracked();
        let next = match current {
            Some(s) if s.key == key => match s.direction {
                DataTableSortDirection::Ascending => Some(DataTableSort {
                    key,
                    direction: DataTableSortDirection::Descending,
                }),
                DataTableSortDirection::Descending => None,
            },
            _ => Some(DataTableSort {
                key,
                direction: DataTableSortDirection::Ascending,
            }),
        };
        self.cx.emit(DataTableEvent::SortChange(next));
    }

    // Columns.

    pub(crate) fn resizable(&self, def: usize) -> bool {
        let table = self.props.resizable_columns.get();
        self.st
            .borrow()
            .defs
            .get(def)
            .is_some_and(|c| c.resizable.unwrap_or(table))
    }

    pub(crate) fn movable(&self, def: usize) -> bool {
        let table = self.props.movable_columns.get();
        self.st
            .borrow()
            .defs
            .get(def)
            .is_some_and(|c| c.movable.unwrap_or(table))
    }

    pub(crate) fn resize_start(&self, def: usize) {
        let width = self.st.borrow().columns.width(def);
        *self.resizing.borrow_mut() = Some((def, width));
    }

    pub(crate) fn resize_move(&self, offset: Points) {
        let Some((def, from)) = *self.resizing.borrow() else {
            return;
        };
        self.set_width(def, from + offset.0, true);
        // As gpui-component's: the edge being dragged stays in view, the
        // table scrolling as it passes the viewport's end.
        self.reveal_trailing_edge(def);
    }

    fn reveal_trailing_edge(&self, def: usize) {
        let g = untracked(|| self.geo());
        let end = {
            let st = self.st.borrow();
            let Some(display) = st.columns.display_of(def) else {
                return;
            };
            if display < st.columns.fixed_len() {
                return;
            }
            st.columns.start(display) - st.columns.fixed_width()
                + st.columns.display_width(display) as f64
        };
        if end <= g.cx + g.x.viewport {
            return;
        }
        let to = g.x.reveal(g.cx, end - 1.0, end);
        if to != g.cx {
            let x = g.x.scroll_points(to);
            self.hscroll.scroll_to(Point { x, y: Points::ZERO }, false);
        }
    }

    /// The drag ended at `offset`. A press that did not move the handle,
    /// twice in a row, fits the column.
    pub(crate) fn resize_end(&self, offset: Points) {
        let Some((def, _)) = self.resizing.borrow_mut().take() else {
            return;
        };
        if offset.0.abs() > MOVE_SLOP {
            *self.handle_tap.borrow_mut() = None;
            return;
        }
        let now = nsh_core::time::now();
        let previous = self.handle_tap.borrow_mut().take();
        match previous {
            Some((last, at)) if last == def && now.duration_since(at) < DOUBLE_PRESS => {
                self.fit(def);
            }
            _ => *self.handle_tap.borrow_mut() = Some((def, now)),
        }
    }

    /// Sets column `def`'s width; tells the app when it changed.
    fn set_width(&self, def: usize, width: f32, report: bool) -> Option<f32> {
        let (changed, now, key) = {
            let mut st = self.st.borrow_mut();
            if def >= st.defs.len() {
                return None;
            }
            let changed = st.columns.set_width(def, width);
            (changed, st.columns.width(def), st.defs[def].key.clone())
        };
        if changed {
            self.bump_layout();
            if report {
                self.cx.emit(DataTableEvent::ColumnResize(key, Points(now)));
            }
        }
        Some(now)
    }

    pub(crate) fn set_column_width(&self, key: &str, width: Points, report: bool) {
        let def = self.st.borrow().defs.iter().position(|c| c.key == key);
        if let Some(def) = def {
            self.set_width(def, width.0, report);
        }
    }

    pub(crate) fn column_widths(&self) -> Vec<Points> {
        self.st
            .borrow()
            .columns
            .widths()
            .iter()
            .map(|&w| Points(w))
            .collect()
    }

    /// Fits the column `key` to its widest text and title.
    pub(crate) fn fit_column(&self, key: &str) -> Option<Points> {
        let def = self.st.borrow().defs.iter().position(|c| c.key == key)?;
        self.fit(def).map(Points)
    }

    pub(crate) fn fit(&self, def: usize) -> Option<f32> {
        let css = self.font_css();
        let rows = self.row_count();
        let visible = untracked(|| self.visible_rows());
        let start = self.props.data_start.get_untracked() as usize;
        let loaded = start..start + self.props.data.with_untracked(|d| d.len());
        let from = visible.start.saturating_sub(FIT_ROWS).max(loaded.start);
        let to = (visible.end + FIT_ROWS).min(rows).min(loaded.end);
        let mut widest = measure_text(&css, &self.title(def)).0;
        let (sortable, padding) = {
            let st = self.st.borrow();
            let column = st.defs.get(def)?;
            (
                column.sortable,
                column.fit_padding.map_or(0.0, |p| p.0.max(0.0)),
            )
        };
        if sortable {
            widest += SORT_WIDTH;
        }
        let mut text = String::new();
        for row in from..to.max(from) {
            text.clear();
            self.write_cell(row, def, &mut text);
            if !text.is_empty() {
                widest = widest.max(measure_text(&css, &text).0);
            }
        }
        self.set_width(def, (widest + padding).ceil(), true)
    }

    /// A title was grabbed to move its column.
    pub(crate) fn move_start(&self, display: usize) {
        self.column_drag.set(Some(MoveDrag {
            from: display,
            to: display,
            moving: false,
        }));
    }

    /// The drag is at `x`, in the table's viewport: where it would drop.
    pub(crate) fn move_to(&self, x: f32, travelled: f32) {
        let Some(drag) = self.column_drag.get_untracked() else {
            return;
        };
        let g = untracked(|| self.geo());
        let to = {
            let st = self.st.borrow();
            let n = st.columns.len();
            let fixed = st.columns.fixed_len();
            let table_x = (x - g.lead) as f64;
            let at = if table_x < g.fixed as f64 {
                st.columns.display_at(table_x.max(0.0), 0.0)
            } else {
                st.columns.display_at(table_x, g.cx)
            };
            // Within the zone the column is in.
            let (low, high) = if drag.from < fixed {
                (0, fixed.saturating_sub(1))
            } else {
                (fixed, n.saturating_sub(1))
            };
            at.unwrap_or(if table_x < 0.0 { low } else { high })
                .clamp(low, high)
        };
        let next = MoveDrag {
            from: drag.from,
            to,
            moving: drag.moving || travelled.abs() > MOVE_SLOP,
        };
        if next != drag {
            self.column_drag.set(Some(next));
        }
    }

    pub(crate) fn move_end(&self, drop: bool) {
        let drag = self.column_drag.get_untracked();
        self.column_drag.set(None);
        let Some(drag) = drag else {
            return;
        };
        if !drop || !drag.moving || drag.from == drag.to {
            return;
        }
        let event = {
            let mut st = self.st.borrow_mut();
            let key = st.defs[st.columns.def(drag.from)].key.clone();
            if !st.columns.move_to(drag.from, drag.to) {
                return;
            }
            let order = st
                .columns
                .order()
                .iter()
                .map(|&d| st.defs[d].key.clone())
                .collect();
            super::DataTableColumnMove {
                key,
                from: drag.from as u32,
                to: drag.to as u32,
                order,
            }
        };
        self.bump_layout();
        self.cx.emit(DataTableEvent::ColumnMove(event));
    }

    // Text out.

    /// The titles and the texts of rows `start..end` (default all given).
    pub(crate) fn dump(&self, start: Option<usize>, end: Option<usize>) -> DataTableDump {
        let first = self.props.data_start.get_untracked() as usize;
        let given = first + self.props.data.with_untracked(|d| d.len());
        let rows = self.row_count();
        let from = start.unwrap_or(first).max(first);
        let to = end.unwrap_or(given).min(given).min(rows);
        let order: Vec<usize> = self.st.borrow().columns.order().to_vec();
        let headers = order.iter().map(|&d| self.title(d).to_string()).collect();
        let rows = (from..to.max(from))
            .map(|row| {
                order
                    .iter()
                    .map(|&d| {
                        let mut text = String::new();
                        self.write_cell(row, d, &mut text);
                        text
                    })
                    .collect()
            })
            .collect();
        DataTableDump { headers, rows }
    }

    /// The text of the selection: a row's cells with tabs, a column's with
    /// line breaks, a cell's.
    pub(crate) fn selection_text(&self) -> Option<String> {
        let sel = self.st.borrow().selection;
        let order: Vec<usize> = self.st.borrow().columns.order().to_vec();
        let mut text = String::new();
        match sel {
            Selection::None => return None,
            Selection::Cell(row, def) => self.write_cell(row, def, &mut text),
            Selection::Row(row) => {
                for (i, &def) in order.iter().enumerate() {
                    if i > 0 {
                        text.push('\t');
                    }
                    self.write_cell(row, def, &mut text);
                }
            }
            Selection::Column(def) => {
                let rows = self.row_count().min(COPY_ROWS);
                for row in 0..rows {
                    if row > 0 {
                        text.push('\n');
                    }
                    self.write_cell(row, def, &mut text);
                }
            }
        }
        Some(text)
    }

    pub(crate) fn copy_selection(&self) {
        if let Some(text) = self.selection_text() {
            set_clipboard(text);
        }
    }
}

/// The region of the body a made row is in (`Dt::press_row`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PressRegion {
    Lead,
    Fixed,
    /// The scrolling columns, placed from the column at display index
    /// `origin`.
    Scroll {
        origin: usize,
    },
}

/// What a press landed on.
#[derive(Debug, Clone, Copy)]
struct Hit {
    row: Option<usize>,
    /// The column's definition index.
    column: Option<usize>,
    /// The row header.
    header: bool,
}

fn range_of(range: &Range<usize>) -> DataTableRange {
    DataTableRange {
        start: range.start as u32,
        end: range.end as u32,
    }
}

fn to_public(selection: Selection) -> Option<DataTableSelection> {
    match selection {
        Selection::None => None,
        Selection::Row(r) => Some(DataTableSelection {
            row: Some(r as u32),
            column: None,
        }),
        Selection::Column(c) => Some(DataTableSelection {
            row: None,
            column: Some(c as u32),
        }),
        Selection::Cell(r, c) => Some(DataTableSelection {
            row: Some(r as u32),
            column: Some(c as u32),
        }),
    }
}

fn from_public(selection: DataTableSelection) -> Selection {
    match (selection.row, selection.column) {
        (Some(r), Some(c)) => Selection::Cell(r as usize, c as usize),
        (Some(r), None) => Selection::Row(r as usize),
        (None, Some(c)) => Selection::Column(c as usize),
        (None, None) => Selection::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selections_convert_both_ways() {
        for s in [
            Selection::None,
            Selection::Row(3),
            Selection::Column(2),
            Selection::Cell(4, 1),
        ] {
            assert_eq!(from_public(to_public(s).unwrap_or_default()), s);
        }
    }

    #[test]
    fn a_column_without_limits_gets_the_defaults() {
        let spec = spec_of(&DataTableColumn::default());
        assert_eq!((spec.width, spec.min, spec.max), (120.0, 20.0, 1200.0));
        let column = DataTableColumn {
            min_width: Some(Points(300.0)),
            max_width: Some(Points(100.0)),
            ..Default::default()
        };
        let spec = spec_of(&column);
        assert!(spec.max >= spec.min);
    }
}
