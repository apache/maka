//! The JS face of tables' commands (`insertTable`, `addRowAfter`,
//! `mergeCells`, ...): typed helpers making commands as data, which the
//! editor resolves by name in the kernel's registry (`tables::commands`).
//! The extensions themselves are classes of `extension_api`'s
//! (`TableKit`, `RichTable`, ...).
//!
//! The helpers follow Tiptap's `@tiptap/extension-table` commands (MIT,
//! © Tiptap GmbH).

use nsh_core::{JsonValue, prelude::*};
use serde_json::json;

use super::{RichCommand, named};

/// What `insertTable` inserts.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichInsertTableOptions {
    /// Its rows (3).
    pub(crate) rows: Option<usize>,
    /// Its columns (3).
    pub(crate) cols: Option<usize>,
    /// Whether its first row is header cells (true).
    pub(crate) with_header_row: Option<bool>,
}

/// Which row or column `moveTableRow` / `moveTableColumn` moves.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichMoveTableOptions {
    /// The index of the row (column) to move.
    pub(crate) from: usize,
    /// The index it moves to.
    pub(crate) to: usize,
    /// Whether the moved rows (columns) are selected afterwards (true).
    pub(crate) select: Option<bool>,
    /// The position before the table (the one around the selection when
    /// left out).
    pub(crate) table: Option<usize>,
}

/// What `setColumnWidth` sets.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichColumnWidthOptions {
    /// The column's index.
    pub(crate) col: usize,
    /// Its width in points; `null` (or left out) for as wide as its
    /// content.
    pub(crate) width: Option<f64>,
    /// The position before the table (the one around the selection when
    /// left out).
    pub(crate) table: Option<usize>,
}

/// What `setRowHeight` sets.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichRowHeightOptions {
    /// The row's index.
    pub(crate) row: usize,
    /// Its height in points; `null` (or left out) for as tall as its
    /// content.
    pub(crate) height: Option<f64>,
    /// The position before the table (the one around the selection when
    /// left out).
    pub(crate) table: Option<usize>,
}

/// The cells `setCellSelection` selects.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichCellSelectionOptions {
    /// The position before the anchor cell.
    pub(crate) anchor_cell: usize,
    /// The position before the head cell (the anchor cell when left out).
    pub(crate) head_cell: Option<usize>,
}

/// The table commands' helpers.
#[module]
pub(crate) struct RichTableApi;

#[module(flat)]
impl RichTableApi {
    /// Inserts a table (3 × 3 with a header row by default) over the
    /// selection, the cursor in its first cell (Tiptap's `insertTable`).
    pub(crate) fn insert_table(options: Option<RichInsertTableOptions>) -> RichCommand {
        let o = options.unwrap_or_default();
        named(
            "insertTable",
            json!({ "rows": o.rows, "cols": o.cols, "withHeaderRow": o.with_header_row }),
        )
    }

    /// Adds a column before the selected cells.
    pub(crate) fn add_column_before() -> RichCommand {
        named("addColumnBefore", JsonValue::Null)
    }

    /// Adds a column after the selected cells.
    pub(crate) fn add_column_after() -> RichCommand {
        named("addColumnAfter", JsonValue::Null)
    }

    /// Deletes the selected columns (not all of a table's).
    pub(crate) fn delete_column() -> RichCommand {
        named("deleteColumn", JsonValue::Null)
    }

    /// Adds a row before the selected cells.
    pub(crate) fn add_row_before() -> RichCommand {
        named("addRowBefore", JsonValue::Null)
    }

    /// Adds a row after the selected cells.
    pub(crate) fn add_row_after() -> RichCommand {
        named("addRowAfter", JsonValue::Null)
    }

    /// Deletes the selected rows (not all of a table's).
    pub(crate) fn delete_row() -> RichCommand {
        named("deleteRow", JsonValue::Null)
    }

    /// Deletes the table around the selection.
    pub(crate) fn delete_table() -> RichCommand {
        named("deleteTable", JsonValue::Null)
    }

    /// Merges the selected cells into one.
    pub(crate) fn merge_cells() -> RichCommand {
        named("mergeCells", JsonValue::Null)
    }

    /// Splits a merged cell into cells of one row and column each.
    pub(crate) fn split_cell() -> RichCommand {
        named("splitCell", JsonValue::Null)
    }

    /// Merges the selected cells, or splits the merged cell.
    pub(crate) fn merge_or_split() -> RichCommand {
        named("mergeOrSplit", JsonValue::Null)
    }

    /// Makes the table's first column header cells, or plain cells again.
    pub(crate) fn toggle_header_column() -> RichCommand {
        named("toggleHeaderColumn", JsonValue::Null)
    }

    /// Makes the table's first row header cells, or plain cells again.
    pub(crate) fn toggle_header_row() -> RichCommand {
        named("toggleHeaderRow", JsonValue::Null)
    }

    /// Makes the selected cells header cells, or plain cells again.
    pub(crate) fn toggle_header_cell() -> RichCommand {
        named("toggleHeaderCell", JsonValue::Null)
    }

    /// Sets the attribute `name` of the selected cells to `value`.
    pub(crate) fn set_cell_attribute(name: String, value: JsonValue) -> RichCommand {
        named("setCellAttribute", json!({ "name": name, "value": value }))
    }

    /// Selects the next cell's content.
    pub(crate) fn go_to_next_cell() -> RichCommand {
        named("goToNextCell", JsonValue::Null)
    }

    /// Selects the previous cell's content.
    pub(crate) fn go_to_previous_cell() -> RichCommand {
        named("goToPreviousCell", JsonValue::Null)
    }

    /// Repairs the document's tables (missing cells, overlapping merged
    /// cells, disagreeing column widths).
    pub(crate) fn fix_tables() -> RichCommand {
        named("fixTables", JsonValue::Null)
    }

    /// Selects the cells from the anchor cell to the head cell.
    pub(crate) fn set_cell_selection(options: RichCellSelectionOptions) -> RichCommand {
        named(
            "setCellSelection",
            json!({ "anchorCell": options.anchor_cell, "headCell": options.head_cell }),
        )
    }

    /// Moves a table's row (with the rows its merged cells span) to
    /// another row's place.
    pub(crate) fn move_table_row(options: RichMoveTableOptions) -> RichCommand {
        named("moveTableRow", move_args(options))
    }

    /// Moves a table's column (with the columns its merged cells span) to
    /// another column's place.
    pub(crate) fn move_table_column(options: RichMoveTableOptions) -> RichCommand {
        named("moveTableColumn", move_args(options))
    }

    /// Sets a table column's width.
    pub(crate) fn set_column_width(options: RichColumnWidthOptions) -> RichCommand {
        named(
            "setColumnWidth",
            json!({ "col": options.col, "width": options.width, "table": options.table }),
        )
    }

    /// Sets a table row's height.
    pub(crate) fn set_row_height(options: RichRowHeightOptions) -> RichCommand {
        named(
            "setRowHeight",
            json!({ "row": options.row, "height": options.height, "table": options.table }),
        )
    }
}

fn move_args(options: RichMoveTableOptions) -> JsonValue {
    json!({
        "from": options.from,
        "to": options.to,
        "select": options.select,
        "table": options.table,
    })
}
