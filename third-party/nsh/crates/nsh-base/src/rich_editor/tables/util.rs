//! prosemirror-tables' `util.ts`: finding the cells and tables around
//! positions and the selection, and changing a cell's spans.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others).

use serde_json::Value;

use super::{
    TableRole, is_cell_role,
    map::{Axis, Rect, TableMap, width_json},
    table_role,
};
use crate::rich_editor::{
    model::{Attrs, Node, ResolvedPos},
    state::{EditorState, Selection},
};

fn resolve(doc: &Node, pos: usize) -> Option<ResolvedPos> {
    doc.resolve(pos).ok()
}

/// The position before the cell around `pos` (resolved: it points at the
/// cell from inside its row), if `pos` is in a table's cell.
pub fn cell_around(pos: &ResolvedPos) -> Option<ResolvedPos> {
    for d in (1..pos.depth).rev() {
        if table_role(pos.node(d).ty()) == Some(TableRole::Row) {
            return resolve(pos.doc(), pos.before(d + 1));
        }
    }
    None
}

/// The innermost cell around `pos`.
pub fn cell_wrapping(pos: &ResolvedPos) -> Option<Node> {
    (1..=pos.depth)
        .rev()
        .map(|d| pos.node(d))
        .find(|node| is_cell_role(table_role(node.ty())))
        .cloned()
}

/// Whether the selection's head is in a table's row.
pub fn is_in_table(state: &EditorState) -> bool {
    let head = state.selection().resolved_head();
    (1..=head.depth)
        .rev()
        .any(|d| table_role(head.node(d).ty()) == Some(TableRole::Row))
}

/// The cell a position right next to one points at: the first cell
/// starting at it (going into the nodes after it), else the last one
/// ending at it.
pub fn cell_near(pos: &ResolvedPos) -> Option<ResolvedPos> {
    let doc = pos.doc();
    let mut after = pos.node_after();
    let mut at = pos.pos;
    while let Some(node) = after {
        if is_cell_role(table_role(node.ty())) {
            return resolve(doc, at);
        }
        after = node.first_child().cloned();
        at += 1;
    }
    let mut before = pos.node_before();
    let mut at = pos.pos;
    while let Some(node) = before {
        if is_cell_role(table_role(node.ty())) {
            return resolve(doc, at - node.node_size());
        }
        before = node.last_child().cloned();
        at = at.checked_sub(1)?;
    }
    None
}

/// The cell the selection is about (prosemirror-tables'
/// `selectionCell`): a cell selection's later end, a selected cell, or
/// the cell around (or next to) the head.
pub fn selection_cell(state: &EditorState) -> Option<ResolvedPos> {
    let selection = state.selection();
    if let Some(cells) = selection.as_custom::<super::CellSelection>() {
        let (anchor, head) = (cells.anchor_cell(), cells.head_cell());
        return Some(if anchor.pos > head.pos {
            anchor.clone()
        } else {
            head.clone()
        });
    }
    if let Some(node) = selection.as_node()
        && is_cell_role(table_role(node.node().ty()))
    {
        return Some(selection.resolved_anchor().clone());
    }
    let head = selection.resolved_head();
    cell_around(head).or_else(|| cell_near(head))
}

/// Whether `pos` points at a cell: it is in a row, before a cell.
pub fn points_at_cell(pos: &ResolvedPos) -> bool {
    table_role(pos.parent().ty()) == Some(TableRole::Row) && pos.node_after().is_some()
}

/// The position after the cell `pos` points at.
pub fn move_cell_forward(pos: &ResolvedPos) -> Option<ResolvedPos> {
    let size = pos.node_after()?.node_size();
    resolve(pos.doc(), pos.pos + size)
}

/// Whether two positions pointing at cells are in the same table.
pub fn in_same_table(a: &ResolvedPos, b: &ResolvedPos) -> bool {
    a.depth == b.depth
        && a.depth >= 1
        && a.pos >= b.start(b.depth - 1)
        && a.pos <= b.end(b.depth - 1)
}

/// The table around a position pointing at a cell, with where its
/// content starts.
pub(crate) fn table_of(cell: &ResolvedPos) -> (Node, usize) {
    let depth = cell.depth - 1;
    (cell.node(depth).clone(), cell.start(depth))
}

/// The rectangle the cell `pos` points at covers.
pub fn find_cell(pos: &ResolvedPos) -> Option<Rect> {
    let (table, start) = table_of(pos);
    TableMap::get(&table).try_find_cell(pos.pos - start)
}

/// The first column of the cell `pos` points at.
pub fn col_count(pos: &ResolvedPos) -> Option<usize> {
    find_cell(pos).map(|rect| rect.left)
}

/// The cell next to the one `pos` points at, along `axis` toward `dir`.
pub fn next_cell(pos: &ResolvedPos, axis: Axis, dir: i32) -> Option<ResolvedPos> {
    let (table, start) = table_of(pos);
    let moved = TableMap::get(&table).next_cell(pos.pos - start, axis, dir)?;
    resolve(pos.doc(), start + moved)
}

/// A cell's attributes with `n` columns fewer from its column `pos` on.
pub fn remove_col_span(attrs: &Attrs, pos: usize, n: usize) -> Attrs {
    let mut result = attrs.clone();
    let span = attrs.get("colspan").and_then(Value::as_u64).unwrap_or(1) as usize;
    result.insert("colspan".into(), Value::from(span.saturating_sub(n).max(1)));
    if let Some(mut widths) = colwidth_of(attrs) {
        let end = (pos + n).min(widths.len());
        if pos < end {
            widths.drain(pos..end);
        }
        result.insert("colwidth".into(), widths_json(widths));
    }
    result
}

/// A cell's attributes with `n` columns more at its column `pos`.
pub fn add_col_span(attrs: &Attrs, pos: usize, n: usize) -> Attrs {
    let mut result = attrs.clone();
    let span = attrs.get("colspan").and_then(Value::as_u64).unwrap_or(1) as usize;
    result.insert("colspan".into(), Value::from(span + n));
    if let Some(mut widths) = colwidth_of(attrs) {
        let at = pos.min(widths.len());
        for _ in 0..n {
            widths.insert(at, 0.0);
        }
        result.insert("colwidth".into(), widths_json(widths));
    }
    result
}

fn colwidth_of(attrs: &Attrs) -> Option<Vec<f64>> {
    let items = attrs.get("colwidth")?.as_array()?;
    Some(items.iter().map(|w| w.as_f64().unwrap_or(0.0)).collect())
}

// Widths as a `colwidth` value: null when none is known.
pub(crate) fn widths_json(widths: Vec<f64>) -> Value {
    if widths.iter().any(|w| *w > 0.0) {
        Value::Array(widths.into_iter().map(width_json).collect())
    } else {
        Value::Null
    }
}

/// Whether every cell of column `col` is a header cell.
pub fn column_is_header(map: &TableMap, table: &Node, col: usize) -> bool {
    (0..map.height).all(|row| {
        table
            .node_at(map.map[col + row * map.width])
            .is_some_and(|cell| table_role(cell.ty()) == Some(TableRole::HeaderCell))
    })
}

/// Whether every cell of row `row` is a header cell.
pub fn row_is_header(map: &TableMap, table: &Node, row: usize) -> bool {
    (0..map.width).all(|col| {
        table
            .node_at(map.map[col + row * map.width])
            .is_some_and(|cell| table_role(cell.ty()) == Some(TableRole::HeaderCell))
    })
}

/// A table found in a document.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct FoundTable {
    /// The position before it.
    pub pos: usize,
    /// Where its content starts.
    pub start: usize,
    /// Its depth.
    pub depth: usize,
    /// The table.
    pub node: Node,
}

/// The innermost table around `pos`.
pub fn find_table(pos: &ResolvedPos) -> Option<FoundTable> {
    (1..=pos.depth).rev().find_map(|depth| {
        let node = pos.node(depth);
        (table_role(node.ty()) == Some(TableRole::Table)).then(|| FoundTable {
            pos: pos.before(depth),
            start: pos.start(depth),
            depth,
            node: node.clone(),
        })
    })
}

/// The table starting at `pos` in `doc`.
pub fn table_at(doc: &Node, pos: usize) -> Option<FoundTable> {
    let node = doc.node_at(pos)?;
    if table_role(node.ty()) != Some(TableRole::Table) {
        return None;
    }
    let depth = resolve(doc, pos)?.depth + 1;
    Some(FoundTable {
        pos,
        start: pos + 1,
        depth,
        node,
    })
}

/// The table at `pos` in `state`'s document when given, else the one
/// around the selection.
pub(crate) fn table_or_selected(state: &EditorState, pos: Option<usize>) -> Option<FoundTable> {
    match pos {
        Some(pos) => table_at(state.doc(), pos),
        None => find_table(state.selection().resolved_head()),
    }
}

/// The positions before the cells a [`CellSelection`](super::CellSelection)
/// covers (none for other selections): what a view highlights.
pub fn selected_cells(selection: &Selection) -> Vec<usize> {
    selection
        .as_custom::<super::CellSelection>()
        .map(super::CellSelection::cell_positions)
        .unwrap_or_default()
}
