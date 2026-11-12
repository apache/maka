//! The rows of an `EmojiPicker` and the moves of its highlight, pure: its
//! groups' emoji cut into rows of `columns` cells under each group's
//! header (frimousse's model), every cell in reading order, each group's
//! first row. A move is a lookup: the next cell, the cell of the same
//! column in the row above or below (the last of a shorter row), a page of
//! rows.

use std::hash::{Hash, Hasher};

use rustc_hash::FxHasher;

use super::EmojiGroupId;

/// A group shown: its emoji, as indices of the catalog.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Section {
    pub(crate) group: EmojiGroupId,
    pub(crate) emoji: Vec<u32>,
    /// It shows under a header row.
    pub(crate) header: bool,
}

/// A row of the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Row {
    /// Section `0`'s header.
    Header(u32),
    /// Cells `start..start + len` of section `section`.
    Cells { section: u32, start: u32, len: u32 },
}

impl Row {
    pub(crate) fn section(self) -> u32 {
        match self {
            Row::Header(section) | Row::Cells { section, .. } => section,
        }
    }
}

/// A move of the highlight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Move {
    Previous,
    Next,
    Up,
    Down,
    First,
    Last,
    /// Up this many rows of cells.
    PageUp(usize),
    /// Down this many rows of cells.
    PageDown(usize),
}

/// The rows the sections show.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Grid {
    pub(crate) rows: Vec<Row>,
    /// Each cell's emoji (an index of the catalog), in reading order.
    pub(crate) cells: Vec<u32>,
    /// Each cell's row.
    cell_rows: Vec<u32>,
    /// Each section's group and first row (its header, else its first row
    /// of cells).
    pub(crate) sections: Vec<(EmojiGroupId, u32)>,
    /// The rows' keys, hashed from what they show, so a row keeps its cell
    /// while the query, the skin tone or the recent emoji change others.
    pub(crate) keys: Vec<u64>,
}

impl Grid {
    /// `sections` in rows of `columns` cells, each under its header (no
    /// section with no emoji shows).
    pub(crate) fn new(sections: &[Section], columns: usize) -> Self {
        let columns = columns.max(1);
        let mut grid = Self::default();
        for section in sections.iter().filter(|s| !s.emoji.is_empty()) {
            let at = grid.sections.len() as u32;
            grid.sections.push((section.group, grid.rows.len() as u32));
            if section.header {
                grid.keys.push(hash(&(0u8, section.group)));
                grid.rows.push(Row::Header(at));
            }
            for chunk in section.emoji.chunks(columns) {
                let row = grid.rows.len() as u32;
                let start = grid.cells.len() as u32;
                grid.keys.push(hash(&(1u8, section.group, chunk)));
                grid.rows.push(Row::Cells {
                    section: at,
                    start,
                    len: chunk.len() as u32,
                });
                grid.cells.extend_from_slice(chunk);
                grid.cell_rows.extend(std::iter::repeat_n(row, chunk.len()));
            }
        }
        grid
    }

    /// The row of cell `cell`.
    pub(crate) fn row_of(&self, cell: usize) -> Option<usize> {
        self.cell_rows.get(cell).map(|&r| r as usize)
    }

    /// The first cell showing emoji `emoji`.
    pub(crate) fn cell_of(&self, emoji: u32) -> Option<usize> {
        self.cells.iter().position(|&e| e == emoji)
    }

    /// The first row of the section of `group`.
    pub(crate) fn row_of_group(&self, group: EmojiGroupId) -> Option<usize> {
        self.sections
            .iter()
            .find(|(g, _)| *g == group)
            .map(|&(_, row)| row as usize)
    }

    /// Where the highlight goes from cell `from` by `by` (the first cell
    /// from none); `None` with no cells.
    pub(crate) fn step(&self, from: Option<usize>, by: Move) -> Option<usize> {
        let last = self.cells.len().checked_sub(1)?;
        let Some(from) = from.filter(|&f| f <= last) else {
            return Some(match by {
                Move::Last => last,
                _ => 0,
            });
        };
        Some(match by {
            Move::Previous => from.saturating_sub(1),
            Move::Next => (from + 1).min(last),
            Move::First => 0,
            Move::Last => last,
            Move::Up => self.vertical(from, -1, 1),
            Move::Down => self.vertical(from, 1, 1),
            Move::PageUp(rows) => self.vertical(from, -1, rows.max(1)),
            Move::PageDown(rows) => self.vertical(from, 1, rows.max(1)),
        })
    }

    /// The cell `count` rows of cells from cell `from`'s, toward `dir`, in
    /// its column (the last cell of a shorter row); as far as the rows go.
    fn vertical(&self, from: usize, dir: isize, count: usize) -> usize {
        let row = self.cell_rows[from] as usize;
        let Row::Cells { start, .. } = self.rows[row] else {
            return from;
        };
        let column = from - start as usize;
        let mut target = None;
        let mut left = count;
        let mut at = row as isize + dir;
        while left > 0 && at >= 0 && (at as usize) < self.rows.len() {
            if let Row::Cells { start, len, .. } = self.rows[at as usize] {
                target = Some(start as usize + column.min(len as usize - 1));
                left -= 1;
            }
            at += dir;
        }
        target.unwrap_or(from)
    }
}

fn hash(value: &impl Hash) -> u64 {
    let mut h = FxHasher::default();
    value.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smileys 0..=9 and people 10..=12, three to a row.
    fn grid(headers: bool) -> Grid {
        Grid::new(
            &[
                Section {
                    group: EmojiGroupId::SmileysEmotion,
                    emoji: (0..10).collect(),
                    header: headers,
                },
                Section {
                    group: EmojiGroupId::AnimalsNature,
                    emoji: Vec::new(),
                    header: headers,
                },
                Section {
                    group: EmojiGroupId::PeopleBody,
                    emoji: (10..13).collect(),
                    header: headers,
                },
            ],
            3,
        )
    }

    #[test]
    fn sections_are_cut_into_rows_under_their_headers() {
        let g = grid(true);
        assert_eq!(
            g.rows,
            [
                Row::Header(0),
                Row::Cells {
                    section: 0,
                    start: 0,
                    len: 3
                },
                Row::Cells {
                    section: 0,
                    start: 3,
                    len: 3
                },
                Row::Cells {
                    section: 0,
                    start: 6,
                    len: 3
                },
                Row::Cells {
                    section: 0,
                    start: 9,
                    len: 1
                },
                Row::Header(1),
                Row::Cells {
                    section: 1,
                    start: 10,
                    len: 3
                },
            ]
        );
        assert_eq!(
            g.sections,
            [
                (EmojiGroupId::SmileysEmotion, 0),
                (EmojiGroupId::PeopleBody, 5)
            ]
        );
        assert_eq!(g.row_of_group(EmojiGroupId::PeopleBody), Some(5));
        assert_eq!(g.row_of_group(EmojiGroupId::Flags), None);
        assert_eq!(g.row_of(9), Some(4));
        assert_eq!(g.cell_of(11), Some(11));
        let without = grid(false);
        assert_eq!(without.rows.len(), 5);
        assert_eq!(without.sections[1], (EmojiGroupId::PeopleBody, 4));
    }

    #[test]
    fn keys_follow_what_a_row_shows() {
        let g = grid(true);
        let mut keys = g.keys.clone();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), g.keys.len());
        // The same emoji in another row of the same group keeps its key.
        let shifted = Grid::new(
            &[Section {
                group: EmojiGroupId::SmileysEmotion,
                emoji: (3..6).collect(),
                header: true,
            }],
            3,
        );
        assert_eq!(shifted.keys[1], g.keys[2]);
    }

    #[test]
    fn moves_go_along_rows_and_down_columns() {
        let g = grid(true);
        assert_eq!(g.step(None, Move::Down), Some(0));
        assert_eq!(g.step(None, Move::Last), Some(12));
        assert_eq!(g.step(Some(2), Move::Next), Some(3));
        assert_eq!(g.step(Some(0), Move::Previous), Some(0));
        assert_eq!(g.step(Some(12), Move::Next), Some(12));
        assert_eq!(g.step(Some(1), Move::Down), Some(4));
        // A shorter row takes its last cell; the header is passed over.
        assert_eq!(g.step(Some(8), Move::Down), Some(9));
        assert_eq!(g.step(Some(9), Move::Down), Some(10));
        assert_eq!(g.step(Some(11), Move::Up), Some(9));
        assert_eq!(g.step(Some(1), Move::Up), Some(1));
        assert_eq!(g.step(Some(1), Move::PageDown(2)), Some(7));
        assert_eq!(g.step(Some(1), Move::PageDown(10)), Some(11));
        assert_eq!(g.step(Some(11), Move::PageUp(10)), Some(1));
        assert_eq!(g.step(Some(5), Move::First), Some(0));
        assert_eq!(Grid::default().step(None, Move::Next), None);
    }
}
