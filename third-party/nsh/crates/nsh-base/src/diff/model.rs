//! The line diff of two texts: its hunks, the pairs of changed lines that
//! are alike (for highlighting the words changed within them), those words,
//! and reverting or accepting one hunk.
//!
//! A text's lines are split after each `\n`, which stays part of its line
//! for the diff: "a\nb\n" and "a\nb" both have two lines, and their last
//! lines differ (a missing final line break is a change, as git shows it).
//! A `\r` before the `\n` is content: the diff compares texts as they are.

use std::ops::Range;

use imara_diff::{Algorithm, Diff, InternedInput};
use rustc_hash::FxHashMap;
use unicode_segmentation::UnicodeSegmentation;

/// One hunk: lines `old.start..old.end` of the old text became `new.start..new.end` of the new one (either may be
/// empty: a pure insertion or deletion).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hunk {
    /// The old text's lines the hunk replaces.
    pub(crate) old: Range<usize>,
    /// The new text's lines in their place.
    pub(crate) new: Range<usize>,
}

/// A changed line paired with the line of the other side most like it (for highlighting words), or alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pair {
    /// The old (deleted) line.
    pub(crate) old: Option<usize>,
    /// The new (added) line.
    pub(crate) new: Option<usize>,
}

/// What [`DiffModel::inline`] marks within a pair of changed lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum InlineMode {
    /// Words, joining changed words one character apart into one range.
    #[default]
    WordAlt,
    /// Each changed word.
    Word,
    /// Each changed character (grapheme).
    Char,
    /// Nothing.
    None,
}

/// Hunks with more lines than this on a side pair their lines in order:
/// the similarity alignment is quadratic.
const PAIR_CAP: usize = 64;
/// Lines less alike than this are not paired by similarity.
const SIMILAR: f32 = 0.4;
/// When more than this fraction of a line changed, its line tint says enough.
const MOSTLY_CHANGED: f32 = 0.7;
/// Lines longer than this (bytes) get no inline ranges: diffing their
/// characters would cost more than the highlight is worth.
const INLINE_MAX_LEN: usize = 10_000;

/// The line diff of an old and a new text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DiffModel {
    /// How many lines the old text has.
    pub(crate) old_lines: usize,
    /// How many lines the new text has.
    pub(crate) new_lines: usize,
    /// The changes, in order (neither their old nor their new ranges overlap
    /// or touch: equal lines separate them).
    pub(crate) hunks: Vec<Hunk>,
    /// Whether the old text ends with a line break (false when it is empty).
    pub(crate) old_final_newline: bool,
    /// Whether the new text ends with a line break (false when it is empty).
    pub(crate) new_final_newline: bool,
    old_starts: Vec<usize>,
    new_starts: Vec<usize>,
}

impl DiffModel {
    /// Diffs `old` and `new` by lines (histogram, then git's indent heuristic).
    pub(crate) fn compute(old: &str, new: &str) -> DiffModel {
        let input = InternedInput::new(old, new);
        let mut diff = Diff::compute(Algorithm::Histogram, &input);
        diff.postprocess_lines(&input);
        let hunks = diff
            .hunks()
            .map(|hunk| Hunk {
                old: hunk.before.start as usize..hunk.before.end as usize,
                new: hunk.after.start as usize..hunk.after.end as usize,
            })
            .collect();
        let old_starts = line_starts(old);
        let new_starts = line_starts(new);
        debug_assert_eq!(old_starts.len(), input.before.len());
        debug_assert_eq!(new_starts.len(), input.after.len());
        DiffModel {
            old_lines: old_starts.len(),
            new_lines: new_starts.len(),
            hunks,
            old_final_newline: old.ends_with('\n'),
            new_final_newline: new.ends_with('\n'),
            old_starts,
            new_starts,
        }
    }

    /// Line `line` of `old` (the text this model was computed from), without its line break; "" past the end.
    pub(crate) fn old_line<'a>(&self, old: &'a str, line: usize) -> &'a str {
        line_in(old, &self.old_starts, line)
    }

    /// Line `line` of `new` (the text this model was computed from), without its line break; "" past the end.
    pub(crate) fn new_line<'a>(&self, new: &'a str, line: usize) -> &'a str {
        line_in(new, &self.new_starts, line)
    }

    /// The byte range of old line `line` without its line break (the end of the text past the last line).
    #[cfg(test)]
    pub(crate) fn old_line_range(&self, old: &str, line: usize) -> Range<usize> {
        range_in(old, &self.old_starts, line)
    }

    /// The byte range of new line `line` without its line break (the end of the text past the last line).
    #[cfg(test)]
    pub(crate) fn new_line_range(&self, new: &str, line: usize) -> Range<usize> {
        range_in(new, &self.new_starts, line)
    }

    /// The pairs of hunk `index`'s lines, in display order. Lines are paired by similarity (each old line with the
    /// new line most like it, in order, as long as they are alike enough); the lines left between two such pairs
    /// (or before the first, after the last) are paired in order as far as both sides have lines, as split views
    /// show them side by side, and the rest are alone: the old ones first, then the new ones. Hunks of more than 64
    /// lines on a side pair all their lines in order.
    pub(crate) fn pairs(&self, index: usize, old: &str, new: &str) -> Vec<Pair> {
        let Some(hunk) = self.hunks.get(index) else {
            return Vec::new();
        };
        let a: Vec<&str> = hunk
            .old
            .clone()
            .map(|line| self.old_line(old, line))
            .collect();
        let b: Vec<&str> = hunk
            .new
            .clone()
            .map(|line| self.new_line(new, line))
            .collect();
        let anchors = align(&a, &b);
        let mut out = Vec::with_capacity(a.len().max(b.len()));
        let (mut i, mut j) = (0, 0);
        let ends = anchors
            .iter()
            .map(|&(x, y)| (x, y, true))
            .chain([(a.len(), b.len(), false)]);
        for (x, y, anchor) in ends {
            let both = (x - i).min(y - j);
            for k in 0..both {
                out.push(Pair {
                    old: Some(hunk.old.start + i + k),
                    new: Some(hunk.new.start + j + k),
                });
            }
            for k in i + both..x {
                out.push(Pair {
                    old: Some(hunk.old.start + k),
                    new: None,
                });
            }
            for k in j + both..y {
                out.push(Pair {
                    old: None,
                    new: Some(hunk.new.start + k),
                });
            }
            if anchor {
                out.push(Pair {
                    old: Some(hunk.old.start + x),
                    new: Some(hunk.new.start + y),
                });
            }
            (i, j) = (x + 1, y + 1);
        }
        out
    }

    /// The changed byte ranges within a paired old line and new line (each relative to its line, without '\n'), by
    /// `mode`: words (letter / digit / `_` runs, whitespace runs, any other grapheme alone; CJK ideographs, kana
    /// and hangul are words of one grapheme each), `WordAlt` joining changed words one character apart (a separator
    /// between two changed words) so a phrase reads as one change, `Char` by graphemes, `None` nothing. When nearly
    /// everything changed (over 70 % of either line), returns no ranges: the line tint is enough.
    pub(crate) fn inline(
        old_line: &str,
        new_line: &str,
        mode: InlineMode,
    ) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
        let none = (Vec::new(), Vec::new());
        if mode == InlineMode::None
            || old_line == new_line
            || old_line.is_empty()
            || new_line.is_empty()
            || old_line.len() > INLINE_MAX_LEN
            || new_line.len() > INLINE_MAX_LEN
        {
            return none;
        }
        let tokens = |line: &str| match mode {
            InlineMode::Char => grapheme_tokens(line),
            _ => word_tokens(line),
        };
        let (ta, tb) = (tokens(old_line), tokens(new_line));
        let mut input = InternedInput::default();
        input.update_before(ta.iter().map(|range| &old_line[range.clone()]));
        input.update_after(tb.iter().map(|range| &new_line[range.clone()]));
        // Myers: tokens within a line repeat too often for the histogram,
        // which would fall back to it anyway.
        let mut diff = Diff::compute(Algorithm::Myers, &input);
        diff.postprocess_no_heuristic(&input);
        let (mut ra, mut rb) = (Vec::new(), Vec::new());
        for hunk in diff.hunks() {
            let (before, after) = (
                hunk.before.start as usize..hunk.before.end as usize,
                hunk.after.start as usize..hunk.after.end as usize,
            );
            if !before.is_empty() {
                ra.push(ta[before.start].start..ta[before.end - 1].end);
            }
            if !after.is_empty() {
                rb.push(tb[after.start].start..tb[after.end - 1].end);
            }
        }
        if mode == InlineMode::WordAlt {
            ra = join_close(ra, old_line);
            rb = join_close(rb, new_line);
        }
        let mostly = |ranges: &[Range<usize>], line: &str| {
            ranges.iter().map(|range| range.len()).sum::<usize>() as f32
                > MOSTLY_CHANGED * line.len() as f32
        };
        if mostly(&ra, old_line) || mostly(&rb, new_line) {
            return none;
        }
        (ra, rb)
    }

    /// A model of `old` and `new` whose hunks are given, not computed: the
    /// hunks of several files' models, moved to where each file's lines
    /// start in the joined texts (`files::join`).
    pub(crate) fn joined(old: &str, new: &str, hunks: Vec<Hunk>) -> DiffModel {
        let old_starts = line_starts(old);
        let new_starts = line_starts(new);
        DiffModel {
            old_lines: old_starts.len(),
            new_lines: new_starts.len(),
            hunks,
            old_final_newline: old.ends_with('\n'),
            new_final_newline: new.ends_with('\n'),
            old_starts,
            new_starts,
        }
    }

    /// Lines added and deleted.
    pub(crate) fn stats(&self) -> (usize, usize) {
        self.hunks.iter().fold((0, 0), |(added, deleted), hunk| {
            (added + hunk.new.len(), deleted + hunk.old.len())
        })
    }

    /// The hunk containing new line `line` (or a deletion at it), or the last one before it (navigation).
    #[cfg(test)]
    pub(crate) fn hunk_at_new(&self, line: usize) -> Option<usize> {
        // Hunks never touch, so the last starting at or before the line
        // holds it if any does.
        self.hunks
            .partition_point(|hunk| hunk.new.start <= line)
            .checked_sub(1)
    }

    /// The hunk containing old line `line` (or an insertion at it), or the last one before it.
    #[cfg(test)]
    pub(crate) fn hunk_at_old(&self, line: usize) -> Option<usize> {
        self.hunks
            .partition_point(|hunk| hunk.old.start <= line)
            .checked_sub(1)
    }
}

/// The new `new`: the new text with hunk `hunk`'s new lines replaced by its old lines, the rest of `new` kept.
/// Line breaks are kept exactly, a missing final one included.
pub(crate) fn revert_hunk(old: &str, new: &str, hunk: &Hunk) -> String {
    splice(new, hunk.new.clone(), old, hunk.old.clone())
}

/// The new `old`: the old text with hunk `hunk`'s old lines replaced by its new lines, the rest of `old` kept.
/// Line breaks are kept exactly, a missing final one included.
pub(crate) fn accept_hunk(old: &str, new: &str, hunk: &Hunk) -> String {
    splice(old, hunk.old.clone(), new, hunk.new.clone())
}

/// Byte range of line `line` in `text` without its '\n' (the end of the text past the last line).
#[cfg(test)]
pub(crate) fn line_range(text: &str, line: usize) -> Range<usize> {
    let mut start = 0;
    for _ in 0..line {
        match text[start..].find('\n') {
            Some(at) => start += at + 1,
            None => return text.len()..text.len(),
        }
    }
    if start == text.len() && line > 0 {
        // Past a final line break: no line there.
        return start..start;
    }
    let end = text[start..].find('\n').map_or(text.len(), |at| start + at);
    start..end
}

/// The start offset of every line (a line index, built once per text): one per line, none for an empty text, none
/// after a final line break.
pub(crate) fn line_starts(text: &str) -> Vec<usize> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut starts = vec![0];
    starts.extend(
        text.match_indices('\n')
            .map(|(at, _)| at + 1)
            .filter(|&start| start < text.len()),
    );
    starts
}

/// How many lines `text` has for the diff.
#[cfg(test)]
pub(crate) fn line_count(text: &str) -> usize {
    text.bytes().filter(|&byte| byte == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

/// The byte range of lines `lines`, their line breaks included, by the index `starts` of `text`.
pub(crate) fn lines_span(text: &str, starts: &[usize], lines: Range<usize>) -> Range<usize> {
    let at = |line: usize| starts.get(line).copied().unwrap_or(text.len());
    let start = at(lines.start);
    start..at(lines.end).max(start)
}

fn line_in<'a>(text: &'a str, starts: &[usize], line: usize) -> &'a str {
    text.get(range_in(text, starts, line)).unwrap_or("")
}

fn range_in(text: &str, starts: &[usize], line: usize) -> Range<usize> {
    let span = lines_span(text, starts, line..line + 1);
    let end = if text[..span.end].ends_with('\n') && span.end > span.start {
        span.end - 1
    } else {
        span.end
    };
    span.start..end
}

/// `into` with its lines `lines` replaced by `from`'s lines `from_lines`.
fn splice(into: &str, lines: Range<usize>, from: &str, from_lines: Range<usize>) -> String {
    let span = lines_span(into, &line_starts(into), lines);
    let from_span = lines_span(from, &line_starts(from), from_lines);
    let mut out = String::with_capacity(into.len() - span.len() + from_span.len());
    out.push_str(&into[..span.start]);
    out.push_str(&from[from_span]);
    out.push_str(&into[span.end..]);
    out
}

/// The pairs `(old, new)` of lines alike enough, increasing on both sides, of
/// the most total similarity (a weighted longest common subsequence).
fn align(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 || n > PAIR_CAP || m > PAIR_CAP {
        return Vec::new();
    }
    let ta: Vec<Vec<&str>> = a.iter().map(|line| content_tokens(line)).collect();
    let tb: Vec<Vec<&str>> = b.iter().map(|line| content_tokens(line)).collect();
    let width = m + 1;
    let mut score = vec![0.0_f32; (n + 1) * width];
    // 0: paired, 1: skip the old line, 2: skip the new line.
    let mut step = vec![0_u8; (n + 1) * width];
    for i in 1..=n {
        for j in 1..=m {
            let mut best = f32::NEG_INFINITY;
            let mut choice = 1;
            let alike = similarity(a[i - 1], b[j - 1], &ta[i - 1], &tb[j - 1]);
            if alike >= SIMILAR {
                best = score[(i - 1) * width + j - 1] + alike;
                choice = 0;
            }
            // Ties keep the pair, then skip the old line: deterministic.
            if score[(i - 1) * width + j] > best {
                best = score[(i - 1) * width + j];
                choice = 1;
            }
            if score[i * width + j - 1] > best {
                best = score[i * width + j - 1];
                choice = 2;
            }
            score[i * width + j] = best;
            step[i * width + j] = choice;
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        match step[i * width + j] {
            0 => {
                pairs.push((i - 1, j - 1));
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    pairs.reverse();
    pairs
}

/// How alike two lines are, from 0 to 1: the better of their common prefix
/// and suffix over the longer (ignoring indentation), which finds an edit in
/// place, and the share of word tokens they have in common, which finds
/// words moved.
fn similarity(a: &str, b: &str, ta: &[&str], tb: &[&str]) -> f32 {
    let (a, b) = (a.trim().as_bytes(), b.trim().as_bytes());
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let rest = a.len().min(b.len()) - prefix;
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(rest)
        .take_while(|(x, y)| x == y)
        .count();
    let affix = (prefix + suffix) as f32 / a.len().max(b.len()) as f32;
    if ta.is_empty() || tb.is_empty() {
        return affix;
    }
    let mut counts: FxHashMap<&str, i32> = FxHashMap::default();
    for token in ta {
        *counts.entry(*token).or_default() += 1;
    }
    let mut common = 0;
    for token in tb {
        if let Some(count) = counts.get_mut(token)
            && *count > 0
        {
            *count -= 1;
            common += 1;
        }
    }
    let dice = (2 * common) as f32 / (ta.len() + tb.len()) as f32;
    affix.max(dice)
}

/// A line's word tokens without its whitespace (for similarity).
fn content_tokens(line: &str) -> Vec<&str> {
    word_tokens(line)
        .into_iter()
        .map(|range| &line[range])
        .filter(|token| !token.trim().is_empty())
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Word,
    Space,
    Other,
}

fn class_of(grapheme: &str) -> Class {
    let c = grapheme.chars().next().unwrap_or(' ');
    if c.is_whitespace() {
        Class::Space
    } else if (c.is_alphanumeric() || c == '_') && !is_wide_script(c) {
        Class::Word
    } else {
        Class::Other
    }
}

/// Scripts written without spaces between words: each character is a word,
/// or a changed character would mark a whole sentence.
fn is_wide_script(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF       // Hiragana, Katakana
        | 0x3400..=0x4DBF     // CJK Extension A
        | 0x4E00..=0x9FFF     // CJK Unified Ideographs
        | 0xAC00..=0xD7AF     // Hangul syllables
        | 0xF900..=0xFAFF     // CJK Compatibility Ideographs
        | 0x20000..=0x3FFFF) // CJK Extensions B and later
}

/// Words: runs of word graphemes, runs of whitespace, any other grapheme alone.
fn word_tokens(line: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut last = Class::Other;
    for (at, grapheme) in line.grapheme_indices(true) {
        let class = class_of(grapheme);
        let end = at + grapheme.len();
        match out.last_mut() {
            Some(range) if class == last && class != Class::Other => range.end = end,
            _ => out.push(at..end),
        }
        last = class;
    }
    out
}

fn grapheme_tokens(line: &str) -> Vec<Range<usize>> {
    line.grapheme_indices(true)
        .map(|(at, grapheme)| at..at + grapheme.len())
        .collect()
}

/// Joins ranges at most one character apart.
fn join_close(ranges: Vec<Range<usize>>, line: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match out.last_mut() {
            Some(last) if line[last.end..range.start].chars().nth(1).is_none() => {
                last.end = range.end
            }
            _ => out.push(range),
        }
    }
    out
}

#[cfg(test)]
// Changed ranges read best as the lists they are, one range or more.
#[allow(clippy::single_range_in_vec_init)]
mod tests {
    use super::*;

    fn hunk(old: Range<usize>, new: Range<usize>) -> Hunk {
        Hunk { old, new }
    }

    fn marked<'a>(line: &'a str, ranges: &[Range<usize>]) -> Vec<&'a str> {
        ranges.iter().map(|range| &line[range.clone()]).collect()
    }

    /// Accepting every hunk turns old into new, reverting every one turns new
    /// into old; one at a time, recomputing in between, as the view does.
    fn round_trip(old: &str, new: &str) {
        let mut text = old.to_string();
        loop {
            let model = DiffModel::compute(&text, new);
            let Some(first) = model.hunks.first() else {
                break;
            };
            let next = accept_hunk(&text, new, first);
            assert_ne!(next, text);
            text = next;
        }
        assert_eq!(text, new);
        let mut text = new.to_string();
        loop {
            let model = DiffModel::compute(old, &text);
            let Some(last) = model.hunks.last() else {
                break;
            };
            let next = revert_hunk(old, &text, last);
            assert_ne!(next, text);
            text = next;
        }
        assert_eq!(text, old);
    }

    #[test]
    fn identical_texts_have_no_hunks() {
        let model = DiffModel::compute("a\nb\n", "a\nb\n");
        assert!(model.hunks.is_empty());
        assert_eq!((model.old_lines, model.new_lines), (2, 2));
        assert_eq!(model.stats(), (0, 0));
        assert!(DiffModel::compute("", "").hunks.is_empty());
        assert_eq!(model.hunk_at_new(1), None);
    }

    #[test]
    fn empty_texts() {
        let model = DiffModel::compute("", "a\nb\n");
        assert_eq!(model.hunks, vec![hunk(0..0, 0..2)]);
        assert_eq!(model.stats(), (2, 0));
        assert!(!model.old_final_newline && model.new_final_newline);
        let model = DiffModel::compute("a\n", "");
        assert_eq!(model.hunks, vec![hunk(0..1, 0..0)]);
        assert_eq!(model.stats(), (0, 1));
        let model = DiffModel::compute("", "\n");
        assert_eq!(model.hunks, vec![hunk(0..0, 0..1)]);
        round_trip("", "a\nb\n");
        round_trip("a\n", "");
        round_trip("", "\n");
    }

    #[test]
    fn insertions_and_deletions() {
        let model = DiffModel::compute("a\nb\nc\n", "a\nx\nb\nc\n");
        assert_eq!(model.hunks, vec![hunk(1..1, 1..2)]);
        let model = DiffModel::compute("a\nb\nc\n", "x\na\nb\nc\n");
        assert_eq!(model.hunks, vec![hunk(0..0, 0..1)]);
        let model = DiffModel::compute("a\nb\nc\n", "a\nb\nc\nd\n");
        assert_eq!(model.hunks, vec![hunk(3..3, 3..4)]);
        let model = DiffModel::compute("a\nb\nc\n", "a\nb\n");
        assert_eq!(model.hunks, vec![hunk(2..3, 2..2)]);
        let model = DiffModel::compute("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n");
        assert_eq!(model.hunks, vec![hunk(1..2, 1..2), hunk(4..5, 4..5)]);
        assert_eq!(model.stats(), (2, 2));
        round_trip("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n");
        round_trip("a\nb\nc\n", "x\na\nb\nc\nd\n");
    }

    #[test]
    fn a_missing_final_newline_is_a_change() {
        let model = DiffModel::compute("a\nb\n", "a\nb");
        assert_eq!((model.old_lines, model.new_lines), (2, 2));
        assert_eq!(model.hunks, vec![hunk(1..2, 1..2)]);
        assert!(model.old_final_newline && !model.new_final_newline);
        assert_eq!(model.new_line("a\nb", 1), "b");
        let model = DiffModel::compute("a\nb", "a\nb\n");
        assert_eq!(model.hunks, vec![hunk(1..2, 1..2)]);
        // Lines added after a last line without a line break change it too.
        let model = DiffModel::compute("a\nb", "a\nb\nc");
        assert_eq!(model.hunks, vec![hunk(1..2, 1..3)]);
        round_trip("a\nb\n", "a\nb");
        round_trip("a\nb", "a\nb\n");
        round_trip("a\nb", "a\nb\nc");
        round_trip("x\na\nb", "a\nB");
    }

    #[test]
    fn revert_and_accept_keep_line_breaks() {
        let (old, new) = ("a\nb", "a\nB\nc\n");
        let model = DiffModel::compute(old, new);
        assert_eq!(model.hunks, vec![hunk(1..2, 1..3)]);
        assert_eq!(revert_hunk(old, new, &model.hunks[0]), "a\nb");
        assert_eq!(accept_hunk(old, new, &model.hunks[0]), "a\nB\nc\n");
        let (old, new) = ("1\n2\n3\n4\n5\n", "1\nTWO\n3\n4\nFIVE");
        let model = DiffModel::compute(old, new);
        assert_eq!(model.hunks.len(), 2);
        assert_eq!(revert_hunk(old, new, &model.hunks[0]), "1\n2\n3\n4\nFIVE");
        assert_eq!(revert_hunk(old, new, &model.hunks[1]), "1\nTWO\n3\n4\n5\n");
        assert_eq!(accept_hunk(old, new, &model.hunks[0]), "1\nTWO\n3\n4\n5\n");
        assert_eq!(accept_hunk(old, new, &model.hunks[1]), "1\n2\n3\n4\nFIVE");
        round_trip(old, new);
    }

    #[test]
    fn crlf_is_content() {
        let (old, new) = ("a\r\nb\r\n", "a\nb\r\n");
        let model = DiffModel::compute(old, new);
        assert_eq!(model.hunks, vec![hunk(0..1, 0..1)]);
        assert_eq!(model.old_line(old, 0), "a\r");
        assert_eq!(model.new_line(new, 0), "a");
        assert_eq!(model.old_line(old, 1), "b\r");
        assert_eq!(line_range(old, 1), 3..5);
        let (ra, rb) = DiffModel::inline("a\r", "a", InlineMode::Word);
        assert_eq!((ra, rb), (vec![1..2], vec![]));
        round_trip(old, new);
        round_trip("x\r\ny\r\n", "x\r\nz\r\ny");
    }

    #[test]
    fn hunks_slide_down_to_whole_blocks() {
        // The added block could also start at the old closing brace; the
        // hunk takes the block as written.
        let model = DiffModel::compute("{\n  a\n}\n", "{\n  a\n}\n{\n  b\n}\n");
        assert_eq!(model.hunks, vec![hunk(3..3, 3..6)]);
    }

    #[test]
    fn hunk_navigation() {
        let model = DiffModel::compute("a\nb\nc\nd\ne\nf\n", "a\nB\nc\nd\nf\n");
        assert_eq!(model.hunks, vec![hunk(1..2, 1..2), hunk(4..5, 4..4)]);
        assert_eq!(model.hunk_at_new(0), None);
        assert_eq!(model.hunk_at_new(1), Some(0));
        assert_eq!(model.hunk_at_new(3), Some(0));
        assert_eq!(model.hunk_at_new(4), Some(1));
        assert_eq!(model.hunk_at_new(100), Some(1));
        assert_eq!(model.hunk_at_old(4), Some(1));
        assert_eq!(model.hunk_at_old(3), Some(0));
        assert_eq!(model.hunk_at_old(0), None);
    }

    #[test]
    fn pairs_in_order_when_alike() {
        let old = "let a = 1;\nlet b = 2;\n";
        let new = "let a = 10;\nlet b = 20;\n";
        let model = DiffModel::compute(old, new);
        assert_eq!(
            model.pairs(0, old, new),
            vec![
                Pair {
                    old: Some(0),
                    new: Some(0)
                },
                Pair {
                    old: Some(1),
                    new: Some(1)
                }
            ]
        );
        assert!(model.pairs(1, old, new).is_empty());
    }

    #[test]
    fn pairs_find_the_line_most_alike() {
        let old = "x\nfn compute(values: &[u32]) -> u32 {\ny\n";
        let new = "x\nuse std::fmt;\n\nfn compute(values: &[u64]) -> u64 {\ny\n";
        let model = DiffModel::compute(old, new);
        assert_eq!(model.hunks, vec![hunk(1..2, 1..4)]);
        assert_eq!(
            model.pairs(0, old, new),
            vec![
                Pair {
                    old: None,
                    new: Some(1)
                },
                Pair {
                    old: None,
                    new: Some(2)
                },
                Pair {
                    old: Some(1),
                    new: Some(3)
                },
            ]
        );
    }

    #[test]
    fn unlike_lines_pair_in_order_and_extra_lines_stay_alone() {
        let old = "keep\nalpha\nbeta\ngamma\nkeep\n";
        let new = "keep\n1\n2\nkeep\n";
        let model = DiffModel::compute(old, new);
        assert_eq!(model.hunks, vec![hunk(1..4, 1..3)]);
        assert_eq!(
            model.pairs(0, old, new),
            vec![
                Pair {
                    old: Some(1),
                    new: Some(1)
                },
                Pair {
                    old: Some(2),
                    new: Some(2)
                },
                Pair {
                    old: Some(3),
                    new: None
                },
            ]
        );
        let model = DiffModel::compute("a\n", "a\nb\nc\n");
        assert_eq!(
            model.pairs(0, "a\n", "a\nb\nc\n"),
            vec![
                Pair {
                    old: None,
                    new: Some(1)
                },
                Pair {
                    old: None,
                    new: Some(2)
                }
            ]
        );
    }

    #[test]
    fn large_hunks_pair_in_order() {
        let old: String = (0..100).map(|i| format!("old line {i}\n")).collect();
        let new: String = (0..80).map(|i| format!("new row {i}\n")).collect();
        let model = DiffModel::compute(&old, &new);
        assert_eq!(model.hunks, vec![hunk(0..100, 0..80)]);
        let pairs = model.pairs(0, &old, &new);
        assert_eq!(pairs.len(), 100);
        assert_eq!(
            pairs[79],
            Pair {
                old: Some(79),
                new: Some(79)
            }
        );
        assert_eq!(
            pairs[80],
            Pair {
                old: Some(80),
                new: None
            }
        );
    }

    #[test]
    fn inline_words() {
        let (old, new) = ("let total = price * count;", "let total = cost * count;");
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::Word);
        assert_eq!(marked(old, &ra), ["price"]);
        assert_eq!(marked(new, &rb), ["cost"]);
        let (ra, rb) = DiffModel::inline("foo(a, b)", "foo(a, c)", InlineMode::WordAlt);
        assert_eq!((ra, rb), (vec![7..8], vec![7..8]));
    }

    #[test]
    fn word_alt_joins_a_phrase() {
        let old = "the quick brown fox jumps";
        let new = "the slow red fox jumps";
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::Word);
        assert_eq!(marked(old, &ra), ["quick", "brown"]);
        assert_eq!(marked(new, &rb), ["slow", "red"]);
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::WordAlt);
        assert_eq!(marked(old, &ra), ["quick brown"]);
        assert_eq!(marked(new, &rb), ["slow red"]);
        let old = "call(alpha, beta, gamma, delta)";
        let new = "call(ALPHA, beta, GAMMA, delta)";
        let (ra, _) = DiffModel::inline(old, new, InlineMode::Word);
        assert_eq!(marked(old, &ra), ["alpha", "gamma"]);
        // Two words one separator apart read as one change.
        let old = "x = a.b + 1";
        let new = "x = c.d + 1";
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::Word);
        assert_eq!(marked(old, &ra), ["a", "b"]);
        let (ra, rb2) = DiffModel::inline(old, new, InlineMode::WordAlt);
        assert_eq!(marked(old, &ra), ["a.b"]);
        assert_eq!(marked(new, &rb2), ["c.d"]);
        assert_eq!(rb.len(), 2);
    }

    #[test]
    fn inline_chars() {
        let (ra, rb) = DiffModel::inline("color: grey;", "color: gray;", InlineMode::Char);
        assert_eq!(marked("color: grey;", &ra), ["e"]);
        assert_eq!(marked("color: gray;", &rb), ["a"]);
    }

    #[test]
    fn inline_multibyte() {
        let (old, new) = ("我喜欢猫和狗", "我喜欢鸟和狗");
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::WordAlt);
        assert_eq!(marked(old, &ra), ["猫"]);
        assert_eq!(marked(new, &rb), ["鸟"]);
        let (old, new) = ("thumbs 👍🏽 up ok", "thumbs 👍🏿 up ok");
        for mode in [InlineMode::Word, InlineMode::Char] {
            let (ra, rb) = DiffModel::inline(old, new, mode);
            assert_eq!(marked(old, &ra), ["👍🏽"]);
            assert_eq!(marked(new, &rb), ["👍🏿"]);
        }
        let (old, new) = ("café au lait", "cafe au lait");
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::Char);
        assert_eq!(marked(old, &ra), ["é"]);
        assert_eq!(marked(new, &rb), ["e"]);
        let (ra, _) = DiffModel::inline(old, new, InlineMode::Word);
        assert_eq!(marked(old, &ra), ["café"]);
    }

    #[test]
    fn inline_gives_up_when_most_changed() {
        let (ra, rb) = DiffModel::inline("alpha beta", "gamma delta", InlineMode::WordAlt);
        assert!(ra.is_empty() && rb.is_empty());
        assert_eq!(
            DiffModel::inline("a b", "a b", InlineMode::Word),
            (vec![], vec![])
        );
        assert_eq!(
            DiffModel::inline("", "abc", InlineMode::Word),
            (vec![], vec![])
        );
        assert_eq!(
            DiffModel::inline("foo(a, b)", "foo(a, c)", InlineMode::None),
            (vec![], vec![])
        );
    }

    #[test]
    fn inline_pure_insertion_marks_one_side() {
        let (old, new) = ("let x = f(a);", "let x = f(a, b);");
        let (ra, rb) = DiffModel::inline(old, new, InlineMode::Word);
        assert!(ra.is_empty());
        assert_eq!(marked(new, &rb), [", b"]);
    }

    #[test]
    fn line_helpers() {
        assert_eq!(line_starts(""), Vec::<usize>::new());
        assert_eq!(line_starts("a"), vec![0]);
        assert_eq!(line_starts("a\n"), vec![0]);
        assert_eq!(line_starts("a\nbc"), vec![0, 2]);
        assert_eq!(line_starts("\n\n"), vec![0, 1]);
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("a\nb\n"), 2);
        assert_eq!(line_count("a\nb"), 2);
        assert_eq!(line_count("\n"), 1);
        assert_eq!(line_range("a\nbc\n", 0), 0..1);
        assert_eq!(line_range("a\nbc\n", 1), 2..4);
        assert_eq!(line_range("a\nbc\n", 2), 5..5);
        assert_eq!(line_range("a\nbc", 1), 2..4);
        assert_eq!(line_range("a\nbc", 7), 4..4);
        assert_eq!(line_range("", 0), 0..0);
        assert_eq!(line_range("é\n日本", 1), 3..9);
        let text = "a\nbc";
        let starts = line_starts(text);
        assert_eq!(lines_span(text, &starts, 0..1), 0..2);
        assert_eq!(lines_span(text, &starts, 1..2), 2..4);
        assert_eq!(lines_span(text, &starts, 2..2), 4..4);
        let model = DiffModel::compute("a\nbc", "a\nbc\n");
        assert_eq!(model.old_line_range("a\nbc", 1), 2..4);
        assert_eq!(model.new_line_range("a\nbc\n", 1), 2..4);
        assert_eq!(model.new_line("a\nbc\n", 5), "");
    }

    #[test]
    fn large_texts_with_few_changes() {
        let old: String = (0..50_000).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 100\n", "line one hundred\n")
            .replace("line 40000\n", "");
        let model = DiffModel::compute(&old, &new);
        assert_eq!(
            model.hunks,
            vec![hunk(100..101, 100..101), hunk(40000..40001, 40000..40000)]
        );
        assert_eq!(
            model.pairs(0, &old, &new),
            vec![Pair {
                old: Some(100),
                new: Some(100)
            }]
        );
        round_trip(&old[..2000], &new[..2100]);
    }
}
