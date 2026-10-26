//! Where the text can fold: by indentation, as VS Code's indentation-based
//! folding. A line followed by lines indented deeper starts a fold that
//! hides them; blank lines inside join it, those after its last line stay
//! out, and the line that ends the block at the start line's indentation
//! (a closing bracket, `end`, `else:`) stays visible.

use super::buffer::Buffer;

/// A range of lines that can fold: line `start` stays visible (it shows the
/// fold), lines `start + 1..=end` hide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FoldRange {
    /// The line that shows the fold.
    pub(crate) start: usize,
    /// The last line it hides (after `start`).
    pub(crate) end: usize,
}

impl FoldRange {
    /// Whether folded it hides `line`.
    #[cfg(test)]
    pub(crate) fn hides(&self, line: usize) -> bool {
        self.start < line && line <= self.end
    }

    /// Whether `line` is one of its lines, the visible first one included.
    #[cfg(test)]
    pub(crate) fn contains(&self, line: usize) -> bool {
        self.start <= line && line <= self.end
    }
}

/// Where folds can start: sorted by `start`, then outer folds before inner
/// ones; nested folds are inside one another, never overlapping otherwise.
/// `tab_size` is the columns a tab advances to (its next stop).
pub(crate) fn fold_ranges(buffer: &Buffer, tab_size: u32) -> Vec<FoldRange> {
    let tab_size = tab_size.max(1) as usize;
    let mut ranges = Vec::new();
    // The lines whose blocks are open, their indentation growing.
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut last_non_blank = None;
    for (line, indent) in indentations(buffer, tab_size).into_iter().enumerate() {
        let Some(indent) = indent else {
            continue;
        };
        while let Some(&(start, depth)) = open.last() {
            if depth < indent {
                break;
            }
            open.pop();
            push(&mut ranges, start, last_non_blank);
        }
        open.push((line, indent));
        last_non_blank = Some(line);
    }
    while let Some((start, _)) = open.pop() {
        push(&mut ranges, start, last_non_blank);
    }
    ranges.sort_by_key(|range| (range.start, std::cmp::Reverse(range.end)));
    ranges
}

/// The innermost fold of `ranges` (as [`fold_ranges`] sorts them) that
/// `line` is on, its first line included: what folding at a caret folds.
#[cfg(test)]
pub(crate) fn fold_at(ranges: &[FoldRange], line: usize) -> Option<FoldRange> {
    // Sorted by start, an inner fold comes after its outer ones: the last
    // one containing the line is the innermost.
    let candidates = &ranges[..ranges.partition_point(|range| range.start <= line)];
    candidates
        .iter()
        .rev()
        .find(|range| range.contains(line))
        .copied()
}

/// A fold from `start` to the last non-blank line of its block, when it
/// hides anything.
fn push(ranges: &mut Vec<FoldRange>, start: usize, end: Option<usize>) {
    if let Some(end) = end
        && end > start
    {
        ranges.push(FoldRange { start, end });
    }
}

/// The columns of each line's leading whitespace (a tab to its next
/// stop), None for a blank line: one pass over the text's chunks, which
/// reads each line's indentation and skips to its line break (a line at a
/// time through the rope would cost a lookup per line).
fn indentations(buffer: &Buffer, tab_size: usize) -> Vec<Option<usize>> {
    let mut out = Vec::with_capacity(buffer.line_count());
    // The line's columns so far; None once its text began (the rest of
    // the line is skipped).
    let mut columns = Some(0);
    let mut indent = None;
    for chunk in buffer.rope().chunks() {
        let mut i = 0;
        while i < chunk.len() {
            match columns {
                Some(c) => {
                    let Some(ch) = chunk[i..].chars().next() else {
                        break;
                    };
                    match ch {
                        '\n' => {
                            out.push(None);
                            columns = Some(0);
                        }
                        '\t' => columns = Some((c / tab_size + 1) * tab_size),
                        ch if ch.is_whitespace() => columns = Some(c + 1),
                        _ => {
                            indent = Some(c);
                            columns = None;
                        }
                    }
                    i += ch.len_utf8();
                }
                None => match chunk[i..].find('\n') {
                    Some(k) => {
                        out.push(indent.take());
                        columns = Some(0);
                        i += k + 1;
                    }
                    None => i = chunk.len(),
                },
            }
        }
    }
    // The last line, which has no line break.
    out.push(if columns.is_none() { indent } else { None });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folds(text: &str) -> Vec<(usize, usize)> {
        fold_ranges(&Buffer::new(text), 4)
            .into_iter()
            .map(|range| (range.start, range.end))
            .collect()
    }

    #[test]
    fn nothing_to_fold() {
        assert!(folds("").is_empty());
        assert!(folds("one line").is_empty());
        assert!(folds("a\nb\nc\n").is_empty());
        assert!(folds("fn a() {\n}\n").is_empty());
        assert!(folds("   \n\t\n").is_empty());
    }

    #[test]
    fn closing_lines_stay_visible() {
        let text = "fn main() {\n    let a = 1;\n    if a {\n        b();\n    }\n}\n";
        assert_eq!(folds(text), vec![(0, 4), (2, 3)]);
    }

    #[test]
    fn blank_lines_join_and_trailing_ones_stay_out() {
        let text = "def f():\n    a\n\n    b\n\n\nx = 1";
        assert_eq!(folds(text), vec![(0, 3)]);
        // A block running to the end of the text, without a last line break.
        assert_eq!(
            folds("class A:\n  def f(self):\n    pass"),
            vec![(0, 2), (1, 2)]
        );
        assert_eq!(folds("a:\n  b\n  \n"), vec![(0, 1)]);
    }

    #[test]
    fn tabs_advance_to_stops() {
        // A tab is 4 columns: deeper than 2 spaces, as deep as 4.
        assert_eq!(folds("a\n  b\n\tc\n"), vec![(0, 2), (1, 2)]);
        assert_eq!(folds("a\n    b\n\tc\nd"), vec![(0, 2)]);
        // "  \t" reaches the same stop as "\t".
        assert_eq!(folds("a\n\tb\n  \tc"), vec![(0, 2)]);
        assert_eq!(fold_ranges(&Buffer::new("a\n\tb"), 0).len(), 1);
    }

    #[test]
    fn crlf_and_multibyte_lines() {
        assert_eq!(folds("项目:\r\n  名字 👋🏽\r\n  值\r\n结束"), vec![(0, 2)]);
        // A full-width space indents like any other whitespace.
        assert_eq!(folds("a\n\u{3000}b"), vec![(0, 1)]);
    }

    #[test]
    fn outdented_blocks_close_every_deeper_one() {
        let text = "a\n  b\n    c\n      d\ne\n  f";
        assert_eq!(folds(text), vec![(0, 3), (1, 3), (2, 3), (4, 5)]);
    }

    #[test]
    fn the_fold_at_a_line() {
        let ranges = fold_ranges(
            &Buffer::new("fn a() {\n    if x {\n        y();\n    }\n    z();\n}\nw"),
            4,
        );
        let at = |line| fold_at(&ranges, line).map(|range| (range.start, range.end));
        assert_eq!(at(0), Some((0, 4)));
        assert_eq!(at(1), Some((1, 2)));
        assert_eq!(at(2), Some((1, 2)));
        assert_eq!(at(3), Some((0, 4)));
        assert_eq!(at(5), None);
        assert_eq!(at(6), None);
        let range = FoldRange { start: 1, end: 2 };
        assert!(!range.hides(1) && range.hides(2) && !range.hides(3));
    }
}
