//! The folds as sets of ranges, apart from where they come from
//! (`fold.rs`'s indentation or the app's `foldRanges`): the app's ranges
//! made a list of the indentation's shape ([`normalize`]) and kept on their
//! lines through edits ([`carry`]); the folded set, nested folds included,
//! after an edit ([`edited`]); levels of nesting, the folds inside a fold,
//! and the outermost folds of a set (what the display map hides).

use super::fold::FoldRange;

/// The fold of `ranges` starting on `line` (the outermost, when several
/// do), else the innermost one `line` is in.
pub(crate) fn fold_for(ranges: &[FoldRange], line: usize) -> Option<FoldRange> {
    let at = ranges.partition_point(|range| range.start < line);
    match ranges.get(at) {
        Some(range) if range.start == line => Some(*range),
        _ => innermost(ranges, line),
    }
}

/// The innermost of `ranges` (sorted) that `line` is on, its first line
/// included.
fn innermost(ranges: &[FoldRange], line: usize) -> Option<FoldRange> {
    // Sorted by start, an inner fold comes after its outer ones: the last
    // one holding the line is the innermost.
    ranges[..ranges.partition_point(|range| range.start <= line)]
        .iter()
        .rev()
        .find(|range| range.start <= line && line <= range.end)
        .copied()
}

/// `ranges` as [`fold_ranges`] gives its own: sorted by start, then outer
/// before inner; one per start line (the outermost); none empty or past the
/// last of `line_count` lines (an end past it is clamped); each inside the
/// ones before it that it starts in. A range crossing an earlier one's end
/// is dropped, as an editor cannot hide part of a fold.
pub(crate) fn normalize(mut ranges: Vec<FoldRange>, line_count: usize) -> Vec<FoldRange> {
    let last = line_count.saturating_sub(1);
    for range in &mut ranges {
        range.end = range.end.min(last);
    }
    ranges.retain(|range| range.start < range.end);
    ranges.sort_by_key(|range| (range.start, std::cmp::Reverse(range.end)));
    ranges.dedup_by_key(|range| range.start);
    let mut open: Vec<FoldRange> = Vec::new();
    ranges.retain(|range| {
        while open.last().is_some_and(|outer| outer.end < range.start) {
            open.pop();
        }
        if open.last().is_some_and(|outer| range.end > outer.end) {
            return false;
        }
        open.push(*range);
        true
    });
    ranges
}

/// The nesting level of each of `ranges` (as [`normalize`] makes them),
/// from 1 for those inside no other.
pub(crate) fn levels(ranges: &[FoldRange]) -> Vec<usize> {
    let mut open: Vec<usize> = Vec::new();
    ranges
        .iter()
        .map(|range| {
            while open.last().is_some_and(|end| *end < range.start) {
                open.pop();
            }
            open.push(range.end);
            open.len()
        })
        .collect()
}

/// The folds of `ranges` (sorted) that are `outer` or inside it.
pub(crate) fn within(ranges: &[FoldRange], outer: FoldRange) -> impl Iterator<Item = &FoldRange> {
    let at = ranges.partition_point(|range| range.start < outer.start);
    ranges[at..]
        .iter()
        .take_while(move |range| range.start <= outer.end)
        .filter(move |range| range.end <= outer.end)
}

/// The folds of a nested set (sorted) inside no other: what is hidden.
pub(crate) fn outermost(folds: &[FoldRange]) -> Vec<FoldRange> {
    let mut outer: Vec<FoldRange> = Vec::new();
    for fold in folds {
        if outer.last().is_none_or(|last| fold.start > last.end) {
            outer.push(*fold);
        }
    }
    outer
}

/// Folded ranges after lines `first..first + old_count` became
/// `first..first + new_count`, as the display map carries its own: those
/// before the span stay, those after it shift, those it touches unfold.
pub(crate) fn edited(
    folds: &[FoldRange],
    first: usize,
    old_count: usize,
    new_count: usize,
) -> Vec<FoldRange> {
    let delta = new_count as isize - old_count as isize;
    folds
        .iter()
        .filter_map(|fold| {
            if fold.end < first {
                Some(*fold)
            } else if fold.start >= first + old_count {
                Some(FoldRange {
                    start: fold.start.saturating_add_signed(delta),
                    end: fold.end.saturating_add_signed(delta),
                })
            } else {
                None
            }
        })
        .collect()
}

/// The app's range `range` after lines `first..first + old_count` became
/// `first..first + new_count`, kept on its lines until the app gives new
/// ones (as diagnostics are): a range around the span grows or shrinks
/// with it, one after it shifts, an end (or start) inside it stays, within
/// the span's new lines. None when nothing is left to hide.
pub(crate) fn carry(
    range: FoldRange,
    first: usize,
    old_count: usize,
    new_count: usize,
) -> Option<FoldRange> {
    let old_end = first + old_count;
    let delta = new_count as isize - old_count as isize;
    if range.end < first {
        return Some(range);
    }
    if range.start >= old_end {
        return Some(FoldRange {
            start: range.start.saturating_add_signed(delta),
            end: range.end.saturating_add_signed(delta),
        });
    }
    let last_new = (first + new_count).saturating_sub(1).max(first);
    let start = if range.start < first {
        range.start
    } else {
        range.start.min(last_new)
    };
    let end = if range.end >= old_end {
        range.end.saturating_add_signed(delta)
    } else {
        range.end.min(last_new)
    };
    (end > start).then_some(FoldRange { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::{buffer::Buffer, fold::fold_ranges};

    #[test]
    fn the_fold_for_a_line() {
        let ranges = fold_ranges(
            &Buffer::new("fn a() {\n    if x {\n        y();\n    }\n    z();\n}\nw"),
            4,
        );
        // On a fold's first line, the fold starting there; else the
        // innermost around the line.
        let for_line = |line| fold_for(&ranges, line).map(|range| (range.start, range.end));
        assert_eq!(for_line(1), Some((1, 2)));
        assert_eq!(for_line(2), Some((1, 2)));
        assert_eq!(for_line(4), Some((0, 4)));
        assert_eq!(for_line(6), None);
    }

    fn ranges(pairs: &[(usize, usize)]) -> Vec<FoldRange> {
        pairs
            .iter()
            .map(|&(start, end)| FoldRange { start, end })
            .collect()
    }

    fn pairs(ranges: &[FoldRange]) -> Vec<(usize, usize)> {
        ranges
            .iter()
            .map(|range| (range.start, range.end))
            .collect()
    }

    #[test]
    fn the_apps_ranges_are_normalized() {
        // Unsorted, empty, backwards, past the end, the same start twice
        // (the outer kept), and one crossing an earlier one's end.
        let given = ranges(&[(5, 7), (0, 3), (2, 2), (4, 3), (8, 40), (0, 1), (2, 5)]);
        assert_eq!(pairs(&normalize(given, 10)), vec![(0, 3), (5, 7), (8, 9)]);
        // Nested and disjoint ranges stay.
        let given = ranges(&[(1, 2), (0, 9), (4, 6), (5, 6)]);
        assert_eq!(
            pairs(&normalize(given, 10)),
            vec![(0, 9), (1, 2), (4, 6), (5, 6)]
        );
        assert!(normalize(ranges(&[(0, 3)]), 0).is_empty());
        assert!(normalize(ranges(&[(0, 3)]), 1).is_empty());
    }

    #[test]
    fn levels_and_nesting() {
        let set = ranges(&[(0, 9), (1, 2), (4, 8), (5, 6), (10, 12)]);
        assert_eq!(levels(&set), vec![1, 2, 2, 3, 1]);
        assert_eq!(
            pairs(
                &within(&set, FoldRange { start: 4, end: 8 })
                    .copied()
                    .collect::<Vec<_>>()
            ),
            vec![(4, 8), (5, 6)]
        );
        assert_eq!(pairs(&outermost(&set)), vec![(0, 9), (10, 12)]);
        assert!(levels(&[]).is_empty());
    }

    #[test]
    fn folds_after_an_edit() {
        let set = ranges(&[(0, 2), (4, 6), (9, 10)]);
        // Two lines inserted in line 5's place (one line became three).
        assert_eq!(pairs(&edited(&set, 5, 1, 3)), vec![(0, 2), (11, 12)]);
        // An edit on line 3 touches no fold.
        assert_eq!(pairs(&edited(&set, 3, 1, 1)), vec![(0, 2), (4, 6), (9, 10)]);
    }

    #[test]
    fn the_apps_ranges_follow_edits() {
        let range = FoldRange { start: 2, end: 6 };
        let carried = |first, old, new| carry(range, first, old, new).map(|r| (r.start, r.end));
        // Before and after it.
        assert_eq!(carried(8, 1, 1), Some((2, 6)));
        assert_eq!(carried(0, 1, 3), Some((4, 8)));
        // Lines added inside grow it; removed ones shrink it.
        assert_eq!(carried(4, 1, 3), Some((2, 8)));
        assert_eq!(carried(3, 3, 1), Some((2, 4)));
        // Typing on its first or last line keeps it.
        assert_eq!(carried(2, 1, 1), Some((2, 6)));
        assert_eq!(carried(6, 1, 1), Some((2, 6)));
        // Its end deleted with the lines after it: it ends in the span.
        assert_eq!(carried(5, 4, 1), Some((2, 5)));
        // Everything but its first line deleted: nothing to hide.
        assert_eq!(carried(2, 6, 1), None);
    }
}
