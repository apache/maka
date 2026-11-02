//! Tables in the view: a table node is a grid whose items are its cells
//! (rows have no view: the walk of the tree flattens them), each placed at
//! its slots of the table's map, the columns as wide as their `colwidth`
//! (else sharing the room, at least `cellMinWidth`), the rows at least
//! their `height`. Over the content box: the handles resizing columns and
//! rows on their right and bottom borders, the grips of the table the
//! selection is in (on its top and left borders), which select a column or
//! a row and drag it elsewhere, and the line showing where it drops. The
//! gestures are the content box's own presses and drags, so they take
//! nothing from its selecting: a press on a handle or a grip starts one.

use nsh_core::prelude::*;
use serde_json::Value;

use super::{
    controller::{BlockItem, Rv},
    geometry::Hit,
    parts::Part,
    render::part,
};
use crate::{
    rich_editor::{
        commands::BoxCommand,
        model::{Node, ResolvedPos},
        state::{Selection, TextSelection},
        tables::{
            Axis, CellSelection, TableMap, TableRole, cell_around, column_widths,
            commands::{move_table_column, move_table_row, set_column_width, set_row_height},
            find_table, is_cell, is_table, next_cell, table_role,
        },
    },
    theme,
};

/// Half the width of the band a column's (row's) border is resized from.
const HANDLE: f32 = 3.0;

/// A grip's band: its length along the border and its depth across it.
const GRIP: (f32, f32) = (24.0, 12.0);

/// How far a grip drags before it moves its row or column.
const DRAG_SLOP: f32 = 4.0;

/// The least height a row resizes to.
const MIN_ROW_HEIGHT: f32 = 16.0;

/// A table as laid out: in the content box.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TableLayout {
    /// The position before the table.
    pub(crate) pos: usize,
    /// Its box.
    pub(crate) bounds: Bounds<Points>,
    /// Each column's left and right.
    pub(crate) cols: Vec<(Points, Points)>,
    /// Each row's top and bottom.
    pub(crate) rows: Vec<(Points, Points)>,
    /// The least width of a column (`cellMinWidth`).
    pub(crate) min_width: Points,
    /// Whether columns and rows resize (`resizable`).
    pub(crate) resizable: bool,
    /// Whether the last column resizes too (`lastColumnResizable`).
    pub(crate) last_column_resizable: bool,
}

/// A gesture on a table, from a press on a handle or a grip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum TableDrag {
    /// Resizing column `col`, `start` wide at the press at x `from`.
    ColWidth {
        table: usize,
        col: usize,
        start: Points,
        from: Points,
        min: Points,
    },
    /// Resizing row `row`, `start` high at the press at y `from`.
    RowHeight {
        table: usize,
        row: usize,
        start: Points,
        from: Points,
    },
    /// Moving column `from` (pressed at `press`), over column `to`.
    MoveCol {
        table: usize,
        from: usize,
        press: Point<Points>,
        to: Option<usize>,
    },
    /// Moving row `from`, over row `to`.
    MoveRow {
        table: usize,
        from: usize,
        press: Point<Points>,
        to: Option<usize>,
    },
}

/// A table gesture with what turns the pointer's place in the root into
/// the content box's.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TableGesture {
    pub(crate) drag: TableDrag,
    /// The press in the content less the press in the root.
    pub(crate) shift: Point<Points>,
    /// The scroll offset at the press.
    pub(crate) scroll: Points,
}

/// What a table gesture shows while it lasts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum TablePreview {
    /// Column `col` of the table at `table` is `width` wide.
    ColWidth {
        table: usize,
        col: usize,
        width: Points,
    },
    /// Row `row` is `height` high.
    RowHeight {
        table: usize,
        row: usize,
        height: Points,
    },
    /// A dragged row or column drops at this line.
    Drop(Bounds<Points>),
}

/// The table's options from its spec's `extra`: `cellMinWidth`,
/// `resizable`, `lastColumnResizable`.
fn options(table: &Node) -> (Points, bool, bool) {
    let extra = &table.ty().spec().extra;
    let min = extra
        .get("cellMinWidth")
        .and_then(Value::as_f64)
        .unwrap_or(25.0) as f32;
    let flag = |key: &str| extra.get(key).and_then(Value::as_bool).unwrap_or(true);
    (px(min), flag("resizable"), flag("lastColumnResizable"))
}

/// A length for a grid track (`120px`).
fn track_px(value: Points) -> String {
    format!("{}px", (value.0 * 10.0).round() / 10.0)
}

/// The grid's columns: each `colwidth`'s (the preview's for the column
/// being resized), else a share of the room, at least `cellMinWidth`.
pub(crate) fn column_tracks(table: &Node, preview: Option<(usize, Points)>) -> String {
    let (min, _, _) = options(table);
    column_widths(table)
        .into_iter()
        .enumerate()
        .map(|(i, width)| {
            let width = match preview {
                Some((col, w)) if col == i => Some(w),
                _ => width,
            };
            match width {
                Some(w) => track_px(w.max(min)),
                None => format!("minmax({},1fr)", track_px(min)),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether every column has a width: the table is then as wide as they
/// are, not as its container.
pub(crate) fn fixed_width(table: &Node) -> bool {
    let widths = column_widths(table);
    !widths.is_empty() && widths.iter().all(Option::is_some)
}

/// The grid's rows: at least each row's `height` (the preview's for the
/// row being resized), else as high as their content.
pub(crate) fn row_tracks(table: &Node, preview: Option<(usize, Points)>) -> String {
    (0..table.child_count())
        .map(|i| {
            let height = match preview {
                Some((row, h)) if row == i => Some(h),
                _ => table
                    .child(i)
                    .attrs()
                    .get("height")
                    .and_then(Value::as_f64)
                    .filter(|h| *h > 0.0)
                    .map(|h| px(h as f32)),
            };
            match height {
                Some(h) => format!("minmax({},auto)", track_px(h)),
                None => "auto".to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Where a cell sits in its table's grid: its first column and row lines
/// and the lines it ends at (1-based, as CSS counts them).
pub(crate) fn placement(doc: &Node, cell_pos: usize) -> Option<(i16, i16, i16, i16)> {
    let at = doc.resolve(cell_pos).ok()?;
    let depth = at.depth.checked_sub(1)?;
    let table = at.node(depth);
    let map = TableMap::get(table);
    let rect = map.try_find_cell(cell_pos - at.start(depth))?;
    let line = |n: usize| i16::try_from(n + 1).unwrap_or(i16::MAX);
    Some((
        line(rect.left),
        line(rect.right),
        line(rect.top),
        line(rect.bottom),
    ))
}

/// A table's block: a grid, its top and left borders the theme's.
pub(crate) fn grid(wrapper: View, rv: &Rv, item: ReadSignal<BlockItem>) -> View {
    let (cols_rv, rows_rv) = (rv.clone(), rv.clone());
    wrapper
        .grid()
        .grid_template_columns(move || {
            let it = item.get();
            let preview = match cols_rv.table_preview.get() {
                Some(TablePreview::ColWidth { table, col, width }) if table == it.pos => {
                    Some((col, width))
                }
                _ => None,
            };
            SharedString::from(column_tracks(&it.node, preview))
        })
        .grid_template_rows(move || {
            let it = item.get();
            let preview = match rows_rv.table_preview.get() {
                Some(TablePreview::RowHeight { table, row, height }) if table == it.pos => {
                    Some((row, height))
                }
                _ => None,
            };
            SharedString::from(row_tracks(&it.node, preview))
        })
        .style_when(move || fixed_width(&item.get().node), |s| s.self_start())
        .border_t(px(1.0))
        .border_l(px(1.0))
        .border_color(move || theme().border)
}

/// A cell's block: placed at its slots, its right and bottom borders the
/// theme's, header cells on the theme's `muted`, and over its content
/// while a cell selection holds it, the `selectedCell` part (the theme's
/// selection color).
pub(crate) fn cell(wrapper: View, rv: &Rv, item: ReadSignal<BlockItem>) -> View {
    let header = table_role(item.get_untracked().node.ty()) == Some(TableRole::HeaderCell);
    let place_rv = rv.clone();
    let at = computed(move || {
        place_rv.doc_rev.get();
        let it = item.get();
        let state = place_rv.st.borrow();
        placement(state.doc(), it.pos).unwrap_or((1, 2, 1, 2))
    });
    let selected_rv = rv.clone();
    let selected = move || {
        selected_rv.sel_rev.get();
        let it = item.get();
        let state = selected_rv.st.borrow();
        state
            .selection()
            .as_custom::<CellSelection>()
            .is_some_and(|cells| cells.contains_cell(it.pos))
    };
    let overlay_rv = rv.clone();
    wrapper
        .relative()
        .min_w(px(0.0))
        .col_start(move || at.get().0)
        .col_end(move || at.get().1)
        .row_start(move || at.get().2)
        .row_end(move || at.get().3)
        .px(px(8.0))
        .py(px(4.0))
        .border_r(px(1.0))
        .border_b(px(1.0))
        .border_color(move || theme().border)
        .when(header, |v| v.bg(move || theme().muted))
        .child(when(selected, move || {
            part(
                view()
                    .absolute()
                    .left(px(0.0))
                    .top(px(0.0))
                    .size_full()
                    .pointer_events(PointerEvents::None)
                    .bg(move || theme().selection()),
                &overlay_rv,
                Part::SelectedCell,
            )
        }))
}

/// The handles, grips and drop line of the tables, over the content.
pub(crate) fn controls(rv: Rv) -> impl IntoElement {
    dynamic(move || {
        rv.layout_rev.get();
        rv.doc_rev.get();
        rv.sel_rev.get();
        let preview = rv.table_preview.get();
        if !rv.props.editable.get() {
            return Vec::new();
        }
        let layouts = rv.table_layouts();
        let active = rv.active_table();
        let mut out: Vec<AnyElement> = Vec::new();
        for layout in &layouts {
            if layout.resizable && is_desktop() {
                out.extend(resize_handles(&rv, layout, preview));
            }
            if Some(layout.pos) == active {
                out.extend(grips(&rv, layout));
            }
        }
        if let Some(TablePreview::Drop(line)) = preview {
            out.push(
                part(
                    view()
                        .absolute()
                        .left(Length::from(line.origin.x))
                        .top(Length::from(line.origin.y))
                        .w(Length::from(line.size.width))
                        .h(Length::from(line.size.height))
                        .pointer_events(PointerEvents::None)
                        .bg(move || theme().primary),
                    &rv,
                    Part::TableDropIndicator,
                )
                .into_element(),
            );
        }
        out
    })
}

/// A band at `b` with `cursor`, its line (`line`, in the band) showing
/// on hover and while `active`.
fn band(
    rv: &Rv,
    b: Bounds<Points>,
    line: Bounds<Points>,
    cursor: Cursor,
    active: bool,
) -> AnyElement {
    view()
        .absolute()
        .left(Length::from(b.origin.x))
        .top(Length::from(b.origin.y))
        .w(Length::from(b.size.width))
        .h(Length::from(b.size.height))
        .cursor(cursor)
        .group()
        .child(part(
            view()
                .absolute()
                .left(Length::from(line.origin.x))
                .top(Length::from(line.origin.y))
                .w(Length::from(line.size.width))
                .h(Length::from(line.size.height))
                .pointer_events(PointerEvents::None)
                .bg(move || theme().primary)
                .opacity(if active { 1.0 } else { 0.0 })
                .group_hover(|s| s.opacity(1.0)),
            rv,
            Part::TableResizeHandle,
        ))
        .into_element()
}

fn resize_handles(rv: &Rv, t: &TableLayout, preview: Option<TablePreview>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    let b = t.bounds;
    for (c, (_, right)) in t.cols.iter().enumerate() {
        if c + 1 == t.cols.len() && !t.last_column_resizable {
            continue;
        }
        let active = matches!(preview, Some(TablePreview::ColWidth { table, col, .. })
            if table == t.pos && col == c);
        out.push(band(
            rv,
            Bounds::new(
                Point::new(*right - px(HANDLE), b.origin.y),
                Size::new(px(HANDLE * 2.0), b.size.height),
            ),
            Bounds::new(
                Point::new(px(HANDLE - 1.0), px(0.0)),
                Size::new(px(2.0), b.size.height),
            ),
            Cursor::ColResize,
            active,
        ));
    }
    for (r, (_, bottom)) in t.rows.iter().enumerate() {
        let active = matches!(preview, Some(TablePreview::RowHeight { table, row, .. })
            if table == t.pos && row == r);
        out.push(band(
            rv,
            Bounds::new(
                Point::new(b.origin.x, *bottom - px(HANDLE)),
                Size::new(b.size.width, px(HANDLE * 2.0)),
            ),
            Bounds::new(
                Point::new(px(0.0), px(HANDLE - 1.0)),
                Size::new(b.size.width, px(2.0)),
            ),
            Cursor::RowResize,
            active,
        ));
    }
    out
}

/// The grip bands of a column (on the table's top border, centered over
/// it) and of a row (on its left border).
fn col_grip(t: &TableLayout, col: usize) -> Bounds<Points> {
    let (left, right) = t.cols[col];
    let center = (left + right) * 0.5;
    Bounds::new(
        Point::new(
            center - px(GRIP.0 / 2.0),
            t.bounds.origin.y - px(GRIP.1 / 2.0),
        ),
        Size::new(px(GRIP.0), px(GRIP.1)),
    )
}

fn row_grip(t: &TableLayout, row: usize) -> Bounds<Points> {
    let (top, bottom) = t.rows[row];
    let center = (top + bottom) * 0.5;
    Bounds::new(
        Point::new(
            t.bounds.origin.x - px(GRIP.1 / 2.0),
            center - px(GRIP.0 / 2.0),
        ),
        Size::new(px(GRIP.1), px(GRIP.0)),
    )
}

/// The grips: a small bar on each, in the theme's `muted-foreground` (the
/// `tableGrip` part).
fn grips(rv: &Rv, t: &TableLayout) -> Vec<AnyElement> {
    let bar = |b: Bounds<Points>, horizontal: bool| {
        let (w, h) = if horizontal { (16.0, 4.0) } else { (4.0, 16.0) };
        view()
            .absolute()
            .left(Length::from(b.origin.x))
            .top(Length::from(b.origin.y))
            .w(Length::from(b.size.width))
            .h(Length::from(b.size.height))
            .items_center()
            .justify_center()
            .cursor(Cursor::Grab)
            .child(part(
                view()
                    .w(px(w))
                    .h(px(h))
                    .rounded(px(2.0))
                    .pointer_events(PointerEvents::None)
                    .bg(move || theme().muted_foreground.opacity(0.6)),
                rv,
                Part::TableGrip,
            ))
            .into_element()
    };
    let mut out: Vec<AnyElement> = (0..t.cols.len())
        .map(|c| bar(col_grip(t, c), true))
        .collect();
    out.extend((0..t.rows.len()).map(|r| bar(row_grip(t, r), false)));
    out
}

fn contains(b: &Bounds<Points>, p: Point<Points>) -> bool {
    p.x >= b.origin.x
        && p.x < b.origin.x + b.size.width
        && p.y >= b.origin.y
        && p.y < b.origin.y + b.size.height
}

/// The cells of column `col` (row `row`) of the table at `table`, as a
/// column (row) selection.
fn line_selection(doc: &Node, table: usize, axis: Axis, index: usize) -> Option<Selection> {
    let node = doc.node_at(table)?;
    let map = TableMap::get(&node);
    let start = table + 1;
    let (first, last) = match axis {
        Axis::Horizontal => (
            map.map.get(index)?,
            map.map.get((map.height - 1) * map.width + index)?,
        ),
        Axis::Vertical => (
            map.map.get(index * map.width)?,
            map.map.get(index * map.width + map.width - 1)?,
        ),
    };
    let (a, b) = (
        doc.resolve(start + first).ok()?,
        doc.resolve(start + last).ok()?,
    );
    match axis {
        Axis::Horizontal => CellSelection::col_selection(a, b),
        Axis::Vertical => CellSelection::row_selection(a, b),
    }
    .map(Into::into)
}

impl Rv {
    /// The place at `at` (content box): in the innermost cell it is in,
    /// that cell's (a neighbor's text beside it may be nearer), else the
    /// nearest anywhere.
    pub(crate) fn hit(&self, at: Point<Points>) -> Option<Hit> {
        let range = {
            let tree = self.tree.borrow();
            let geo = self.geo.borrow();
            tree.children
                .values()
                .flatten()
                .filter(|b| is_cell(&b.node))
                .filter(|b| {
                    let (Some(o), Some((_, f))) = (geo.origin(b.id), geo.frames.get(&b.id)) else {
                        return false;
                    };
                    contains(&Bounds::new(o, f.size), at)
                })
                .min_by_key(|b| b.node.node_size())
                .map(|b| (b.pos, b.pos + b.node.node_size()))
        };
        let geo = self.geo.borrow();
        range
            .and_then(|range| geo.hit_in(at, Some(range)))
            .or_else(|| geo.hit(at))
    }

    /// The tables as laid out, from their cells' frames.
    pub(crate) fn table_layouts(&self) -> Vec<TableLayout> {
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        let mut out = Vec::new();
        for item in tree.children.values().flatten() {
            if !is_table(&item.node) {
                continue;
            }
            let (Some(origin), Some((_, frame))) = (geo.origin(item.id), geo.frames.get(&item.id))
            else {
                continue;
            };
            let bounds = Bounds::new(origin, frame.size);
            let map = TableMap::get(&item.node);
            let start = item.pos + 1;
            let mut lefts = vec![None; map.width];
            let mut rights = vec![None; map.width];
            let mut tops = vec![None; map.height];
            let mut bottoms = vec![None; map.height];
            for cell in tree.children.get(&item.id).into_iter().flatten() {
                let Some(rect) = cell
                    .pos
                    .checked_sub(start)
                    .and_then(|p| map.try_find_cell(p))
                else {
                    continue;
                };
                let (Some(o), Some((_, f))) = (geo.origin(cell.id), geo.frames.get(&cell.id))
                else {
                    continue;
                };
                lefts[rect.left] = Some(o.x);
                rights[rect.right - 1] = Some(o.x + f.size.width);
                tops[rect.top] = Some(o.y);
                bottoms[rect.bottom - 1] = Some(o.y + f.size.height);
            }
            let cols = edges(
                &lefts,
                &rights,
                bounds.origin.x,
                bounds.origin.x + bounds.size.width,
            );
            let rows = edges(
                &tops,
                &bottoms,
                bounds.origin.y,
                bounds.origin.y + bounds.size.height,
            );
            let (min_width, resizable, last_column_resizable) = options(&item.node);
            out.push(TableLayout {
                pos: item.pos,
                bounds,
                cols,
                rows,
                min_width,
                resizable,
                last_column_resizable,
            });
        }
        crate::sort::sort_by_key(&mut out, |t| t.pos);
        out
    }

    /// The table the selection is in (the innermost), by position.
    pub(crate) fn active_table(&self) -> Option<usize> {
        let state = self.st.borrow();
        find_table(state.selection().resolved_head()).map(|t| t.pos)
    }

    /// The table gesture a press at `at` (content box) starts: on a grip
    /// of the table the selection is in, else on a column's or row's
    /// border.
    pub(crate) fn table_target(&self, at: Point<Points>) -> Option<TableDrag> {
        let layouts = self.table_layouts();
        let active = self.active_table();
        // Inner tables first: their grips and borders lie over the outer's.
        for t in layouts.iter().rev() {
            if Some(t.pos) == active {
                for c in 0..t.cols.len() {
                    if contains(&col_grip(t, c), at) {
                        return Some(TableDrag::MoveCol {
                            table: t.pos,
                            from: c,
                            press: at,
                            to: None,
                        });
                    }
                }
                for r in 0..t.rows.len() {
                    if contains(&row_grip(t, r), at) {
                        return Some(TableDrag::MoveRow {
                            table: t.pos,
                            from: r,
                            press: at,
                            to: None,
                        });
                    }
                }
            }
            if !t.resizable || !is_desktop() || !contains(&t.bounds, at) {
                continue;
            }
            let near = |edge: Points, v: Points| (edge - v).0.abs() <= HANDLE;
            for (c, (left, right)) in t.cols.iter().enumerate() {
                if c + 1 == t.cols.len() && !t.last_column_resizable {
                    continue;
                }
                if near(*right, at.x) {
                    return Some(TableDrag::ColWidth {
                        table: t.pos,
                        col: c,
                        start: *right - *left,
                        from: at.x,
                        min: t.min_width,
                    });
                }
            }
            for (r, (top, bottom)) in t.rows.iter().enumerate() {
                if near(*bottom, at.y) {
                    return Some(TableDrag::RowHeight {
                        table: t.pos,
                        row: r,
                        start: *bottom - *top,
                        from: at.y,
                    });
                }
            }
        }
        None
    }

    /// A press starting table gesture `drag`: a grip selects its column or
    /// row at once; the rest happens as it drags (desktops: a finger's
    /// press is a tap).
    pub(crate) fn start_table_drag(&self, drag: TableDrag, at: Point<Points>, page: Point<Points>) {
        let doc = self.session.state().doc().clone();
        let selection = match drag {
            TableDrag::MoveCol { table, from, .. } => {
                line_selection(&doc, table, Axis::Horizontal, from)
            }
            TableDrag::MoveRow { table, from, .. } => {
                line_selection(&doc, table, Axis::Vertical, from)
            }
            _ => None,
        };
        if let Some(selection) = selection {
            self.set_selection(selection, false);
        }
        if is_desktop() {
            *self.table_gesture.borrow_mut() = Some(TableGesture {
                drag,
                shift: Point::new(at.x - page.x, at.y - page.y),
                scroll: self.scroll_y.get_untracked(),
            });
        }
    }

    /// Whether a table gesture is under way.
    pub(crate) fn table_dragging(&self) -> bool {
        self.table_gesture.borrow().is_some()
    }

    /// The pointer of a table gesture moved to `page` (root).
    pub(crate) fn table_drag_to(&self, page: Point<Points>) {
        let Some(mut gesture) = *self.table_gesture.borrow() else {
            return;
        };
        let scrolled = self.scroll_y.get_untracked() - gesture.scroll;
        let at = Point::new(
            page.x + gesture.shift.x,
            page.y + gesture.shift.y + scrolled,
        );
        let preview = match &mut gesture.drag {
            TableDrag::ColWidth {
                table,
                col,
                start,
                from,
                min,
            } => Some(TablePreview::ColWidth {
                table: *table,
                col: *col,
                width: (*start + at.x - *from).max(*min),
            }),
            TableDrag::RowHeight {
                table,
                row,
                start,
                from,
            } => Some(TablePreview::RowHeight {
                table: *table,
                row: *row,
                height: (*start + at.y - *from).max(px(MIN_ROW_HEIGHT)),
            }),
            TableDrag::MoveCol {
                table,
                from,
                press,
                to,
            } => {
                if to.is_none() && (at.x - press.x).0.abs() < DRAG_SLOP {
                    return;
                }
                let layout = self.table_layouts().into_iter().find(|t| t.pos == *table);
                layout.and_then(|t| {
                    let target = index_at(&t.cols, at.x)?;
                    *to = Some(target);
                    let x = if target < *from {
                        t.cols[target].0
                    } else {
                        t.cols[target].1
                    };
                    Some(TablePreview::Drop(Bounds::new(
                        Point::new(x - px(1.0), t.bounds.origin.y),
                        Size::new(px(2.0), t.bounds.size.height),
                    )))
                })
            }
            TableDrag::MoveRow {
                table,
                from,
                press,
                to,
            } => {
                if to.is_none() && (at.y - press.y).0.abs() < DRAG_SLOP {
                    return;
                }
                let layout = self.table_layouts().into_iter().find(|t| t.pos == *table);
                layout.and_then(|t| {
                    let target = index_at(&t.rows, at.y)?;
                    *to = Some(target);
                    let y = if target < *from {
                        t.rows[target].0
                    } else {
                        t.rows[target].1
                    };
                    Some(TablePreview::Drop(Bounds::new(
                        Point::new(t.bounds.origin.x, y - px(1.0)),
                        Size::new(t.bounds.size.width, px(2.0)),
                    )))
                })
            }
        };
        *self.table_gesture.borrow_mut() = Some(gesture);
        if self.table_preview.get_untracked() != preview {
            self.table_preview.set(preview);
        }
    }

    /// A table gesture ended: the width, height or move it previewed, as
    /// one change.
    pub(crate) fn table_release(&self) {
        let gesture = self.table_gesture.borrow_mut().take();
        let preview = self.table_preview.get_untracked();
        if preview.is_some() {
            self.table_preview.set(None);
        }
        let Some(gesture) = gesture else {
            return;
        };
        if !self.editable() {
            return;
        }
        let command: Option<BoxCommand> = match (gesture.drag, preview) {
            (
                TableDrag::ColWidth {
                    table, col, start, ..
                },
                Some(TablePreview::ColWidth { width, .. }),
            ) if width != start => Some(set_column_width(Some(table), col, Some(width))),
            (
                TableDrag::RowHeight {
                    table, row, start, ..
                },
                Some(TablePreview::RowHeight { height, .. }),
            ) if height != start => Some(set_row_height(Some(table), row, Some(height))),
            (
                TableDrag::MoveCol {
                    table,
                    from,
                    to: Some(to),
                    ..
                },
                _,
            ) if to != from => Some(move_table_column(Some(table), from, to, true)),
            (
                TableDrag::MoveRow {
                    table,
                    from,
                    to: Some(to),
                    ..
                },
                _,
            ) if to != from => Some(move_table_row(Some(table), from, to, true)),
            _ => None,
        };
        if let Some(command) = command {
            self.run_command(&command);
        }
    }

    /// Runs `command` on the session's state, dispatching what it does.
    pub(crate) fn run_command(&self, command: &BoxCommand) -> bool {
        let state = self.session.state();
        let mut trs = Vec::new();
        let applied = command(&state, Some(&mut |tr| trs.push(tr)));
        for tr in trs {
            self.dispatch(tr);
        }
        applied
    }

    /// The box around a cell selection's cells (none for other
    /// selections).
    pub(crate) fn cells_box(&self) -> Option<Bounds<Points>> {
        let positions = {
            let state = self.st.borrow();
            state
                .selection()
                .as_custom::<CellSelection>()?
                .cell_positions()
        };
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        tree.children
            .values()
            .flatten()
            .filter(|b| positions.contains(&b.pos))
            .filter_map(|b| {
                let origin = geo.origin(b.id)?;
                let (_, frame) = geo.frames.get(&b.id)?;
                Some(Bounds::new(origin, frame.size))
            })
            .reduce(|a, b| a.union(&b))
    }

    /// Up or Down (`dir`) from the first or last line of a cell's first or
    /// last textblock: into the cell above or below, at the x the caret
    /// keeps (none when there is no such cell, or the caret is not there).
    pub(crate) fn table_vertical(
        &self,
        head: &ResolvedPos,
        x: Points,
        dir: i32,
    ) -> Option<Selection> {
        let cell = cell_around(head)?;
        // The head's textblock is the cell's first (last) block, all the
        // way down.
        for d in (cell.depth + 1)..head.depth {
            let index = head.index(d);
            let edge = if dir < 0 {
                0
            } else {
                head.node(d).child_count().checked_sub(1)?
            };
            if index != edge {
                return None;
            }
        }
        let next = next_cell(&cell, Axis::Vertical, dir)?;
        let frame = {
            let tree = self.tree.borrow();
            let geo = self.geo.borrow();
            tree.children
                .values()
                .flatten()
                .find(|b| b.pos == next.pos)
                .and_then(|b| {
                    Some(Bounds::new(
                        geo.origin(b.id)?,
                        geo.frames.get(&b.id)?.1.size,
                    ))
                })
        };
        let doc = head.doc();
        if let Some(frame) = frame {
            let y = if dir > 0 {
                frame.origin.y + px(1.0)
            } else {
                frame.origin.y + frame.size.height - px(1.0)
            };
            let x = x
                .max(frame.origin.x)
                .min(frame.origin.x + frame.size.width - px(1.0));
            let range = next
                .node_after()
                .map(|cell| (next.pos, next.pos + cell.node_size()));
            if let Some(Hit::Text(pos, side)) = self.geo.borrow().hit_in(Point::new(x, y), range)
                && let Ok(at) = doc.resolve(pos)
            {
                return Some(TextSelection::with_affinity(at.clone(), at, side).into());
            }
        }
        if dir > 0 {
            Some(Selection::near(&next, 1))
        } else {
            let node = next.node_after()?;
            let end = doc.resolve(next.pos + node.node_size() - 1).ok()?;
            Some(Selection::near(&end, -1))
        }
    }
}

/// The index of the line (column or row) spanning `v`, the nearest end's
/// past them.
fn index_at(lines: &[(Points, Points)], v: Points) -> Option<usize> {
    if lines.is_empty() {
        return None;
    }
    if let Some(i) = lines.iter().position(|(a, b)| v >= *a && v < *b) {
        return Some(i);
    }
    Some(if v < lines[0].0 { 0 } else { lines.len() - 1 })
}

/// Each line's start and end from the cells starting and ending at it,
/// the neighbors' where no cell does, the table's edges at its ends.
fn edges(
    starts: &[Option<Points>],
    ends: &[Option<Points>],
    first: Points,
    last: Points,
) -> Vec<(Points, Points)> {
    let n = starts.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = starts[i]
            .or_else(|| i.checked_sub(1).and_then(|j| ends[j]))
            .unwrap_or(if i == 0 { first } else { px(f32::NAN) });
        let end = ends[i]
            .or_else(|| starts.get(i + 1).copied().flatten())
            .unwrap_or(if i + 1 == n { last } else { px(f32::NAN) });
        out.push((start, end));
    }
    // What is still unknown shares the room between what is.
    for i in 0..n {
        if out[i].0.0.is_nan() {
            out[i].0 = if i > 0 && !out[i - 1].1.0.is_nan() {
                out[i - 1].1
            } else {
                first + (last - first) * (i as f32 / n as f32)
            };
        }
        if out[i].1.0.is_nan() {
            out[i].1 = first + (last - first) * ((i + 1) as f32 / n as f32);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{
        model::{Attrs, Fragment},
        tables::test_util::{cell_pos, doc, p, schema, table, td, tds, tr},
    };

    #[test]
    fn tracks_follow_widths_and_heights() {
        let s = schema();
        let mut attrs = Attrs::new();
        attrs.insert("colwidth".into(), serde_json::json!([120]));
        let wide = s
            .node(
                "tableCell",
                Some(attrs),
                Fragment::from(vec![p("a")]),
                vec![],
            )
            .unwrap();
        let mut row_attrs = Attrs::new();
        row_attrs.insert("height".into(), serde_json::json!(40));
        let row = s
            .node(
                "tableRow",
                Some(row_attrs),
                Fragment::from(vec![wide, td("b")]),
                vec![],
            )
            .unwrap();
        let t = table(vec![row, tr(vec![td("c"), td("d")])]);
        assert_eq!(column_tracks(&t, None), "120px minmax(25px,1fr)");
        assert_eq!(column_tracks(&t, Some((1, px(10.0)))), "120px 25px");
        assert_eq!(row_tracks(&t, None), "minmax(40px,auto) auto");
        assert_eq!(
            row_tracks(&t, Some((1, px(30.0)))),
            "minmax(40px,auto) minmax(30px,auto)"
        );
        assert!(!fixed_width(&t));
    }

    #[test]
    fn cells_are_placed_at_their_slots() {
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 2, 1), tds("b", 1, 2)]),
            tr(vec![td("c"), td("d")]),
        ])]);
        let at = |text| placement(&d, cell_pos(&d, text)).unwrap();
        assert_eq!(at("a"), (1, 3, 1, 2));
        assert_eq!(at("b"), (3, 4, 1, 3));
        assert_eq!(at("c"), (1, 2, 2, 3));
        assert_eq!(at("d"), (2, 3, 2, 3));
    }

    #[test]
    fn edges_fill_what_no_cell_gives() {
        let e = edges(
            &[Some(px(0.0)), None, Some(px(200.0))],
            &[None, Some(px(200.0)), Some(px(300.0))],
            px(0.0),
            px(300.0),
        );
        assert_eq!(
            e[0],
            (px(0.0), px(0.0) + (px(300.0) - px(0.0)) * (1.0 / 3.0))
        );
        assert_eq!(e[1].1, px(200.0));
        assert_eq!(e[2], (px(200.0), px(300.0)));
        assert_eq!(index_at(&e, px(250.0)), Some(2));
        assert_eq!(index_at(&e, px(-5.0)), Some(0));
    }
}
