//! Editing in tables, after prosemirror-tables' `input.ts` and the
//! `tableEditing` plugin: arrows leaving a cell move to the next one,
//! Shift+arrows grow cell selections, Backspace and Delete clear selected
//! cells, a pointer dragged across cells selects them, and selections that
//! would be awkward in tables are normalized after each change. The view
//! paints selected cells itself (its `selectedCell` part), where
//! prosemirror-tables decorates them with a class.
//!
//! The kernel has no view: where prosemirror-tables asks the view whether
//! the cursor is at the visual end of its textblock, these commands check
//! that it is at the textblock's first or last position.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others).

use std::sync::Arc;

use super::{
    CellSelection, TableRole,
    map::{Axis, TableMap},
    table_node_types, table_role,
    util::{cell_around, in_same_table, next_cell},
};
use crate::rich_editor::{
    commands::{BoxCommand, command},
    extensions::{Keymap, KeymapOptions},
    model::{Node, ResolvedPos},
    state::{
        EditorState, KeyEvent, Plugin, PluginKey, PluginSpec, Selection, SelectionKind,
        TextSelection, Transaction,
    },
};

/// How [`table_editing`] treats selections.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct TableEditingOptions {
    /// Whether a whole table can be node-selected; when false, a selected
    /// table becomes a selection of all its cells.
    pub allow_table_node_selection: bool,
}

/// The key of [`table_editing`].
pub fn table_editing_key() -> PluginKey {
    PluginKey::new("tableEditing")
}

fn resolve(doc: &Node, pos: usize) -> Option<ResolvedPos> {
    doc.resolve(pos).ok()
}

fn is_cell_type(node: &Node) -> bool {
    matches!(
        table_role(node.ty()),
        Some(TableRole::Cell | TableRole::HeaderCell)
    )
}

// The position before the cell whose edge the cursor is at, going `dir`
// (prosemirror-tables' `atEndOfCell`): the cursor at the start (end) of
// the cell's first (last) textblock.
fn at_end_of_cell(state: &EditorState, dir: i32) -> Option<usize> {
    let selection = state.selection();
    let text = selection.as_text()?;
    let head = text.head();
    let parent = head.parent();
    if !parent.is_textblock() {
        return None;
    }
    let at_edge = if dir < 0 {
        head.parent_offset == 0
    } else {
        head.parent_offset == parent.content().size()
    };
    if !at_edge {
        return None;
    }
    for d in (0..head.depth).rev() {
        let node = head.node(d);
        let index = if dir < 0 {
            head.index(d)
        } else {
            head.index_after(d)
        };
        if index != if dir < 0 { 0 } else { node.child_count() } {
            return None;
        }
        if is_cell_type(node) {
            return Some(head.before(d));
        }
    }
    None
}

/// The arrow key `dir` (-1 left / up, 1 right / down) along `axis`, as
/// prosemirror-tables' `arrow`: a cell selection collapses next to its
/// head cell; a cursor at the cell's edge moves into the next cell
/// (horizontally: the position past the edge; vertically: the cell below
/// or above, or out of the table past the last row).
pub fn arrow(axis: Axis, dir: i32) -> BoxCommand {
    command(move |state, dispatch| {
        let selection = state.selection();
        let next = if let Some(cells) = selection.as_custom::<CellSelection>() {
            Selection::near(cells.head_cell(), dir)
        } else {
            if axis == Axis::Vertical && !selection.empty() {
                return false;
            }
            let Some(end) = at_end_of_cell(state, dir) else {
                return false;
            };
            match axis {
                Axis::Horizontal => {
                    let head = selection.head() as isize + dir as isize;
                    let Some(pos) = usize::try_from(head)
                        .ok()
                        .and_then(|pos| resolve(state.doc(), pos))
                    else {
                        return false;
                    };
                    Selection::near(&pos, dir)
                }
                Axis::Vertical => {
                    let Some(cell) = resolve(state.doc(), end) else {
                        return false;
                    };
                    match next_cell(&cell, axis, dir) {
                        Some(next) => Selection::near(&next, 1),
                        None => {
                            // Out of the table, before or after it.
                            let table_depth = cell.depth - 1;
                            let pos = if dir < 0 {
                                cell.before(table_depth)
                            } else {
                                cell.after(table_depth)
                            };
                            let Some(pos) = resolve(state.doc(), pos) else {
                                return false;
                            };
                            Selection::near(&pos, dir)
                        }
                    }
                }
            }
        };
        if &next == selection {
            return false;
        }
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            tr.set_selection(next);
            tr.scroll_into_view();
            dispatch(tr);
        }
        true
    })
}

/// Shift with the arrow key `dir` along `axis`, as prosemirror-tables'
/// `shiftArrow`: a cell selection's head moves to the next cell; a cursor
/// at its cell's edge selects that cell and the next.
pub fn shift_arrow(axis: Axis, dir: i32) -> BoxCommand {
    command(move |state, dispatch| {
        let selection = state.selection();
        let cells = match selection.as_custom::<CellSelection>() {
            Some(cells) => cells.clone(),
            None => {
                let Some(end) = at_end_of_cell(state, dir) else {
                    return false;
                };
                let Some(cell) = resolve(state.doc(), end) else {
                    return false;
                };
                let Some(cells) = CellSelection::new(cell.clone(), cell) else {
                    return false;
                };
                cells
            }
        };
        let Some(head) = next_cell(cells.head_cell(), axis, dir) else {
            return false;
        };
        let Some(next) = CellSelection::new(cells.anchor_cell().clone(), head) else {
            return false;
        };
        let next: Selection = next.into();
        if &next == selection {
            return false;
        }
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            tr.set_selection(next);
            dispatch(tr);
        }
        true
    })
}

/// Empties the selected cells (prosemirror-tables' `deleteCellSelection`,
/// Backspace and Delete in a cell selection); applies to any cell
/// selection, changing the cells that are not empty already.
pub fn delete_cell_selection() -> BoxCommand {
    command(|state, dispatch| {
        let Some(cells) = state.selection().as_custom::<CellSelection>() else {
            return false;
        };
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            let base = table_node_types(state.schema())
                .and_then(|types| types.cell.create_and_fill(None, Default::default(), vec![]))
                .map(|cell| cell.content().clone());
            if let Some(base) = base {
                cells.for_each_cell(|cell, pos| {
                    if cell.content() != &base {
                        let from = tr.mapping.map(pos + 1, 1);
                        let to = tr.mapping.map(pos + cell.node_size() - 1, 1);
                        let _ = tr.replace(
                            from,
                            to,
                            crate::rich_editor::model::Slice::new(base.clone(), 0, 0),
                        );
                    }
                });
            }
            if tr.doc_changed() {
                dispatch(tr);
            }
        }
        true
    })
}

// `after(depth)` with prosemirror's `depth == self.depth + 1` meaning the
// position itself.
fn after_at(pos: &ResolvedPos, depth: usize) -> usize {
    if depth > pos.depth {
        pos.pos
    } else {
        pos.after(depth)
    }
}

fn before_at(pos: &ResolvedPos, depth: usize) -> usize {
    if depth > pos.depth {
        pos.pos
    } else {
        pos.before(depth)
    }
}

// A text selection from the end of a cell to the start of the next
// (prosemirror-tables' `isCellBoundarySelection`).
fn is_cell_boundary_selection(from: &ResolvedPos, to: &ResolvedPos) -> bool {
    if from.pos == to.pos || from.pos + 6 < to.pos {
        return false;
    }
    let mut after_from = from.pos;
    let mut before_to = to.pos;
    let mut depth = from.depth as isize;
    while depth >= 0 {
        let d = depth as usize;
        if after_at(from, d + 1) < from.end(d) {
            break;
        }
        depth -= 1;
        after_from += 1;
    }
    let mut d = to.depth as isize;
    while d >= 0 {
        let du = d as usize;
        if before_at(to, du + 1) > to.start(du) {
            break;
        }
        d -= 1;
        before_to = before_to.saturating_sub(1);
    }
    if depth < 0 {
        return false;
    }
    after_from == before_to
        && matches!(
            table_role(from.node(depth as usize).ty()),
            Some(TableRole::Row | TableRole::Table)
        )
}

fn innermost_cell(pos: &ResolvedPos) -> Option<Node> {
    (1..=pos.depth)
        .rev()
        .map(|d| pos.node(d))
        .find(|node| is_cell_type(node))
        .cloned()
}

// A text selection from inside a cell to the start of another
// (prosemirror-tables' `isTextSelectionAcrossCells`: a triple click's).
fn is_text_selection_across_cells(from: &ResolvedPos, to: &ResolvedPos) -> bool {
    let a = innermost_cell(from);
    let b = innermost_cell(to);
    let differ = match (&a, &b) {
        (Some(a), Some(b)) => !a.ptr_eq(b),
        (None, None) => false,
        _ => true,
    };
    differ && to.parent_offset == 0
}

/// The selection of `doc` normalized for tables (prosemirror-tables'
/// `normalizeSelection`), none when it is fine: a selected cell becomes
/// a cell selection, a selected row a row selection, a selected table
/// (unless `allow_table_node_selection`) all its cells; a text selection
/// over a cell boundary collapses, one from a cell to the start of
/// another keeps to the first cell's textblock, and one from a cell to
/// another cell of the same table selects the cells between.
pub fn normalize_selection(
    doc: &Node,
    selection: &Selection,
    allow_table_node_selection: bool,
) -> Option<Selection> {
    match selection.kind() {
        SelectionKind::Node(node) => {
            let from = selection.from();
            match table_role(node.node().ty())? {
                TableRole::Cell | TableRole::HeaderCell => CellSelection::create(doc, from, None),
                TableRole::Row => {
                    let cell = resolve(doc, from + 1)?;
                    CellSelection::row_selection(cell.clone(), cell).map(Into::into)
                }
                TableRole::Table if !allow_table_node_selection => {
                    let map = TableMap::get(node.node());
                    let start = from + 1;
                    let last = start + *map.map.last()?;
                    CellSelection::create(doc, start + 1, Some(last))
                }
                TableRole::Table => None,
            }
        }
        SelectionKind::Text(_) => {
            let (from, to) = (selection.resolved_from(), selection.resolved_to());
            if is_cell_boundary_selection(from, to) {
                return Some(TextSelection::create(doc, from.pos, None));
            }
            if is_text_selection_across_cells(from, to) {
                return Some(TextSelection::create(
                    doc,
                    from.start(from.depth),
                    Some(from.end(from.depth)),
                ));
            }
            let anchor = cell_around(selection.resolved_anchor())?;
            let head = cell_around(selection.resolved_head())?;
            if anchor.pos != head.pos && in_same_table(&anchor, &head) {
                return CellSelection::new(anchor, head).map(Into::into);
            }
            None
        }
        _ => None,
    }
}

struct TableEditing {
    options: TableEditingOptions,
    keymap: Keymap,
}

impl PluginSpec for TableEditing {
    fn key(&self) -> PluginKey {
        table_editing_key()
    }

    fn append_transaction(
        &self,
        _trs: &[Transaction],
        _old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        let selection = normalize_selection(
            new.doc(),
            new.selection(),
            self.options.allow_table_node_selection,
        )?;
        let mut tr = new.tr();
        tr.set_selection(selection);
        Some(tr)
    }

    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        self.keymap.handle(state, event, dispatch)
    }

    fn create_selection_between(
        &self,
        state: &EditorState,
        anchor: &ResolvedPos,
        head: &ResolvedPos,
    ) -> Option<Selection> {
        super::cell_selection_between(state, anchor.pos, head.pos)
    }
}

/// The keys of [`table_editing`]: the arrows ([`arrow`]), Shift with the
/// arrows ([`shift_arrow`]), and Backspace, Mod-Backspace, Delete and
/// Mod-Delete ([`delete_cell_selection`]).
pub fn table_editing_bindings() -> Vec<(String, BoxCommand)> {
    let mut bindings = Vec::new();
    for (key, axis, dir) in [
        ("ArrowLeft", Axis::Horizontal, -1),
        ("ArrowRight", Axis::Horizontal, 1),
        ("ArrowUp", Axis::Vertical, -1),
        ("ArrowDown", Axis::Vertical, 1),
    ] {
        bindings.push((key.to_owned(), arrow(axis, dir)));
        bindings.push((format!("Shift-{key}"), shift_arrow(axis, dir)));
    }
    for key in ["Backspace", "Mod-Backspace", "Delete", "Mod-Delete"] {
        bindings.push((key.to_owned(), delete_cell_selection()));
    }
    bindings
}

/// The plugin that makes tables editable (prosemirror-tables'
/// `tableEditing`): its keys ([`table_editing_bindings`]), cell
/// selections from pointer drags across cells, and
/// [`normalize_selection`] after each change.
pub fn table_editing(options: TableEditingOptions) -> Plugin {
    let keymap = Keymap::new(table_editing_bindings(), &KeymapOptions::default())
        .expect("the table keys' names are valid");
    Arc::new(TableEditing { options, keymap })
}

#[cfg(test)]
mod tests {
    use super::{super::test_util::*, *};
    use crate::rich_editor::state::NodeSelection;

    fn run(state: &EditorState, cmd: &BoxCommand) -> Option<EditorState> {
        let mut out = None;
        let applied = cmd(state, Some(&mut |tr| out = Some(tr)));
        assert_eq!(applied, cmd(state, None), "dry run disagrees");
        out.map(|tr| state.apply(tr).unwrap())
    }

    fn cells_of(state: &EditorState) -> (usize, usize) {
        let cells = state
            .selection()
            .as_custom::<CellSelection>()
            .expect("a cell selection");
        (cells.anchor_cell().pos, cells.head_cell().pos)
    }

    #[test]
    fn arrows_move_between_cells_at_their_edges() {
        let d = doc(vec![grid(&[&["ab", "cd"], &["ef", "gh"]])]);
        // At the end of `ab`, right moves into `cd`.
        let state = at(d.clone(), in_cell(&d, "ab") + 2);
        let next = run(&state, &arrow(Axis::Horizontal, 1)).expect("moved");
        assert_eq!(next.selection().head(), in_cell(&d, "cd"));
        // Inside the text it leaves the key to the view.
        let state = at(d.clone(), in_cell(&d, "ab") + 1);
        assert!(run(&state, &arrow(Axis::Horizontal, 1)).is_none());
        // Down from the end of `cd` goes to `gh`.
        let state = at(d.clone(), in_cell(&d, "cd") + 2);
        let next = run(&state, &arrow(Axis::Vertical, 1)).expect("moved");
        assert_eq!(next.selection().head(), in_cell(&d, "gh"));
    }

    #[test]
    fn shift_arrows_grow_cell_selections() {
        let d = doc(vec![grid(&[&["ab", "cd"], &["ef", "gh"]])]);
        let state = at(d.clone(), in_cell(&d, "ab") + 2);
        let state = run(&state, &shift_arrow(Axis::Horizontal, 1)).expect("selected");
        assert_eq!(cells_of(&state), (cell_pos(&d, "ab"), cell_pos(&d, "cd")));
        let state = run(&state, &shift_arrow(Axis::Vertical, 1)).expect("grew");
        assert_eq!(cells_of(&state), (cell_pos(&d, "ab"), cell_pos(&d, "gh")));
    }

    #[test]
    fn delete_empties_selected_cells() {
        let d = doc(vec![grid(&[&["a", "b"], &["c", "d"]])]);
        let selection =
            CellSelection::create(&d, cell_pos(&d, "a"), Some(cell_pos(&d, "b"))).unwrap();
        let state = state_with(d, selection, vec![]);
        let state = run(&state, &delete_cell_selection()).expect("deleted");
        assert_eq!(shape(&first_table(state.doc())), "|/c|d");
    }

    #[test]
    fn selected_cells_and_rows_become_cell_selections() {
        let d = doc(vec![grid(&[&["a", "b"], &["c", "d"]])]);
        let cell = NodeSelection::create(&d, cell_pos(&d, "b"));
        let normalized = normalize_selection(&d, &cell, false).unwrap();
        let cells = normalized.as_custom::<CellSelection>().unwrap();
        assert_eq!(cells.cell_positions(), vec![cell_pos(&d, "b")]);
        let row = NodeSelection::create(&d, cell_pos(&d, "c") - 1);
        let normalized = normalize_selection(&d, &row, false).unwrap();
        let cells = normalized.as_custom::<CellSelection>().unwrap();
        assert!(cells.is_row_selection());
        let table = NodeSelection::create(&d, 0);
        let normalized = normalize_selection(&d, &table, false).unwrap();
        assert_eq!(
            normalized
                .as_custom::<CellSelection>()
                .unwrap()
                .cell_positions()
                .len(),
            4
        );
        assert!(normalize_selection(&d, &table, true).is_none());
    }

    #[test]
    fn text_selections_across_cells_become_cell_selections() {
        let d = doc(vec![grid(&[&["a", "b"], &["c", "d"]])]);
        let text = TextSelection::create(&d, in_cell(&d, "a") + 1, Some(in_cell(&d, "d") + 1));
        let normalized = normalize_selection(&d, &text, false).unwrap();
        let cells = normalized.as_custom::<CellSelection>().unwrap();
        assert_eq!(cells.cell_positions().len(), 4);
        // Within one cell: left alone.
        let text = TextSelection::create(&d, in_cell(&d, "a"), Some(in_cell(&d, "a") + 1));
        assert!(normalize_selection(&d, &text, false).is_none());
    }

    #[test]
    fn drags_across_cells_select_them() {
        let d = doc(vec![grid(&[&["a", "b"], &["c", "d"]])]);
        let plugin = table_editing(TableEditingOptions::default());
        let selection = TextSelection::create(&d, in_cell(&d, "a"), None);
        let state = state_with(d.clone(), selection, vec![plugin.clone()]);
        let anchor = d.resolve(in_cell(&d, "a")).unwrap();
        let head = d.resolve(in_cell(&d, "d")).unwrap();
        let dragged = plugin
            .create_selection_between(&state, &anchor, &head)
            .expect("cells");
        let mut tr = state.tr();
        tr.set_selection(dragged);
        let state = state.apply(tr).unwrap();
        let cells = state
            .selection()
            .as_custom::<CellSelection>()
            .expect("cells");
        assert_eq!(cells.cell_positions().len(), 4);
    }
}
