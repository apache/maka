//! Tables, after `prosemirror-tables` and Tiptap's table extensions. The
//! kernel finds a table's types by their role, not their names: a node
//! type whose spec's `extra.tableRole` is `"table"`, `"row"`, `"cell"` or
//! `"header_cell"` ([`TableRole`]), as prosemirror-tables' `tableRole`.
//! [`nodes`] gives Tiptap's types (`table`, `tableRow`, `tableCell`,
//! `tableHeader`); `extensions::kit`'s `table_kit` brings them with their
//! keys, plugins and commands.
//!
//! - [`TableMap`]: a table's grid, each slot naming the cell covering it,
//!   with the problems of a malformed table.
//! - [`CellSelection`]: a rectangle of cells, a custom selection kind
//!   (JSON `{type: "cell", anchor, head}`).
//! - [`fix_tables`] repairs tables (missing cells, overlapping spans,
//!   disagreeing column widths); [`fix_tables_plugin`] runs it after each
//!   change.
//! - [`table_editing`]: Tab and arrow keys between cells, Shift+arrows and
//!   drags making cell selections, Backspace and Delete clearing selected
//!   cells, selections normalized to cells.
//! - The commands ([`commands`]), by Tiptap's names in the built-in
//!   registry: `insertTable`, `addColumnBefore`, `mergeCells`, ...
//!
//! See docs/dev/rich-editor.md "Tables".
//!
//! Credits: a Rust port of prosemirror-tables (MIT, © Marijn Haverbeke and
//! others); the extensions follow Tiptap's `@tiptap/extension-table` (MIT,
//! © Tiptap GmbH).

mod cell_selection;
pub mod commands;
mod editing;
mod fix;
mod map;
pub mod nodes;
mod util;

use serde_json::Value;

pub use self::{
    cell_selection::{CELL_SELECTION, CellSelection, cell_selection_between, is_cell},
    commands::{TableRect, selected_rect},
    editing::{
        TableEditingOptions, arrow, delete_cell_selection, normalize_selection, shift_arrow,
        table_editing, table_editing_bindings, table_editing_key,
    },
    fix::{fix_table, fix_tables, fix_tables_key, fix_tables_plugin},
    map::{Axis, Rect, TableMap, TableProblem, colspan, column_widths, is_table, rowspan},
    util::{
        FoundTable, add_col_span, cell_around, cell_near, cell_wrapping, col_count,
        column_is_header, find_cell, find_table, in_same_table, is_in_table, move_cell_forward,
        next_cell, points_at_cell, remove_col_span, row_is_header, selected_cells, selection_cell,
        table_at,
    },
};
use crate::rich_editor::model::{NodeType, Schema};

/// The part a node type plays in a table: its spec's `extra.tableRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TableRole {
    /// A table (`"table"`): rows.
    Table,
    /// A row (`"row"`): cells.
    Row,
    /// A cell (`"cell"`).
    Cell,
    /// A header cell (`"header_cell"`).
    HeaderCell,
}

impl TableRole {
    /// The role's name in a spec's `extra.tableRole`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::Row => "row",
            Self::Cell => "cell",
            Self::HeaderCell => "header_cell",
        }
    }

    /// The role named `name`.
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "table" => Self::Table,
            "row" => Self::Row,
            "cell" => Self::Cell,
            "header_cell" => Self::HeaderCell,
            _ => return None,
        })
    }
}

/// The table role of `ty`, if it has one.
pub fn table_role(ty: &NodeType) -> Option<TableRole> {
    ty.spec()
        .extra
        .get("tableRole")
        .and_then(Value::as_str)
        .and_then(TableRole::from_name)
}

pub(crate) fn is_cell_role(role: Option<TableRole>) -> bool {
    matches!(role, Some(TableRole::Cell | TableRole::HeaderCell))
}

/// A schema's table types, by role (prosemirror-tables'
/// `tableNodeTypes`).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TableNodeTypes {
    /// The table.
    pub table: NodeType,
    /// The row.
    pub row: NodeType,
    /// The cell.
    pub cell: NodeType,
    /// The header cell.
    pub header_cell: NodeType,
}

impl TableNodeTypes {
    /// The type of `role`.
    pub fn of(&self, role: TableRole) -> &NodeType {
        match role {
            TableRole::Table => &self.table,
            TableRole::Row => &self.row,
            TableRole::Cell => &self.cell,
            TableRole::HeaderCell => &self.header_cell,
        }
    }
}

/// `schema`'s table types (the first of each role), when it has all four.
pub fn table_node_types(schema: &Schema) -> Option<TableNodeTypes> {
    // The names are cached, not the types: a type holds its schema, which
    // would then hold itself.
    let names = schema.cached("tableNodeTypes", || {
        let find = |role| {
            schema
                .node_types()
                .into_iter()
                .find(|ty| table_role(ty) == Some(role))
                .map(|ty| ty.name().to_owned())
        };
        Some([
            find(TableRole::Table)?,
            find(TableRole::Row)?,
            find(TableRole::Cell)?,
            find(TableRole::HeaderCell)?,
        ])
    });
    let [table, row, cell, header_cell] = names.as_ref().as_ref()?;
    Some(TableNodeTypes {
        table: schema.node_type(table)?,
        row: schema.node_type(row)?,
        cell: schema.node_type(cell)?,
        header_cell: schema.node_type(header_cell)?,
    })
}

#[cfg(test)]
pub(crate) mod test_util {
    //! A schema with tables and builders for the tables' tests.

    use std::sync::OnceLock;

    use serde_json::Value;

    use crate::rich_editor::{
        extensions::{ExtensionManager, kit},
        model::{Attrs, Fragment, Node, Schema},
        state::{EditorState, EditorStateConfig, Plugin, Selection, TextSelection},
    };

    pub(crate) fn manager() -> &'static ExtensionManager {
        static MANAGER: OnceLock<ExtensionManager> = OnceLock::new();
        MANAGER.get_or_init(|| {
            ExtensionManager::with_core(vec![kit::starter_kit(), kit::table_kit()]).unwrap()
        })
    }

    pub(crate) fn schema() -> Schema {
        manager().schema().clone()
    }

    pub(crate) fn p(text: &str) -> Node {
        let s = schema();
        let content = if text.is_empty() {
            Fragment::empty()
        } else {
            Fragment::from(vec![s.text(text, vec![])])
        };
        s.node("paragraph", None, content, vec![]).unwrap()
    }

    fn cell_of(name: &str, text: &str, colspan: usize, rowspan: usize) -> Node {
        let mut attrs = Attrs::new();
        attrs.insert("colspan".into(), Value::from(colspan));
        attrs.insert("rowspan".into(), Value::from(rowspan));
        schema()
            .node(name, Some(attrs), Fragment::from(vec![p(text)]), vec![])
            .unwrap()
    }

    /// A cell holding a paragraph of `text`.
    pub(crate) fn td(text: &str) -> Node {
        cell_of("tableCell", text, 1, 1)
    }

    /// A cell spanning `colspan` columns and `rowspan` rows.
    pub(crate) fn tds(text: &str, colspan: usize, rowspan: usize) -> Node {
        cell_of("tableCell", text, colspan, rowspan)
    }

    /// A header cell.
    pub(crate) fn th(text: &str) -> Node {
        cell_of("tableHeader", text, 1, 1)
    }

    pub(crate) fn tr(cells: Vec<Node>) -> Node {
        schema()
            .node("tableRow", None, Fragment::from(cells), vec![])
            .unwrap()
    }

    pub(crate) fn table(rows: Vec<Node>) -> Node {
        schema()
            .node("table", None, Fragment::from(rows), vec![])
            .unwrap()
    }

    pub(crate) fn doc(blocks: Vec<Node>) -> Node {
        schema()
            .node("doc", None, Fragment::from(blocks), vec![])
            .unwrap()
    }

    /// A table of `rows` rows of cells named by their texts.
    pub(crate) fn grid(rows: &[&[&str]]) -> Node {
        table(
            rows.iter()
                .map(|row| tr(row.iter().map(|text| td(text)).collect()))
                .collect(),
        )
    }

    /// The position before the first cell whose text is `text`.
    pub(crate) fn cell_pos(doc: &Node, text: &str) -> usize {
        let mut found = None;
        doc.descendants(&mut |node, pos, _, _| {
            if found.is_some() {
                return false;
            }
            if super::is_cell(node) && node.text_content() == text {
                found = Some(pos);
                return false;
            }
            true
        });
        found.unwrap_or_else(|| panic!("no cell {text:?}"))
    }

    /// The position inside the paragraph of the cell `text`, at its start.
    pub(crate) fn in_cell(doc: &Node, text: &str) -> usize {
        cell_pos(doc, text) + 2
    }

    /// The texts of a table's cells, row by row (`|` between cells, `/`
    /// between rows; `*` marks a header cell, `(c,r)` spans).
    pub(crate) fn shape(table: &Node) -> String {
        let mut rows = Vec::new();
        for i in 0..table.child_count() {
            let row = table.child(i);
            let mut cells = Vec::new();
            for j in 0..row.child_count() {
                let cell = row.child(j);
                let mut text = cell.text_content();
                if cell.ty().name() == "tableHeader" {
                    text = format!("*{text}");
                }
                let (c, r) = (super::colspan(cell), super::rowspan(cell));
                if c > 1 || r > 1 {
                    text = format!("{text}({c},{r})");
                }
                cells.push(text);
            }
            rows.push(cells.join("|"));
        }
        rows.join("/")
    }

    /// The first table of `doc`.
    pub(crate) fn first_table(doc: &Node) -> Node {
        let mut found = None;
        doc.descendants(&mut |node, _, _, _| {
            if found.is_none() && super::is_table(node) {
                found = Some(node.clone());
            }
            found.is_none()
        });
        found.expect("a table")
    }

    pub(crate) fn state_with(doc: Node, selection: Selection, plugins: Vec<Plugin>) -> EditorState {
        EditorState::create(
            EditorStateConfig::new(schema())
                .doc(doc)
                .selection(selection)
                .plugins(plugins),
        )
        .unwrap()
    }

    /// A state with a cursor at `pos`.
    pub(crate) fn at(doc: Node, pos: usize) -> EditorState {
        let selection = TextSelection::create(&doc, pos, None);
        state_with(doc, selection, vec![])
    }
}
