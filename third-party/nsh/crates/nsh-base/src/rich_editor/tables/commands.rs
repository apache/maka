//! The table commands, after prosemirror-tables' `commands.ts` and
//! Tiptap's table extension: adding and deleting rows and columns,
//! merging and splitting cells, header rows, columns and cells, cell
//! attributes, moving between cells, inserting and deleting tables, and
//! NSH's for the view: moving rows and columns, column widths and row
//! heights. [`table_command_factories`] makes them by Tiptap's names from
//! JSON arguments.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others);
//! the Tiptap commands follow `@tiptap/extension-table` (MIT, © Tiptap
//! GmbH).

use std::sync::Arc;

use nsh_core::prelude::Points;
use serde_json::Value;

use super::{
    CellSelection, TableRole,
    fix::fix_tables,
    map::{Axis, Rect, TableMap, colspan, rowspan, width_json},
    table_node_types, table_role,
    util::{
        FoundTable, add_col_span, cell_around, cell_wrapping, column_is_header, is_in_table,
        move_cell_forward, remove_col_span, row_is_header, selection_cell, table_or_selected,
        widths_json,
    },
};
use crate::rich_editor::{
    commands::{
        BoxCommand, CommandFactory, CommandRegistry, Dispatch, command, helpers::attr_value_eq,
    },
    model::{Attrs, Fragment, Node, NodeType},
    state::{EditorState, Selection, TextSelection, Transaction},
};

/// The selected rectangle of a table (prosemirror-tables'
/// `selectedRect`): the cell selection's, or the cell's around the
/// selection.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TableRect {
    /// The rectangle, in slots.
    pub rect: Rect,
    /// Where the table's content starts.
    pub table_start: usize,
    /// The table's map.
    pub map: Arc<TableMap>,
    /// The table.
    pub table: Node,
}

/// The rectangle the selection covers in its table, none outside tables.
pub fn selected_rect(state: &EditorState) -> Option<TableRect> {
    let cell = selection_cell(state)?;
    let depth = cell.depth.checked_sub(1)?;
    let table = cell.node(depth).clone();
    let table_start = cell.start(depth);
    let map = TableMap::get(&table);
    let rect = match state.selection().as_custom::<CellSelection>() {
        Some(cells) => map.rect_between(
            cells.anchor_cell().pos - table_start,
            cells.head_cell().pos - table_start,
        ),
        None => map.try_find_cell(cell.pos - table_start)?,
    };
    Some(TableRect {
        rect,
        table_start,
        map,
        table,
    })
}

fn node_at(table: &Node, pos: usize) -> Option<Node> {
    table.node_at(pos)
}

fn fill(ty: &NodeType, attrs: Option<Attrs>) -> Option<Node> {
    ty.create_and_fill(attrs, Fragment::empty(), vec![])
}

// Runs `f` on a new transaction and dispatches it when `f` applies.
fn with_tr(
    state: &EditorState,
    dispatch: Dispatch<'_>,
    f: impl FnOnce(&mut Transaction) -> bool,
) -> bool {
    let mut tr = state.tr();
    if !f(&mut tr) {
        return false;
    }
    if let Some(dispatch) = dispatch {
        dispatch(tr);
    }
    true
}

// --- Columns ---------------------------------------------------------------------

/// Adds a column at `col` of the table `rect` describes, in `tr`: cells of
/// the type of the column next to it (plain cells next to a header
/// column at the table's edge), widening cells spanning across `col`.
pub fn add_column(tr: &mut Transaction, rect: &TableRect, col: usize) {
    let TableRect {
        map,
        table_start,
        table,
        ..
    } = rect;
    let types = table_node_types(table.ty().schema());
    let mut ref_column: Option<isize> = Some(if col > 0 { -1 } else { 0 });
    let ref_col = (col as isize + ref_column.unwrap_or(0)).max(0) as usize;
    if ref_col < map.width && column_is_header(map, table, ref_col) {
        ref_column = if col == 0 || col == map.width {
            None
        } else {
            Some(0)
        };
    }
    let mut row = 0;
    while row < map.height {
        let index = row * map.width + col;
        if col > 0 && col < map.width && map.map[index - 1] == map.map[index] {
            // Inside a cell spanning columns: widen it.
            let pos = map.map[index];
            if let Some(cell) = node_at(table, pos) {
                let attrs = add_col_span(cell.attrs(), col - map.col_count(pos), 1);
                let at = tr.mapping.map(table_start + pos, 1);
                let _ = tr.set_node_markup(at, None, Some(attrs), None);
                row += rowspan(&cell);
                continue;
            }
        } else {
            let ty = match ref_column {
                None => types.as_ref().map(|t| t.cell.clone()),
                Some(offset) => {
                    let at = (index as isize + offset) as usize;
                    node_at(table, map.map[at]).map(|cell| cell.ty().clone())
                }
            };
            let pos = map.position_at(row, col, table);
            if let Some(cell) = ty.as_ref().and_then(|ty| fill(ty, None)) {
                let at = tr.mapping.map(table_start + pos, 1);
                let _ = tr.insert(at, Fragment::from(vec![cell]));
            }
        }
        row += 1;
    }
}

fn add_column_command(after: bool) -> BoxCommand {
    command(move |state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(rect) = selected_rect(state) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let col = if after {
                rect.rect.right
            } else {
                rect.rect.left
            };
            add_column(tr, &rect, col);
            true
        })
    })
}

/// Adds a column before the selected ones (`addColumnBefore`).
pub fn add_column_before() -> BoxCommand {
    add_column_command(false)
}

/// Adds a column after the selected ones (`addColumnAfter`).
pub fn add_column_after() -> BoxCommand {
    add_column_command(true)
}

/// Removes column `col` of the table `rect` describes, in `tr` (whose
/// steps from `map_from` on the rectangle's positions map through):
/// narrowing cells spanning across it, deleting the others.
pub fn remove_column(tr: &mut Transaction, rect: &TableRect, col: usize) {
    let TableRect {
        map,
        table,
        table_start,
        ..
    } = rect;
    let map_from = tr.mapping.maps.len();
    let mut row = 0;
    while row < map.height {
        let index = row * map.width + col;
        let pos = map.map[index];
        let Some(cell) = node_at(table, pos) else {
            row += 1;
            continue;
        };
        let spans = (col > 0 && map.map[index - 1] == pos)
            || (col + 1 < map.width && map.map[index + 1] == pos);
        let at = tr.mapping.slice_from(map_from).map(table_start + pos, 1);
        if spans {
            let attrs = remove_col_span(cell.attrs(), col - map.col_count(pos), 1);
            let _ = tr.set_node_markup(at, None, Some(attrs), None);
        } else {
            let _ = tr.delete(at, at + cell.node_size());
        }
        row += rowspan(&cell);
    }
}

// The table rectangle `rect` with the table as `tr` has it now.
fn refreshed(tr: &Transaction, rect: &mut TableRect) -> bool {
    match tr.doc().node_at(rect.table_start - 1) {
        Some(table) => {
            rect.map = TableMap::get(&table);
            rect.table = table;
            true
        }
        None => false,
    }
}

/// Deletes the selected columns (`deleteColumn`); does not apply when
/// they are all of the table's.
pub fn delete_column() -> BoxCommand {
    command(|state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(mut rect) = selected_rect(state) else {
            return false;
        };
        if rect.rect.left == 0 && rect.rect.right == rect.map.width {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            let left = rect.rect.left;
            let mut i = rect.rect.right - 1;
            loop {
                remove_column(tr, &rect, i);
                if i == left || !refreshed(tr, &mut rect) {
                    break;
                }
                i -= 1;
            }
            true
        })
    })
}

// --- Rows ------------------------------------------------------------------------

/// Adds a row at `row` of the table `rect` describes, in `tr`: cells of
/// the types of the row next to it (plain cells next to a header row at
/// the table's edge), lengthening cells spanning across `row`.
pub fn add_row(tr: &mut Transaction, rect: &TableRect, row: usize) {
    let TableRect {
        map,
        table_start,
        table,
        ..
    } = rect;
    let Some(types) = table_node_types(table.ty().schema()) else {
        return;
    };
    let mut row_pos = *table_start;
    for i in 0..row {
        row_pos += table.child(i).node_size();
    }
    let mut ref_row: Option<isize> = Some(if row > 0 { -1 } else { 0 });
    let check = (row as isize + ref_row.unwrap_or(0)).max(0) as usize;
    if check < map.height && row_is_header(map, table, check) {
        ref_row = if row == 0 || row == map.height {
            None
        } else {
            Some(0)
        };
    }
    let mut cells = Vec::new();
    let mut col = 0;
    while col < map.width {
        let index = map.width * row + col;
        if row > 0 && row < map.height && map.map[index] == map.map[index - map.width] {
            // Inside a cell spanning rows: lengthen it.
            let pos = map.map[index];
            if let Some(cell) = node_at(table, pos) {
                let mut attrs = cell.attrs().clone();
                attrs.insert("rowspan".into(), Value::from(rowspan(&cell) + 1));
                let _ = tr.set_node_markup(table_start + pos, None, Some(attrs), None);
                col += colspan(&cell);
                continue;
            }
        } else {
            let ty = match ref_row {
                None => Some(types.cell.clone()),
                Some(offset) => {
                    let at = index as isize + offset * map.width as isize;
                    node_at(table, map.map[at as usize]).map(|cell| cell.ty().clone())
                }
            };
            if let Some(cell) = ty.as_ref().and_then(|ty| fill(ty, None)) {
                cells.push(cell);
            }
        }
        col += 1;
    }
    if let Ok(row_node) = types.row.create(None, Fragment::from(cells), vec![]) {
        let _ = tr.insert(row_pos, Fragment::from(vec![row_node]));
    }
}

fn add_row_command(after: bool) -> BoxCommand {
    command(move |state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(rect) = selected_rect(state) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let row = if after {
                rect.rect.bottom
            } else {
                rect.rect.top
            };
            add_row(tr, &rect, row);
            true
        })
    })
}

/// Adds a row before the selected ones (`addRowBefore`).
pub fn add_row_before() -> BoxCommand {
    add_row_command(false)
}

/// Adds a row after the selected ones (`addRowAfter`).
pub fn add_row_after() -> BoxCommand {
    add_row_command(true)
}

/// Removes row `row` of the table `rect` describes, in `tr`: cells
/// spanning into it from above get shorter, cells starting in it and
/// spanning below move down a row.
pub fn remove_row(tr: &mut Transaction, rect: &TableRect, row: usize) {
    let TableRect {
        map,
        table,
        table_start,
        ..
    } = rect;
    let mut row_pos = 0;
    for i in 0..row {
        row_pos += table.child(i).node_size();
    }
    let next_row = row_pos + table.child(row).node_size();
    let map_from = tr.mapping.maps.len();
    let _ = tr.delete(row_pos + table_start, next_row + table_start);
    let mut seen = std::collections::HashSet::new();
    let mut col = 0;
    while col < map.width {
        let index = row * map.width + col;
        let pos = map.map[index];
        if !seen.insert(pos) {
            col += 1;
            continue;
        }
        let Some(cell) = node_at(table, pos) else {
            col += 1;
            continue;
        };
        if row > 0 && pos == map.map[index - map.width] {
            // It starts above: one row shorter.
            let mut attrs = cell.attrs().clone();
            attrs.insert("rowspan".into(), Value::from(rowspan(&cell) - 1));
            let at = tr.mapping.slice_from(map_from).map(pos + table_start, 1);
            let _ = tr.set_node_markup(at, None, Some(attrs), None);
            col += colspan(&cell);
            continue;
        } else if row + 1 < map.height && pos == map.map[index + map.width] {
            // It continues below: moved down into the next row.
            let mut attrs = cell.attrs().clone();
            attrs.insert("rowspan".into(), Value::from(rowspan(&cell) - 1));
            if let Ok(copy) = cell
                .ty()
                .create(Some(attrs), cell.content().clone(), vec![])
            {
                let new_pos = map.position_at(row + 1, col, table);
                let at = tr
                    .mapping
                    .slice_from(map_from)
                    .map(table_start + new_pos, 1);
                let _ = tr.insert(at, Fragment::from(vec![copy]));
            }
            col += colspan(&cell);
            continue;
        }
        col += 1;
    }
}

/// Deletes the selected rows (`deleteRow`); does not apply when they are
/// all of the table's.
pub fn delete_row() -> BoxCommand {
    command(|state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(mut rect) = selected_rect(state) else {
            return false;
        };
        if rect.rect.top == 0 && rect.rect.bottom == rect.map.height {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            let top = rect.rect.top;
            let mut i = rect.rect.bottom - 1;
            loop {
                remove_row(tr, &rect, i);
                if i == top || !refreshed(tr, &mut rect) {
                    break;
                }
                i -= 1;
            }
            true
        })
    })
}

// --- Merging and splitting -------------------------------------------------------------

// A cell holding one empty textblock.
fn is_empty(cell: &Node) -> bool {
    let c = cell.content();
    c.child_count() == 1 && c.child(0).is_textblock() && c.child(0).child_count() == 0
}

// Whether a cell crosses the rectangle's edge.
fn cells_overlap_rectangle(map: &TableMap, rect: Rect) -> bool {
    let TableMap {
        width, height, map, ..
    } = map;
    let (width, height) = (*width, *height);
    let mut index_top = rect.top * width + rect.left;
    let mut index_left = index_top;
    let mut index_bottom = (rect.bottom - 1) * width + rect.left;
    let mut index_right = index_top + (rect.right - rect.left - 1);
    for _ in rect.top..rect.bottom {
        if (rect.left > 0 && map[index_left] == map[index_left - 1])
            || (rect.right < width && map[index_right] == map[index_right + 1])
        {
            return true;
        }
        index_left += width;
        index_right += width;
    }
    for _ in rect.left..rect.right {
        if (rect.top > 0 && map[index_top] == map[index_top - width])
            || (rect.bottom < height && map[index_bottom] == map[index_bottom + width])
        {
            return true;
        }
        index_top += 1;
        index_bottom += 1;
    }
    false
}

/// Merges the selected cells into one (`mergeCells`): the first takes
/// the rectangle and the others' content. Applies to a cell selection of
/// more than one cell whose rectangle no cell crosses.
pub fn merge_cells() -> BoxCommand {
    command(|state, dispatch| {
        let Some(cells) = state.selection().as_custom::<CellSelection>() else {
            return false;
        };
        if cells.anchor_cell().pos == cells.head_cell().pos {
            return false;
        }
        let Some(rect) = selected_rect(state) else {
            return false;
        };
        if cells_overlap_rectangle(&rect.map, rect.rect) {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            let TableRect {
                rect: r,
                map,
                table,
                table_start,
            } = &rect;
            let mut seen = std::collections::HashSet::new();
            let mut content = Fragment::empty();
            let mut merged: Option<(usize, Node)> = None;
            for row in r.top..r.bottom {
                for col in r.left..r.right {
                    let cell_pos = map.map[row * map.width + col];
                    if !seen.insert(cell_pos) {
                        continue;
                    }
                    let Some(cell) = node_at(table, cell_pos) else {
                        continue;
                    };
                    if merged.is_none() {
                        merged = Some((cell_pos, cell));
                    } else {
                        if !is_empty(&cell) {
                            content = content.append(cell.content());
                        }
                        let at = tr.mapping.map(cell_pos + table_start, 1);
                        let _ = tr.delete(at, at + cell.node_size());
                    }
                }
            }
            let Some((merged_pos, merged_cell)) = merged else {
                return true;
            };
            let span = colspan(&merged_cell);
            let mut attrs = add_col_span(
                merged_cell.attrs(),
                span,
                (r.right - r.left).saturating_sub(span),
            );
            attrs.insert("rowspan".into(), Value::from(r.bottom - r.top));
            let _ = tr.set_node_markup(merged_pos + table_start, None, Some(attrs), None);
            if content.size() > 0 {
                let end = merged_pos + 1 + merged_cell.content().size();
                let start = if is_empty(&merged_cell) {
                    merged_pos + 1
                } else {
                    end
                };
                let _ = tr.replace_with(start + table_start, end + table_start, content);
            }
            if let Some(selection) = CellSelection::create(tr.doc(), merged_pos + table_start, None)
            {
                tr.set_selection(selection);
            }
            true
        })
    })
}

/// Splits a cell spanning several rows or columns into cells of one slot
/// each (`splitCell`), the new ones of the cell's type.
pub fn split_cell() -> BoxCommand {
    split_cell_with_type(Arc::new(|cell: &Node, _row, _col| Some(cell.ty().clone())))
}

/// The type of each cell a split makes, from the cell split and the
/// row and column of the new cell.
pub type CellTypeFn = Arc<dyn Fn(&Node, usize, usize) -> Option<NodeType> + Send + Sync>;

/// [`split_cell`] with the new cells' types from `cell_type`.
pub fn split_cell_with_type(cell_type: CellTypeFn) -> BoxCommand {
    command(move |state, dispatch| {
        let selection = state.selection();
        let (cell_node, cell_pos) = match selection.as_custom::<CellSelection>() {
            Some(cells) => {
                if cells.anchor_cell().pos != cells.head_cell().pos {
                    return false;
                }
                let Some(node) = cells.anchor_cell().node_after() else {
                    return false;
                };
                (node, cells.anchor_cell().pos)
            }
            None => {
                let from = selection.resolved_from();
                let (Some(node), Some(around)) = (cell_wrapping(from), cell_around(from)) else {
                    return false;
                };
                (node, around.pos)
            }
        };
        if colspan(&cell_node) == 1 && rowspan(&cell_node) == 1 {
            return false;
        }
        let Some(rect) = selected_rect(state) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let widths = super::map::colwidth(&cell_node);
            let mut base = cell_node.attrs().clone();
            base.insert("rowspan".into(), Value::from(1));
            base.insert("colspan".into(), Value::from(1));
            let r = rect.rect;
            let attrs: Vec<Attrs> = (0..r.right - r.left)
                .map(|i| {
                    let mut attrs = base.clone();
                    if let Some(widths) = &widths {
                        let width = widths.get(i).copied().filter(|w| *w > 0.0);
                        attrs.insert(
                            "colwidth".into(),
                            width.map_or(Value::Null, |w| Value::Array(vec![width_json(w)])),
                        );
                    }
                    attrs
                })
                .collect();
            let mut last_cell = None;
            for row in r.top..r.bottom {
                let mut pos = rect.map.position_at(row, r.left, &rect.table);
                if row == r.top {
                    pos += cell_node.node_size();
                }
                for (i, col) in (r.left..r.right).enumerate() {
                    if col == r.left && row == r.top {
                        continue;
                    }
                    let ty = cell_type(&cell_node, row, col);
                    if let Some(cell) = ty.and_then(|ty| fill(&ty, Some(attrs[i].clone()))) {
                        let at = tr.mapping.map(pos + rect.table_start, 1);
                        last_cell = Some(at);
                        let _ = tr.insert(at, Fragment::from(vec![cell]));
                    }
                }
            }
            let ty = cell_type(&cell_node, r.top, r.left);
            let _ = tr.set_node_markup(cell_pos, ty, Some(attrs[0].clone()), None);
            if let Some(cells) = selection.as_custom::<CellSelection>() {
                let head = last_cell.unwrap_or(cells.anchor_cell().pos);
                if let Some(selection) =
                    CellSelection::create(tr.doc(), cells.anchor_cell().pos, Some(head))
                {
                    tr.set_selection(selection);
                }
            }
            true
        })
    })
}

/// Merges the selected cells, else splits the cell (Tiptap's
/// `mergeOrSplit`).
pub fn merge_or_split() -> BoxCommand {
    let (merge, split) = (merge_cells(), split_cell());
    command(move |state, mut dispatch| {
        let merged = match &mut dispatch {
            Some(dispatch) => merge(state, Some(&mut **dispatch)),
            None => merge(state, None),
        };
        merged || split(state, dispatch)
    })
}

// --- Attributes and headers ------------------------------------------------------------

/// Sets the attribute `name` of the selected cells to `value`
/// (`setCellAttribute`); does not apply when the selection's cell has it
/// already.
pub fn set_cell_attr(name: String, value: Value) -> BoxCommand {
    command(move |state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(cell) = selection_cell(state) else {
            return false;
        };
        let Some(node) = cell.node_after() else {
            return false;
        };
        if node
            .attrs()
            .get(&name)
            .is_some_and(|v| attr_value_eq(v, &value))
        {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            let set = |tr: &mut Transaction, node: &Node, pos: usize| {
                let mut attrs = node.attrs().clone();
                attrs.insert(name.clone(), value.clone());
                let _ = tr.set_node_markup(pos, None, Some(attrs), None);
            };
            match state.selection().as_custom::<CellSelection>() {
                Some(cells) => cells.for_each_cell(|node, pos| {
                    if !node
                        .attrs()
                        .get(&name)
                        .is_some_and(|v| attr_value_eq(v, &value))
                    {
                        set(tr, node, pos);
                    }
                }),
                None => set(tr, &node, cell.pos),
            }
            true
        })
    })
}

/// Which header [`toggle_header`] toggles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HeaderKind {
    /// The table's first row.
    Row,
    /// The table's first column.
    Column,
}

// Whether the first row (or column) is all header cells.
fn header_enabled(kind: HeaderKind, rect: &TableRect) -> bool {
    let r = match kind {
        HeaderKind::Row => Rect::new(0, 0, rect.map.width, 1),
        HeaderKind::Column => Rect::new(0, 0, 1, rect.map.height),
    };
    rect.map.cells_in_rect(r).into_iter().all(|pos| {
        node_at(&rect.table, pos)
            .is_none_or(|cell| table_role(cell.ty()) == Some(TableRole::HeaderCell))
    })
}

/// Toggles the table's header row or column (prosemirror-tables'
/// `toggleHeader`, as Tiptap's `toggleHeaderRow` / `toggleHeaderColumn`):
/// its cells become header cells, or plain cells when they are header
/// cells already; a header column (row) already there keeps its cell.
pub fn toggle_header(kind: HeaderKind) -> BoxCommand {
    command(move |state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let (Some(types), Some(rect)) = (table_node_types(state.schema()), selected_rect(state))
        else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let row_enabled = header_enabled(HeaderKind::Row, &rect);
            let column_enabled = header_enabled(HeaderKind::Column, &rect);
            let (cells_rect, new_type) = match kind {
                HeaderKind::Column => {
                    let start = usize::from(row_enabled);
                    let ty = if column_enabled {
                        &types.cell
                    } else {
                        &types.header_cell
                    };
                    (Rect::new(0, start, 1, rect.map.height), ty)
                }
                HeaderKind::Row => {
                    let start = usize::from(column_enabled);
                    let ty = if row_enabled {
                        &types.cell
                    } else {
                        &types.header_cell
                    };
                    (Rect::new(start, 0, rect.map.width, 1), ty)
                }
            };
            for relative in rect.map.cells_in_rect(cells_rect) {
                let pos = relative + rect.table_start;
                if let Some(cell) = tr.doc().node_at(pos) {
                    let attrs = cell.attrs().clone();
                    let _ = tr.set_node_markup(pos, Some(new_type.clone()), Some(attrs), None);
                }
            }
            true
        })
    })
}

/// Toggles the selected cells between header cells and plain cells
/// (`toggleHeaderCell`): header cells become plain cells; when there were
/// none, every selected cell becomes a header cell.
pub fn toggle_header_cell() -> BoxCommand {
    command(|state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let (Some(types), Some(rect)) = (table_node_types(state.schema()), selected_rect(state))
        else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let cells = rect.map.cells_in_rect(rect.rect);
            let nodes: Vec<Option<Node>> =
                cells.iter().map(|pos| node_at(&rect.table, *pos)).collect();
            for (pos, node) in cells.iter().zip(&nodes) {
                if let Some(node) = node
                    && node.ty() == &types.header_cell
                {
                    let _ = tr.set_node_markup(
                        rect.table_start + pos,
                        Some(types.cell.clone()),
                        Some(node.attrs().clone()),
                        None,
                    );
                }
            }
            if tr.steps.is_empty() {
                for (pos, node) in cells.iter().zip(&nodes) {
                    if let Some(node) = node {
                        let _ = tr.set_node_markup(
                            rect.table_start + pos,
                            Some(types.header_cell.clone()),
                            Some(node.attrs().clone()),
                            None,
                        );
                    }
                }
            }
            true
        })
    })
}

// --- Moving between cells ----------------------------------------------------------------

// The cell after (or before) the one `cell` points at, in reading order
// (prosemirror-tables' `findNextCell`).
fn find_next_cell(cell: &crate::rich_editor::model::ResolvedPos, dir: i32) -> Option<usize> {
    let depth = cell.depth;
    let table = cell.node(depth - 1);
    if dir < 0 {
        if let Some(before) = cell.node_before() {
            return Some(cell.pos - before.node_size());
        }
        let mut row_end = cell.before(depth);
        for row in (0..cell.index(depth - 1)).rev() {
            let row_node = table.child(row);
            if let Some(last) = row_node.last_child() {
                return Some(row_end - 1 - last.node_size());
            }
            row_end -= row_node.node_size();
        }
    } else {
        if cell.index(depth) + 1 < cell.parent().child_count() {
            return Some(cell.pos + cell.node_after()?.node_size());
        }
        let mut row_start = cell.after(depth);
        for row in cell.index_after(depth - 1)..table.child_count() {
            let row_node = table.child(row);
            if row_node.child_count() > 0 {
                return Some(row_start + 1);
            }
            row_start += row_node.node_size();
        }
    }
    None
}

/// Selects the content of the next cell (`dir` 1) or the previous one
/// (`dir` -1) in reading order (`goToNextCell`, `goToPreviousCell`); does
/// not apply in the last (first) cell.
pub fn go_to_next_cell(dir: i32) -> BoxCommand {
    command(move |state, dispatch| {
        if !is_in_table(state) {
            return false;
        }
        let Some(cell) = selection_cell(state) else {
            return false;
        };
        let Some(next) = find_next_cell(&cell, dir) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let Ok(next) = tr.doc().resolve(next) else {
                return false;
            };
            let Some(after) = move_cell_forward(&next) else {
                return false;
            };
            tr.set_selection(TextSelection::between(&next, &after, None));
            tr.scroll_into_view();
            true
        })
    })
}

/// Tiptap's Tab in tables: the next cell, or in the last cell a new row
/// after the selected ones and its first cell.
pub fn go_to_next_cell_or_add_row() -> BoxCommand {
    let next = go_to_next_cell(1);
    command(move |state, mut dispatch| {
        let moved = match &mut dispatch {
            Some(dispatch) => next(state, Some(&mut **dispatch)),
            None => next(state, None),
        };
        if moved {
            return true;
        }
        if !is_in_table(state) {
            return false;
        }
        let (Some(rect), Some(cell)) = (selected_rect(state), selection_cell(state)) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            add_row(tr, &rect, rect.rect.bottom);
            let cell = tr.mapping.map(cell.pos, 1);
            let Ok(cell) = tr.doc().resolve(cell) else {
                return true;
            };
            if let Some(next) = find_next_cell(&cell, 1)
                && let Ok(next) = tr.doc().resolve(next)
                && let Some(after) = move_cell_forward(&next)
            {
                tr.set_selection(TextSelection::between(&next, &after, None));
            }
            tr.scroll_into_view();
            true
        })
    })
}

/// Deletes the table around the selection (`deleteTable`).
pub fn delete_table() -> BoxCommand {
    command(|state, dispatch| {
        let Some(table) = super::find_table(state.selection().resolved_anchor()) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            let end = table.pos + table.node.node_size();
            let _ = tr.delete(table.pos, end);
            tr.scroll_into_view();
            true
        })
    })
}

/// Deletes the table when every cell is selected (Tiptap's Backspace and
/// Delete in tables).
pub fn delete_table_when_all_cells_selected() -> BoxCommand {
    let delete = delete_table();
    command(move |state, dispatch| {
        let Some(cells) = state.selection().as_custom::<CellSelection>() else {
            return false;
        };
        let (map, _, rect) = cells.rect();
        if rect.left != 0 || rect.top != 0 || rect.right != map.width || rect.bottom != map.height {
            return false;
        }
        delete(state, dispatch)
    })
}

// --- Inserting tables and selecting cells -----------------------------------------------

/// A table of `rows` × `cols` empty cells, the first row of header cells
/// when `with_header_row` (Tiptap's `createTable`).
pub fn create_table(
    schema: &crate::rich_editor::model::Schema,
    rows: usize,
    cols: usize,
    with_header_row: bool,
) -> Option<Node> {
    let types = table_node_types(schema)?;
    if rows == 0 || cols == 0 {
        return None;
    }
    let row_of = |ty: &NodeType| -> Option<Node> {
        let cells = (0..cols)
            .map(|_| fill(ty, None))
            .collect::<Option<Vec<_>>>()?;
        types
            .row
            .create_checked(None, Fragment::from(cells), vec![])
            .ok()
    };
    let mut table_rows = Vec::with_capacity(rows);
    for i in 0..rows {
        let ty = if with_header_row && i == 0 {
            &types.header_cell
        } else {
            &types.cell
        };
        table_rows.push(row_of(ty)?);
    }
    types
        .table
        .create_checked(None, Fragment::from(table_rows), vec![])
        .ok()
}

/// Inserts a table of `rows` × `cols` (`insertTable({ rows, cols,
/// withHeaderRow })`, 3 × 3 with a header row by default) over the
/// selection, the cursor in its first cell.
pub fn insert_table(rows: usize, cols: usize, with_header_row: bool) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(table) = create_table(state.schema(), rows, cols, with_header_row) else {
            return false;
        };
        let from = state.selection().from();
        with_tr(state, dispatch, |tr| {
            let steps = tr.steps.len();
            tr.replace_selection_with(table.clone(), false);
            if tr.steps.len() == steps {
                return false;
            }
            // The table inserted: the first from where the selection was.
            let start = tr.mapping.map(from, -1);
            let mut found = None;
            let size = tr.doc().content().size();
            tr.doc().nodes_between(start, size, &mut |node, pos, _, _| {
                if found.is_some() {
                    return false;
                }
                if pos >= start && node.ptr_eq(&table) {
                    found = Some(pos);
                    return false;
                }
                true
            });
            let Some(pos) = found else {
                return true;
            };
            if let Ok(inside) = tr.doc().resolve(pos + 1) {
                tr.set_selection(Selection::near(&inside, 1));
            }
            tr.scroll_into_view();
            true
        })
    })
}

/// Selects the cells from the one at `anchor` to the one at `head`
/// (positions before cells; `setCellSelection({ anchorCell, headCell })`).
pub fn set_cell_selection(anchor: usize, head: Option<usize>) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(selection) = CellSelection::create(state.doc(), anchor, head) else {
            return false;
        };
        with_tr(state, dispatch, |tr| {
            tr.set_selection(selection);
            true
        })
    })
}

/// Repairs every table of the document (`fixTables`); does not apply
/// when they are all sound.
pub fn fix_tables_command() -> BoxCommand {
    command(|state, dispatch| {
        let Some(tr) = fix_tables(state, None) else {
            return false;
        };
        if let Some(dispatch) = dispatch {
            dispatch(tr);
        }
        true
    })
}

// --- Moving rows and columns -----------------------------------------------------------

// The smallest span of rows (or columns) holding `index` that no cell
// crosses.
fn closed_span(map: &TableMap, index: usize, axis: Axis) -> Option<(usize, usize)> {
    let len = match axis {
        Axis::Vertical => map.height,
        Axis::Horizontal => map.width,
    };
    if index >= len {
        return None;
    }
    let (mut start, mut end) = (index, index + 1);
    loop {
        let (mut new_start, mut new_end) = (start, end);
        for line in start..end {
            let count = match axis {
                Axis::Vertical => map.width,
                Axis::Horizontal => map.height,
            };
            for other in 0..count {
                let slot = match axis {
                    Axis::Vertical => line * map.width + other,
                    Axis::Horizontal => other * map.width + line,
                };
                let Some(r) = map.try_find_cell(map.map[slot]) else {
                    continue;
                };
                let (a, b) = match axis {
                    Axis::Vertical => (r.top, r.bottom),
                    Axis::Horizontal => (r.left, r.right),
                };
                new_start = new_start.min(a);
                new_end = new_end.max(b);
            }
        }
        if (new_start, new_end) == (start, end) {
            return Some((start, end));
        }
        (start, end) = (new_start, new_end);
    }
}

// Where each line goes when the span `from` moves next to the span
// `target` (after it when moving down or right): the old index of each
// new line.
fn moved_order(len: usize, from: (usize, usize), target: (usize, usize)) -> Vec<usize> {
    let (a, b) = from;
    let (c, d) = target;
    let mut order: Vec<usize> = Vec::with_capacity(len);
    if c >= b {
        order.extend(0..a);
        order.extend(b..d);
        order.extend(a..b);
        order.extend(d..len);
    } else {
        order.extend(0..c);
        order.extend(a..b);
        order.extend(c..a);
        order.extend(b..len);
    }
    order
}

/// Moves row `from` of the table at `table` (the one around the selection
/// when none) to where row `to` is (`moveTableRow`). A row with cells
/// spanning into others moves with them, and lands before or after the
/// rows spanning with `to`; refused when `to` is among the rows moving.
/// With `select`, the moved rows are selected.
pub fn move_table_row(table: Option<usize>, from: usize, to: usize, select: bool) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(found) = table_or_selected(state, table) else {
            return false;
        };
        let map = TableMap::get(&found.node);
        if !map.problems.is_empty() {
            return false;
        }
        let (Some(origin), Some(target)) = (
            closed_span(&map, from, Axis::Vertical),
            closed_span(&map, to, Axis::Vertical),
        ) else {
            return false;
        };
        if (origin.0..origin.1).contains(&to) {
            return false;
        }
        let order = moved_order(map.height, origin, target);
        let rows: Vec<Node> = order.iter().map(|&i| found.node.child(i).clone()).collect();
        let new_table = found.node.copy(Fragment::from(rows));
        let first = order.iter().position(|&i| i == origin.0).unwrap_or(0);
        let count = origin.1 - origin.0;
        replace_table(state, dispatch, &found, new_table, select, |map| {
            let last = (first + count - 1).min(map.height - 1);
            (
                map.map[first * map.width],
                map.map[last * map.width + map.width - 1],
                Axis::Vertical,
            )
        })
    })
}

/// Moves column `from` of the table at `table` (the one around the
/// selection when none) to where column `to` is (`moveTableColumn`), as
/// [`move_table_row`] moves rows: columns with cells spanning into
/// others move with them.
pub fn move_table_column(table: Option<usize>, from: usize, to: usize, select: bool) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(found) = table_or_selected(state, table) else {
            return false;
        };
        let map = TableMap::get(&found.node);
        if !map.problems.is_empty() {
            return false;
        }
        let (Some(origin), Some(target)) = (
            closed_span(&map, from, Axis::Horizontal),
            closed_span(&map, to, Axis::Horizontal),
        ) else {
            return false;
        };
        if (origin.0..origin.1).contains(&to) {
            return false;
        }
        let order = moved_order(map.width, origin, target);
        // Each column's new index.
        let mut new_index = vec![0; map.width];
        for (new, &old) in order.iter().enumerate() {
            new_index[old] = new;
        }
        // Every cell keeps its row and moves with its first column; no
        // cell crosses the moved spans' edges, so its columns stay
        // together.
        let mut rows: Vec<Vec<(usize, Node)>> = vec![Vec::new(); map.height];
        for (pos, rect) in map.cells() {
            if let Some(cell) = found.node.node_at(pos) {
                rows[rect.top].push((new_index[rect.left], cell));
            }
        }
        let rows: Vec<Node> = rows
            .into_iter()
            .enumerate()
            .map(|(i, mut cells)| {
                cells.sort_by_key(|(col, _)| *col);
                found.node.child(i).copy(Fragment::from(
                    cells.into_iter().map(|(_, c)| c).collect::<Vec<_>>(),
                ))
            })
            .collect();
        let new_table = found.node.copy(Fragment::from(rows));
        let first = order.iter().position(|&i| i == origin.0).unwrap_or(0);
        let count = origin.1 - origin.0;
        replace_table(state, dispatch, &found, new_table, select, |map| {
            let last = (first + count - 1).min(map.width - 1);
            (
                map.map[first],
                map.map[(map.height - 1) * map.width + last],
                Axis::Horizontal,
            )
        })
    })
}

// Replaces a table with its rearranged copy, selecting the moved rows or
// columns (`cells` gives their first and last cells in the new map).
fn replace_table(
    state: &EditorState,
    dispatch: Dispatch<'_>,
    found: &FoundTable,
    new_table: Node,
    select: bool,
    cells: impl FnOnce(&TableMap) -> (usize, usize, Axis),
) -> bool {
    with_tr(state, dispatch, |tr| {
        let end = found.pos + found.node.node_size();
        if tr
            .replace_with(found.pos, end, Fragment::from(vec![new_table.clone()]))
            .is_err()
        {
            return false;
        }
        if select {
            let map = TableMap::get(&new_table);
            let (first, last, axis) = cells(&map);
            let doc = tr.doc().clone();
            let (Ok(first), Ok(last)) = (
                doc.resolve(found.start + first),
                doc.resolve(found.start + last),
            ) else {
                return true;
            };
            let selection = match axis {
                Axis::Vertical => CellSelection::row_selection(first, last),
                Axis::Horizontal => CellSelection::col_selection(first, last),
            };
            if let Some(selection) = selection {
                tr.set_selection(selection.into());
            }
        }
        true
    })
}

// --- Sizes ---------------------------------------------------------------------------

/// Sets the width of column `col` of the table at `table` (the one around
/// the selection when none) to `width` (none: as wide as its content):
/// the `colwidth` of each cell covering the column (`setColumnWidth`).
pub fn set_column_width(table: Option<usize>, col: usize, width: Option<Points>) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(found) = table_or_selected(state, table) else {
            return false;
        };
        let map = TableMap::get(&found.node);
        if col >= map.width {
            return false;
        }
        let width = width.map(|w| f64::from(w.0).max(0.0));
        with_tr(state, dispatch, |tr| {
            let mut seen = std::collections::HashSet::new();
            for row in 0..map.height {
                let pos = map.map[row * map.width + col];
                if !seen.insert(pos) {
                    continue;
                }
                let Some(cell) = found.node.node_at(pos) else {
                    continue;
                };
                let span = colspan(&cell);
                let index = col - map.col_count(pos);
                let mut widths = super::map::colwidth(&cell).unwrap_or_else(|| vec![0.0; span]);
                widths.resize(span, 0.0);
                widths[index] = width.unwrap_or(0.0);
                let value = widths_json(widths);
                if cell.attrs().get("colwidth").unwrap_or(&Value::Null) == &value {
                    continue;
                }
                let at = tr.mapping.map(found.start + pos, 1);
                let _ = tr.set_node_attribute(at, "colwidth", value);
            }
            !tr.steps.is_empty()
        })
    })
}

/// Sets the height of row `row` of the table at `table` (the one around
/// the selection when none) to `height` (none: as tall as its content):
/// the row's `height` (`setRowHeight`).
pub fn set_row_height(table: Option<usize>, row: usize, height: Option<Points>) -> BoxCommand {
    command(move |state, dispatch| {
        let Some(found) = table_or_selected(state, table) else {
            return false;
        };
        if row >= found.node.child_count() {
            return false;
        }
        let mut pos = found.start;
        for i in 0..row {
            pos += found.node.child(i).node_size();
        }
        let value = height.map_or(Value::Null, |h| width_json(f64::from(h.0).max(0.0)));
        if found
            .node
            .child(row)
            .attrs()
            .get("height")
            .unwrap_or(&Value::Null)
            == &value
        {
            return false;
        }
        with_tr(state, dispatch, |tr| {
            tr.set_node_attribute(pos, "height", value).is_ok()
        })
    })
}

// --- By name ------------------------------------------------------------------------------

fn arg_usize(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| *n >= 0.0 && n.fract() == 0.0)
            .map(|n| Some(n as usize))
            .ok_or_else(|| format!("`{key}` is a whole number, got {v}")),
    }
}

fn required(args: &Value, key: &str, name: &str) -> Result<usize, String> {
    arg_usize(args, key)?.ok_or_else(|| format!("{name} needs `{key}`"))
}

fn arg_points(args: &Value, key: &str) -> Result<Option<Points>, String> {
    match args.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| *n >= 0.0)
            .map(|n| Some(nsh_core::prelude::px(n as f32)))
            .ok_or_else(|| format!("`{key}` is a length in points, got {v}")),
    }
}

fn factory(
    f: impl Fn(&Value) -> Result<BoxCommand, String> + Send + Sync + 'static,
) -> CommandFactory {
    Arc::new(move |args, _schema| f(args))
}

/// The table commands by Tiptap's names (and NSH's for the view), made
/// from JSON arguments: `insertTable({ rows, cols, withHeaderRow })`,
/// `addColumnBefore`, `addColumnAfter`, `deleteColumn`, `addRowBefore`,
/// `addRowAfter`, `deleteRow`, `deleteTable`, `mergeCells`, `splitCell`,
/// `mergeOrSplit`, `toggleHeaderColumn`, `toggleHeaderRow`,
/// `toggleHeaderCell`, `setCellAttribute({ name, value })`,
/// `goToNextCell`, `goToPreviousCell`, `fixTables`, `setCellSelection({
/// anchorCell, headCell })`, `moveTableRow({ from, to, select, table })`,
/// `moveTableColumn(...)`, `setColumnWidth({ table, col, width })` and
/// `setRowHeight({ table, row, height })`.
pub fn table_command_factories() -> Vec<(String, CommandFactory)> {
    let plain = |f: fn() -> BoxCommand| factory(move |_| Ok(f()));
    vec![
        (
            "insertTable".into(),
            factory(|args| {
                let rows = arg_usize(args, "rows")?.unwrap_or(3);
                let cols = arg_usize(args, "cols")?.unwrap_or(3);
                let header = args
                    .get("withHeaderRow")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                Ok(insert_table(rows, cols, header))
            }),
        ),
        ("addColumnBefore".into(), plain(add_column_before)),
        ("addColumnAfter".into(), plain(add_column_after)),
        ("deleteColumn".into(), plain(delete_column)),
        ("addRowBefore".into(), plain(add_row_before)),
        ("addRowAfter".into(), plain(add_row_after)),
        ("deleteRow".into(), plain(delete_row)),
        ("deleteTable".into(), plain(delete_table)),
        ("mergeCells".into(), plain(merge_cells)),
        ("splitCell".into(), plain(split_cell)),
        ("mergeOrSplit".into(), plain(merge_or_split)),
        (
            "toggleHeaderColumn".into(),
            factory(|_| Ok(toggle_header(HeaderKind::Column))),
        ),
        (
            "toggleHeaderRow".into(),
            factory(|_| Ok(toggle_header(HeaderKind::Row))),
        ),
        ("toggleHeaderCell".into(), plain(toggle_header_cell)),
        (
            "setCellAttribute".into(),
            factory(|args| {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("setCellAttribute needs a string `name`")?;
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                Ok(set_cell_attr(name.to_owned(), value))
            }),
        ),
        ("goToNextCell".into(), factory(|_| Ok(go_to_next_cell(1)))),
        (
            "goToPreviousCell".into(),
            factory(|_| Ok(go_to_next_cell(-1))),
        ),
        ("fixTables".into(), plain(fix_tables_command)),
        (
            "setCellSelection".into(),
            factory(|args| {
                let anchor = required(args, "anchorCell", "setCellSelection")?;
                Ok(set_cell_selection(anchor, arg_usize(args, "headCell")?))
            }),
        ),
        (
            "moveTableRow".into(),
            factory(|args| {
                let from = required(args, "from", "moveTableRow")?;
                let to = required(args, "to", "moveTableRow")?;
                let select = args.get("select").and_then(Value::as_bool).unwrap_or(true);
                Ok(move_table_row(arg_usize(args, "table")?, from, to, select))
            }),
        ),
        (
            "moveTableColumn".into(),
            factory(|args| {
                let from = required(args, "from", "moveTableColumn")?;
                let to = required(args, "to", "moveTableColumn")?;
                let select = args.get("select").and_then(Value::as_bool).unwrap_or(true);
                Ok(move_table_column(
                    arg_usize(args, "table")?,
                    from,
                    to,
                    select,
                ))
            }),
        ),
        (
            "setColumnWidth".into(),
            factory(|args| {
                let col = required(args, "col", "setColumnWidth")?;
                Ok(set_column_width(
                    arg_usize(args, "table")?,
                    col,
                    arg_points(args, "width")?,
                ))
            }),
        ),
        (
            "setRowHeight".into(),
            factory(|args| {
                let row = required(args, "row", "setRowHeight")?;
                Ok(set_row_height(
                    arg_usize(args, "table")?,
                    row,
                    arg_points(args, "height")?,
                ))
            }),
        ),
    ]
}

/// Registers [`table_command_factories`] in `registry`.
pub fn register_commands(registry: &mut CommandRegistry) {
    for (name, factory) in table_command_factories() {
        registry.register(
            name,
            move |args: &Value, schema: &crate::rich_editor::model::Schema| factory(args, schema),
        );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{super::test_util::*, *};

    // Runs `cmd`, checking that its dry run agrees.
    fn run(state: &EditorState, cmd: &BoxCommand) -> Option<EditorState> {
        let mut out = None;
        let applied = cmd(state, Some(&mut |tr| out = Some(tr)));
        assert_eq!(applied, cmd(state, None), "dry run disagrees");
        assert_eq!(applied, out.is_some());
        out.map(|tr| state.apply(tr).unwrap())
    }

    fn named(name: &str, args: Value) -> BoxCommand {
        CommandRegistry::builtin()
            .make(name, &args, &schema())
            .unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    fn run_named(state: &EditorState, name: &str, args: Value) -> Option<EditorState> {
        run(state, &named(name, args))
    }

    fn table_shape(state: &EditorState) -> String {
        shape(&first_table(state.doc()))
    }

    fn abcd() -> Node {
        doc(vec![grid(&[&["a", "b"], &["c", "d"]])])
    }

    fn in_text(text: &str) -> EditorState {
        let d = abcd();
        let pos = in_cell(&d, text);
        at(d, pos)
    }

    fn cells(d: Node, anchor: &str, head: &str) -> EditorState {
        let selection =
            CellSelection::create(&d, cell_pos(&d, anchor), Some(cell_pos(&d, head))).unwrap();
        state_with(d, selection, vec![])
    }

    fn head_cell_text(state: &EditorState) -> String {
        let head = state.selection().resolved_head();
        cell_wrapping(head)
            .map(|cell| cell.text_content())
            .unwrap_or_default()
    }

    #[test]
    fn insert_table_makes_a_table_with_a_header_row() {
        let d = doc(vec![p("x")]);
        let state = at(d, 2);
        let state = run_named(
            &state,
            "insertTable",
            json!({ "rows": 2, "cols": 3, "withHeaderRow": true }),
        )
        .expect("inserted");
        assert_eq!(table_shape(&state), "*|*|*/||");
        let head = state.selection().resolved_head();
        assert!(
            cell_around(head).is_some(),
            "the cursor is in the first cell"
        );
        let state = run_named(&state, "insertTable", json!({ "withHeaderRow": false }));
        assert!(state.is_some(), "3 × 3 by default");
        assert!(
            run_named(
                &at(doc(vec![p("x")]), 1),
                "insertTable",
                json!({ "rows": 0 })
            )
            .is_none()
        );
    }

    #[test]
    fn columns_are_added_before_and_after() {
        let state = run_named(&in_text("a"), "addColumnAfter", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a||b/c||d");
        let state = run_named(&in_text("b"), "addColumnBefore", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a||b/c||d");
        // A cell spanning across the new column widens.
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 2, 1)]),
            tr(vec![td("c"), td("d")]),
        ])]);
        let pos = in_cell(&d, "c");
        let state = run(&at(d, pos), &add_column_after()).unwrap();
        assert_eq!(table_shape(&state), "a(3,1)/c||d");
        assert!(run(&at(doc(vec![p("x")]), 1), &add_column_after()).is_none());
    }

    #[test]
    fn columns_are_deleted_but_not_all() {
        let state = run_named(&in_text("a"), "deleteColumn", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "b/d");
        let all = cells(abcd(), "a", "d");
        assert!(run_named(&all, "deleteColumn", json!(null)).is_none());
        // A cell spanning the deleted column narrows.
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 2, 1)]),
            tr(vec![td("c"), td("d")]),
        ])]);
        let pos = in_cell(&d, "d");
        let state = run(&at(d, pos), &delete_column()).unwrap();
        assert_eq!(table_shape(&state), "a/c");
    }

    #[test]
    fn rows_are_added_and_deleted() {
        let state = run_named(&in_text("a"), "addRowAfter", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a|b/|/c|d");
        let state = run_named(&in_text("c"), "addRowBefore", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a|b/|/c|d");
        let state = run_named(&in_text("c"), "deleteRow", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a|b");
        assert!(run_named(&cells(abcd(), "a", "d"), "deleteRow", json!(null)).is_none());
        // A cell spanning into the deleted row gets shorter.
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 1, 2), td("b")]),
            tr(vec![td("d")]),
        ])]);
        let pos = in_cell(&d, "d");
        let state = run(&at(d, pos), &delete_row()).unwrap();
        assert_eq!(table_shape(&state), "a|b");
        // A cell starting in the deleted row moves down.
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 1, 2), td("b")]),
            tr(vec![td("d")]),
        ])]);
        let pos = in_cell(&d, "b");
        let state = run(&at(d, pos), &delete_row()).unwrap();
        assert_eq!(table_shape(&state), "a|d");
    }

    #[test]
    fn cells_are_merged_and_split() {
        let state = run_named(&cells(abcd(), "a", "d"), "mergeCells", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "abcd(2,2)/");
        // One cell, or a text cursor: nothing to merge.
        assert!(run_named(&cells(abcd(), "a", "a"), "mergeCells", json!(null)).is_none());
        assert!(run_named(&in_text("a"), "mergeCells", json!(null)).is_none());
        let state = run_named(&cells(abcd(), "a", "b"), "mergeCells", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "ab(2,1)/c|d");
        let pos = in_cell(state.doc(), "ab");
        let state = run_named(&at(state.doc().clone(), pos), "splitCell", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "ab|/c|d");
        // A cell of one slot does not split.
        assert!(run_named(&in_text("a"), "splitCell", json!(null)).is_none());
    }

    #[test]
    fn merge_or_split_does_whichever_applies() {
        let state = run_named(&cells(abcd(), "a", "c"), "mergeOrSplit", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "ac(1,2)|b/d");
        let pos = in_cell(state.doc(), "ac");
        let state = run_named(&at(state.doc().clone(), pos), "mergeOrSplit", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "ac|b/|d");
    }

    #[test]
    fn headers_are_toggled() {
        let state = run_named(&in_text("a"), "toggleHeaderRow", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "*a|*b/c|d");
        let state = run_named(&state, "toggleHeaderRow", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a|b/c|d");
        let state = run_named(&in_text("a"), "toggleHeaderColumn", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "*a|b/*c|d");
        let state = run_named(&in_text("a"), "toggleHeaderCell", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "*a|b/c|d");
        let d = doc(vec![table(vec![tr(vec![th("a"), td("b")])])]);
        let pos = in_cell(&d, "a");
        let state = run(&at(d, pos), &toggle_header_cell()).unwrap();
        assert_eq!(table_shape(&state), "a|b");
    }

    #[test]
    fn cell_attributes_are_set() {
        let args = json!({ "name": "colwidth", "value": [50] });
        let state = run_named(&cells(abcd(), "a", "c"), "setCellAttribute", args.clone()).unwrap();
        let table = first_table(state.doc());
        assert_eq!(table.child(0).child(0).attrs()["colwidth"], json!([50]));
        assert_eq!(table.child(1).child(0).attrs()["colwidth"], json!([50]));
        assert_eq!(table.child(0).child(1).attrs()["colwidth"], Value::Null);
        // Already set: nothing to do.
        let pos = in_cell(state.doc(), "a");
        assert!(run_named(&at(state.doc().clone(), pos), "setCellAttribute", args).is_none());
    }

    #[test]
    fn the_cursor_goes_to_the_next_and_previous_cells() {
        let state = run_named(&in_text("b"), "goToNextCell", json!(null)).unwrap();
        assert_eq!(head_cell_text(&state), "c");
        let state = run_named(&state, "goToPreviousCell", json!(null)).unwrap();
        assert_eq!(head_cell_text(&state), "b");
        assert!(run_named(&in_text("a"), "goToPreviousCell", json!(null)).is_none());
        assert!(run_named(&in_text("d"), "goToNextCell", json!(null)).is_none());
    }

    #[test]
    fn tab_in_the_last_cell_adds_a_row() {
        let state = run(&in_text("d"), &go_to_next_cell_or_add_row()).unwrap();
        assert_eq!(table_shape(&state), "a|b/c|d/|");
        let head = state.selection().resolved_head();
        let cell = cell_around(head).unwrap();
        assert_eq!(cell.index(cell.depth - 1), 2, "in the new row");
        assert!(run(&at(doc(vec![p("x")]), 1), &go_to_next_cell_or_add_row()).is_none());
    }

    #[test]
    fn tables_are_deleted() {
        let d = doc(vec![p("x"), grid(&[&["a"]])]);
        let pos = in_cell(&d, "a");
        let state = run_named(&at(d, pos), "deleteTable", json!(null)).unwrap();
        assert_eq!(state.doc().child_count(), 1);
        assert!(
            run(
                &cells(abcd(), "a", "b"),
                &delete_table_when_all_cells_selected()
            )
            .is_none()
        );
        let state = run(
            &cells(abcd(), "a", "d"),
            &delete_table_when_all_cells_selected(),
        )
        .unwrap();
        let mut tables = 0;
        state.doc().descendants(&mut |node, _, _, _| {
            tables += usize::from(super::super::is_table(node));
            true
        });
        assert_eq!(tables, 0);
    }

    #[test]
    fn cells_are_selected_by_position() {
        let d = abcd();
        let (a, d_pos) = (cell_pos(&d, "a"), cell_pos(&d, "d"));
        let state = at(d.clone(), in_cell(&d, "a"));
        let state = run_named(
            &state,
            "setCellSelection",
            json!({ "anchorCell": a, "headCell": d_pos }),
        )
        .unwrap();
        let cells = state.selection().as_custom::<CellSelection>().unwrap();
        assert_eq!(cells.cell_positions().len(), 4);
        assert!(run_named(&state, "setCellSelection", json!({ "anchorCell": 1 })).is_none());
    }

    #[test]
    fn fix_tables_applies_only_to_broken_tables() {
        assert!(run_named(&in_text("a"), "fixTables", json!(null)).is_none());
        let d = doc(vec![table(vec![
            tr(vec![td("a"), td("b")]),
            tr(vec![td("c")]),
        ])]);
        let pos = in_cell(&d, "a");
        let state = run_named(&at(d, pos), "fixTables", json!(null)).unwrap();
        assert_eq!(table_shape(&state), "a|b/c|");
    }

    #[test]
    fn rows_and_columns_move() {
        let state =
            run_named(&in_text("a"), "moveTableRow", json!({ "from": 0, "to": 1 })).unwrap();
        assert_eq!(table_shape(&state), "c|d/a|b");
        let moved = state.selection().as_custom::<CellSelection>().unwrap();
        assert!(moved.is_row_selection());
        assert_eq!(moved.head_cell().node_after().unwrap().text_content(), "b");
        let state = run_named(
            &in_text("a"),
            "moveTableColumn",
            json!({ "from": 1, "to": 0, "select": false }),
        )
        .unwrap();
        assert_eq!(table_shape(&state), "b|a/d|c");
        assert!(state.selection().as_custom::<CellSelection>().is_none());
        // Rows a cell spans move together; a target among them is refused.
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 1, 2), td("b")]),
            tr(vec![td("c")]),
            tr(vec![td("d"), td("e")]),
        ])]);
        let pos = in_cell(&d, "b");
        let state = at(d, pos);
        let moved = run(&state, &move_table_row(None, 1, 2, true)).unwrap();
        assert_eq!(table_shape(&moved), "d|e/a(1,2)|b/c");
        assert!(run(&state, &move_table_row(None, 1, 0, true)).is_none());
        let moved = run(&state, &move_table_column(None, 0, 1, false)).unwrap();
        assert_eq!(table_shape(&moved), "b|a(1,2)/c/e|d");
        // The table by its position.
        let table_pos = Some(0);
        assert!(run(&in_text("a"), &move_table_column(table_pos, 0, 1, false)).is_some());
        assert!(run(&in_text("a"), &move_table_column(Some(1), 0, 1, false)).is_none());
    }

    #[test]
    fn column_widths_and_row_heights_are_set() {
        let args = json!({ "col": 0, "width": 120 });
        let state = run_named(&in_text("b"), "setColumnWidth", args.clone()).unwrap();
        let table = first_table(state.doc());
        assert_eq!(table.child(0).child(0).attrs()["colwidth"], json!([120]));
        assert_eq!(table.child(1).child(0).attrs()["colwidth"], json!([120]));
        assert_eq!(
            super::super::column_widths(&table),
            vec![Some(nsh_core::prelude::px(120.0)), None]
        );
        assert!(
            run_named(&state, "setColumnWidth", args).is_none(),
            "unchanged"
        );
        let state =
            run_named(&state, "setColumnWidth", json!({ "col": 0, "width": null })).unwrap();
        assert_eq!(
            first_table(state.doc()).child(0).child(0).attrs()["colwidth"],
            Value::Null
        );
        assert!(run_named(&state, "setColumnWidth", json!({ "col": 5, "width": 1 })).is_none());
        let state = run_named(&state, "setRowHeight", json!({ "row": 1, "height": 40 })).unwrap();
        assert_eq!(
            first_table(state.doc()).child(1).attrs()["height"],
            json!(40)
        );
        let state = run_named(&state, "setRowHeight", json!({ "row": 1, "height": null })).unwrap();
        assert_eq!(
            first_table(state.doc()).child(1).attrs()["height"],
            Value::Null
        );
        assert!(named_err("setRowHeight", json!({ "height": 3 })));
    }

    fn named_err(name: &str, args: Value) -> bool {
        CommandRegistry::builtin()
            .make(name, &args, &schema())
            .is_err()
    }
}
