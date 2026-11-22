//! The rows a diff shows: unchanged lines around each hunk, the hunks'
//! lines side by side (`Split`) or one over the other (`Unified`), and the
//! unchanged lines between hunks collapsed into separators that expand.
//!
//! Rows are made only for what shows: a gap of unchanged lines costs its
//! shown lines and one separator, never a walk over every hidden line, so
//! a big text with few changes lays out in time proportional to its rows.

use super::model::DiffModel;

/// What a row of lines shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// An unchanged line, on both sides.
    Context,
    /// A line only the new text has.
    Added,
    /// A line only the old text has.
    Deleted,
    /// A split row with a deleted line beside the added line paired with it.
    Modified,
}

/// One row of the diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Row {
    /// Lines: the old line and the new line (split: both sides of one row,
    /// either may be `None` for the empty filler; unified: one of them, or
    /// both for a context line), the row's kind and the hunk it belongs to
    /// (`None` for context lines). The view looks up a `Modified` row's
    /// inline ranges through `DiffModel::inline`.
    Line {
        old: Option<usize>,
        new: Option<usize>,
        kind: Kind,
        hunk: Option<usize>,
    },
    /// Collapsed unchanged lines: the index of the gap (before hunk 0 is gap
    /// 0, between hunks `i - 1` and `i` is gap `i`, after the last is gap
    /// `hunks.len()`), how many lines it hides, and whether it is the first or
    /// the last gap (the first only expands up, the last only down: see
    /// [`Expansions::expand`]). For a patch, a hunk header instead: `gap` is
    /// the header's index in [`Options::headers`], `lines` is 0, `first` is
    /// whether it is the first header, `last` is false and `header` is its
    /// text.
    Separator {
        gap: usize,
        lines: usize,
        first: bool,
        last: bool,
        header: Option<String>,
    },
    /// The header of file `file` of a patch of several files (`files.rs`):
    /// its rows follow unless it is collapsed.
    File { file: usize },
}

/// How the two texts show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Layout {
    /// Side by side: old lines on the left, new lines on the right.
    #[default]
    Split,
    /// One column: a hunk's deleted lines, then its added lines.
    Unified,
}

/// A patch hunk's header and where its lines start in the texts the patch
/// shows (`FilePatch::texts`: lines counted from 0 in those texts, not in
/// the files).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Header {
    /// The hunk's first line in the old text.
    pub(crate) old: usize,
    /// The hunk's first line in the new text.
    pub(crate) new: usize,
    /// What the separator shows (the view decides: e.g. the text after the
    /// second `@@`, or the whole `@@ -1,3 +1,4 @@` line).
    pub(crate) text: String,
}

/// What the rows are made of besides the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Options {
    /// Side by side or unified.
    pub(crate) layout: Layout,
    /// Unchanged lines shown on each side of a hunk.
    pub(crate) context: usize,
    /// Shows every unchanged line: no separators.
    pub(crate) expand_all: bool,
    /// A patch's hunk headers, in order. When there are any, the texts are a
    /// patch's (only the lines its hunks show): nothing collapses, and each
    /// header is a separator before the first row of its hunk.
    pub(crate) headers: Vec<Header>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            layout: Layout::Split,
            context: 3,
            expand_all: false,
            headers: Vec::new(),
        }
    }
}

/// What the user expanded of each gap: lines shown from its top (just below
/// the hunk above) and from its bottom (just above the hunk below), beyond
/// the context lines. Gap indices are the model's: a new model (other texts,
/// a reverted hunk) clears them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Expansions {
    /// `(from_top, from_bottom)` per gap, `usize::MAX` for all of it.
    gaps: Vec<(usize, usize)>,
}

impl Expansions {
    /// Reveals `lines` more of gap `gap`. `up`: the lines just above the hunk
    /// below the gap (from the gap's bottom, growing up toward the hunk above:
    /// what the first gap's separator expands); otherwise the lines just
    /// below the hunk above (from the gap's top, growing down: what the last
    /// gap's separator expands).
    pub(crate) fn expand(&mut self, gap: usize, up: bool, lines: usize) {
        if lines == 0 {
            return;
        }
        let entry = self.entry(gap);
        if up {
            entry.1 = entry.1.saturating_add(lines);
        } else {
            entry.0 = entry.0.saturating_add(lines);
        }
    }

    /// Reveals all of gap `gap`.
    pub(crate) fn expand_gap(&mut self, gap: usize) {
        self.entry(gap).0 = usize::MAX;
    }

    /// Collapses every gap again.
    pub(crate) fn clear(&mut self) {
        self.gaps.clear();
    }

    /// What is revealed of gap `gap`: from its top and from its bottom.
    fn get(&self, gap: usize) -> (usize, usize) {
        self.gaps.get(gap).copied().unwrap_or((0, 0))
    }

    fn entry(&mut self, gap: usize) -> &mut (usize, usize) {
        if self.gaps.len() <= gap {
            self.gaps.resize(gap + 1, (0, 0));
        }
        &mut self.gaps[gap]
    }
}

/// The rows: context lines around each hunk (`options.context` each side),
/// gaps of unchanged lines collapsed into one separator unless shown by
/// `expansions` (a gap that would hide one line shows whole). Split: a
/// hunk's pairs (`DiffModel::pairs`) as rows, paired lines side by side
/// (`Modified`), the rest with an empty filler on the other side; unified:
/// the hunk's deleted lines, then its added lines. With patch headers
/// (`options.headers`), every line shows and each header is a separator
/// before its hunk's first row.
pub(crate) fn rows(
    model: &DiffModel,
    old: &str,
    new: &str,
    options: &Options,
    expansions: &Expansions,
) -> Vec<Row> {
    let mut out = Rows {
        rows: Vec::new(),
        headers: &options.headers,
        next_header: 0,
    };
    let show_all = options.expand_all || !options.headers.is_empty();
    let hunks = &model.hunks;
    let (mut old_at, mut new_at) = (0, 0);
    for gap in 0..=hunks.len() {
        let (old_end, new_end) = match hunks.get(gap) {
            Some(hunk) => (hunk.old.start, hunk.new.start),
            None => (model.old_lines, model.new_lines),
        };
        // The unchanged lines between hunks are the same count on both sides;
        // `min` only guards against a model that disagrees.
        let count = old_end
            .saturating_sub(old_at)
            .min(new_end.saturating_sub(new_at));
        let first = gap == 0;
        let last = gap == hunks.len();
        let (top, bottom) = if show_all {
            (count, 0)
        } else {
            let (from_top, from_bottom) = expansions.get(gap);
            let top = if first { 0 } else { options.context }.saturating_add(from_top);
            let bottom = if last { 0 } else { options.context }.saturating_add(from_bottom);
            (top, bottom)
        };
        // A separator in place of one line saves nothing: show it.
        if top.saturating_add(bottom).saturating_add(1) >= count {
            out.context(old_at, new_at, count);
        } else {
            out.context(old_at, new_at, top);
            out.rows.push(Row::Separator {
                gap,
                lines: count - top - bottom,
                first,
                last,
                header: None,
            });
            let skip = count - bottom;
            out.context(old_at + skip, new_at + skip, bottom);
        }
        let Some(hunk) = hunks.get(gap) else {
            break;
        };
        match options.layout {
            Layout::Split => {
                for pair in model.pairs(gap, old, new) {
                    let kind = match (pair.old, pair.new) {
                        (Some(_), Some(_)) => Kind::Modified,
                        (Some(_), None) => Kind::Deleted,
                        (None, _) => Kind::Added,
                    };
                    out.line(pair.old, pair.new, kind, Some(gap));
                }
            }
            Layout::Unified => {
                for line in hunk.old.clone() {
                    out.line(Some(line), None, Kind::Deleted, Some(gap));
                }
                for line in hunk.new.clone() {
                    out.line(None, Some(line), Kind::Added, Some(gap));
                }
            }
        }
        old_at = hunk.old.end;
        new_at = hunk.new.end;
    }
    // Headers of hunks with no lines left (an empty patch hunk).
    while out.next_header < out.headers.len() {
        out.header();
    }
    out.rows
}

/// The first row of hunk `index` in `rows` (navigation).
pub(crate) fn hunk_row(rows: &[Row], index: usize) -> Option<usize> {
    rows.iter()
        .position(|row| matches!(row, Row::Line { hunk: Some(hunk), .. } if *hunk == index))
}

/// The rows being made, and the patch headers still to place.
struct Rows<'a> {
    rows: Vec<Row>,
    headers: &'a [Header],
    next_header: usize,
}

impl Rows<'_> {
    /// `count` unchanged lines from `old` and `new`.
    fn context(&mut self, old: usize, new: usize, count: usize) {
        for i in 0..count {
            self.line(Some(old + i), Some(new + i), Kind::Context, None);
        }
    }

    fn line(&mut self, old: Option<usize>, new: Option<usize>, kind: Kind, hunk: Option<usize>) {
        // A header goes before the first row that reaches its hunk on either
        // side.
        while let Some(header) = self.headers.get(self.next_header) {
            let reached = old.is_some_and(|line| line >= header.old)
                || new.is_some_and(|line| line >= header.new);
            if !reached {
                break;
            }
            self.header();
        }
        self.rows.push(Row::Line {
            old,
            new,
            kind,
            hunk,
        });
    }

    fn header(&mut self) {
        let index = self.next_header;
        self.rows.push(Row::Separator {
            gap: index,
            lines: 0,
            first: index == 0,
            last: false,
            header: Some(self.headers[index].text.clone()),
        });
        self.next_header += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines joined, each with its line break.
    fn text(lines: &[&str]) -> String {
        lines.iter().map(|line| format!("{line}\n")).collect()
    }

    const LETTERS: [&str; 8] = ["a", "b", "c", "d", "e", "f", "g", "h"];

    fn layout(old: &str, new: &str, options: &Options, expansions: &Expansions) -> Vec<Row> {
        rows(&DiffModel::compute(old, new), old, new, options, expansions)
    }

    fn unified() -> Options {
        Options {
            layout: Layout::Unified,
            ..Options::default()
        }
    }

    fn ctx(old: usize, new: usize) -> Row {
        Row::Line {
            old: Some(old),
            new: Some(new),
            kind: Kind::Context,
            hunk: None,
        }
    }

    fn added(new: usize, hunk: usize) -> Row {
        Row::Line {
            old: None,
            new: Some(new),
            kind: Kind::Added,
            hunk: Some(hunk),
        }
    }

    fn deleted(old: usize, hunk: usize) -> Row {
        Row::Line {
            old: Some(old),
            new: None,
            kind: Kind::Deleted,
            hunk: Some(hunk),
        }
    }

    fn separator(gap: usize, lines: usize, first: bool, last: bool) -> Row {
        Row::Separator {
            gap,
            lines,
            first,
            last,
            header: None,
        }
    }

    fn separators(rows: &[Row]) -> usize {
        rows.iter()
            .filter(|row| matches!(row, Row::Separator { .. }))
            .count()
    }

    #[test]
    fn no_changes_collapse_into_one_separator() {
        let t = text(&LETTERS);
        let rows = layout(&t, &t, &Options::default(), &Expansions::default());
        assert_eq!(rows, vec![separator(0, 8, true, true)]);
    }

    #[test]
    fn no_changes_show_whole_with_expand_all() {
        let t = text(&LETTERS);
        let options = Options {
            expand_all: true,
            ..Options::default()
        };
        let rows = layout(&t, &t, &options, &Expansions::default());
        assert_eq!(rows, (0..8).map(|i| ctx(i, i)).collect::<Vec<_>>());
    }

    #[test]
    fn empty_texts_have_no_rows() {
        assert_eq!(
            layout("", "", &Options::default(), &Expansions::default()),
            vec![]
        );
    }

    #[test]
    fn insertion_at_the_start() {
        let old = text(&LETTERS);
        let new = text(&["x", "a", "b", "c", "d", "e", "f", "g", "h"]);
        let rows = layout(&old, &new, &Options::default(), &Expansions::default());
        assert_eq!(
            rows,
            vec![
                added(0, 0),
                ctx(0, 1),
                ctx(1, 2),
                ctx(2, 3),
                separator(1, 5, false, true),
            ]
        );
    }

    #[test]
    fn insertion_at_the_end() {
        let old = text(&LETTERS);
        let new = text(&["a", "b", "c", "d", "e", "f", "g", "h", "x"]);
        let rows = layout(&old, &new, &Options::default(), &Expansions::default());
        assert_eq!(
            rows,
            vec![
                separator(0, 5, true, false),
                ctx(5, 5),
                ctx(6, 6),
                ctx(7, 7),
                added(8, 0),
            ]
        );
    }

    #[test]
    fn deletion_at_the_end() {
        let old = text(&["a", "b", "c", "d", "e", "f", "g", "h", "x"]);
        let new = text(&LETTERS);
        let rows = layout(&old, &new, &unified(), &Expansions::default());
        assert_eq!(
            rows,
            vec![
                separator(0, 5, true, false),
                ctx(5, 5),
                ctx(6, 6),
                ctx(7, 7),
                deleted(8, 0),
            ]
        );
        assert_eq!(hunk_row(&rows, 0), Some(4));
        assert_eq!(hunk_row(&rows, 1), None);
    }

    #[test]
    fn modified_pair_split_and_unified() {
        let old = text(&["fn main() {", "    let value = 1;", "}"]);
        let new = text(&["fn main() {", "    let value = 2;", "}"]);
        let split = layout(&old, &new, &Options::default(), &Expansions::default());
        assert_eq!(
            split,
            vec![
                ctx(0, 0),
                Row::Line {
                    old: Some(1),
                    new: Some(1),
                    kind: Kind::Modified,
                    hunk: Some(0),
                },
                ctx(2, 2),
            ]
        );
        let unified = layout(&old, &new, &unified(), &Expansions::default());
        assert_eq!(
            unified,
            vec![ctx(0, 0), deleted(1, 0), added(1, 0), ctx(2, 2)]
        );
        assert_eq!(hunk_row(&split, 0), Some(1));
        assert_eq!(hunk_row(&unified, 0), Some(1));
    }

    #[test]
    fn split_rows_cover_every_changed_line_once() {
        let old = text(&["one", "two", "three", "keep"]);
        let new = text(&["uno", "keep"]);
        let rows = layout(&old, &new, &Options::default(), &Expansions::default());
        let mut olds = Vec::new();
        let mut news = Vec::new();
        for row in &rows {
            if let Row::Line { old, new, kind, .. } = row {
                olds.extend(*old);
                news.extend(*new);
                let expected = match (old, new) {
                    (Some(_), Some(_)) if *kind == Kind::Context => Kind::Context,
                    (Some(_), Some(_)) => Kind::Modified,
                    (Some(_), None) => Kind::Deleted,
                    _ => Kind::Added,
                };
                assert_eq!(*kind, expected);
            }
        }
        assert_eq!(olds, vec![0, 1, 2, 3]);
        assert_eq!(news, vec![0, 1]);
    }

    #[test]
    fn first_gap_expands_up() {
        let old = text(&LETTERS);
        let new = text(&["a", "b", "c", "d", "e", "f", "g", "h", "x"]);
        let mut expansions = Expansions::default();
        expansions.expand(0, true, 2);
        let rows = layout(&old, &new, &Options::default(), &expansions);
        assert_eq!(rows[0], separator(0, 3, true, false));
        assert_eq!(rows[1], ctx(3, 3));
        assert_eq!(rows.len(), 1 + 5 + 1);
        // Two more would leave one line hidden: the whole gap shows.
        expansions.expand(0, true, 2);
        let rows = layout(&old, &new, &Options::default(), &expansions);
        assert_eq!(separators(&rows), 0);
        assert_eq!(rows.len(), 9);
    }

    #[test]
    fn last_gap_expands_down() {
        let old = text(&LETTERS);
        let new = text(&["x", "a", "b", "c", "d", "e", "f", "g", "h"]);
        let mut expansions = Expansions::default();
        expansions.expand(1, false, 2);
        let rows = layout(&old, &new, &Options::default(), &expansions);
        assert_eq!(rows.len(), 1 + 5 + 1);
        assert_eq!(rows[5], ctx(4, 5));
        assert_eq!(rows[6], separator(1, 3, false, true));
        expansions.clear();
        expansions.expand_gap(1);
        let rows = layout(&old, &new, &Options::default(), &expansions);
        assert_eq!(rows.len(), 9);
        assert_eq!(separators(&rows), 0);
    }

    #[test]
    fn middle_gap_expands_both_ways() {
        let lines: Vec<String> = (0..20).map(|i| format!("line {i}")).collect();
        let old: Vec<&str> = lines.iter().map(String::as_str).collect();
        let mut new = old.clone();
        new[0] = "changed first";
        new[19] = "changed last";
        let (old, new) = (text(&old), text(&new));
        let options = unified();
        let mut expansions = Expansions::default();
        // Lines 1..19 unchanged: 3 context lines each side, 12 hidden.
        let rows = layout(&old, &new, &options, &expansions);
        assert!(rows.contains(&separator(1, 12, false, false)));
        expansions.expand(1, false, 4);
        expansions.expand(1, true, 5);
        let rows = layout(&old, &new, &options, &expansions);
        let at = rows
            .iter()
            .position(|row| matches!(row, Row::Separator { .. }))
            .unwrap();
        assert_eq!(rows[at], separator(1, 3, false, false));
        // Below the hunk above: lines 1..=7; above the hunk below: lines 11..=18.
        assert_eq!(rows[at - 1], ctx(7, 7));
        assert_eq!(rows[at + 1], ctx(11, 11));
    }

    #[test]
    fn a_gap_of_one_hidden_line_shows_whole() {
        // Lines 1..=7 between two changes: 3 + 3 context lines leave one.
        let old = text(&["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
        let new = text(&["zero", "1", "2", "3", "4", "5", "6", "7", "eight"]);
        let rows = layout(&old, &new, &unified(), &Expansions::default());
        assert_eq!(separators(&rows), 0);
        assert_eq!(rows.len(), 2 + 7 + 2);
        // One more line between them collapses two.
        let old = text(&["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        let new = text(&["zero", "1", "2", "3", "4", "5", "6", "7", "8", "nine"]);
        let rows = layout(&old, &new, &unified(), &Expansions::default());
        assert!(rows.contains(&separator(1, 2, false, false)));
    }

    #[test]
    fn zero_context_shows_only_the_hunks() {
        let old = text(&LETTERS);
        let new = text(&["a", "b", "c", "X", "e", "f", "g", "h"]);
        let options = Options {
            context: 0,
            ..unified()
        };
        let rows = layout(&old, &new, &options, &Expansions::default());
        assert_eq!(
            rows,
            vec![
                separator(0, 3, true, false),
                deleted(3, 0),
                added(3, 0),
                separator(1, 4, false, true),
            ]
        );
    }

    #[test]
    fn patch_headers_separate_hunks() {
        let old = text(&["a", "b", "c", "d"]);
        let new = text(&["a", "bee", "c", "dee"]);
        let options = Options {
            context: 0,
            headers: vec![
                Header {
                    old: 0,
                    new: 0,
                    text: "fn one".into(),
                },
                Header {
                    old: 2,
                    new: 2,
                    text: "fn two".into(),
                },
            ],
            ..unified()
        };
        let header = |gap: usize, text: &str| Row::Separator {
            gap,
            lines: 0,
            first: gap == 0,
            last: false,
            header: Some(text.into()),
        };
        let rows = layout(&old, &new, &options, &Expansions::default());
        assert_eq!(
            rows,
            vec![
                header(0, "fn one"),
                ctx(0, 0),
                deleted(1, 0),
                added(1, 0),
                header(1, "fn two"),
                ctx(2, 2),
                deleted(3, 1),
                added(3, 1),
            ]
        );
    }

    #[test]
    fn large_text_with_few_changes_has_few_rows() {
        let lines: Vec<String> = (0..50_000).map(|i| format!("line {i}")).collect();
        let old: Vec<&str> = lines.iter().map(String::as_str).collect();
        let mut new = old.clone();
        let changed: Vec<String> = (0..10).map(|i| format!("changed {i}")).collect();
        for (i, line) in changed.iter().enumerate() {
            new[i * 5_000 + 2_500] = line;
        }
        let (old, new) = (text(&old), text(&new));
        let model = DiffModel::compute(&old, &new);
        assert_eq!(model.hunks.len(), 10);
        for layout in [Layout::Split, Layout::Unified] {
            let options = Options {
                layout,
                ..Options::default()
            };
            let rows = rows(&model, &old, &new, &options, &Expansions::default());
            assert_eq!(separators(&rows), 11);
            assert!(rows.len() <= 11 + 10 * (2 + 6), "{} rows", rows.len());
            for index in 0..10 {
                assert!(hunk_row(&rows, index).is_some());
            }
        }
    }
}
