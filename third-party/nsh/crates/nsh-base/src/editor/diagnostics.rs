//! Diagnostics and decorations anchored to the text: the app's ranges
//! (lines and UTF-16 columns) resolved once into byte ranges, then carried
//! through every edit until the app sets new ones, so a mark stays on its
//! text while the user types and the app's linter has not answered yet.

use std::ops::Range;

use super::{
    buffer::{Bias, Buffer, Change, map_offset},
    data::{EditorDiagnostic, EditorDiagnosticSeverity, EditorPosition, EditorRange},
};

/// A diagnostic or decoration as byte ranges of the text, carried through
/// edits until the app sets new ones.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Mark<T> {
    /// What it marks (empty: the position it is at).
    pub(crate) range: Range<usize>,
    /// The app's value.
    pub(crate) item: T,
}

/// `items` as marks of `buffer`'s text, sorted by start (then end; equal
/// ranges keep the app's order). Positions past a line's end or the text's
/// end clamp; a range given backwards is turned around.
pub(crate) fn resolve<T: Clone>(
    buffer: &Buffer,
    items: &[T],
    range_of: impl Fn(&T) -> EditorRange,
) -> Vec<Mark<T>> {
    // A linter's or highlighter's marks come by line, several to a line:
    // the line last looked up is kept (the next one starts after it), and
    // on an ASCII line a column is a byte, with no lookup in the rope (four
    // per position otherwise).
    let mut line: Option<(u32, usize, usize, bool)> = None;
    let mut offset_of = |position: EditorPosition| {
        if position.line as usize >= buffer.line_count() {
            return buffer.len();
        }
        let (_, start, end, ascii) = match line {
            Some(cached) if cached.0 == position.line => cached,
            _ => {
                let at = position.line as usize;
                let start = match line {
                    Some((last, _, end, _)) if last + 1 == position.line => end + 1,
                    _ => buffer.line_start(at),
                };
                let end = buffer.line_end(at);
                let cached = (position.line, start, end, buffer.is_ascii(start..end));
                line = Some(cached);
                cached
            }
        };
        if ascii {
            (start + position.column as usize).min(end)
        } else {
            buffer.offset_of(position)
        }
    };
    let mut marks: Vec<Mark<T>> = items
        .iter()
        .map(|item| {
            let range = range_of(item);
            let start = offset_of(range.start);
            let end = offset_of(range.end);
            Mark {
                range: start.min(end)..start.max(end),
                item: item.clone(),
            }
        })
        .collect();
    // Usually sorted already, so this only checks.
    if !marks.is_sorted_by_key(|mark| (mark.range.start, mark.range.end)) {
        sort(&mut marks);
    }
    marks
}

/// `marks` carried through `changes` (an edit's, undo's or redo's). Text
/// typed at a mark's start or end stays outside it, text typed inside
/// grows it; a mark whose text was replaced entirely shrinks to an empty
/// one where the replacement starts. `reach` is at least the bytes of the
/// longest mark (`app_highlight::reach`); returns that bound for the marks
/// as they are now, which grow by what was typed into them at most.
pub(crate) fn adjust<T>(marks: &mut [Mark<T>], reach: usize, changes: &[Change]) -> usize {
    let Some(first) = changes.iter().map(|change| change.range.start).min() else {
        return reach;
    };
    // The marks ending before every change stay as they are: by start,
    // those starting more than `reach` bytes before the first one. A
    // keystroke moves only the marks after it, and those keep their order
    // unless a replacement collapsed some.
    let from = marks.partition_point(|mark| mark.range.start.saturating_add(reach) < first);
    let rest = &mut marks[from..];
    for mark in rest.iter_mut() {
        let start = map_offset(changes, mark.range.start, Bias::Right);
        let end = map_offset(changes, mark.range.end, Bias::Left);
        mark.range = if end < start {
            let at = map_offset(changes, mark.range.start, Bias::Left);
            at..at
        } else {
            start..end
        };
    }
    if !rest.is_sorted_by_key(|mark| (mark.range.start, mark.range.end)) {
        sort(rest);
    }
    let typed: usize = changes.iter().map(|change| change.new_len).sum();
    reach.saturating_add(typed)
}

/// The marks overlapping lines `lines` (for rows to draw), in order. A
/// mark ending at a line's start (after the line break before it) is not on
/// that line; an empty one is on the line it is in.
#[cfg(test)]
pub(crate) fn in_lines<'a, T>(
    marks: &'a [Mark<T>],
    buffer: &Buffer,
    lines: Range<usize>,
) -> impl Iterator<Item = &'a Mark<T>> + use<'a, T> {
    let lines = lines.start..lines.end.min(buffer.line_count());
    // An empty span matches nothing: `low` past every offset.
    let (low, high) = if lines.is_empty() {
        (usize::MAX, 0)
    } else {
        (
            buffer.line_start(lines.start),
            buffer.line_end(lines.end - 1),
        )
    };
    marks
        .iter()
        .take_while(move |mark| mark.range.start <= high)
        .filter(move |mark| {
            if mark.range.is_empty() {
                mark.range.start >= low
            } else {
                mark.range.end > low
            }
        })
}

/// The marks at `offset` (a caret or the pointer): those whose range holds
/// it, its ends included.
#[cfg(test)]
pub(crate) fn at_offset<T>(marks: &[Mark<T>], offset: usize) -> impl Iterator<Item = &Mark<T>> {
    marks
        .iter()
        .take_while(move |mark| mark.range.start <= offset)
        .filter(move |mark| offset <= mark.range.end)
}

/// The text a mark shows on: its range, or for an empty one the char after
/// it (nothing at the end of its line), so a diagnostic at a position still
/// has something to underline.
#[cfg(test)]
pub(crate) fn shown_range(buffer: &Buffer, range: Range<usize>) -> Range<usize> {
    if !range.is_empty() {
        return range;
    }
    match buffer.char_at(range.start) {
        Some(c) if c != '\n' => range.start..range.start + c.len_utf8(),
        _ => range,
    }
}

/// The most serious severity on each line in `lines` (the gutter's marks),
/// sorted by line. A diagnostic counts on the line it starts on, as a
/// gutter shows one mark per diagnostic.
pub(crate) fn line_severities(
    marks: &[Mark<EditorDiagnostic>],
    buffer: &Buffer,
    lines: Range<usize>,
) -> Vec<(usize, EditorDiagnosticSeverity)> {
    let lines = lines.start..lines.end.min(buffer.line_count());
    if lines.is_empty() {
        return Vec::new();
    }
    // The marks starting on the lines: two binary searches, as the gutter
    // asks for every row it shows.
    let low = buffer.line_start(lines.start);
    let high = buffer.line_end(lines.end - 1);
    let from = marks.partition_point(|mark| mark.range.start < low);
    let to = marks
        .partition_point(|mark| mark.range.start <= high)
        .max(from);
    let mut severities: Vec<(usize, EditorDiagnosticSeverity)> = Vec::new();
    for mark in &marks[from..to] {
        let line = buffer.line_of(mark.range.start);
        let severity = mark.item.severity;
        // Marks come by start, so a line's marks are next to each other.
        match severities.last_mut() {
            Some((last, worst)) if *last == line => {
                if rank(severity) < rank(*worst) {
                    *worst = severity;
                }
            }
            _ => severities.push((line, severity)),
        }
    }
    severities
}

/// How serious a severity is: lower is more serious.
pub(crate) fn rank(severity: EditorDiagnosticSeverity) -> u8 {
    match severity {
        EditorDiagnosticSeverity::Error => 0,
        EditorDiagnosticSeverity::Warning => 1,
        EditorDiagnosticSeverity::Info => 2,
        EditorDiagnosticSeverity::Hint => 3,
    }
}

/// By start, then end; stable, so marks of one range keep their order.
fn sort<T>(marks: &mut [Mark<T>]) {
    marks.sort_by_key(|mark| (mark.range.start, mark.range.end));
}

#[cfg(test)]
mod tests {
    use super::{
        super::{buffer::EditKind, data::EditorPosition, types::Selections},
        *,
    };

    fn range(l0: u32, c0: u32, l1: u32, c1: u32) -> EditorRange {
        EditorRange::new(EditorPosition::new(l0, c0), EditorPosition::new(l1, c1))
    }

    fn diagnostic(range: EditorRange, severity: EditorDiagnosticSeverity) -> EditorDiagnostic {
        EditorDiagnostic {
            range,
            severity,
            ..Default::default()
        }
    }

    fn marks_of(buffer: &Buffer, ranges: &[EditorRange]) -> Vec<Mark<EditorRange>> {
        resolve(buffer, ranges, |r| *r)
    }

    fn adjust_marks<T>(marks: &mut [Mark<T>], changes: &[Change]) {
        let reach = super::super::app_highlight::reach(marks);
        adjust(marks, reach, changes);
    }

    fn ranges<T>(marks: &[Mark<T>]) -> Vec<Range<usize>> {
        marks.iter().map(|m| m.range.clone()).collect()
    }

    fn edit(buffer: &mut Buffer, edits: Vec<(Range<usize>, &str)>) -> Vec<Change> {
        let selections = Selections::default();
        let edits = edits.into_iter().map(|(r, s)| (r, s.to_owned())).collect();
        buffer.edit(edits, &selections, &selections, EditKind::Other)
    }

    #[test]
    fn resolve_converts_utf16_and_sorts() {
        // "😀" is 2 UTF-16 units and 4 bytes, "é" 1 and 2.
        let buffer = Buffer::new("😀é x\r\nsecond");
        let marks = marks_of(
            &buffer,
            &[
                range(1, 0, 1, 6),
                range(0, 2, 0, 3),
                range(0, 5, 0, 4),
                range(5, 0, 9, 9),
            ],
        );
        assert_eq!(ranges(&marks), vec![4..6, 7..8, 9..15, 15..15]);
        assert!(
            marks_of(&Buffer::new(""), &[range(0, 0, 0, 3)])[0]
                .range
                .is_empty()
        );
    }

    #[test]
    fn edits_carry_marks() {
        let mut buffer = Buffer::new("let value = 1;");
        let mut marks = marks_of(&buffer, &[range(0, 4, 0, 9), range(0, 12, 0, 12)]);
        assert_eq!(ranges(&marks), vec![4..9, 12..12]);
        // Typed before: both shift.
        let changes = edit(&mut buffer, vec![(0..0, "pub ")]);
        adjust_marks(&mut marks, &changes);
        assert_eq!(ranges(&marks), vec![8..13, 16..16]);
        // Typed at the end: stays out; typed inside: grows.
        let changes = edit(&mut buffer, vec![(10..10, "LU"), (13..13, "s")]);
        adjust_marks(&mut marks, &changes);
        assert_eq!(ranges(&marks), vec![8..15, 19..19]);
        assert_eq!(buffer.slice(8..15), "vaLUlue");
        // Replaced entirely: empty where the replacement starts.
        let changes = edit(&mut buffer, vec![(7..16, " x")]);
        adjust_marks(&mut marks, &changes);
        assert_eq!(buffer.text(), "pub let x = 1;");
        assert_eq!(ranges(&marks), vec![7..7, 12..12]);
    }

    #[test]
    fn resolve_line_by_line() {
        // Marks by line, as a linter gives them: ASCII lines take columns
        // as bytes, the others convert.
        let buffer = Buffer::new("ab\né x\n\ncd");
        let marks = marks_of(
            &buffer,
            &[
                range(0, 1, 0, 9),
                range(1, 1, 1, 3),
                range(1, 2, 1, 2),
                range(2, 0, 2, 4),
                range(3, 1, 3, 2),
                range(3, 0, 4, 0),
            ],
        );
        assert_eq!(ranges(&marks), vec![1..2, 5..7, 6..6, 8..8, 9..11, 10..11]);
    }

    #[test]
    fn edits_leave_the_marks_before_them() {
        // A long mark starting first still reaches the edit; the short ones
        // between end before it.
        let mut buffer = Buffer::new("aaaa bbbb cccc dddd");
        let mut marks = marks_of(
            &buffer,
            &[
                range(0, 0, 0, 14),
                range(0, 0, 0, 4),
                range(0, 5, 0, 9),
                range(0, 15, 0, 19),
            ],
        );
        let reach = super::super::app_highlight::reach(&marks);
        let changes = edit(&mut buffer, vec![(12..12, "XY")]);
        let reach = adjust(&mut marks, reach, &changes);
        assert_eq!(ranges(&marks), vec![0..4, 0..16, 5..9, 17..21]);
        assert_eq!(reach, 16);
        // Typed before every mark: all move, in order.
        let changes = edit(&mut buffer, vec![(0..0, "_")]);
        adjust(&mut marks, reach, &changes);
        assert_eq!(ranges(&marks), vec![1..5, 1..17, 6..10, 18..22]);
    }

    #[test]
    fn empty_marks_stay_before_typing() {
        let mut buffer = Buffer::new("ab");
        let mut marks = marks_of(&buffer, &[range(0, 1, 0, 1)]);
        let changes = edit(&mut buffer, vec![(1..1, "中")]);
        adjust_marks(&mut marks, &changes);
        assert_eq!(ranges(&marks), vec![1..1]);
        adjust_marks(&mut marks, &[]);
        assert_eq!(ranges(&marks), vec![1..1]);
    }

    #[test]
    fn undo_carries_marks_back() {
        let mut buffer = Buffer::new("a\nb\nc");
        let mut marks = marks_of(&buffer, &[range(2, 0, 2, 1)]);
        let changes = edit(&mut buffer, vec![(0..4, "")]);
        adjust_marks(&mut marks, &changes);
        assert_eq!(ranges(&marks), vec![0..1]);
        let (changes, _) = buffer.undo().unwrap();
        adjust_marks(&mut marks, &changes);
        assert_eq!(ranges(&marks), vec![4..5]);
        assert_eq!(buffer.slice(4..5), "c");
    }

    #[test]
    fn marks_in_lines() {
        // Lines: "abc" 0..3, "def" 4..7, "" 8..8, "gh" 9..11.
        let buffer = Buffer::new("abc\ndef\n\ngh");
        let marks = marks_of(
            &buffer,
            &[
                range(0, 0, 1, 0), // 0..4: ends at line 1's start
                range(0, 1, 1, 1), // 1..5: runs into line 1
                range(1, 3, 1, 3), // 7..7: at line 1's end
                range(2, 0, 2, 0), // 8..8: the empty line
                range(3, 1, 3, 2), // 10..11
            ],
        );
        let on = |lines: Range<usize>| {
            ranges(
                &in_lines(&marks, &buffer, lines)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(on(0..1), vec![0..4, 1..5]);
        assert_eq!(on(1..2), vec![1..5, 7..7]);
        assert_eq!(on(2..3), vec![8..8]);
        assert_eq!(on(3..10), vec![10..11]);
        assert_eq!(on(0..0), Vec::<Range<usize>>::new());
        assert_eq!(on(7..9), Vec::<Range<usize>>::new());
        assert_eq!(
            at_offset(&marks, 4)
                .map(|m| m.range.clone())
                .collect::<Vec<_>>(),
            vec![0..4, 1..5]
        );
    }

    #[test]
    fn shown_ranges() {
        let buffer = Buffer::new("a中\n");
        assert_eq!(shown_range(&buffer, 1..1), 1..4);
        assert_eq!(shown_range(&buffer, 4..4), 4..4);
        assert_eq!(shown_range(&buffer, 5..5), 5..5);
        assert_eq!(shown_range(&buffer, 0..2), 0..2);
    }

    #[test]
    fn severities_per_line() {
        use EditorDiagnosticSeverity::*;
        let buffer = Buffer::new("one\ntwo\nthree\nfour");
        let items = vec![
            diagnostic(range(0, 0, 0, 1), Hint),
            diagnostic(range(0, 2, 0, 3), Warning),
            diagnostic(range(1, 0, 2, 2), Info),
            diagnostic(range(1, 1, 1, 2), Error),
            diagnostic(range(3, 0, 3, 0), Hint),
        ];
        let marks = resolve(&buffer, &items, |d| d.range);
        assert_eq!(
            line_severities(&marks, &buffer, 0..4),
            vec![(0, Warning), (1, Error), (3, Hint)]
        );
        // A diagnostic counts on its first line only.
        assert_eq!(line_severities(&marks, &buffer, 2..3), vec![]);
        assert_eq!(line_severities(&marks, &buffer, 1..2), vec![(1, Error)]);
    }
}
