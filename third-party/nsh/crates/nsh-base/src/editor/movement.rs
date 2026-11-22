//! Where the caret goes: graphemes, words, line and row ends, vertical
//! moves keeping their x, and brackets.
//!
//! Everything works on the rope in place (graphemes through
//! `GraphemeCursor` over its chunks, words and brackets char by char), so
//! a move costs what it passes over, never the size of the document or of a
//! long line. Words never cross a line break except where a move starts at
//! a line's end and goes on into the next line, as VS Code's do.

use std::ops::Range;

use nsh_core::geometry::Points;
use unicode_segmentation::{GraphemeCursor, GraphemeIncomplete};

use super::{buffer::Buffer, types::RowLayout};

/// How many chars a bracket search reads before giving up.
const BRACKET_SCAN_LIMIT: usize = 100_000;

/// The offset after the grapheme at `offset` (the text's end at its end).
pub(crate) fn next_grapheme(buffer: &Buffer, offset: usize) -> usize {
    let rope = buffer.rope();
    let len = rope.len_bytes();
    let offset = buffer.clip(offset);
    if offset >= len {
        return len;
    }
    let (mut chunk, mut chunk_start, _, _) = rope.chunk_at_byte(offset);
    let mut cursor = GraphemeCursor::new(offset, len, true);
    loop {
        match cursor.next_boundary(chunk, chunk_start) {
            Ok(None) => return len,
            Ok(Some(next)) => return next,
            Err(GraphemeIncomplete::NextChunk) => {
                chunk_start += chunk.len();
                chunk = rope.chunk_at_byte(chunk_start).0;
            }
            Err(GraphemeIncomplete::PreContext(at)) => {
                let (context, start, _, _) = rope.chunk_at_byte(at - 1);
                cursor.provide_context(context, start);
            }
            // The cursor asks for nothing else going forward.
            Err(_) => return offset + buffer.char_at(offset).map_or(0, char::len_utf8),
        }
    }
}

/// The offset where the grapheme before `offset` starts (0 at the start).
pub(crate) fn prev_grapheme(buffer: &Buffer, offset: usize) -> usize {
    let rope = buffer.rope();
    let len = rope.len_bytes();
    let offset = buffer.clip(offset);
    if offset == 0 {
        return 0;
    }
    let (mut chunk, mut chunk_start, _, _) = rope.chunk_at_byte(offset);
    let mut cursor = GraphemeCursor::new(offset, len, true);
    loop {
        match cursor.prev_boundary(chunk, chunk_start) {
            Ok(None) => return 0,
            Ok(Some(prev)) => return prev,
            Err(GraphemeIncomplete::PrevChunk) => {
                let (prev_chunk, start, _, _) = rope.chunk_at_byte(chunk_start - 1);
                chunk = prev_chunk;
                chunk_start = start;
            }
            Err(GraphemeIncomplete::PreContext(at)) => {
                let (context, start, _, _) = rope.chunk_at_byte(at - 1);
                cursor.provide_context(context, start);
            }
            // The cursor asks for nothing else going backward.
            Err(_) => return offset - buffer.char_before(offset).map_or(0, char::len_utf8),
        }
    }
}

/// What a grapheme counts as, for word boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Space,
    Word,
    /// CJK ideographs, kana and Hangul: a run of them is one word (there is
    /// no dictionary), apart from Latin words next to them.
    Ideograph,
    Punct,
}

impl Class {
    /// What VS Code calls a regular character: part of a word.
    fn is_word(self) -> bool {
        matches!(self, Class::Word | Class::Ideograph)
    }
}

fn class_of(c: char, word_chars: &str) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if is_ideograph(c) {
        Class::Ideograph
    } else if c.is_alphanumeric() || c == '_' || word_chars.contains(c) {
        Class::Word
    } else {
        Class::Punct
    }
}

fn is_ideograph(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF | 0x20000..=0x3134F)
}

/// The class of the grapheme at `offset` (by its first char; a grapheme's
/// marks and modifiers go with it), None at the end of its line.
fn class_at(buffer: &Buffer, offset: usize, word_chars: &str) -> Option<Class> {
    match buffer.char_at(offset)? {
        '\n' => None,
        c => Some(class_of(c, word_chars)),
    }
}

/// The class of the grapheme before `offset` and where it starts, None at
/// the start of its line.
fn class_before(buffer: &Buffer, offset: usize, word_chars: &str) -> Option<(Class, usize)> {
    if offset == 0 || buffer.char_before(offset)? == '\n' {
        return None;
    }
    let start = prev_grapheme(buffer, offset);
    Some((class_at(buffer, start, word_chars)?, start))
}

/// From `offset` forward over graphemes of `class`, within the line.
fn run_end(buffer: &Buffer, mut offset: usize, class: Class, word_chars: &str) -> usize {
    while class_at(buffer, offset, word_chars) == Some(class) {
        offset = next_grapheme(buffer, offset);
    }
    offset
}

/// From `offset` backward over graphemes of `class`, within the line.
fn run_start(buffer: &Buffer, mut offset: usize, class: Class, word_chars: &str) -> usize {
    while let Some((c, start)) = class_before(buffer, offset, word_chars) {
        if c != class {
            break;
        }
        offset = start;
    }
    offset
}

/// Alt/Ctrl+Right: past the end of the next word (skipping whitespace and punctuation runs as VS Code does).
///
/// From inside a word or a punctuation run, to its end; a single
/// punctuation char followed by a word (`.` in `foo.bar`) is passed with
/// that word; at a line's end, on to the end of the next line's first word.
pub(crate) fn next_word_end(buffer: &Buffer, offset: usize, word_chars: &str) -> usize {
    let mut at = buffer.clip(offset);
    let mut line = buffer.line_of(at);
    if at >= buffer.line_end(line) {
        if line + 1 >= buffer.line_count() {
            return buffer.len();
        }
        line += 1;
        at = buffer.line_start(line);
    }
    let line_start = buffer.line_start(line);
    let line_end = buffer.line_end(line);
    let mut first = true;
    loop {
        at = run_end(buffer, at, Class::Space, word_chars);
        let Some(class) = class_at(buffer, at, word_chars) else {
            return line_end;
        };
        let end = run_end(buffer, at, class, word_chars);
        // Only the run's own length counts: from its middle it is not one char.
        let single = end == next_grapheme(buffer, at)
            && (at == line_start
                || class_before(buffer, at, word_chars).map(|(c, _)| c) != Some(class));
        let followed_by_word = class_at(buffer, end, word_chars).is_some_and(Class::is_word);
        if first && class == Class::Punct && single && followed_by_word {
            first = false;
            at = end;
            continue;
        }
        return end;
    }
}

/// Alt/Ctrl+Left: to the start of the previous word.
///
/// The mirror of [`next_word_end`]: back over whitespace to the start of
/// the word or punctuation run before; a single punctuation char right
/// before a word is passed too; at a line's start, to the end of the line
/// before and on from there.
pub(crate) fn prev_word_start(buffer: &Buffer, offset: usize, word_chars: &str) -> usize {
    let mut at = buffer.clip(offset);
    let mut line = buffer.line_of(at);
    if at <= buffer.line_start(line) {
        if line == 0 {
            return 0;
        }
        line -= 1;
        at = buffer.line_end(line);
    }
    let line_start = buffer.line_start(line);
    let mut first = true;
    loop {
        at = run_start(buffer, at, Class::Space, word_chars);
        let Some((class, _)) = class_before(buffer, at, word_chars) else {
            return line_start;
        };
        let start = run_start(buffer, at, class, word_chars);
        let single = prev_grapheme(buffer, at) == start;
        let followed_by_word = class_at(buffer, at, word_chars).is_some_and(Class::is_word);
        if first && class == Class::Punct && single && followed_by_word {
            first = false;
            at = start;
            continue;
        }
        return start;
    }
}

/// What a double click selects: the word at offset, else the run of whitespace or punctuation there.
///
/// The word after `offset` or, when there is none, the one before it (a
/// click at the end of `foo)` selects `foo`); then the run after or before.
/// Empty on an empty line.
pub(crate) fn word_range(buffer: &Buffer, offset: usize, word_chars: &str) -> Range<usize> {
    let offset = buffer.clip(offset);
    let after = class_at(buffer, offset, word_chars);
    let before = class_before(buffer, offset, word_chars).map(|(c, _)| c);
    let class = match (after, before) {
        (Some(a), _) if a.is_word() => a,
        (_, Some(b)) if b.is_word() => b,
        (Some(a), _) => a,
        (None, Some(b)) => b,
        (None, None) => return offset..offset,
    };
    run_start(buffer, offset, class, word_chars)..run_end(buffer, offset, class, word_chars)
}

/// The first non-whitespace offset of the line offset is on (its end when the line is blank).
pub(crate) fn first_non_blank(buffer: &Buffer, line: usize) -> usize {
    let start = buffer.line_start(line);
    let end = buffer.line_end(line);
    let blank: usize = buffer
        .chars_at(start)
        .take_while(|&c| c != '\n' && c.is_whitespace())
        .map(char::len_utf8)
        .sum();
    (start + blank).min(end)
}

/// Home: on a row that starts its line, toggles between the first non-blank and the line start; on a wrapped row,
/// the row start (then the line's first non-blank).
pub(crate) fn smart_home(buffer: &Buffer, layout: &dyn RowLayout, offset: usize) -> usize {
    let offset = buffer.clip(offset);
    let (row, _) = layout.locate(offset);
    let row_start = layout.row_range(row).start;
    let line = buffer.line_of(row_start);
    let line_start = buffer.line_start(line);
    let first = first_non_blank(buffer, line);
    if row_start == line_start {
        if offset == first { line_start } else { first }
    } else if offset == row_start {
        first
    } else {
        row_start
    }
}

/// End: the end of the row (the last offset before a soft wrap), then the end of the line.
///
/// The end of a soft-wrapped row is also where the next row starts, and
/// [`RowLayout::locate`] puts the caret there on the next row, so a second
/// End from it goes to the end of that row, and so on to the line's end.
pub(crate) fn smart_end(buffer: &Buffer, layout: &dyn RowLayout, offset: usize) -> usize {
    let offset = buffer.clip(offset);
    let (row, _) = layout.locate(offset);
    let row_end = layout.row_range(row).end;
    if offset == row_end {
        buffer.line_end(buffer.line_of(offset))
    } else {
        row_end
    }
}

/// Up/Down/Page: `rows` display rows away (negative up), keeping `goal` (the x to stay at; None: the offset's own x).
/// Past the first row goes to 0, past the last to the end of the text. Returns the new offset and the goal kept.
pub(crate) fn vertical(
    buffer: &Buffer,
    layout: &dyn RowLayout,
    offset: usize,
    goal: Option<Points>,
    rows: isize,
) -> (usize, Points) {
    let offset = buffer.clip(offset);
    let (row, x) = layout.locate(offset);
    let goal = goal.unwrap_or(x);
    if rows == 0 {
        return (offset, goal);
    }
    let last = layout.row_count().saturating_sub(1);
    let target = row as isize + rows;
    if target < 0 {
        (0, goal)
    } else if target as usize > last {
        (buffer.len(), goal)
    } else {
        (layout.offset_at(target as usize, goal), goal)
    }
}

/// The bracket at `offset` (after it) or just before it, and its partner: their offsets (the opening one first).
/// `pairs` like `[('(', ')'), ('[', ']'), ('{', '}')]`. Counts nesting; gives up after 100 000 chars.
pub(crate) fn matching_bracket(
    buffer: &Buffer,
    offset: usize,
    pairs: &[(char, char)],
) -> Option<(usize, usize)> {
    let offset = buffer.clip(offset);
    let at = buffer.char_at(offset).map(|c| (c, offset));
    let before = buffer
        .char_before(offset)
        .map(|c| (c, offset - c.len_utf8()));
    for (c, position) in at.into_iter().chain(before) {
        for &(open, close) in pairs {
            if c == open {
                return find_close(buffer, position + c.len_utf8(), open, close)
                    .map(|end| (position, end));
            }
            if c == close {
                return find_open(buffer, position, open, close).map(|start| (start, position));
            }
        }
    }
    None
}

/// The offset of the `close` matching an `open` that ends at `from`.
fn find_close(buffer: &Buffer, from: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = from;
    for c in buffer.chars_at(from).take(BRACKET_SCAN_LIMIT) {
        if c == close {
            if depth == 0 {
                return Some(at);
            }
            depth -= 1;
        } else if c == open {
            depth += 1;
        }
        at += c.len_utf8();
    }
    None
}

/// The offset of the `open` matching a `close` that starts at `from`.
fn find_open(buffer: &Buffer, from: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = from;
    for c in buffer.chars_before(from).take(BRACKET_SCAN_LIMIT) {
        at -= c.len_utf8();
        if c == open {
            if depth == 0 {
                return Some(at);
            }
            depth -= 1;
        } else if c == close {
            depth += 1;
        }
    }
    None
}

/// The innermost bracket pair enclosing `range` (offsets of the opening and the closing bracket).
///
/// The opening brackets before `range` that are not closed before it are
/// tried from the nearest out; the first whose partner closes at or after
/// `range`'s end encloses it.
pub(crate) fn enclosing_brackets(
    buffer: &Buffer,
    range: Range<usize>,
    pairs: &[(char, char)],
) -> Option<(usize, usize)> {
    let start = buffer.clip(range.start.min(range.end));
    let end = buffer.clip(range.start.max(range.end));
    // Per pair, how many closing brackets seen going back still wait for
    // their opening one.
    let mut depths = vec![0usize; pairs.len()];
    let mut at = start;
    for c in buffer.chars_before(start).take(BRACKET_SCAN_LIMIT) {
        at -= c.len_utf8();
        let Some(index) = pairs.iter().position(|&(o, cl)| c == o || c == cl) else {
            continue;
        };
        let (open, close) = pairs[index];
        if c == close {
            depths[index] += 1;
        } else if depths[index] > 0 {
            depths[index] -= 1;
        } else {
            // An unclosed one encloses nothing: the next one out may.
            match find_close(buffer, at + open.len_utf8(), open, close) {
                Some(partner) if partner >= end => return Some((at, partner)),
                _ => {}
            }
        }
    }
    None
}

/// The range of whole lines `first..=last`, with the last line's line break (or the one before the first line when
/// the last line is the text's last and has none: what deleting lines removes).
pub(crate) fn lines_range(buffer: &Buffer, first: usize, last: usize) -> Range<usize> {
    let count = buffer.line_count();
    let last = last.min(count - 1);
    let first = first.min(last);
    if last + 1 < count {
        buffer.line_start(first)..buffer.line_start(last + 1)
    } else if first > 0 {
        buffer.line_end(first - 1)..buffer.len()
    } else {
        0..buffer.len()
    }
}

/// Where the parts of `word` meet, as byte offsets inside it: camelCase
/// humps (`foo|Bar`), the end of a run of capitals before a capitalized
/// part (`HTML|Parser`), and both sides of a run of underscores
/// (`foo|_|bar`).
fn subword_boundaries(word: &str) -> Vec<usize> {
    let chars: Vec<(usize, char)> = word.char_indices().collect();
    let mut bounds = Vec::new();
    for k in 1..chars.len() {
        let (at, c) = chars[k];
        let prev = chars[k - 1].1;
        let next = chars.get(k + 1).map(|&(_, c)| c);
        let hump = (prev.is_lowercase() || prev.is_ascii_digit()) && c.is_uppercase();
        let acronym_end =
            prev.is_uppercase() && c.is_uppercase() && next.is_some_and(char::is_lowercase);
        let underscore = (prev == '_') != (c == '_');
        if hump || acronym_end || underscore {
            bounds.push(at);
        }
    }
    bounds
}

/// Past the end of the next part of a word (camelCase humps, snake_case
/// parts); whitespace before a word is passed, and anywhere else (punctuation,
/// a line's end) the move is [`next_word_end`]'s.
pub(crate) fn next_subword_end(buffer: &Buffer, offset: usize, word_chars: &str) -> usize {
    let offset = buffer.clip(offset);
    let mut at = offset;
    if class_at(buffer, at, word_chars) == Some(Class::Space) {
        at = run_end(buffer, at, Class::Space, word_chars);
    }
    if class_at(buffer, at, word_chars) != Some(Class::Word) {
        return next_word_end(buffer, offset, word_chars);
    }
    let start = run_start(buffer, at, Class::Word, word_chars);
    let end = run_end(buffer, at, Class::Word, word_chars);
    let word = buffer.slice(start..end);
    let mut from = at;
    for bound in subword_boundaries(&word)
        .into_iter()
        .map(|b| start + b)
        .chain([end])
    {
        if bound <= from {
            continue;
        }
        // A part of underscores alone goes with the part after it.
        if word[from - start..bound - start].chars().all(|c| c == '_') {
            from = bound;
            continue;
        }
        return bound;
    }
    end
}

/// To the start of the previous part of a word: the mirror of
/// [`next_subword_end`].
pub(crate) fn prev_subword_start(buffer: &Buffer, offset: usize, word_chars: &str) -> usize {
    let offset = buffer.clip(offset);
    let mut at = offset;
    if let Some((Class::Space, _)) = class_before(buffer, at, word_chars) {
        at = run_start(buffer, at, Class::Space, word_chars);
    }
    if !matches!(class_before(buffer, at, word_chars), Some((Class::Word, _))) {
        return prev_word_start(buffer, offset, word_chars);
    }
    let start = run_start(buffer, at, Class::Word, word_chars);
    let end = run_end(buffer, at, Class::Word, word_chars);
    let word = buffer.slice(start..end);
    let mut to = at;
    for bound in std::iter::once(start)
        .chain(subword_boundaries(&word).into_iter().map(|b| start + b))
        .rev()
    {
        if bound >= to {
            continue;
        }
        if word[bound - start..to - start].chars().all(|c| c == '_') {
            to = bound;
            continue;
        }
        return bound;
    }
    start
}

/// Whether `line` holds only whitespace.
fn is_blank_line(buffer: &Buffer, line: usize) -> bool {
    buffer.line_text(line).trim().is_empty()
}

/// Down a paragraph: to the start of the first blank line after the
/// paragraph the offset is in (or the next one, from a blank line), else
/// the text's end.
pub(crate) fn next_paragraph(buffer: &Buffer, offset: usize) -> usize {
    let count = buffer.line_count();
    let current = buffer.line_of(buffer.clip(offset));
    let mut line = current + 1;
    if is_blank_line(buffer, current) {
        while line < count && is_blank_line(buffer, line) {
            line += 1;
        }
    }
    while line < count && !is_blank_line(buffer, line) {
        line += 1;
    }
    if line < count {
        buffer.line_start(line)
    } else {
        buffer.len()
    }
}

/// Up a paragraph: to the start of the blank line before the paragraph the
/// offset is in (or the previous one, from a blank line), else the text's
/// start.
pub(crate) fn prev_paragraph(buffer: &Buffer, offset: usize) -> usize {
    let mut line = buffer.line_of(buffer.clip(offset));
    if is_blank_line(buffer, line) {
        while line > 0 && is_blank_line(buffer, line - 1) {
            line -= 1;
        }
    }
    while line > 0 && !is_blank_line(buffer, line - 1) {
        line -= 1;
    }
    if line == 0 {
        0
    } else {
        buffer.line_start(line - 1)
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::*;

    const W: &str = "";

    /// Rows of at most `wrap` chars (one row per line without), each char
    /// 10 points wide.
    struct Rows {
        rows: Vec<Range<usize>>,
        text: String,
    }

    impl Rows {
        fn new(buffer: &Buffer, wrap: Option<usize>) -> Rows {
            let mut rows = Vec::new();
            for line in 0..buffer.line_count() {
                let start = buffer.line_start(line);
                let text = buffer.line_text(line);
                let bounds: Vec<usize> = text
                    .char_indices()
                    .map(|(i, _)| i)
                    .chain([text.len()])
                    .collect();
                let width = wrap.unwrap_or(usize::MAX);
                let mut first = 0;
                while bounds.len() - 1 - first > width {
                    rows.push(start + bounds[first]..start + bounds[first + width]);
                    first += width;
                }
                rows.push(start + bounds[first]..start + text.len());
            }
            Rows {
                rows,
                text: buffer.text(),
            }
        }
    }

    impl RowLayout for Rows {
        fn row_count(&self) -> usize {
            self.rows.len()
        }

        fn locate(&self, offset: usize) -> (usize, Points) {
            let row = self
                .rows
                .iter()
                .rposition(|r| r.start <= offset)
                .unwrap_or(0);
            let start = self.rows[row].start;
            let chars = self.text[start..offset.max(start)].chars().count();
            (row, px(chars as f32 * 10.0))
        }

        fn offset_at(&self, row: usize, x: Points) -> usize {
            let range = self.rows[row].clone();
            let chars = (x.0 / 10.0).round().max(0.0) as usize;
            self.text[range.clone()]
                .char_indices()
                .nth(chars)
                .map_or(range.end, |(i, _)| range.start + i)
        }

        fn row_range(&self, row: usize) -> Range<usize> {
            self.rows[row].clone()
        }
    }

    fn rights(text: &str, word_chars: &str) -> Vec<usize> {
        let buffer = Buffer::new(text);
        let mut stops = Vec::new();
        let mut at = 0;
        while at < buffer.len() {
            at = next_word_end(&buffer, at, word_chars);
            stops.push(at);
        }
        stops
    }

    fn lefts(text: &str, word_chars: &str) -> Vec<usize> {
        let buffer = Buffer::new(text);
        let mut stops = Vec::new();
        let mut at = buffer.len();
        while at > 0 {
            at = prev_word_start(&buffer, at, word_chars);
            stops.push(at);
        }
        stops
    }

    #[test]
    fn graphemes_step_over_clusters() {
        // e + combining acute, a thumbs up with a skin tone, a family (ZWJ
        // sequence), a flag, CJK.
        let text = "e\u{301}👍🏽👨‍👩‍👧🇨🇳中\n";
        let buffer = Buffer::new(text);
        let mut forward = vec![0];
        while *forward.last().unwrap() < buffer.len() {
            forward.push(next_grapheme(&buffer, *forward.last().unwrap()));
        }
        let expected: Vec<usize> = {
            use unicode_segmentation::UnicodeSegmentation;
            let mut v = vec![0];
            v.extend(text.grapheme_indices(true).map(|(i, g)| i + g.len()));
            v
        };
        assert_eq!(forward, expected);
        let mut backward = vec![buffer.len()];
        while *backward.last().unwrap() > 0 {
            backward.push(prev_grapheme(&buffer, *backward.last().unwrap()));
        }
        backward.reverse();
        assert_eq!(backward, expected);
    }

    #[test]
    fn graphemes_at_the_ends_and_on_empty_text() {
        let empty = Buffer::new("");
        assert_eq!(next_grapheme(&empty, 0), 0);
        assert_eq!(prev_grapheme(&empty, 0), 0);
        let buffer = Buffer::new("ab");
        assert_eq!(next_grapheme(&buffer, 2), 2);
        assert_eq!(next_grapheme(&buffer, 99), 2);
        assert_eq!(prev_grapheme(&buffer, 0), 0);
        // CRLF is one line break once normalized.
        let crlf = Buffer::new("a\r\nb");
        assert_eq!(next_grapheme(&crlf, 1), 2);
        assert_eq!(prev_grapheme(&crlf, 3), 2);
    }

    #[test]
    fn graphemes_across_rope_chunks() {
        // Long enough for several chunks, emoji with modifiers all along.
        let text = "👍🏽a".repeat(2000);
        let buffer = Buffer::new(&text);
        let mut at = 0;
        let mut count = 0;
        while at < buffer.len() {
            at = next_grapheme(&buffer, at);
            count += 1;
        }
        assert_eq!(count, 4000);
        while at > 0 {
            at = prev_grapheme(&buffer, at);
            count -= 1;
        }
        assert_eq!(count, 0);
    }

    #[test]
    fn word_right_as_vs_code() {
        // foo| bar| baz|
        assert_eq!(rights("foo bar  baz", W), vec![3, 7, 12]);
        // A single dot before a word goes with it; a run of them stops.
        assert_eq!(rights("foo.bar", W), vec![3, 7]);
        assert_eq!(rights("a..b", W), vec![1, 3, 4]);
        assert_eq!(rights("f(x);", W), vec![1, 3, 5]);
        // Line ends: the next line's first word.
        assert_eq!(rights("ab\n  cd\n", W), vec![2, 7, 8]);
        // From inside a word, its end.
        let buffer = Buffer::new("hello world");
        assert_eq!(next_word_end(&buffer, 2, W), 5);
        assert_eq!(next_word_end(&buffer, 11, W), 11);
    }

    #[test]
    fn word_left_as_vs_code() {
        assert_eq!(lefts("foo bar  baz", W), vec![9, 4, 0]);
        assert_eq!(lefts("foo.bar", W), vec![4, 0]);
        assert_eq!(lefts("f(x);", W), vec![3, 2, 0]);
        assert_eq!(lefts("ab\n  cd", W), vec![5, 3, 0]);
        let empty = Buffer::new("");
        assert_eq!(prev_word_start(&empty, 0, W), 0);
        assert_eq!(next_word_end(&empty, 0, W), 0);
    }

    #[test]
    fn word_chars_and_scripts() {
        // `$` is a word char in JS.
        assert_eq!(rights("$foo.$bar", "$"), vec![4, 9]);
        assert_eq!(rights("$foo", W), vec![4]);
        // CJK runs apart from Latin words.
        let text = "abc中文def";
        assert_eq!(rights(text, W), vec![3, 9, 12]);
        // Tabs are whitespace; emoji with modifiers stay whole.
        assert_eq!(rights("\tx 👍🏽 y", W), vec![2, 11, 13]);
    }

    #[test]
    fn double_click_ranges() {
        let buffer = Buffer::new("let foo_bar = (x);\n\nend");
        assert_eq!(word_range(&buffer, 5, W), 4..11);
        // At a word's end, the word before rather than the space.
        assert_eq!(word_range(&buffer, 11, W), 4..11);
        assert_eq!(word_range(&buffer, 12, W), 12..13);
        // Between `(` and `x`, the word.
        assert_eq!(word_range(&buffer, 15, W), 15..16);
        assert_eq!(word_range(&buffer, 16, W), 15..16);
        assert_eq!(word_range(&buffer, 17, W), 16..18);
        // The empty line.
        assert_eq!(word_range(&buffer, 19, W), 19..19);
        // The last line, without a line break.
        assert_eq!(word_range(&buffer, 23, W), 20..23);
        let text = Buffer::new("é中文👍🏽");
        assert_eq!(word_range(&text, 0, W), 0..2);
        assert_eq!(word_range(&text, 2, W), 2..8);
        assert_eq!(word_range(&text, 8, W), 2..8);
        assert_eq!(word_range(&text, 16, W), 8..16);
    }

    #[test]
    fn first_non_blank_of_lines() {
        let buffer = Buffer::new("  a\n\t\tb\n   \n");
        assert_eq!(first_non_blank(&buffer, 0), 2);
        assert_eq!(first_non_blank(&buffer, 1), 6);
        assert_eq!(first_non_blank(&buffer, 2), 11);
        assert_eq!(first_non_blank(&buffer, 3), 12);
    }

    #[test]
    fn home_and_end_on_lines() {
        let buffer = Buffer::new("    let x;\nend");
        let rows = Rows::new(&buffer, None);
        assert_eq!(smart_home(&buffer, &rows, 8), 4);
        assert_eq!(smart_home(&buffer, &rows, 4), 0);
        assert_eq!(smart_home(&buffer, &rows, 0), 4);
        assert_eq!(smart_home(&buffer, &rows, 2), 4);
        assert_eq!(smart_end(&buffer, &rows, 2), 10);
        assert_eq!(smart_end(&buffer, &rows, 10), 10);
        assert_eq!(smart_end(&buffer, &rows, 11), 14);
    }

    #[test]
    fn home_and_end_on_wrapped_rows() {
        // Rows of 4 chars: "  ab", "cdef", "gh".
        let buffer = Buffer::new("  abcdefgh");
        let rows = Rows::new(&buffer, Some(4));
        assert_eq!(rows.row_count(), 3);
        assert_eq!(smart_home(&buffer, &rows, 6), 4);
        assert_eq!(smart_home(&buffer, &rows, 4), 2);
        assert_eq!(smart_home(&buffer, &rows, 9), 8);
        assert_eq!(smart_end(&buffer, &rows, 5), 8);
        assert_eq!(smart_end(&buffer, &rows, 9), 10);
        assert_eq!(smart_end(&buffer, &rows, 10), 10);
    }

    #[test]
    fn vertical_moves_keep_their_goal() {
        let buffer = Buffer::new("abcdef\nab\nabcdef");
        let rows = Rows::new(&buffer, None);
        let (down, goal) = vertical(&buffer, &rows, 5, None, 1);
        assert_eq!((down, goal), (9, px(50.0)));
        let (down, goal) = vertical(&buffer, &rows, down, Some(goal), 1);
        assert_eq!((down, goal), (15, px(50.0)));
        // Past the ends.
        assert_eq!(vertical(&buffer, &rows, 3, None, -1), (0, px(30.0)));
        assert_eq!(vertical(&buffer, &rows, 12, None, 5), (16, px(20.0)));
        assert_eq!(vertical(&buffer, &rows, 12, None, -2), (2, px(20.0)));
        // Multibyte: x counts chars, offsets are bytes.
        let cjk = Buffer::new("中文字\nabc");
        let rows = Rows::new(&cjk, None);
        assert_eq!(vertical(&cjk, &rows, 6, None, -1), (0, px(20.0)));
        assert_eq!(vertical(&cjk, &rows, 12, None, -1), (6, px(20.0)));
        let empty = Buffer::new("");
        let rows = Rows::new(&empty, None);
        assert_eq!(vertical(&empty, &rows, 0, None, 1), (0, px(0.0)));
        assert_eq!(vertical(&empty, &rows, 0, None, -1), (0, px(0.0)));
    }

    #[test]
    fn vertical_moves_over_wrapped_rows() {
        let buffer = Buffer::new("abcdefgh\nxy");
        let rows = Rows::new(&buffer, Some(4));
        assert_eq!(vertical(&buffer, &rows, 1, None, 1), (5, px(10.0)));
        assert_eq!(vertical(&buffer, &rows, 5, None, 1), (10, px(10.0)));
        assert_eq!(
            vertical(&buffer, &rows, 3, Some(px(30.0)), 2),
            (11, px(30.0))
        );
    }

    const PAIRS: &[(char, char)] = &[('(', ')'), ('[', ']'), ('{', '}')];

    #[test]
    fn matching_brackets() {
        let buffer = Buffer::new("f(a[1], (b)) {\n  x\n}");
        assert_eq!(matching_bracket(&buffer, 1, PAIRS), Some((1, 11)));
        assert_eq!(matching_bracket(&buffer, 12, PAIRS), Some((1, 11)));
        assert_eq!(matching_bracket(&buffer, 11, PAIRS), Some((1, 11)));
        assert_eq!(matching_bracket(&buffer, 10, PAIRS), Some((8, 10)));
        assert_eq!(matching_bracket(&buffer, 3, PAIRS), Some((3, 5)));
        assert_eq!(matching_bracket(&buffer, 13, PAIRS), Some((13, 19)));
        assert_eq!(matching_bracket(&buffer, 20, PAIRS), Some((13, 19)));
        assert_eq!(matching_bracket(&buffer, 16, PAIRS), None);
        let unbalanced = Buffer::new("((a)");
        assert_eq!(matching_bracket(&unbalanced, 0, PAIRS), None);
        assert_eq!(matching_bracket(&Buffer::new(""), 0, PAIRS), None);
        let wide = Buffer::new("(中)");
        assert_eq!(matching_bracket(&wide, 5, PAIRS), Some((0, 4)));
    }

    #[test]
    fn brackets_enclosing_a_range() {
        let buffer = Buffer::new("{ a(b, [c]) d }");
        assert_eq!(enclosing_brackets(&buffer, 8..9, PAIRS), Some((7, 9)));
        assert_eq!(enclosing_brackets(&buffer, 7..10, PAIRS), Some((3, 10)));
        assert_eq!(enclosing_brackets(&buffer, 4..5, PAIRS), Some((3, 10)));
        assert_eq!(enclosing_brackets(&buffer, 2..12, PAIRS), Some((0, 14)));
        assert_eq!(enclosing_brackets(&buffer, 12..12, PAIRS), Some((0, 14)));
        assert_eq!(enclosing_brackets(&buffer, 0..15, PAIRS), None);
        // A range reaching past an inner pair's end belongs to the outer one.
        assert_eq!(enclosing_brackets(&buffer, 5..12, PAIRS), Some((0, 14)));
        assert_eq!(
            enclosing_brackets(&Buffer::new("()"), 1..1, PAIRS),
            Some((0, 1))
        );
        assert_eq!(enclosing_brackets(&Buffer::new(""), 0..0, PAIRS), None);
    }

    #[test]
    fn ranges_of_whole_lines() {
        let buffer = Buffer::new("a\nbb\nccc");
        assert_eq!(lines_range(&buffer, 0, 0), 0..2);
        assert_eq!(lines_range(&buffer, 1, 1), 2..5);
        // The last line, without a line break: the one before it goes.
        assert_eq!(lines_range(&buffer, 2, 2), 4..8);
        assert_eq!(lines_range(&buffer, 1, 2), 1..8);
        assert_eq!(lines_range(&buffer, 0, 2), 0..8);
        let trailing = Buffer::new("a\n");
        assert_eq!(lines_range(&trailing, 0, 0), 0..2);
        assert_eq!(lines_range(&trailing, 1, 1), 1..2);
        assert_eq!(lines_range(&Buffer::new(""), 0, 0), 0..0);
    }

    #[test]
    fn subwords_of_camel_and_snake_case() {
        let rights = |text: &str| {
            let buffer = Buffer::new(text);
            let mut stops = Vec::new();
            let mut at = 0;
            while at < buffer.len() {
                at = next_subword_end(&buffer, at, W);
                stops.push(at);
            }
            stops
        };
        let lefts = |text: &str| {
            let buffer = Buffer::new(text);
            let mut stops = Vec::new();
            let mut at = buffer.len();
            while at > 0 {
                at = prev_subword_start(&buffer, at, W);
                stops.push(at);
            }
            stops
        };
        assert_eq!(rights("fooBar_baz"), vec![3, 6, 10]);
        assert_eq!(lefts("fooBar_baz"), vec![7, 3, 0]);
        assert_eq!(rights("HTMLParser"), vec![4, 10]);
        assert_eq!(rights("__init__"), vec![6, 8]);
        assert_eq!(rights("get2Fast"), vec![4, 8]);
        // Whitespace is passed into the next word's first part; punctuation
        // moves as by words.
        assert_eq!(rights("a  fooBar"), vec![1, 6, 9]);
        assert_eq!(lefts("fooBar  x"), vec![8, 3, 0]);
        assert_eq!(rights("f(x)"), vec![1, 3, 4]);
        // Multibyte letters keep their case rules.
        assert_eq!(rights("éÉé"), vec![2, 6]);
        let empty = Buffer::new("");
        assert_eq!(next_subword_end(&empty, 0, W), 0);
        assert_eq!(prev_subword_start(&empty, 0, W), 0);
    }

    #[test]
    fn paragraphs_end_at_blank_lines() {
        // Lines: 0 "a", 1 "b", 2 "", 3 "  ", 4 "c", 5 "", 6 "d".
        let buffer = Buffer::new("a\nb\n\n  \nc\n\nd");
        let start = |line| buffer.line_start(line);
        assert_eq!(next_paragraph(&buffer, 0), start(2));
        assert_eq!(next_paragraph(&buffer, start(2)), start(5));
        assert_eq!(next_paragraph(&buffer, start(3)), start(5));
        assert_eq!(next_paragraph(&buffer, start(5)), buffer.len());
        assert_eq!(next_paragraph(&buffer, buffer.len()), buffer.len());
        assert_eq!(prev_paragraph(&buffer, buffer.len()), start(5));
        assert_eq!(prev_paragraph(&buffer, start(5)), start(3));
        assert_eq!(prev_paragraph(&buffer, start(4)), start(3));
        assert_eq!(prev_paragraph(&buffer, start(3)), 0);
        assert_eq!(prev_paragraph(&buffer, 1), 0);
        let empty = Buffer::new("");
        assert_eq!(next_paragraph(&empty, 0), 0);
        assert_eq!(prev_paragraph(&empty, 0), 0);
    }
}
