//! Where a diff's rows are: each row's height (its wrapped lines, the
//! taller side's in a split row, and the annotations under it), their tops
//! for placing and finding rows, and how a long line wraps at a column
//! count (the font is monospaced: a character is a column).

use std::ops::Range;

use nsh_core::prelude::*;

use super::controller::Span;

/// The rows' tops and their texts' heights.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Geometry {
    /// The top of every row, then the bottom of the last (`rows + 1`).
    tops: Vec<Points>,
    /// The height of each row's lines: its annotations start below them.
    text: Vec<Points>,
}

impl Geometry {
    /// Rows of `lines[i]` wrapped lines (at least one) of `line_height`,
    /// and `extra[i]` below them (annotations; missing is none).
    pub(crate) fn new(lines: &[u32], extra: &[Points], line_height: Points) -> Geometry {
        let mut tops = Vec::with_capacity(lines.len() + 1);
        let mut text = Vec::with_capacity(lines.len());
        let mut y = Points::ZERO;
        for (row, count) in lines.iter().enumerate() {
            tops.push(y);
            let height = line_height * (*count).max(1) as f32;
            text.push(height);
            y += height + extra.get(row).copied().unwrap_or(Points::ZERO);
        }
        tops.push(y);
        Geometry { tops, text }
    }

    /// How many rows there are.
    pub(crate) fn rows(&self) -> usize {
        self.text.len()
    }

    /// The top of row `row` (the bottom of the last past the end).
    pub(crate) fn top(&self, row: usize) -> Points {
        let last = self.tops.len().saturating_sub(1);
        self.tops
            .get(row.min(last))
            .copied()
            .unwrap_or(Points::ZERO)
    }

    /// The height of row `row`'s lines.
    pub(crate) fn text_height(&self, row: usize) -> Points {
        self.text.get(row).copied().unwrap_or(Points::ZERO)
    }

    /// The height of every row.
    pub(crate) fn height(&self) -> Points {
        self.tops.last().copied().unwrap_or(Points::ZERO)
    }

    /// The row at `y` (the first above 0, the last below the end); 0 when
    /// there are none.
    pub(crate) fn row_at(&self, y: Points) -> usize {
        if self.text.is_empty() {
            return 0;
        }
        // The first top past `y`, less one.
        let after = self.tops[..self.text.len()].partition_point(|top| *top <= y);
        after.saturating_sub(1).min(self.text.len() - 1)
    }

    /// The rows between `y` and `y + height`, `overscan` more each way.
    pub(crate) fn range(&self, y: Points, height: Points, overscan: usize) -> Range<usize> {
        if self.text.is_empty() {
            return 0..0;
        }
        let first = self.row_at(y).saturating_sub(overscan);
        let last = (self.row_at(y + height) + 1 + overscan).min(self.text.len());
        first.min(last)..last
    }
}

/// Where each wrapped line of `text` (tabs expanded) starts, in bytes, at
/// `columns` a line: after the last whitespace that fits, else at the
/// edge; whitespace past the edge hangs there rather than starting a line.
/// The first is 0.
pub(crate) fn wrap_starts(text: &str, columns: usize) -> Vec<usize> {
    let columns = columns.max(1);
    let mut starts = vec![0];
    let mut count = 0;
    // Just after the last whitespace of the current line.
    let mut break_at: Option<usize> = None;
    for (at, c) in text.char_indices() {
        let blank = c.is_whitespace();
        if count >= columns && !blank {
            let line_start = *starts.last().unwrap_or(&0);
            let start = match break_at {
                Some(b) if b > line_start => b,
                _ => at,
            };
            starts.push(start);
            count = text[start..at].chars().count();
            break_at = None;
        }
        count += 1;
        if blank {
            break_at = Some(at + c.len_utf8());
        }
    }
    starts
}

/// How many lines `text` (tabs expanded) wraps into at `columns`.
pub(crate) fn wrapped_lines(text: &str, columns: usize) -> usize {
    // Most lines fit: a byte is at least a character.
    if text.len() <= columns {
        return 1;
    }
    wrap_starts(text, columns).len()
}

/// `spans` cut into the wrapped lines that start at `starts` (byte offsets
/// into their joined text, as [`wrap_starts`] gives them).
pub(crate) fn wrap_spans(spans: Vec<Span>, starts: &[usize]) -> Vec<Vec<Span>> {
    let mut lines: Vec<Vec<Span>> = vec![Vec::new(); starts.len().max(1)];
    let mut at = 0;
    for span in spans {
        let end = at + span.text.len();
        let mut from = at;
        while from < end {
            // The line `from` is on, and where the next one starts.
            let line = starts.partition_point(|s| *s <= from).saturating_sub(1);
            let to = starts.get(line + 1).copied().unwrap_or(usize::MAX).min(end);
            lines[line].push(Span {
                text: span.text[from - at..to - at].to_string(),
                token: span.token,
                changed: span.changed,
            });
            from = to;
        }
        at = end;
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(text: &str, columns: usize) -> Vec<&str> {
        let starts = wrap_starts(text, columns);
        starts
            .iter()
            .enumerate()
            .map(|(i, s)| &text[*s..starts.get(i + 1).copied().unwrap_or(text.len())])
            .collect()
    }

    #[test]
    fn wraps_after_whitespace() {
        assert_eq!(pieces("aaaa bbbb", 5), vec!["aaaa ", "bbbb"]);
        assert_eq!(pieces("ab cdefg", 4), vec!["ab ", "cdef", "g"]);
        assert_eq!(wrapped_lines("aaaa bbbb", 5), 2);
    }

    #[test]
    fn breaks_long_words_at_the_edge() {
        assert_eq!(pieces("abcdefgh", 3), vec!["abc", "def", "gh"]);
        assert_eq!(pieces("abcdef", 3), vec!["abc", "def"]);
    }

    #[test]
    fn whitespace_hangs_past_the_edge() {
        assert_eq!(pieces("abc   ", 3), vec!["abc   "]);
        assert_eq!(pieces("abc   def", 3), vec!["abc   ", "def"]);
        assert_eq!(wrapped_lines("", 3), 1);
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert_eq!(pieces("ééé", 3), vec!["ééé"]);
        assert_eq!(pieces("éééé", 3), vec!["ééé", "é"]);
        assert_eq!(wrapped_lines("éééé", 3), 2);
        // Zero columns wrap at every character rather than looping.
        assert_eq!(wrapped_lines("ab", 0), 2);
    }

    #[test]
    fn spans_follow_the_wrapped_lines() {
        let span = |text: &str, changed| Span {
            text: text.into(),
            token: None,
            changed,
        };
        let spans = vec![span("ab", false), span("cd e", true), span("f", false)];
        // "abcd ef" at 5: "abcd ", "ef".
        let starts = wrap_starts("abcd ef", 5);
        assert_eq!(starts, vec![0, 5]);
        let lines = wrap_spans(spans, &starts);
        let texts: Vec<Vec<(&str, bool)>> = lines
            .iter()
            .map(|l| l.iter().map(|s| (s.text.as_str(), s.changed)).collect())
            .collect();
        assert_eq!(
            texts,
            vec![
                vec![("ab", false), ("cd ", true)],
                vec![("e", true), ("f", false)]
            ]
        );
    }

    #[test]
    fn rows_of_several_lines_and_annotations() {
        let lh = px(20.0);
        let g = Geometry::new(&[1, 3, 0, 1], &[Points::ZERO, px(50.0)], lh);
        assert_eq!(g.rows(), 4);
        assert_eq!(g.top(0), px(0.0));
        assert_eq!(g.top(1), px(20.0));
        assert_eq!(g.text_height(1), px(60.0));
        // Row 1: three lines and an annotation of 50.
        assert_eq!(g.top(2), px(130.0));
        // A count of 0 is one line.
        assert_eq!(g.top(3), px(150.0));
        assert_eq!(g.height(), px(170.0));
        assert_eq!(g.top(99), px(170.0));
        assert_eq!(g.row_at(px(-5.0)), 0);
        assert_eq!(g.row_at(px(19.9)), 0);
        assert_eq!(g.row_at(px(20.0)), 1);
        assert_eq!(g.row_at(px(129.0)), 1);
        assert_eq!(g.row_at(px(1000.0)), 3);
        assert_eq!(g.range(px(25.0), px(10.0), 0), 1..2);
        assert_eq!(g.range(px(25.0), px(200.0), 1), 0..4);
    }

    #[test]
    fn no_rows() {
        let g = Geometry::new(&[], &[], px(20.0));
        assert_eq!(g.rows(), 0);
        assert_eq!(g.height(), Points::ZERO);
        assert_eq!(g.row_at(px(10.0)), 0);
        assert_eq!(g.range(Points::ZERO, px(100.0), 8), 0..0);
    }
}
