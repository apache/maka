//! The parts of a [`super::DataTable`] the app styles: Tailwind classes
//! ([`DataTableClasses`]) and inline styles ([`DataTableStyles`]) by part,
//! supplying the table's appearance.

use nsh_core::{element::Style, prelude::*};

use crate::text_view::PartStyle;

macro_rules! parts {
    ($( $(#[doc = $doc:literal])* $field:ident => $variant:ident ),* $(,)?) => {
        /// Tailwind classes of a `DataTable`'s parts
        /// (`classes={{ rowSelected: "bg-primary/10" }}`), after the part's
        /// own styles: at equal rank they win.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct DataTableClasses {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<SharedString>, )*
        }

        /// Inline styles of a `DataTable`'s parts, over its classes.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct DataTableStyles {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<PartStyle>, )*
        }

        /// A part of a [`super::DataTable`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum DataTablePart {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl DataTableClasses {
            pub(crate) fn get(&self, part: DataTablePart) -> Option<&SharedString> {
                match part {
                    $( DataTablePart::$variant => self.$field.as_ref(), )*
                }
            }
        }

        impl DataTableStyles {
            pub(crate) fn get(&self, part: DataTablePart) -> Option<&Style> {
                match part {
                    $( DataTablePart::$variant => self.$field.as_ref().map(|s| &s.0), )*
                }
            }
        }
    };
}

parts! {
    /// The table's box: its border, radius and background.
    root => Root,
    /// The header, across the table (its rows of group labels and column
    /// titles).
    header => Header,
    /// A group label above the columns it spans.
    group_cell => GroupCell,
    /// Every column's title cell.
    header_cell => HeaderCell,
    /// The label and sort button's layout row inside a title cell.
    header_content => HeaderContent,
    /// A title being dragged, after `headerCell`.
    header_cell_dragging => HeaderCellDragging,
    /// The title cell of the column the table is sorted by, after
    /// `headerCell`.
    header_cell_sorted => HeaderCellSorted,
    /// The title cell of the selected column (a title pressed),
    /// after `headerCell`.
    header_cell_selected => HeaderCellSelected,
    /// The sort button of a sortable column.
    sort_indicator => SortIndicator,
    /// Its ascending chevron; `selected:` applies while sorted ascending.
    sort_ascending => SortAscending,
    /// Its descending chevron; `selected:` applies while sorted descending.
    sort_descending => SortDescending,
    /// The line at a column's trailing edge that a drag resizes (the band
    /// that takes the drag is wider).
    resize_handle => ResizeHandle,
    /// The line shown where a dragged column will drop.
    move_indicator => MoveIndicator,
    /// Every body row.
    row => Row,
    /// The rows of odd position, after `row` (`stripe`).
    row_odd => RowOdd,
    /// The row the pointer is over, after `row`.
    row_hover => RowHover,
    /// The selected row, after `row`.
    row_selected => RowSelected,
    /// The row a context menu was asked for where cells do not select,
    /// until the next press, after `row`.
    row_active => RowActive,
    /// Every body cell.
    cell => Cell,
    /// The selected cell (`cellSelectable`), after `cell`.
    cell_selected => CellSelected,
    /// The cell a context menu was asked for, until the next press, after
    /// `cell`.
    cell_active => CellActive,
    /// The cells of the selected column (a title pressed), after
    /// `cell`.
    cell_column_selected => CellColumnSelected,
    /// The row header cells (`rowHeader`): row numbers, which select rows.
    row_header => RowHeader,
    /// The corner above the row headers.
    row_header_corner => RowHeaderCorner,
    /// The line at the fixed columns' trailing edge, over the columns that
    /// scroll under them.
    fixed_edge => FixedEdge,
    /// What shows when there are no rows (the `empty` slot's box).
    empty => Empty,
}
