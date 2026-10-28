//! `CellSelection`, after prosemirror-tables' `cellselection.ts`: a
//! rectangle of a table's cells selected as cells, and the selection a
//! pointer dragged across cells makes.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others).

use std::sync::Arc;

use serde_json::{Value, json};

use super::{
    TableRole,
    map::{Rect, TableMap, rowspan},
    table_role,
    util::{cell_around, cell_near, in_same_table, points_at_cell, remove_col_span, table_of},
};
use crate::rich_editor::{
    model::{Fragment, Node, ResolvedPos, Slice},
    state::{
        CustomBookmark, CustomSelection, EditorState, Selection, SelectionBookmark, SelectionRange,
        TextSelection, Transaction,
    },
    transform::Mappable,
};

/// The JSON `type` of a [`CellSelection`].
pub const CELL_SELECTION: &str = "cell";

fn resolve(doc: &Node, pos: usize) -> Option<ResolvedPos> {
    doc.resolve(pos).ok()
}

/// A selection of a rectangle of a table's cells (prosemirror-tables'
/// `CellSelection`): from the anchor cell to the head cell, both
/// positions pointing at cells (before them, in their rows). Its ranges
/// are the cells' contents, the head cell's first. The view paints each
/// selected cell (its `selectedCell` part) rather than a native
/// selection. Its JSON form is `{type: "cell",
/// anchor, head}`.
#[derive(Debug, Clone)]
pub struct CellSelection {
    anchor_cell: ResolvedPos,
    head_cell: ResolvedPos,
    ranges: Vec<SelectionRange>,
}

impl CellSelection {
    /// The cells from the one `anchor_cell` points at to the one
    /// `head_cell` points at (both in one table), none when they are not
    /// cells of one table.
    pub fn new(anchor_cell: ResolvedPos, head_cell: ResolvedPos) -> Option<Self> {
        if !points_at_cell(&anchor_cell)
            || !points_at_cell(&head_cell)
            || !in_same_table(&anchor_cell, &head_cell)
        {
            return None;
        }
        let (table, table_start) = table_of(&anchor_cell);
        let map = TableMap::get(&table);
        let rect = rect_between(
            &map,
            anchor_cell.pos - table_start,
            head_cell.pos - table_start,
        )?;
        let doc = anchor_cell.doc().clone();
        let head = head_cell.pos - table_start;
        let mut cells: Vec<usize> = map
            .cells_in_rect(rect)
            .into_iter()
            .filter(|&pos| pos != head)
            .collect();
        // The head cell's range first: the selection's main part.
        cells.insert(0, head);
        let mut ranges = Vec::with_capacity(cells.len());
        for pos in cells {
            let cell = table.node_at(pos)?;
            let from = table_start + pos + 1;
            ranges.push(SelectionRange::new(
                resolve(&doc, from)?,
                resolve(&doc, from + cell.content().size())?,
            ));
        }
        Some(Self {
            anchor_cell,
            head_cell,
            ranges,
        })
    }

    /// The cells from the cell at `anchor` to the cell at `head` (the
    /// anchor's when none) in `doc`, as a selection.
    pub fn create(doc: &Node, anchor: usize, head: Option<usize>) -> Option<Selection> {
        let anchor = resolve(doc, anchor)?;
        let head = match head {
            Some(head) => resolve(doc, head)?,
            None => anchor.clone(),
        };
        Self::new(anchor, head).map(Into::into)
    }

    /// Where the anchor cell is (pointing at it).
    pub fn anchor_cell(&self) -> &ResolvedPos {
        &self.anchor_cell
    }

    /// Where the head cell is (pointing at it).
    pub fn head_cell(&self) -> &ResolvedPos {
        &self.head_cell
    }

    /// The table's map, where its content starts, and the rectangle
    /// selected.
    pub fn rect(&self) -> (Arc<TableMap>, usize, Rect) {
        let (table, start) = table_of(&self.anchor_cell);
        let map = TableMap::get(&table);
        let rect = map.rect_between(self.anchor_cell.pos - start, self.head_cell.pos - start);
        (map, start, rect)
    }

    /// The table the cells are in.
    pub fn table(&self) -> Node {
        table_of(&self.anchor_cell).0
    }

    /// Calls `f` with each selected cell and the position before it.
    pub fn for_each_cell(&self, mut f: impl FnMut(&Node, usize)) {
        let (map, start, rect) = self.rect();
        let table = self.table();
        for pos in map.cells_in_rect(rect) {
            if let Some(cell) = table.node_at(pos) {
                f(&cell, start + pos);
            }
        }
    }

    /// The positions before the selected cells, in reading order.
    pub fn cell_positions(&self) -> Vec<usize> {
        let (map, start, rect) = self.rect();
        map.cells_in_rect(rect)
            .into_iter()
            .map(|pos| start + pos)
            .collect()
    }

    /// Whether the cell at `pos` (the position before it) is selected.
    pub fn contains_cell(&self, pos: usize) -> bool {
        self.cell_positions().contains(&pos)
    }

    /// Whether it selects whole columns: from the table's first row to its
    /// last.
    pub fn is_col_selection(&self) -> bool {
        let depth = self.anchor_cell.depth - 1;
        let anchor_top = self.anchor_cell.index(depth);
        let head_top = self.head_cell.index(depth);
        if anchor_top.min(head_top) > 0 {
            return false;
        }
        let span = |cell: &ResolvedPos| cell.node_after().map_or(1, |n| rowspan(&n));
        let anchor_bottom = anchor_top + span(&self.anchor_cell);
        let head_bottom = head_top + span(&self.head_cell);
        anchor_bottom.max(head_bottom) == self.head_cell.node(depth).child_count()
    }

    /// Whether it selects whole rows: from the table's first column to its
    /// last.
    pub fn is_row_selection(&self) -> bool {
        let (map, start, _) = self.rect();
        let (Some(anchor), Some(head)) = (
            map.try_find_cell(self.anchor_cell.pos - start),
            map.try_find_cell(self.head_cell.pos - start),
        ) else {
            return false;
        };
        if anchor.left.min(head.left) > 0 {
            return false;
        }
        anchor.right.max(head.right) == map.width
    }

    /// The whole columns from the anchor cell's to the head cell's.
    pub fn col_selection(anchor_cell: ResolvedPos, head_cell: ResolvedPos) -> Option<Self> {
        if !points_at_cell(&anchor_cell) || !in_same_table(&anchor_cell, &head_cell) {
            return None;
        }
        let (table, start) = table_of(&anchor_cell);
        let map = TableMap::get(&table);
        let anchor_rect = map.try_find_cell(anchor_cell.pos - start)?;
        let head_rect = map.try_find_cell(head_cell.pos - start)?;
        let doc = anchor_cell.doc().clone();
        let last_row = map.width * (map.height - 1);
        let (mut anchor_cell, mut head_cell) = (anchor_cell, head_cell);
        if anchor_rect.top <= head_rect.top {
            if anchor_rect.top > 0 {
                anchor_cell = resolve(&doc, start + map.map[anchor_rect.left])?;
            }
            if head_rect.bottom < map.height {
                head_cell = resolve(&doc, start + map.map[last_row + head_rect.right - 1])?;
            }
        } else {
            if head_rect.top > 0 {
                head_cell = resolve(&doc, start + map.map[head_rect.left])?;
            }
            if anchor_rect.bottom < map.height {
                anchor_cell = resolve(&doc, start + map.map[last_row + anchor_rect.right - 1])?;
            }
        }
        Self::new(anchor_cell, head_cell)
    }

    /// The whole rows from the anchor cell's to the head cell's.
    pub fn row_selection(anchor_cell: ResolvedPos, head_cell: ResolvedPos) -> Option<Self> {
        if !points_at_cell(&anchor_cell) || !in_same_table(&anchor_cell, &head_cell) {
            return None;
        }
        let (table, start) = table_of(&anchor_cell);
        let map = TableMap::get(&table);
        let anchor_rect = map.try_find_cell(anchor_cell.pos - start)?;
        let head_rect = map.try_find_cell(head_cell.pos - start)?;
        let doc = anchor_cell.doc().clone();
        let (mut anchor_cell, mut head_cell) = (anchor_cell, head_cell);
        if anchor_rect.left <= head_rect.left {
            if anchor_rect.left > 0 {
                anchor_cell = resolve(&doc, start + map.map[anchor_rect.top * map.width])?;
            }
            if head_rect.right < map.width {
                head_cell = resolve(&doc, start + map.map[map.width * (head_rect.top + 1) - 1])?;
            }
        } else {
            if head_rect.left > 0 {
                head_cell = resolve(&doc, start + map.map[head_rect.top * map.width])?;
            }
            if anchor_rect.right < map.width {
                anchor_cell =
                    resolve(&doc, start + map.map[map.width * (anchor_rect.top + 1) - 1])?;
            }
        }
        Self::new(anchor_cell, head_cell)
    }

    /// Reads its JSON form (`{type: "cell", anchor, head}`) in `doc`.
    pub fn from_json(doc: &Node, json: &Value) -> Option<Selection> {
        let anchor = json.get("anchor").and_then(Value::as_u64)? as usize;
        let head = json.get("head").and_then(Value::as_u64)? as usize;
        let size = doc.content().size();
        if anchor > size || head > size {
            return None;
        }
        Self::create(doc, anchor, Some(head))
    }

    /// The selected cells as rows (prosemirror-tables' `content`): a
    /// slice of rows, open at both ends, holding the cells cut to the
    /// rectangle (a cell spanning out of it keeps the part inside, empty
    /// unless it starts inside); the whole table when every cell is
    /// selected.
    pub fn cells_content(&self) -> Slice {
        let table = self.table();
        let (map, _, rect) = self.rect();
        let mut seen = std::collections::HashSet::new();
        let mut rows = Vec::new();
        for row in rect.top..rect.bottom {
            let mut row_content = Vec::new();
            for col in rect.left..rect.right {
                let pos = map.map[row * map.width + col];
                if !seen.insert(pos) {
                    continue;
                }
                let (Some(cell_rect), Some(mut cell)) =
                    (map.try_find_cell(pos), table.node_at(pos))
                else {
                    continue;
                };
                let extra_left = rect.left.saturating_sub(cell_rect.left);
                let extra_right = cell_rect.right.saturating_sub(rect.right);
                if extra_left > 0 || extra_right > 0 {
                    let mut attrs = cell.attrs().clone();
                    if extra_left > 0 {
                        attrs = remove_col_span(&attrs, 0, extra_left);
                    }
                    if extra_right > 0 {
                        let span =
                            attrs.get("colspan").and_then(Value::as_u64).unwrap_or(1) as usize;
                        attrs =
                            remove_col_span(&attrs, span.saturating_sub(extra_right), extra_right);
                    }
                    let made = if cell_rect.left < rect.left {
                        cell.ty()
                            .create_and_fill(Some(attrs), Fragment::empty(), vec![])
                    } else {
                        cell.ty()
                            .create(Some(attrs), cell.content().clone(), vec![])
                            .ok()
                    };
                    let Some(made) = made else { continue };
                    cell = made;
                }
                if cell_rect.top < rect.top || cell_rect.bottom > rect.bottom {
                    let mut attrs = cell.attrs().clone();
                    let span = cell_rect.bottom.min(rect.bottom) - cell_rect.top.max(rect.top);
                    attrs.insert("rowspan".into(), Value::from(span));
                    let made = if cell_rect.top < rect.top {
                        cell.ty()
                            .create_and_fill(Some(attrs), Fragment::empty(), vec![])
                    } else {
                        cell.ty()
                            .create(Some(attrs), cell.content().clone(), vec![])
                            .ok()
                    };
                    let Some(made) = made else { continue };
                    cell = made;
                }
                row_content.push(cell);
            }
            rows.push(table.child(row).copy(Fragment::from(row_content)));
        }
        let fragment = if self.is_col_selection() && self.is_row_selection() {
            Fragment::from(vec![table])
        } else {
            Fragment::from(rows)
        };
        Slice::new(fragment, 1, 1)
    }
}

// The rectangle of two cells, none when either is not a cell of the map.
fn rect_between(map: &TableMap, a: usize, b: usize) -> Option<Rect> {
    let a = map.try_find_cell(a)?;
    let b = map.try_find_cell(b)?;
    Some(Rect::new(
        a.left.min(b.left),
        a.top.min(b.top),
        a.right.max(b.right),
        a.bottom.max(b.bottom),
    ))
}

impl From<CellSelection> for Selection {
    fn from(selection: CellSelection) -> Self {
        Selection::custom(Arc::new(selection))
    }
}

impl CustomSelection for CellSelection {
    fn json_id(&self) -> &str {
        CELL_SELECTION
    }

    // As prosemirror-tables' (a `Selection` whose anchor and head are its
    // first range's ends): the head cell's content.
    fn anchor(&self) -> &ResolvedPos {
        &self.ranges[0].from
    }

    fn head(&self) -> &ResolvedPos {
        &self.ranges[0].to
    }

    fn ranges(&self) -> &[SelectionRange] {
        &self.ranges
    }

    fn map(&self, doc: &Node, mapping: &dyn Mappable) -> Selection {
        let size = doc.content().size();
        let anchor = resolve(doc, mapping.map(self.anchor_cell.pos, 1).min(size));
        let head = resolve(doc, mapping.map(self.head_cell.pos, 1).min(size));
        let (Some(anchor), Some(head)) = (anchor, head) else {
            return Selection::at_start(doc);
        };
        if points_at_cell(&anchor) && points_at_cell(&head) && in_same_table(&anchor, &head) {
            let old_table = &self.anchor_cell.node(self.anchor_cell.depth - 1);
            let new_table = &anchor.node(anchor.depth - 1);
            let changed = !old_table.ptr_eq(new_table);
            let made = if changed && self.is_row_selection() {
                Self::row_selection(anchor.clone(), head.clone())
            } else if changed && self.is_col_selection() {
                Self::col_selection(anchor.clone(), head.clone())
            } else {
                Self::new(anchor.clone(), head.clone())
            };
            if let Some(made) = made {
                return made.into();
            }
        }
        TextSelection::between(&anchor, &head, None)
    }

    fn eq(&self, other: &Selection) -> bool {
        other.as_custom::<CellSelection>().is_some_and(|other| {
            other.anchor_cell.pos == self.anchor_cell.pos
                && other.head_cell.pos == self.head_cell.pos
        })
    }

    fn to_json(&self) -> Value {
        json!({"type": CELL_SELECTION, "anchor": self.anchor_cell.pos, "head": self.head_cell.pos})
    }

    fn bookmark(&self) -> SelectionBookmark {
        SelectionBookmark::Custom(Arc::new(CellBookmark {
            anchor: self.anchor_cell.pos,
            head: self.head_cell.pos,
        }))
    }

    fn content(&self) -> Slice {
        self.cells_content()
    }

    fn visible(&self) -> bool {
        false
    }

    // Each cell's content replaced (the first with `content`, the others
    // emptied), the cursor at the end of the last.
    fn replace(&self, tr: &mut Transaction, content: &Slice) -> bool {
        let map_from = tr.steps.len();
        for (i, range) in self.ranges.iter().enumerate() {
            let mapping = tr.mapping.slice_from(map_from);
            let from = mapping.map(range.from.pos, 1);
            let to = mapping.map(range.to.pos, 1);
            let slice = if i == 0 {
                content.clone()
            } else {
                Slice::empty()
            };
            let _ = tr.replace(from, to, slice);
        }
        let to = tr
            .mapping
            .slice_from(map_from)
            .map(self.ranges[0].to.pos, 1);
        if let Some(pos) = resolve(tr.doc(), to.min(tr.doc().content().size()))
            && let Some(selection) = Selection::find_from(&pos, -1, false)
        {
            tr.set_selection(selection);
        }
        true
    }
}

/// A [`CellSelection`]'s bookmark: its cells' positions.
#[derive(Debug)]
struct CellBookmark {
    anchor: usize,
    head: usize,
}

impl CustomBookmark for CellBookmark {
    fn map(&self, mapping: &dyn Mappable) -> SelectionBookmark {
        SelectionBookmark::Custom(Arc::new(CellBookmark {
            anchor: mapping.map(self.anchor, 1),
            head: mapping.map(self.head, 1),
        }))
    }

    fn resolve(&self, doc: &Node) -> Selection {
        let size = doc.content().size();
        let anchor = resolve(doc, self.anchor.min(size));
        let head = resolve(doc, self.head.min(size));
        let (Some(anchor), Some(head)) = (anchor, head) else {
            return Selection::at_start(doc);
        };
        CellSelection::new(anchor, head.clone())
            .map(Into::into)
            .unwrap_or_else(|| Selection::near(&head, 1))
    }
}

/// The selection a pointer pressed at `anchor` and moved to `head` makes
/// in a table: the cells from the one around `anchor` to the one around
/// (or next to) `head` when they are two cells of one table; none
/// otherwise (a text selection then, within one cell or outside tables).
/// What the view's drag calls (through `table_editing`'s
/// `create_selection_between`).
pub fn cell_selection_between(
    state: &EditorState,
    anchor: usize,
    head: usize,
) -> Option<Selection> {
    let doc = state.doc();
    let size = doc.content().size();
    let anchor = resolve(doc, anchor.min(size))?;
    let head = resolve(doc, head.min(size))?;
    let anchor_cell = cell_around(&anchor).or_else(|| cell_near(&anchor))?;
    let head_cell = cell_around(&head).or_else(|| cell_near(&head))?;
    if anchor_cell.pos == head_cell.pos {
        return None;
    }
    // Cells of nested tables: the outer table's cells when the ends are
    // in different tables, as long as one table holds both.
    let (anchor_cell, head_cell) = same_table_cells(anchor_cell, head_cell)?;
    if anchor_cell.pos == head_cell.pos {
        return None;
    }
    CellSelection::new(anchor_cell, head_cell).map(Into::into)
}

// The cells around `a` and `b` (or around their tables) in one table.
fn same_table_cells(a: ResolvedPos, b: ResolvedPos) -> Option<(ResolvedPos, ResolvedPos)> {
    let (mut a, mut b) = (a, b);
    loop {
        if in_same_table(&a, &b) {
            return Some((a, b));
        }
        // Move the deeper one out to the cell around its table.
        if a.depth >= b.depth {
            a = outer_cell(&a)?;
        } else {
            b = outer_cell(&b)?;
        }
    }
}

fn outer_cell(cell: &ResolvedPos) -> Option<ResolvedPos> {
    let table_depth = cell.depth.checked_sub(1)?;
    if table_depth == 0 {
        return None;
    }
    let before_table = resolve(cell.doc(), cell.before(table_depth))?;
    cell_around(&before_table)
}

/// Whether `node` is a cell (its type's `tableRole` is `cell` or
/// `header_cell`).
pub fn is_cell(node: &Node) -> bool {
    matches!(
        table_role(node.ty()),
        Some(TableRole::Cell | TableRole::HeaderCell)
    )
}
