//! `TableMap`, after prosemirror-tables' `tablemap.ts`: a table's grid of
//! slots, each naming the cell that covers it, so code can move by rows
//! and columns through cells that span several of them.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others).

use std::sync::{Arc, Mutex};

use nsh_core::prelude::{Points, px};
use serde_json::Value;

use super::{TableRole, table_role};
use crate::rich_editor::model::Node;

/// A rectangle of a table's grid, in slots: columns `left..right`, rows
/// `top..bottom`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct Rect {
    /// The first column.
    pub left: usize,
    /// The first row.
    pub top: usize,
    /// The column after the last.
    pub right: usize,
    /// The row after the last.
    pub bottom: usize,
}

impl Rect {
    /// The rectangle of columns `left..right` and rows `top..bottom`.
    pub fn new(left: usize, top: usize, right: usize, bottom: usize) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }
}

/// What is wrong with a table's shape, as [`TableMap`] finds it and
/// `fix_tables` repairs it. Positions are relative to the table's
/// content, as the map's.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum TableProblem {
    /// The cell at `pos` (in row `row`) covers `n` slots that another
    /// cell covers already.
    Collision {
        /// The row the cell starts in.
        row: usize,
        /// The cell.
        pos: usize,
        /// The slots too many.
        n: usize,
    },
    /// Row `row` is `n` slots short of the table's width.
    Missing {
        /// The row.
        row: usize,
        /// The slots missing.
        n: usize,
    },
    /// The cell at `pos` spans `n` rows past the table's end.
    OverlongRowspan {
        /// The cell.
        pos: usize,
        /// The rows too many.
        n: usize,
    },
    /// The cell at `pos` disagrees with its columns' widths; `colwidth`
    /// is what it should have (0 for a column of no known width).
    ColwidthMismatch {
        /// The cell.
        pos: usize,
        /// The widths its columns should have.
        colwidth: Vec<Points>,
    },
    /// The table has no rows or no columns.
    ZeroSized,
}

/// A table's grid (prosemirror-tables' `TableMap`): `width` × `height`
/// slots, row by row, each holding the position of the cell covering it,
/// relative to the start of the table's content (the position of the
/// first row is 0, of its first cell 1). A cell spanning several columns
/// or rows covers several slots.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct TableMap {
    /// The columns.
    pub width: usize,
    /// The rows.
    pub height: usize,
    /// The cell covering each slot, row by row.
    pub map: Vec<usize>,
    /// What is wrong with the table's shape; empty for a sound table.
    pub problems: Vec<TableProblem>,
}

// Maps of the tables used last: views and commands ask for the same
// tables again and again, and nodes never change.
const CACHE_SIZE: usize = 16;
static CACHE: Mutex<Vec<(Node, Arc<TableMap>)>> = Mutex::new(Vec::new());

impl TableMap {
    /// The map of `table` (a node whose type's `tableRole` is `table`),
    /// cached for the tables used last.
    pub fn get(table: &Node) -> Arc<TableMap> {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = cache.iter().position(|(node, _)| node.ptr_eq(table)) {
            let entry = cache.remove(i);
            let map = entry.1.clone();
            cache.insert(0, entry);
            return map;
        }
        let map = Arc::new(Self::compute(table));
        cache.insert(0, (table.clone(), map.clone()));
        cache.truncate(CACHE_SIZE);
        map
    }

    /// The map of `table`, computed (prosemirror-tables' `computeMap`).
    pub fn compute(table: &Node) -> TableMap {
        let width = find_width(table);
        let height = table.child_count();
        let mut map = vec![0usize; width * height];
        // Which slots are filled: a cell at relative position 0 is
        // impossible (the first row starts there), but the map keeps 0
        // for an empty slot as prosemirror-tables does.
        let mut problems = Vec::new();
        // Per column: the width most cells give it and how many do.
        let mut col_widths: Vec<Option<(f64, usize)>> = vec![None; width];
        let mut map_pos = 0;
        let mut pos = 0;
        for row in 0..height {
            let row_node = table.child(row);
            pos += 1;
            let mut i = 0;
            loop {
                while map_pos < map.len() && map[map_pos] != 0 {
                    map_pos += 1;
                }
                if i == row_node.child_count() {
                    break;
                }
                let cell = row_node.child(i);
                let (colspan, rowspan) = (colspan(cell), rowspan(cell));
                let colwidth = colwidth(cell);
                for h in 0..rowspan {
                    if h + row >= height {
                        problems.push(TableProblem::OverlongRowspan {
                            pos,
                            n: rowspan - h,
                        });
                        break;
                    }
                    let start = map_pos + h * width;
                    for w in 0..colspan {
                        let slot = start + w;
                        if slot < map.len() && map[slot] == 0 {
                            map[slot] = pos;
                        } else {
                            problems.push(TableProblem::Collision {
                                row,
                                pos,
                                n: colspan - w,
                            });
                        }
                        let col_w = colwidth.as_ref().and_then(|c| c.get(w).copied());
                        if let Some(col_w) = col_w.filter(|w| *w != 0.0)
                            && width > 0
                        {
                            let col = slot % width;
                            match &mut col_widths[col] {
                                Some((prev, count)) if *prev == col_w => *count += 1,
                                Some((prev, count)) if *count == 1 => {
                                    *prev = col_w;
                                    *count = 1;
                                }
                                Some(_) => {}
                                None => col_widths[col] = Some((col_w, 1)),
                            }
                        }
                    }
                }
                map_pos += colspan;
                pos += cell.node_size();
                i += 1;
            }
            let expected = (row + 1) * width;
            let mut missing = 0;
            while map_pos < expected {
                if map[map_pos] == 0 {
                    missing += 1;
                }
                map_pos += 1;
            }
            if missing > 0 {
                problems.push(TableProblem::Missing { row, n: missing });
            }
            pos += 1;
        }
        if width == 0 || height == 0 {
            problems.push(TableProblem::ZeroSized);
        }
        let mut table_map = TableMap {
            width,
            height,
            map,
            problems,
        };
        let bad_widths = col_widths
            .iter()
            .any(|w| w.is_some_and(|(_, count)| count < height));
        if bad_widths {
            table_map.find_bad_col_widths(&col_widths, table);
        }
        table_map
    }

    // prosemirror-tables' `findBadColWidths`: the cells whose `colwidth`
    // disagrees with their columns' widths.
    fn find_bad_col_widths(&mut self, col_widths: &[Option<(f64, usize)>], table: &Node) {
        let mut seen = std::collections::HashSet::new();
        let mut found = Vec::new();
        for i in 0..self.map.len() {
            let pos = self.map[i];
            if !seen.insert(pos) {
                continue;
            }
            let Some(node) = table.node_at(pos) else {
                continue;
            };
            let span = colspan(&node);
            let current = colwidth(&node);
            let mut updated: Option<Vec<f64>> = None;
            for j in 0..span {
                let col = (i + j) % self.width;
                let Some((width, _)) = col_widths[col] else {
                    continue;
                };
                if current.as_ref().and_then(|c| c.get(j)) != Some(&width) {
                    updated.get_or_insert_with(|| {
                        current.clone().unwrap_or_else(|| vec![0.0; span])
                    })[j] = width;
                }
            }
            if let Some(updated) = updated {
                found.push(TableProblem::ColwidthMismatch {
                    pos,
                    colwidth: updated.into_iter().map(|w| px(w as f32)).collect(),
                });
            }
        }
        // First, as prosemirror-tables puts them.
        found.append(&mut self.problems);
        self.problems = found;
    }

    /// The rectangle the cell at `pos` covers.
    ///
    /// # Panics
    ///
    /// When no cell of the table is at `pos`.
    pub fn find_cell(&self, pos: usize) -> Rect {
        self.try_find_cell(pos)
            .unwrap_or_else(|| panic!("no cell with offset {pos} found"))
    }

    /// The rectangle the cell at `pos` covers, if a cell is there.
    pub fn try_find_cell(&self, pos: usize) -> Option<Rect> {
        let i = self.map.iter().position(|&p| p == pos)?;
        let left = i % self.width;
        let top = i / self.width;
        let mut right = left + 1;
        let mut bottom = top + 1;
        while right < self.width && self.map[i + (right - left)] == pos {
            right += 1;
        }
        while bottom < self.height && self.map[i + self.width * (bottom - top)] == pos {
            bottom += 1;
        }
        Some(Rect::new(left, top, right, bottom))
    }

    /// The first column the cell at `pos` covers.
    ///
    /// # Panics
    ///
    /// When no cell of the table is at `pos`.
    pub fn col_count(&self, pos: usize) -> usize {
        let i = self
            .map
            .iter()
            .position(|&p| p == pos)
            .unwrap_or_else(|| panic!("no cell with offset {pos} found"));
        i % self.width
    }

    /// The cell next to the cell at `pos` along `axis` toward `dir`
    /// (negative: left or up), none at the table's edge.
    pub fn next_cell(&self, pos: usize, axis: Axis, dir: i32) -> Option<usize> {
        let Rect {
            left,
            top,
            right,
            bottom,
        } = self.try_find_cell(pos)?;
        match axis {
            Axis::Horizontal => {
                if (dir < 0 && left == 0) || (dir >= 0 && right == self.width) {
                    return None;
                }
                let col = if dir < 0 { left - 1 } else { right };
                Some(self.map[top * self.width + col])
            }
            Axis::Vertical => {
                if (dir < 0 && top == 0) || (dir >= 0 && bottom == self.height) {
                    return None;
                }
                let row = if dir < 0 { top - 1 } else { bottom };
                Some(self.map[left + self.width * row])
            }
        }
    }

    /// The smallest rectangle covering the cells at `a` and `b`. Cells
    /// spanning out of it are not taken into account (see
    /// [`TableMap::cells_in_rect`]).
    pub fn rect_between(&self, a: usize, b: usize) -> Rect {
        let a = self.find_cell(a);
        let b = self.find_cell(b);
        Rect::new(
            a.left.min(b.left),
            a.top.min(b.top),
            a.right.max(b.right),
            a.bottom.max(b.bottom),
        )
    }

    /// The positions of the cells whose top left corner is in `rect`, in
    /// reading order.
    pub fn cells_in_rect(&self, rect: Rect) -> Vec<usize> {
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in rect.top..rect.bottom {
            for col in rect.left..rect.right {
                let index = row * self.width + col;
                let pos = self.map[index];
                if !seen.insert(pos) {
                    continue;
                }
                if (col == rect.left && col > 0 && self.map[index - 1] == pos)
                    || (row == rect.top && row > 0 && self.map[index - self.width] == pos)
                {
                    continue;
                }
                result.push(pos);
            }
        }
        result
    }

    /// Where a cell starting at `row` and `col` would go in `table`
    /// (this map's table): before the first cell of the row from that
    /// column on, or at the row's end.
    pub fn position_at(&self, row: usize, col: usize, table: &Node) -> usize {
        let mut row_start = 0;
        for i in 0..table.child_count() {
            let row_end = row_start + table.child(i).node_size();
            if i == row {
                let mut index = col + row * self.width;
                let row_end_index = (row + 1) * self.width;
                // Past the cells of earlier rows spanning into this one.
                while index < row_end_index && self.map[index] < row_start {
                    index += 1;
                }
                return if index == row_end_index {
                    row_end - 1
                } else {
                    self.map[index]
                };
            }
            row_start = row_end;
        }
        row_start
    }

    /// Every cell with the rectangle it covers, in document order: what a
    /// view lays a table's grid out with.
    pub fn cells(&self) -> Vec<(usize, Rect)> {
        let mut cells: Vec<(usize, Rect)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for &pos in &self.map {
            if pos == 0 || !seen.insert(pos) {
                continue;
            }
            if let Some(rect) = self.try_find_cell(pos) {
                cells.push((pos, rect));
            }
        }
        crate::sort::sort_by_key(&mut cells, |(pos, _)| *pos);
        cells
    }
}

/// A direction of movement in a table.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Axis {
    /// Along a row.
    #[default]
    Horizontal,
    /// Along a column.
    Vertical,
}

// The table's width: the widest row, counting cells of earlier rows that
// span into it (prosemirror-tables' `findWidth`).
fn find_width(table: &Node) -> usize {
    let mut width: Option<usize> = None;
    let mut has_rowspan = false;
    for row in 0..table.child_count() {
        let row_node = table.child(row);
        let mut row_width = 0;
        if has_rowspan {
            for j in 0..row {
                let prev = table.child(j);
                for i in 0..prev.child_count() {
                    let cell = prev.child(i);
                    if j + rowspan(cell) > row {
                        row_width += colspan(cell);
                    }
                }
            }
        }
        for i in 0..row_node.child_count() {
            let cell = row_node.child(i);
            row_width += colspan(cell);
            if rowspan(cell) > 1 {
                has_rowspan = true;
            }
        }
        width = Some(width.map_or(row_width, |w| w.max(row_width)));
    }
    width.unwrap_or(0)
}

/// A cell's `colspan` (1 when missing or invalid).
pub fn colspan(cell: &Node) -> usize {
    span_attr(cell, "colspan")
}

/// A cell's `rowspan` (1 when missing or invalid).
pub fn rowspan(cell: &Node) -> usize {
    span_attr(cell, "rowspan")
}

fn span_attr(cell: &Node, name: &str) -> usize {
    cell.attrs()
        .get(name)
        .and_then(Value::as_f64)
        .filter(|n| *n >= 1.0)
        .map_or(1, |n| n as usize)
}

/// A cell's `colwidth`: a width per column it spans (0 for none), or
/// none.
pub(crate) fn colwidth(cell: &Node) -> Option<Vec<f64>> {
    let items = cell.attrs().get("colwidth")?.as_array()?;
    Some(items.iter().map(|w| w.as_f64().unwrap_or(0.0)).collect())
}

/// A width as JSON: whole numbers as integers, as JS writes them.
pub(crate) fn width_json(width: f64) -> Value {
    if width.fract() == 0.0 && width.abs() < 1e15 {
        Value::from(width as i64)
    } else {
        Value::from(width)
    }
}

/// The widths of `table`'s columns as its cells' `colwidth`s give them
/// (the width most cells of a column agree on), none for a column no
/// cell gives a width.
pub fn column_widths(table: &Node) -> Vec<Option<Points>> {
    let map = TableMap::get(table);
    let mut widths: Vec<Option<Points>> = vec![None; map.width];
    let mut seen = std::collections::HashSet::new();
    for (i, &pos) in map.map.iter().enumerate() {
        if !seen.insert(pos) {
            continue;
        }
        let Some(cell) = table.node_at(pos) else {
            continue;
        };
        let Some(colwidth) = colwidth(&cell) else {
            continue;
        };
        for (j, width) in colwidth.into_iter().enumerate() {
            let col = (i + j) % map.width.max(1);
            if width > 0.0 && col < widths.len() && widths[col].is_none() {
                widths[col] = Some(px(width as f32));
            }
        }
    }
    widths
}

/// Whether `node` is a table (its type's `tableRole` is `table`).
pub fn is_table(node: &Node) -> bool {
    table_role(node.ty()) == Some(TableRole::Table)
}
