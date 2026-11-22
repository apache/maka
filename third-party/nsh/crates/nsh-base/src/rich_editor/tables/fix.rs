//! Repairing tables, after prosemirror-tables' `fixtables.ts`: rows
//! missing cells get empty ones, cells overlapping others or spanning
//! past the table's end are cut, cells disagreeing with their columns'
//! widths take them, and empty tables are deleted.
//!
//! Ported from prosemirror-tables (MIT, © Marijn Haverbeke and others).

use std::sync::Arc;

use serde_json::Value;

use super::{
    TableRole,
    map::{TableMap, TableProblem},
    table_node_types, table_role,
    util::remove_col_span,
};
use crate::rich_editor::{
    model::{Fragment, Node},
    state::{EditorState, Plugin, PluginKey, PluginSpec, Transaction},
};

/// The key of [`fix_tables_plugin`], and the meta its transactions carry
/// (`{fixTables: true}`).
pub fn fix_tables_key() -> PluginKey {
    PluginKey::new("fixTables")
}

// prosemirror-tables' `changedDescendants`: calls `f` for every node of
// `cur` that is not in `old` (comparing by identity), with its position.
fn changed_descendants(old: &Node, cur: &Node, offset: usize, f: &mut dyn FnMut(&Node, usize)) {
    let old_size = old.child_count();
    let mut j = 0;
    let mut offset = offset;
    for i in 0..cur.child_count() {
        let child = cur.child(i);
        if let Some(scan) = (j..old_size.min(i + 3)).find(|&scan| old.child(scan).ptr_eq(child)) {
            j = scan + 1;
            offset += child.node_size();
            continue;
        }
        f(child, offset);
        if j < old_size && old.child(j).same_markup(child) {
            changed_descendants(old.child(j), child, offset + 1, f);
        } else {
            child.nodes_between(0, child.content().size(), &mut |node, pos, _, _| {
                f(node, offset + 1 + pos);
                true
            });
        }
        offset += child.node_size();
    }
}

/// A transaction repairing the tables of `state` (those changed since
/// `old` when given, else all), none when every table is sound.
pub fn fix_tables(state: &EditorState, old: Option<&EditorState>) -> Option<Transaction> {
    let mut tables: Vec<(Node, usize)> = Vec::new();
    let mut check = |node: &Node, pos: usize| {
        if table_role(node.ty()) == Some(TableRole::Table) {
            tables.push((node.clone(), pos));
        }
    };
    match old {
        None => state.doc().descendants(&mut |node, pos, _, _| {
            check(node, pos);
            true
        }),
        Some(old) if !old.doc().ptr_eq(state.doc()) => {
            changed_descendants(old.doc(), state.doc(), 0, &mut check)
        }
        Some(_) => {}
    }
    let mut tr: Option<Transaction> = None;
    for (table, pos) in tables {
        tr = fix_table(state, &table, pos, tr);
    }
    tr
}

/// Repairs `table` (at `table_pos` in `state`'s document) in `tr` (a new
/// transaction when none), as prosemirror-tables' `fixTable`; `tr`
/// unchanged when the table is sound.
pub fn fix_table(
    state: &EditorState,
    table: &Node,
    table_pos: usize,
    tr: Option<Transaction>,
) -> Option<Transaction> {
    let map = TableMap::get(table);
    if map.problems.is_empty() {
        return tr;
    }
    let mut tr = tr.unwrap_or_else(|| state.tr());
    let mut must_add = vec![0usize; map.height];
    for problem in &map.problems {
        match problem {
            TableProblem::Collision { row, pos, n } => {
                let Some(cell) = table.node_at(*pos) else {
                    continue;
                };
                let attrs = cell.attrs();
                for j in 0..super::rowspan(&cell) {
                    if let Some(add) = must_add.get_mut(row + j) {
                        *add += n;
                    }
                }
                let span = super::colspan(&cell);
                let at = tr.mapping.map(table_pos + 1 + pos, 1);
                let _ = tr.set_node_markup(
                    at,
                    None,
                    Some(remove_col_span(attrs, span.saturating_sub(*n), *n)),
                    None,
                );
            }
            TableProblem::Missing { row, n } => must_add[*row] += n,
            TableProblem::OverlongRowspan { pos, n } => {
                let Some(cell) = table.node_at(*pos) else {
                    continue;
                };
                let mut attrs = cell.attrs().clone();
                let rowspan = super::rowspan(&cell).saturating_sub(*n).max(1);
                attrs.insert("rowspan".into(), Value::from(rowspan));
                let at = tr.mapping.map(table_pos + 1 + pos, 1);
                let _ = tr.set_node_markup(at, None, Some(attrs), None);
            }
            TableProblem::ColwidthMismatch { pos, colwidth } => {
                let Some(cell) = table.node_at(*pos) else {
                    continue;
                };
                let mut attrs = cell.attrs().clone();
                let widths = colwidth
                    .iter()
                    .map(|w| super::map::width_json(f64::from(w.0)))
                    .collect();
                attrs.insert("colwidth".into(), Value::Array(widths));
                let at = tr.mapping.map(table_pos + 1 + pos, 1);
                let _ = tr.set_node_markup(at, None, Some(attrs), None);
            }
            TableProblem::ZeroSized => {
                let at = tr.mapping.map(table_pos, 1);
                let _ = tr.delete(at, at + table.node_size());
            }
        }
    }
    let first = must_add.iter().position(|n| *n > 0);
    let last = must_add.iter().rposition(|n| *n > 0);
    // The cells missing go at the rows' ends, or at their starts when a
    // bite seems taken out of the table's start (the rows before have
    // none missing and this is the last that has).
    let types = table_node_types(state.schema());
    let mut pos = table_pos + 1;
    for (i, &add) in must_add.iter().enumerate() {
        let row = table.child(i);
        let end = pos + row.node_size();
        if add > 0
            && let Some(types) = &types
        {
            let role = row
                .first_child()
                .and_then(|cell| table_role(cell.ty()))
                .unwrap_or(TableRole::Cell);
            let ty = types.of(role);
            let nodes: Vec<Node> = (0..add)
                .filter_map(|_| ty.create_and_fill(None, Fragment::empty(), vec![]))
                .collect();
            let bite = (i == 0 || first == Some(i - 1)) && last == Some(i);
            let side = if bite { pos + 1 } else { end - 1 };
            let at = tr.mapping.map(side, 1);
            let _ = tr.insert(at, Fragment::from(nodes));
        }
        pos = end;
    }
    tr.set_plugin_meta(&fix_tables_key(), serde_json::json!({ "fixTables": true }));
    Some(tr)
}

struct FixTables;

impl PluginSpec for FixTables {
    fn key(&self) -> PluginKey {
        fix_tables_key()
    }

    fn append_transaction(
        &self,
        _trs: &[Transaction],
        old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        fix_tables(new, Some(old))
    }
}

/// A plugin repairing the tables each change touches ([`fix_tables`] in
/// `append_transaction`).
pub fn fix_tables_plugin() -> Plugin {
    Arc::new(FixTables)
}

#[cfg(test)]
mod tests {
    use super::{super::test_util::*, *};
    use crate::rich_editor::state::TextSelection;

    #[test]
    fn missing_cells_are_added() {
        let d = doc(vec![table(vec![
            tr(vec![td("a"), td("b")]),
            tr(vec![td("c")]),
        ])]);
        let state = at(d, 4);
        let fixed = fix_tables(&state, None).expect("a fix");
        let state = state.apply(fixed).unwrap();
        assert_eq!(shape(&first_table(state.doc())), "a|b/c|");
        assert!(TableMap::get(&first_table(state.doc())).problems.is_empty());
    }

    #[test]
    fn overlong_rowspans_are_cut() {
        let d = doc(vec![table(vec![
            tr(vec![tds("a", 1, 3), td("b")]),
            tr(vec![td("c")]),
        ])]);
        let map = TableMap::compute(&first_table(&d));
        assert_eq!(
            map.problems,
            vec![TableProblem::OverlongRowspan { pos: 1, n: 1 }]
        );
        let state = at(d, 4);
        let state = state.apply(fix_tables(&state, None).unwrap()).unwrap();
        let table = first_table(state.doc());
        assert!(
            TableMap::get(&table).problems.is_empty(),
            "{}",
            shape(&table)
        );
        assert_eq!(shape(&table), "a(1,2)|b/c");
    }

    #[test]
    fn collisions_are_cut() {
        // `b` spans down into the slot `c`'s second column wants.
        let d = doc(vec![table(vec![
            tr(vec![td("a"), tds("b", 1, 2)]),
            tr(vec![tds("c", 2, 1)]),
        ])]);
        let map = TableMap::compute(&first_table(&d));
        assert!(
            map.problems
                .iter()
                .any(|p| matches!(p, TableProblem::Collision { row: 1, n: 1, .. }))
        );
        // As the plugin does, fix until nothing is left to fix.
        let mut state = at(d, 4);
        for _ in 0..4 {
            match fix_tables(&state, None) {
                Some(tr) => state = state.apply(tr).unwrap(),
                None => break,
            }
        }
        let table = first_table(state.doc());
        // As prosemirror-tables' `fixTables`: `c` loses the column it
        // collides in (`removeColSpan`) and its row gets a cell for it on
        // top of the one it misses, at its start (a bite out of the
        // table's start); the first row then misses one, added at its
        // start in a second pass.
        assert_eq!(shape(&table), "|a|b(1,2)|/||c");
        assert!(TableMap::get(&table).problems.is_empty());
    }

    #[test]
    fn colwidth_mismatches_take_the_column_width() {
        let s = schema();
        let mut attrs = crate::rich_editor::model::Attrs::new();
        attrs.insert("colwidth".into(), serde_json::json!([100]));
        let wide = s
            .node(
                "tableCell",
                Some(attrs),
                Fragment::from(vec![p("a")]),
                vec![],
            )
            .unwrap();
        let d = doc(vec![table(vec![tr(vec![wide]), tr(vec![td("b")])])]);
        let state = at(d, 4);
        let state = state.apply(fix_tables(&state, None).unwrap()).unwrap();
        let table = first_table(state.doc());
        assert_eq!(
            table.child(1).child(0).attrs()["colwidth"],
            serde_json::json!([100])
        );
    }

    #[test]
    fn the_plugin_fixes_changed_tables() {
        let d = doc(vec![grid(&[&["a", "b"], &["c", "d"]])]);
        let selection = TextSelection::create(&d, 4, None);
        let state = state_with(d.clone(), selection, vec![fix_tables_plugin()]);
        // Delete the cell `d`: the row is one cell short.
        let mut tr = state.tr();
        let at = cell_pos(&d, "d");
        let size = d.node_at(at).unwrap().node_size();
        tr.delete(at, at + size).unwrap();
        let state = state.apply(tr).unwrap();
        assert_eq!(shape(&first_table(state.doc())), "a|b/c|");
    }
}
