//! What the editor's parts share: positions, selections and the rows the
//! text is laid out in.

use std::ops::Range;

use nsh_core::geometry::Points;

/// A position in the text: a line and the bytes into it, both from 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub(crate) struct Point {
    /// The line.
    pub(crate) line: usize,
    /// The bytes into the line (always on a character boundary).
    pub(crate) column: usize,
}

impl Point {
    pub(crate) fn new(line: usize, column: usize) -> Point {
        Point { line, column }
    }
}

/// One selection: from `anchor`, where it started, to `head`, where the
/// caret is (byte offsets of the text, on character boundaries). An empty
/// one is a caret.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Selection {
    /// Where the selection started; stays as the selection extends.
    pub(crate) anchor: usize,
    /// Where the caret is; moves as the selection extends.
    pub(crate) head: usize,
    /// The x a run of vertical movements keeps (where the first of them
    /// started), so a caret passing a short line comes back to its column;
    /// any other movement or edit clears it.
    pub(crate) goal: Option<Points>,
}

impl Selection {
    /// A caret at `at`.
    pub(crate) fn caret(at: usize) -> Selection {
        Selection {
            anchor: at,
            head: at,
            goal: None,
        }
    }

    /// From `anchor` to `head`.
    pub(crate) fn new(anchor: usize, head: usize) -> Selection {
        Selection {
            anchor,
            head,
            goal: None,
        }
    }

    /// The first offset selected.
    pub(crate) fn start(&self) -> usize {
        self.anchor.min(self.head)
    }

    /// The offset after the last one selected.
    pub(crate) fn end(&self) -> usize {
        self.anchor.max(self.head)
    }

    /// What it selects.
    pub(crate) fn range(&self) -> Range<usize> {
        self.start()..self.end()
    }

    /// A caret, selecting nothing.
    pub(crate) fn is_empty(&self) -> bool {
        self.anchor == self.head
    }

    /// Made backwards: the caret is at its start.
    pub(crate) fn is_reversed(&self) -> bool {
        self.head < self.anchor
    }

    /// The caret moved to `head`, the anchor kept (extending it).
    pub(crate) fn extend_to(self, head: usize) -> Selection {
        Selection {
            anchor: self.anchor,
            head,
            goal: None,
        }
    }
}

/// The selections of an editor: at least one, sorted by start, none
/// overlapping another (overlapping or equal ones merge as they are set).
/// `primary` is the one the view follows (the newest).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Selections {
    all: Vec<Selection>,
    primary: usize,
}

impl Default for Selections {
    fn default() -> Self {
        Selections::single(Selection::caret(0))
    }
}

impl Selections {
    /// One selection.
    pub(crate) fn single(selection: Selection) -> Selections {
        Selections {
            all: vec![selection],
            primary: 0,
        }
    }

    /// `all` (at least one) with `primary` the index of the one the view
    /// follows, sorted and merged.
    pub(crate) fn new(all: Vec<Selection>, primary: usize) -> Selections {
        let mut selections = Selections { all, primary };
        selections.normalize();
        selections
    }

    /// Every selection, sorted by start.
    pub(crate) fn all(&self) -> &[Selection] {
        &self.all
    }

    /// The index of the primary selection in [`Self::all`].
    pub(crate) fn primary_index(&self) -> usize {
        self.primary
    }

    /// The selection the view follows.
    pub(crate) fn primary(&self) -> Selection {
        self.all[self.primary]
    }

    /// How many there are.
    pub(crate) fn len(&self) -> usize {
        self.all.len()
    }

    /// Adds `selection` as the primary one.
    pub(crate) fn push(&mut self, selection: Selection) {
        self.all.push(selection);
        self.primary = self.all.len() - 1;
        self.normalize();
    }

    /// Each selection replaced by what `f` makes of it, then sorted and
    /// merged.
    pub(crate) fn map(&mut self, mut f: impl FnMut(Selection) -> Selection) {
        for selection in &mut self.all {
            *selection = f(*selection);
        }
        self.normalize();
    }

    /// The primary selection alone.
    pub(crate) fn collapse_to_primary(&mut self) {
        let primary = self.primary();
        *self = Selections::single(primary);
    }

    /// Every offset clamped to `len` (the text's length in bytes).
    pub(crate) fn clamp(&mut self, len: usize) {
        self.map(|s| Selection {
            anchor: s.anchor.min(len),
            head: s.head.min(len),
            goal: s.goal,
        });
    }

    /// Sorts the selections by start and merges those that overlap (or
    /// are equal carets), keeping track of the primary one.
    fn normalize(&mut self) {
        if self.all.is_empty() {
            self.all.push(Selection::caret(0));
            self.primary = 0;
            return;
        }
        self.primary = self.primary.min(self.all.len() - 1);
        let mut indexed: Vec<(usize, Selection)> = self.all.drain(..).enumerate().collect();
        indexed.sort_by_key(|(_, s)| (s.start(), s.end()));
        let mut merged: Vec<Selection> = Vec::with_capacity(indexed.len());
        let mut primary_at = 0;
        for (index, selection) in indexed {
            let is_primary = index == self.primary;
            if let Some(last) = merged.last_mut() {
                // Touching selections stay apart (a caret right after a
                // selection too); equal ones and overlapping ones merge.
                let overlaps = selection.start() < last.end() || selection.range() == last.range();
                if overlaps {
                    let start = last.start().min(selection.start());
                    let end = last.end().max(selection.end());
                    let reversed = if is_primary {
                        selection.is_reversed()
                    } else {
                        last.is_reversed()
                    };
                    *last = if reversed {
                        Selection::new(end, start)
                    } else {
                        Selection::new(start, end)
                    };
                    if is_primary {
                        primary_at = merged.len() - 1;
                    }
                    continue;
                }
            }
            if is_primary {
                primary_at = merged.len();
            }
            merged.push(selection);
        }
        self.all = merged;
        self.primary = primary_at;
    }
}

/// How the text is laid out in display rows (a line soft-wrapped is
/// several rows, a folded range's lines none): what vertical movements,
/// presses and the view need of the layout. The display map implements it.
pub(crate) trait RowLayout {
    /// How many display rows there are (at least 1).
    fn row_count(&self) -> usize;

    /// The display row `offset` is on and the x of `offset` in that row
    /// (from the row's start, the text's left edge). An offset where a
    /// line soft-wraps is at the start of the next row; an offset inside a
    /// folded range is where the fold shows (the end of its first line).
    fn locate(&self, offset: usize) -> (usize, Points);

    /// The offset in display row `row` nearest to `x`: on a character
    /// boundary, between the row's start and its end (the end of a
    /// soft-wrapped row is the last offset before the wrap).
    fn offset_at(&self, row: usize, x: Points) -> usize;

    /// The text display row `row` shows, without its line break: byte
    /// offsets of the text.
    fn row_range(&self, row: usize) -> Range<usize>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selections_merge_and_keep_the_primary() {
        let s = Selections::new(
            vec![
                Selection::new(10, 12),
                Selection::caret(2),
                Selection::new(11, 15),
            ],
            2,
        );
        assert_eq!(s.all(), &[Selection::caret(2), Selection::new(10, 15)]);
        assert_eq!(s.primary_index(), 1);
    }

    #[test]
    fn equal_carets_merge_and_touching_selections_stay() {
        let s = Selections::new(
            vec![
                Selection::caret(4),
                Selection::caret(4),
                Selection::new(4, 6),
            ],
            0,
        );
        assert_eq!(s.len(), 2);
        let t = Selections::new(vec![Selection::new(0, 2), Selection::new(2, 4)], 0);
        assert_eq!(t.len(), 2);
    }
}
