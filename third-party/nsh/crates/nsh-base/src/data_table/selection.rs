//! What is selected in a table and how the keyboard moves it.

/// What a table lets presses and keys select (`rowSelectable`,
/// `columnSelectable`, `cellSelectable`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Selectable {
    pub(crate) rows: bool,
    pub(crate) columns: bool,
    pub(crate) cells: bool,
}

/// The selection: nothing, a row, a column (a definition index) or a cell.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum Selection {
    #[default]
    None,
    Row(usize),
    Column(usize),
    Cell(usize, usize),
}

impl Selection {
    pub(crate) fn row(&self) -> Option<usize> {
        match *self {
            Selection::Row(r) | Selection::Cell(r, _) => Some(r),
            _ => None,
        }
    }

    pub(crate) fn column(&self) -> Option<usize> {
        match *self {
            Selection::Column(c) | Selection::Cell(_, c) => Some(c),
            _ => None,
        }
    }

    /// Whether the selection is of a kind `allowed` selects.
    pub(crate) fn fits(&self, allowed: Selectable) -> bool {
        match self {
            Selection::None => true,
            Selection::Row(_) => allowed.rows,
            Selection::Column(_) => allowed.columns,
            Selection::Cell(..) => allowed.cells,
        }
    }
}

/// A key's move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Move {
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    First,
    Last,
}

/// What a move needs to know of the table.
pub(crate) struct Nav<'a> {
    pub(crate) selectable: Selectable,
    pub(crate) rows: usize,
    /// The columns that can be selected, as definition indexes in display
    /// order.
    pub(crate) columns: &'a [usize],
    /// Rows in a page.
    pub(crate) page: usize,
    /// Moves past an end go around to the other.
    pub(crate) wrap: bool,
}

impl Nav<'_> {
    /// The selection after `movement` from `from`, `None` when nothing
    /// moves (no rows to select, or a move nothing selectable has).
    ///
    /// As gpui-component's table: a selected row keeps moving by rows and a
    /// selected column by columns; otherwise the vertical moves (and Home,
    /// End) go by cells when cells select, else by rows; the horizontal ones
    /// by cells when cells select, else by columns. Home and End are the
    /// first and last cell of the row, row or column.
    pub(crate) fn step(&self, from: Selection, movement: Move) -> Option<Selection> {
        let s = self.selectable;
        let vertical = matches!(
            movement,
            Move::Up | Move::Down | Move::PageUp | Move::PageDown
        );
        let horizontal = matches!(movement, Move::Left | Move::Right);
        match from {
            Selection::Row(_) if s.rows && !horizontal => return self.step_row(from, movement),
            Selection::Column(_) if s.columns && !vertical => {
                return self.step_column(from, movement);
            }
            _ => {}
        }
        if s.cells {
            self.step_cell(from, movement)
        } else if s.rows && !horizontal {
            self.step_row(from, movement)
        } else if s.columns && !vertical {
            self.step_column(from, movement)
        } else {
            None
        }
    }

    fn step_row(&self, from: Selection, movement: Move) -> Option<Selection> {
        if self.rows == 0 {
            return None;
        }
        let row = match from {
            Selection::Row(r) => Some(r.min(self.rows - 1)),
            _ => None,
        };
        Some(Selection::Row(self.vertical(row, movement)?))
    }

    fn step_column(&self, from: Selection, movement: Move) -> Option<Selection> {
        let at = match from {
            Selection::Column(c) => self.columns.iter().position(|&d| d == c),
            _ => None,
        };
        Some(Selection::Column(
            self.columns[self.horizontal(at, movement)?],
        ))
    }

    fn step_cell(&self, from: Selection, movement: Move) -> Option<Selection> {
        if self.rows == 0 || self.columns.is_empty() {
            return None;
        }
        // Where the move starts: a row selected by its header enters its
        // cells at the first (or for End the last) one, a column selected by
        // its title at its first (or last) row, nothing at the first cell.
        let (row, at) = match from {
            Selection::Cell(row, col) => (
                Some(row.min(self.rows - 1)),
                self.columns.iter().position(|&d| d == col),
            ),
            Selection::Row(row) => (Some(row.min(self.rows - 1)), None),
            Selection::Column(col) => (None, self.columns.iter().position(|&d| d == col)),
            Selection::None => return Some(Selection::Cell(0, self.columns[0])),
        };
        match movement {
            Move::Left | Move::Right | Move::First | Move::Last => {
                let to = self.horizontal(at, movement)?;
                Some(Selection::Cell(row.unwrap_or(0), self.columns[to]))
            }
            _ => {
                let to = self.vertical(row, movement)?;
                Some(Selection::Cell(to, self.columns[at.unwrap_or(0)]))
            }
        }
    }

    /// The row after a vertical `movement` (Home and End are the first and
    /// last row).
    fn vertical(&self, row: Option<usize>, movement: Move) -> Option<usize> {
        let last = self.rows - 1;
        let Some(row) = row else {
            // Nothing selected: the first row, or the last one for End.
            return Some(match movement {
                Move::Last => last,
                _ => 0,
            });
        };
        let page = self.page.max(1);
        Some(match movement {
            Move::Up if row > 0 => row - 1,
            Move::Up if self.wrap => last,
            Move::Down if row < last => row + 1,
            Move::Down if self.wrap => 0,
            Move::Up | Move::Down => row,
            Move::PageUp => row.saturating_sub(page),
            Move::PageDown => (row + page).min(last),
            Move::First => 0,
            Move::Last => last,
            Move::Left | Move::Right => return None,
        })
    }

    /// The index into `columns` after a horizontal `movement`.
    fn horizontal(&self, at: Option<usize>, movement: Move) -> Option<usize> {
        if self.columns.is_empty() {
            return None;
        }
        let last = self.columns.len() - 1;
        let Some(at) = at else {
            return Some(match movement {
                Move::Last => last,
                _ => 0,
            });
        };
        Some(match movement {
            Move::Left if at > 0 => at - 1,
            Move::Left if self.wrap => last,
            Move::Right if at < last => at + 1,
            Move::Right if self.wrap => 0,
            Move::Left | Move::Right => at,
            Move::First => 0,
            Move::Last => last,
            Move::Up | Move::Down | Move::PageUp | Move::PageDown => return None,
        })
    }
}

/// `selection` kept inside a table of `rows` rows and `columns` columns, and
/// of a kind `allowed` selects (anything else is cleared).
pub(crate) fn clamp(
    selection: Selection,
    allowed: Selectable,
    rows: usize,
    columns: usize,
) -> Selection {
    if !selection.fits(allowed) {
        return Selection::None;
    }
    match selection {
        Selection::Row(r) if r >= rows => Selection::None,
        Selection::Column(c) if c >= columns => Selection::None,
        Selection::Cell(r, c) if r >= rows || c >= columns => Selection::None,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROWS: Selectable = Selectable {
        rows: true,
        columns: false,
        cells: false,
    };
    const COLUMNS: Selectable = Selectable {
        rows: false,
        columns: true,
        cells: false,
    };
    const CELLS: Selectable = Selectable {
        rows: false,
        columns: false,
        cells: true,
    };
    const ALL: Selectable = Selectable {
        rows: true,
        columns: true,
        cells: true,
    };

    fn nav(selectable: Selectable, wrap: bool) -> Nav<'static> {
        Nav {
            selectable,
            rows: 10,
            columns: &[2, 0, 1],
            page: 4,
            wrap,
        }
    }

    #[test]
    fn rows_move_and_wrap() {
        let n = nav(ROWS, false);
        assert_eq!(n.step(Selection::None, Move::Down), Some(Selection::Row(0)));
        assert_eq!(n.step(Selection::Row(3), Move::Up), Some(Selection::Row(2)));
        assert_eq!(n.step(Selection::Row(0), Move::Up), Some(Selection::Row(0)));
        assert_eq!(
            n.step(Selection::Row(9), Move::Down),
            Some(Selection::Row(9))
        );
        assert_eq!(
            n.step(Selection::Row(3), Move::PageDown),
            Some(Selection::Row(7))
        );
        assert_eq!(
            n.step(Selection::Row(8), Move::PageDown),
            Some(Selection::Row(9))
        );
        assert_eq!(
            n.step(Selection::Row(3), Move::PageUp),
            Some(Selection::Row(0))
        );
        assert_eq!(
            n.step(Selection::Row(5), Move::First),
            Some(Selection::Row(0))
        );
        assert_eq!(
            n.step(Selection::Row(5), Move::Last),
            Some(Selection::Row(9))
        );
        assert_eq!(n.step(Selection::Row(5), Move::Left), None);
        let w = nav(ROWS, true);
        assert_eq!(w.step(Selection::Row(0), Move::Up), Some(Selection::Row(9)));
        assert_eq!(
            w.step(Selection::Row(9), Move::Down),
            Some(Selection::Row(0))
        );
    }

    #[test]
    fn columns_move_in_display_order() {
        let n = nav(COLUMNS, false);
        assert_eq!(
            n.step(Selection::None, Move::Right),
            Some(Selection::Column(2))
        );
        assert_eq!(
            n.step(Selection::Column(2), Move::Right),
            Some(Selection::Column(0))
        );
        assert_eq!(
            n.step(Selection::Column(1), Move::Right),
            Some(Selection::Column(1))
        );
        assert_eq!(
            n.step(Selection::Column(0), Move::Left),
            Some(Selection::Column(2))
        );
        assert_eq!(
            n.step(Selection::Column(0), Move::Last),
            Some(Selection::Column(1))
        );
        assert_eq!(n.step(Selection::Column(0), Move::Down), None);
    }

    #[test]
    fn rows_and_columns_move_their_own_ways() {
        // Rows and columns both select (the default): the vertical keys
        // move rows, the horizontal ones columns.
        let n = nav(
            Selectable {
                cells: false,
                ..ALL
            },
            false,
        );
        assert_eq!(n.step(Selection::None, Move::Down), Some(Selection::Row(0)));
        assert_eq!(
            n.step(Selection::None, Move::Right),
            Some(Selection::Column(2))
        );
        assert_eq!(
            n.step(Selection::Row(4), Move::Right),
            Some(Selection::Column(2))
        );
        assert_eq!(
            n.step(Selection::Column(0), Move::Down),
            Some(Selection::Row(0))
        );
    }

    #[test]
    fn cells_move_in_both_directions() {
        let n = nav(CELLS, false);
        assert_eq!(
            n.step(Selection::None, Move::Down),
            Some(Selection::Cell(0, 2))
        );
        assert_eq!(
            n.step(Selection::None, Move::Right),
            Some(Selection::Cell(0, 2))
        );
        assert_eq!(
            n.step(Selection::Cell(1, 0), Move::Down),
            Some(Selection::Cell(2, 0))
        );
        assert_eq!(
            n.step(Selection::Cell(1, 0), Move::Right),
            Some(Selection::Cell(1, 1))
        );
        assert_eq!(
            n.step(Selection::Cell(1, 0), Move::First),
            Some(Selection::Cell(1, 2))
        );
        assert_eq!(
            n.step(Selection::Cell(1, 0), Move::Last),
            Some(Selection::Cell(1, 1))
        );
        assert_eq!(
            n.step(Selection::Cell(8, 0), Move::PageDown),
            Some(Selection::Cell(9, 0))
        );
        let w = nav(CELLS, true);
        assert_eq!(
            w.step(Selection::Cell(1, 1), Move::Right),
            Some(Selection::Cell(1, 2))
        );
    }

    #[test]
    fn a_selected_row_or_column_keeps_its_way_among_cells() {
        let n = nav(ALL, false);
        // A row (its header): the vertical keys move rows, the horizontal
        // ones enter its cells.
        assert_eq!(
            n.step(Selection::Row(3), Move::Down),
            Some(Selection::Row(4))
        );
        assert_eq!(
            n.step(Selection::Row(3), Move::Right),
            Some(Selection::Cell(3, 2))
        );
        // A column (its title): the horizontal keys move columns, the
        // vertical ones enter its cells.
        assert_eq!(
            n.step(Selection::Column(2), Move::Right),
            Some(Selection::Column(0))
        );
        assert_eq!(
            n.step(Selection::Column(0), Move::Down),
            Some(Selection::Cell(0, 0))
        );
        // Nothing: cells.
        assert_eq!(
            n.step(Selection::None, Move::Down),
            Some(Selection::Cell(0, 2))
        );
    }

    #[test]
    fn nothing_moves_without_rows_or_anything_selectable() {
        let mut n = nav(ROWS, false);
        n.rows = 0;
        assert_eq!(n.step(Selection::None, Move::Down), None);
        let none = nav(Selectable::default(), false);
        assert_eq!(none.step(Selection::None, Move::Down), None);
        assert_eq!(none.step(Selection::None, Move::Right), None);
        // Columns alone: the vertical keys do nothing.
        assert_eq!(nav(COLUMNS, false).step(Selection::None, Move::Up), None);
    }

    #[test]
    fn a_selection_is_kept_in_range_and_to_what_selects() {
        assert_eq!(clamp(Selection::Row(3), ROWS, 4, 2), Selection::Row(3));
        assert_eq!(clamp(Selection::Row(4), ROWS, 4, 2), Selection::None);
        assert_eq!(clamp(Selection::Row(1), CELLS, 4, 2), Selection::None);
        assert_eq!(clamp(Selection::Row(1), ALL, 4, 2), Selection::Row(1));
        assert_eq!(clamp(Selection::Column(1), ROWS, 4, 2), Selection::None);
        assert_eq!(
            clamp(Selection::Column(1), COLUMNS, 4, 2),
            Selection::Column(1)
        );
        assert_eq!(clamp(Selection::Cell(1, 1), ROWS, 4, 2), Selection::None);
        assert_eq!(clamp(Selection::Cell(1, 2), CELLS, 4, 2), Selection::None);
        assert_eq!(
            clamp(Selection::Cell(1, 1), CELLS, 4, 2),
            Selection::Cell(1, 1)
        );
    }
}
