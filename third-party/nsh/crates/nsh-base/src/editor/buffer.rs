//! The editor's text: a rope, the edits made to it and their undo history.
//!
//! Offsets are byte offsets of the UTF-8 text, on char boundaries. Lines end
//! with `\n` only: `\r\n` and `\r` become `\n` as text comes in, so a text of
//! `n` line breaks has `n + 1` lines, the last one possibly empty.
//!
//! Line lookups go through the rope's own line index. Ropey's default
//! features also count `\u{0B}`, `\u{0C}`, `\u{85}`, `\u{2028}` and
//! `\u{2029}` as line breaks, and another crate of the build may turn them
//! on; while the text holds one of those (rare: a form feed in old C
//! sources), the buffer keeps a line index of its own instead.

use std::{borrow::Cow, collections::VecDeque, fmt, ops::Range, sync::OnceLock};

use ropey::Rope;

use super::{
    data::EditorPosition,
    types::{Point, Selections},
};

/// The undo steps kept; older ones are dropped.
const MAX_UNDO_STEPS: usize = 1000;
/// A step with this many edits takes no more: undoing it stays quick.
const MAX_EDITS_PER_STEP: usize = 10_000;

/// One change, as applied: `range` (in the text as it was just before this
/// change, i.e. after the earlier changes of the same list) was replaced by
/// `new_len` bytes. Applying a list in order turns the old text into the new
/// one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Change {
    /// What was replaced.
    pub(crate) range: Range<usize>,
    /// The bytes that took its place.
    pub(crate) new_len: usize,
}

/// How an edit groups into undo steps: runs of typing (or deleting) at one
/// place merge into one step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditKind {
    /// Typed text.
    Typing,
    /// Backspace or Delete.
    Deleting,
    /// Anything else: a step of its own.
    Other,
}

/// Which side of an edit an offset at its boundary sticks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Bias {
    /// Before what was inserted (the start of what replaced a range).
    Left,
    /// After what was inserted (the end of what replaced a range).
    Right,
}

/// Lines `first..first + old_count` of the text before a change list became
/// `first..first + new_count` after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LineSpan {
    /// The first line touched, the same before and after.
    pub(crate) first: usize,
    /// How many lines the span had before.
    pub(crate) old_count: usize,
    /// How many lines it has after.
    pub(crate) new_count: usize,
}

/// One replacement of an undo step: at `offset` (in the text as the earlier
/// edits of the step left it), `old` became `new`.
#[derive(Debug, Clone)]
struct Edit {
    offset: usize,
    old: String,
    new: String,
}

/// What one undo or redo replays.
#[derive(Debug, Clone)]
struct Step {
    edits: Vec<Edit>,
    /// The selections before the step: what undo restores.
    before: Selections,
    /// The selections after it: what redo restores.
    after: Selections,
    kind: EditKind,
}

/// The text of an editor, with its undo history.
pub(crate) struct Buffer {
    rope: Rope,
    version: u64,
    undo: VecDeque<Step>,
    redo: Vec<Step>,
    /// Whether the next edit may merge into the last undo step.
    open: bool,
    last_span: Option<LineSpan>,
    /// The chars ropey counts as line breaks besides `\n` in the text (only
    /// counted when ropey counts them).
    other_breaks: usize,
    /// The start of every line, while ropey's line index cannot be used.
    line_starts: Option<Vec<usize>>,
    /// Keeps `line_starts` whatever the text (tests of that path).
    always_index: bool,
}

impl fmt::Debug for Buffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Buffer")
            .field("len", &self.len())
            .field("lines", &self.line_count())
            .field("version", &self.version)
            .field("undo", &self.undo.len())
            .field("redo", &self.redo.len())
            .finish()
    }
}

impl Default for Buffer {
    fn default() -> Self {
        Buffer::new("")
    }
}

impl Buffer {
    /// A buffer of `text` (its line breaks normalized), with no history.
    /// The text as it is now, without the history: what a layout reads
    /// while the buffer itself is edited (the rope is shared, not copied).
    pub(crate) fn snapshot(&self) -> Buffer {
        Buffer {
            rope: self.rope.clone(),
            version: self.version,
            undo: VecDeque::new(),
            redo: Vec::new(),
            open: false,
            last_span: None,
            other_breaks: self.other_breaks,
            line_starts: self.line_starts.clone(),
            always_index: self.always_index,
        }
    }

    pub(crate) fn new(text: &str) -> Buffer {
        let mut buffer = Buffer {
            rope: Rope::new(),
            version: 0,
            undo: VecDeque::new(),
            redo: Vec::new(),
            open: false,
            last_span: None,
            other_breaks: 0,
            line_starts: None,
            always_index: false,
        };
        buffer.load(text);
        buffer
    }

    /// The text.
    pub(crate) fn rope(&self) -> &Rope {
        &self.rope
    }

    /// The whole text.
    pub(crate) fn text(&self) -> String {
        self.rope.to_string()
    }

    /// The text's length in bytes.
    pub(crate) fn len(&self) -> usize {
        self.rope.len_bytes()
    }

    /// Whether the text is empty.
    pub(crate) fn is_empty(&self) -> bool {
        self.rope.len_bytes() == 0
    }

    /// Grows with every change (edits, undo, redo, reset).
    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    /// How many lines there are (at least 1).
    pub(crate) fn line_count(&self) -> usize {
        match &self.line_starts {
            Some(starts) => starts.len(),
            None => self.rope.len_lines(),
        }
    }

    /// Where `line` starts (clamped to the last line).
    pub(crate) fn line_start(&self, line: usize) -> usize {
        let line = line.min(self.line_count() - 1);
        match &self.line_starts {
            Some(starts) => starts[line],
            None => self.rope.line_to_byte(line),
        }
    }

    /// Where `line` ends, before its `\n` (clamped to the last line).
    pub(crate) fn line_end(&self, line: usize) -> usize {
        if line + 1 < self.line_count() {
            self.line_start(line + 1) - 1
        } else {
            self.len()
        }
    }

    /// The bytes of `line`, without its `\n`.
    pub(crate) fn line_len(&self, line: usize) -> usize {
        self.line_end(line) - self.line_start(line)
    }

    /// The text of `line`, without its `\n`.
    pub(crate) fn line_text(&self, line: usize) -> String {
        self.slice(self.line_start(line)..self.line_end(line))
    }

    /// The line `offset` is on (the last one past the end).
    pub(crate) fn line_of(&self, offset: usize) -> usize {
        let offset = offset.min(self.len());
        match &self.line_starts {
            Some(starts) => starts.partition_point(|&start| start <= offset) - 1,
            None => self.rope.byte_to_line(offset),
        }
    }

    /// The line and column of `offset`.
    pub(crate) fn point(&self, offset: usize) -> Point {
        let offset = self.clip(offset);
        let line = self.line_of(offset);
        Point::new(line, offset - self.line_start(line))
    }

    /// The offset of `point`, clamped to its line's end and to a char
    /// boundary.
    pub(crate) fn offset(&self, point: Point) -> usize {
        let start = self.line_start(point.line);
        let end = self.line_end(point.line);
        self.clip(start.saturating_add(point.column).min(end))
    }

    /// `offset` clamped to the length and moved back onto a char boundary.
    pub(crate) fn clip(&self, offset: usize) -> usize {
        let offset = offset.min(self.len());
        self.rope.char_to_byte(self.rope.byte_to_char(offset))
    }

    /// The text of `range` (clipped).
    pub(crate) fn slice(&self, range: Range<usize>) -> String {
        let start = self.clip(range.start);
        let end = self.clip(range.end).max(start);
        self.rope.byte_slice(start..end).to_string()
    }

    /// The char starting at `offset`.
    pub(crate) fn char_at(&self, offset: usize) -> Option<char> {
        let index = self.rope.byte_to_char(self.clip(offset));
        self.rope.get_char(index)
    }

    /// The char ending at `offset`.
    pub(crate) fn char_before(&self, offset: usize) -> Option<char> {
        let index = self.rope.byte_to_char(self.clip(offset));
        index
            .checked_sub(1)
            .and_then(|index| self.rope.get_char(index))
    }

    /// The chars from `offset` on.
    pub(crate) fn chars_at(&self, offset: usize) -> impl Iterator<Item = char> + '_ {
        self.rope
            .chars_at(self.rope.byte_to_char(self.clip(offset)))
    }

    /// The chars before `offset`, nearest first.
    pub(crate) fn chars_before(&self, offset: usize) -> impl Iterator<Item = char> + '_ {
        let mut chars = self
            .rope
            .chars_at(self.rope.byte_to_char(self.clip(offset)));
        std::iter::from_fn(move || chars.prev())
    }

    /// The UTF-16 position (the JS API's, LSP's) of `offset`.
    pub(crate) fn position(&self, offset: usize) -> EditorPosition {
        let offset = self.clip(offset);
        let line = self.line_of(offset);
        let column = self.utf16_at(offset) - self.utf16_at(self.line_start(line));
        EditorPosition::new(saturate(line), saturate(column))
    }

    /// The offset of a UTF-16 position: a column past the line's end is its
    /// end, a line past the last the text's end, a column inside a
    /// surrogate pair the start of its char.
    pub(crate) fn offset_of(&self, position: EditorPosition) -> usize {
        let line = position.line as usize;
        if line >= self.line_count() {
            return self.len();
        }
        let start = self.utf16_at(self.line_start(line));
        let end = self.utf16_at(self.line_end(line));
        let unit = start.saturating_add(position.column as usize).min(end);
        self.rope.char_to_byte(self.rope.utf16_cu_to_char(unit))
    }

    /// Whether bytes `range` are ASCII, so their UTF-16 columns are their
    /// bytes. Answered at once when the whole text is ASCII.
    pub(crate) fn is_ascii(&self, range: Range<usize>) -> bool {
        self.rope.len_chars() == self.rope.len_bytes()
            || self
                .rope
                .byte_slice(range)
                .chunks()
                .all(|chunk| chunk.is_ascii())
    }

    /// Applies `edits` together: ranges of the text as it is now, sorted,
    /// not overlapping (an empty range inserts). `before` are the selections
    /// before the edit (what undo restores), `after` those after it (what
    /// redo restores). Returns the changes applied (empty when nothing
    /// changed).
    pub(crate) fn edit(
        &mut self,
        edits: Vec<(Range<usize>, String)>,
        before: &Selections,
        after: &Selections,
        kind: EditKind,
    ) -> Vec<Change> {
        let len = self.len();
        let mut applied = Vec::with_capacity(edits.len());
        let mut changes = Vec::with_capacity(edits.len());
        let mut span = None;
        // How far the text after the last edit moved, and where in the text
        // as it is now the next edit may start at the earliest.
        let mut delta = 0isize;
        let mut floor = 0;
        let mut word_break = false;
        for (range, text) in edits {
            let start = range.start.min(len);
            let end = range.end.clamp(start, len);
            let start = self.clip(start.saturating_add_signed(delta)).max(floor);
            let end = self.clip(end.saturating_add_signed(delta)).max(start);
            let new = if text.contains('\r') {
                normalize(&text).into_owned()
            } else {
                text
            };
            let old = self.slice(start..end);
            if old == new {
                floor = end;
                continue;
            }
            if kind == EditKind::Typing
                && new.starts_with(char::is_whitespace)
                && self.char_before(start).is_some_and(is_word_char)
            {
                word_break = true;
            }
            self.replace(start, &old, &new, &mut span);
            delta += new.len() as isize - old.len() as isize;
            floor = start + new.len();
            changes.push(Change {
                range: start..end,
                new_len: new.len(),
            });
            applied.push(Edit {
                offset: start,
                old,
                new,
            });
        }
        self.last_span = span;
        if changes.is_empty() {
            return changes;
        }
        self.version += 1;
        self.redo.clear();
        self.record(applied, before, after, kind, word_break);
        changes
    }

    /// Replaces the whole text as one undoable edit, changing only what
    /// differs (the common prefix and suffix stay).
    pub(crate) fn set_text(
        &mut self,
        text: &str,
        before: &Selections,
        after: &Selections,
    ) -> Vec<Change> {
        let text = normalize(text);
        let new = text.as_bytes();
        let old_len = self.len();
        let mut prefix = 0;
        for chunk in self.rope.chunks() {
            let chunk = chunk.as_bytes();
            let common = chunk
                .iter()
                .zip(&new[prefix..])
                .take_while(|(a, b)| a == b)
                .count();
            prefix += common;
            if common < chunk.len() {
                break;
            }
        }
        // Equal bytes before a position make it a boundary in both texts or
        // in neither (the lead byte decides the length).
        while !text.is_char_boundary(prefix) {
            prefix -= 1;
        }
        let most = (old_len - prefix).min(new.len() - prefix);
        let mut bytes = self.rope.bytes_at(old_len);
        let mut suffix = 0;
        while suffix < most && bytes.prev() == Some(new[new.len() - 1 - suffix]) {
            suffix += 1;
        }
        // Equal bytes from a position on make it a boundary in both or
        // neither.
        while !text.is_char_boundary(new.len() - suffix) {
            suffix -= 1;
        }
        let replacement = text[prefix..new.len() - suffix].to_string();
        self.edit(
            vec![(prefix..old_len - suffix, replacement)],
            before,
            after,
            EditKind::Other,
        )
    }

    /// A new document: the text, no history.
    #[cfg(test)]
    pub(crate) fn reset(&mut self, text: &str) {
        let old_count = self.line_count();
        self.load(text);
        self.version += 1;
        self.undo.clear();
        self.redo.clear();
        self.open = false;
        self.last_span = Some(LineSpan {
            first: 0,
            old_count,
            new_count: self.line_count(),
        });
    }

    /// Undoes the last step: the changes made and the selections to restore.
    pub(crate) fn undo(&mut self) -> Option<(Vec<Change>, Selections)> {
        let step = self.undo.pop_back()?;
        let mut span = None;
        let mut changes = Vec::with_capacity(step.edits.len());
        for edit in step.edits.iter().rev() {
            self.replace(edit.offset, &edit.new, &edit.old, &mut span);
            changes.push(Change {
                range: edit.offset..edit.offset + edit.new.len(),
                new_len: edit.old.len(),
            });
        }
        self.version += 1;
        self.last_span = span;
        self.open = false;
        let selections = step.before.clone();
        self.redo.push(step);
        Some((changes, selections))
    }

    /// Redoes the last step undone: the changes made and the selections to
    /// restore.
    pub(crate) fn redo(&mut self) -> Option<(Vec<Change>, Selections)> {
        let step = self.redo.pop()?;
        let mut span = None;
        let mut changes = Vec::with_capacity(step.edits.len());
        for edit in &step.edits {
            self.replace(edit.offset, &edit.old, &edit.new, &mut span);
            changes.push(Change {
                range: edit.offset..edit.offset + edit.old.len(),
                new_len: edit.new.len(),
            });
        }
        self.version += 1;
        self.last_span = span;
        self.open = false;
        let selections = step.after.clone();
        self.undo.push_back(step);
        Some((changes, selections))
    }

    /// Whether there is a step to undo.
    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Whether there is a step to redo.
    pub(crate) fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// The next edit starts a new undo step (a caret moved away, a pause).
    pub(crate) fn break_undo_group(&mut self) {
        self.open = false;
    }

    /// The lines the last change list (edit, set_text, undo, redo, reset:
    /// everything) touched, one span covering all its changes. What the
    /// highlighter and the display map lay out again.
    pub(crate) fn last_line_span(&self) -> Option<LineSpan> {
        self.last_span
    }

    /// The text replaced by `text`, its line breaks normalized.
    fn load(&mut self, text: &str) {
        let text = normalize(text);
        self.rope = Rope::from_str(&text);
        self.other_breaks = if ropey_counts_other_breaks() {
            count_other_breaks(&text)
        } else {
            0
        };
        self.line_starts = None;
        self.sync_line_starts();
    }

    /// Keeps a line index of the buffer's own exactly while ropey's counts
    /// lines differently.
    fn sync_line_starts(&mut self) {
        if !self.always_index && self.other_breaks == 0 {
            self.line_starts = None;
        } else if self.line_starts.is_none() {
            let mut starts = vec![0];
            let mut at = 0;
            for chunk in self.rope.chunks() {
                starts.extend(chunk.match_indices('\n').map(|(i, _)| at + i + 1));
                at += chunk.len();
            }
            self.line_starts = Some(starts);
        }
    }

    /// `old` at `start` becomes `new`, `span` grown by the lines it touches.
    fn replace(&mut self, start: usize, old: &str, new: &str, span: &mut Option<LineSpan>) {
        let end = start + old.len();
        let first = self.line_of(start);
        let old_count = 1 + newlines(old);
        let new_count = 1 + newlines(new);
        *span = Some(match *span {
            None => LineSpan {
                first,
                old_count,
                new_count,
            },
            // The span so far covers lines `acc.first..acc.first +
            // acc.new_count` of the text as it is now; this change covers
            // `first..first + old_count`. Lines before both are where they
            // were in the original text, lines after both shifted by each.
            Some(acc) => {
                let low = acc.first.min(first);
                let high = (acc.first + acc.new_count).max(first + old_count);
                LineSpan {
                    first: low,
                    old_count: high + acc.old_count - acc.new_count - low,
                    new_count: high + new_count - old_count - low,
                }
            }
        });

        let char_start = self.rope.byte_to_char(start);
        if !old.is_empty() {
            let char_end = self.rope.byte_to_char(end);
            self.rope.remove(char_start..char_end);
        }
        if !new.is_empty() {
            self.rope.insert(char_start, new);
        }

        if let Some(starts) = &mut self.line_starts {
            let low = starts.partition_point(|&s| s <= start);
            let high = starts.partition_point(|&s| s <= end);
            for s in &mut starts[high..] {
                *s = *s - old.len() + new.len();
            }
            starts.splice(
                low..high,
                new.match_indices('\n').map(|(i, _)| start + i + 1),
            );
        }
        if ropey_counts_other_breaks() {
            self.other_breaks =
                self.other_breaks - count_other_breaks(old) + count_other_breaks(new);
            self.sync_line_starts();
        }
    }

    /// Records `edits` as a new undo step or merges them into the last one.
    fn record(
        &mut self,
        edits: Vec<Edit>,
        before: &Selections,
        after: &Selections,
        kind: EditKind,
        word_break: bool,
    ) {
        let merge = self.open
            && kind != EditKind::Other
            && !word_break
            && self.undo.back().is_some_and(|last| {
                last.kind == kind
                    && last.edits.len() < MAX_EDITS_PER_STEP
                    && same_selections(&last.after, before)
            });
        self.open = true;
        if merge {
            let Some(last) = self.undo.back_mut() else {
                return;
            };
            last.after = after.clone();
            for edit in edits {
                coalesce(&mut last.edits, edit);
            }
            return;
        }
        self.undo.push_back(Step {
            edits,
            before: before.clone(),
            after: after.clone(),
            kind,
        });
        if self.undo.len() > MAX_UNDO_STEPS {
            self.undo.pop_front();
        }
    }

    /// The UTF-16 code units before `offset` (a char boundary).
    fn utf16_at(&self, offset: usize) -> usize {
        self.rope.char_to_utf16_cu(self.rope.byte_to_char(offset))
    }

    #[cfg(test)]
    fn with_line_index(text: &str) -> Buffer {
        let mut buffer = Buffer::new(text);
        buffer.always_index = true;
        buffer.sync_line_starts();
        buffer
    }
}

/// `offset` carried through `changes` (an offset inside a replaced range
/// goes to its start with `Bias::Left`, its new end with `Bias::Right`; at
/// an insertion point, before it with Left, after it with Right).
pub(crate) fn map_offset(changes: &[Change], mut offset: usize, bias: Bias) -> usize {
    for change in changes {
        let Range { start, end } = change.range;
        if offset < start {
            continue;
        }
        if start == end {
            if offset > start || bias == Bias::Right {
                offset += change.new_len;
            }
        } else if offset >= end {
            offset = offset - (end - start) + change.new_len;
        } else if offset > start {
            offset = match bias {
                Bias::Left => start,
                Bias::Right => start + change.new_len,
            };
        }
    }
    offset
}

/// Appends `edit` to a step's edits, joined with the last one when the two
/// make one replacement (a run of typing, of backspaces, of deletes).
fn coalesce(edits: &mut Vec<Edit>, edit: Edit) {
    if let Some(last) = edits.last_mut() {
        if edit.old.is_empty() && edit.offset == last.offset + last.new.len() {
            last.new.push_str(&edit.new);
            return;
        }
        if edit.new.is_empty() && last.new.is_empty() {
            if edit.offset + edit.old.len() == last.offset {
                last.offset = edit.offset;
                last.old.insert_str(0, &edit.old);
                return;
            }
            if edit.offset == last.offset {
                last.old.push_str(&edit.old);
                return;
            }
        }
    }
    edits.push(edit);
}

/// Whether two selection sets are at the same places (goals aside).
fn same_selections(a: &Selections, b: &Selections) -> bool {
    a.len() == b.len()
        && a.all()
            .iter()
            .zip(b.all())
            .all(|(a, b)| a.anchor == b.anchor && a.head == b.head)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text` with `\r\n` and `\r` turned into `\n`.
fn normalize(text: &str) -> Cow<'_, str> {
    if !text.contains('\r') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('\r') {
        out.push_str(&rest[..at]);
        out.push('\n');
        rest = &rest[at + 1..];
        if let Some(after) = rest.strip_prefix('\n') {
            rest = after;
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn newlines(text: &str) -> usize {
    text.bytes().filter(|&b| b == b'\n').count()
}

fn is_other_break(c: char) -> bool {
    matches!(c, '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

fn count_other_breaks(text: &str) -> usize {
    text.chars().filter(|&c| is_other_break(c)).count()
}

/// Whether ropey, as this build's features set it up, counts the other
/// Unicode line breaks.
fn ropey_counts_other_breaks() -> bool {
    static COUNTS: OnceLock<bool> = OnceLock::new();
    *COUNTS.get_or_init(|| Rope::from_str("\u{2028}").len_lines() > 1)
}

fn saturate(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{super::types::Selection, *};

    fn caret(at: usize) -> Selections {
        Selections::single(Selection::caret(at))
    }

    fn carets(at: &[usize]) -> Selections {
        Selections::new(at.iter().map(|&a| Selection::caret(a)).collect(), 0)
    }

    /// Types `text` char by char at `at`, as the commands do.
    fn type_text(buffer: &mut Buffer, mut at: usize, text: &str) -> usize {
        for c in text.chars() {
            let s = c.to_string();
            buffer.edit(
                vec![(at..at, s.clone())],
                &caret(at),
                &caret(at + s.len()),
                EditKind::Typing,
            );
            at += s.len();
        }
        at
    }

    fn backspace(buffer: &mut Buffer, at: usize) -> usize {
        let start = buffer.clip(at - 1);
        buffer.edit(
            vec![(start..at, String::new())],
            &caret(at),
            &caret(start),
            EditKind::Deleting,
        );
        start
    }

    /// The line starts of `text`, counted naively.
    fn naive_starts(text: &str) -> Vec<usize> {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        starts
    }

    fn check_lines(buffer: &Buffer) {
        let text = buffer.text();
        let starts = naive_starts(&text);
        assert_eq!(buffer.line_count(), starts.len(), "{text:?}");
        for (line, &start) in starts.iter().enumerate() {
            assert_eq!(buffer.line_start(line), start, "{text:?} line {line}");
            let end = starts.get(line + 1).map_or(text.len(), |s| s - 1);
            assert_eq!(buffer.line_end(line), end);
            assert_eq!(buffer.line_text(line), &text[start..end]);
        }
        for (offset, _) in text.char_indices().chain([(text.len(), ' ')]) {
            let line = starts.partition_point(|&s| s <= offset) - 1;
            assert_eq!(buffer.line_of(offset), line, "{text:?} at {offset}");
        }
    }

    #[test]
    fn empty_text_has_one_line() {
        let buffer = Buffer::new("");
        assert!(buffer.is_empty());
        assert_eq!(buffer.line_count(), 1);
        assert_eq!(buffer.line_start(0), 0);
        assert_eq!(buffer.line_end(0), 0);
        assert_eq!(buffer.line_text(5), "");
        assert_eq!(buffer.point(10), Point::new(0, 0));
        assert_eq!(buffer.char_at(0), None);
        assert_eq!(buffer.char_before(0), None);
        assert_eq!(buffer.position(3), EditorPosition::new(0, 0));
        assert_eq!(buffer.offset_of(EditorPosition::new(4, 4)), 0);
    }

    #[test]
    fn line_breaks_are_normalized() {
        let buffer = Buffer::new("a\r\nb\rc\n\r\n");
        assert_eq!(buffer.text(), "a\nb\nc\n\n");
        assert_eq!(buffer.line_count(), 5);
        assert_eq!(buffer.line_text(4), "");
        assert_eq!(normalize("\r\r\n\r"), "\n\n\n");
        assert!(matches!(normalize("plain\n"), Cow::Borrowed(_)));
    }

    #[test]
    fn lines_and_points() {
        let buffer = Buffer::new("fn main() {\n\tlet 名前 = \"😀\";\n}");
        check_lines(&buffer);
        assert_eq!(buffer.line_count(), 3);
        assert_eq!(buffer.line_len(0), 11);
        assert_eq!(buffer.line_text(1), "\tlet 名前 = \"😀\";");
        // The last line, without a line break; lines past it clamp to it.
        assert_eq!(buffer.line_end(2), buffer.len());
        assert_eq!(buffer.line_start(9), buffer.line_start(2));
        let start = buffer.line_start(1);
        assert_eq!(buffer.point(start + 5), Point::new(1, 5));
        // Inside 名 (3 bytes from column 5): back onto its start.
        assert_eq!(buffer.point(start + 6), Point::new(1, 5));
        assert_eq!(buffer.offset(Point::new(1, 6)), start + 5);
        // Past the line's end: its end.
        assert_eq!(buffer.offset(Point::new(0, 99)), 11);
        assert_eq!(buffer.offset(Point::new(9, 99)), buffer.len());
        assert_eq!(buffer.point(buffer.len() + 4), Point::new(2, 1));
    }

    #[test]
    fn clip_and_chars() {
        let text = "a名👍🏽b";
        let buffer = Buffer::new(text);
        assert_eq!(buffer.clip(2), 1);
        assert_eq!(buffer.clip(4), 4);
        assert_eq!(buffer.clip(100), text.len());
        assert_eq!(buffer.char_at(1), Some('名'));
        assert_eq!(buffer.char_at(2), Some('名'));
        assert_eq!(buffer.char_before(4), Some('名'));
        assert_eq!(buffer.char_before(8), Some('👍'));
        assert_eq!(buffer.char_at(text.len()), None);
        assert_eq!(buffer.char_before(text.len()), Some('b'));
        assert_eq!(buffer.chars_at(4).collect::<String>(), "👍🏽b");
        assert_eq!(
            buffer.chars_before(8).collect::<Vec<_>>(),
            vec!['👍', '名', 'a']
        );
        assert_eq!(buffer.chars_before(0).next(), None);
        assert_eq!(buffer.slice(1..8), "名👍");
        #[allow(clippy::reversed_empty_ranges)]
        let backward = 8..1;
        assert_eq!(buffer.slice(backward), "");
        assert_eq!(buffer.slice(2..100), "名👍🏽b");
    }

    #[test]
    fn utf16_positions() {
        let buffer = Buffer::new("ab\n名😀x\n👍🏽");
        let line1 = buffer.line_start(1);
        assert_eq!(buffer.position(line1), EditorPosition::new(1, 0));
        assert_eq!(buffer.position(line1 + 3), EditorPosition::new(1, 1));
        // 😀 is two UTF-16 units.
        assert_eq!(buffer.position(line1 + 7), EditorPosition::new(1, 3));
        assert_eq!(buffer.offset_of(EditorPosition::new(1, 3)), line1 + 7);
        // Inside the surrogate pair: the char's start.
        assert_eq!(buffer.offset_of(EditorPosition::new(1, 2)), line1 + 3);
        assert_eq!(buffer.offset_of(EditorPosition::new(1, 4)), line1 + 8);
        // Past the line's end: the end, not the next line.
        assert_eq!(buffer.offset_of(EditorPosition::new(1, 40)), line1 + 8);
        assert_eq!(buffer.offset_of(EditorPosition::new(0, 9)), 2);
        // An emoji with a modifier: two chars, four units.
        let line2 = buffer.line_start(2);
        assert_eq!(buffer.position(buffer.len()), EditorPosition::new(2, 4));
        assert_eq!(buffer.offset_of(EditorPosition::new(2, 2)), line2 + 4);
        assert_eq!(buffer.offset_of(EditorPosition::new(7, 0)), buffer.len());
        for offset in 0..=buffer.len() {
            let offset = buffer.clip(offset);
            assert_eq!(buffer.offset_of(buffer.position(offset)), offset);
        }
    }

    #[test]
    fn other_unicode_breaks_are_not_lines() {
        for buffer in [
            Buffer::new("a\u{2028}b\u{0C}c\u{85}\nd\u{0B}\u{2029}"),
            Buffer::with_line_index("a\u{2028}b\u{0C}c\u{85}\nd\u{0B}\u{2029}"),
        ] {
            assert_eq!(buffer.line_count(), 2);
            check_lines(&buffer);
        }
        let mut buffer = Buffer::new("one\ntwo");
        buffer.edit(
            vec![(3..3, "\u{0C}".into())],
            &caret(3),
            &caret(4),
            EditKind::Other,
        );
        check_lines(&buffer);
        buffer.undo();
        check_lines(&buffer);
        assert!(buffer.line_starts.is_none());
    }

    #[test]
    fn edits_apply_together() {
        let mut buffer = Buffer::new("one two three");
        let changes = buffer.edit(
            vec![
                (0..3, "1".into()),
                (4..4, "and ".into()),
                (8..13, "3".into()),
            ],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert_eq!(buffer.text(), "1 and two 3");
        assert_eq!(
            changes,
            vec![
                Change {
                    range: 0..3,
                    new_len: 1
                },
                Change {
                    range: 2..2,
                    new_len: 4
                },
                Change {
                    range: 10..15,
                    new_len: 1
                },
            ]
        );
        assert_eq!(buffer.version(), 1);
    }

    #[test]
    fn edits_normalize_and_clip() {
        let mut buffer = Buffer::new("名x");
        // Ranges inside 名 and past the end clip onto boundaries: the second
        // starts at 名.
        buffer.edit(
            vec![(1..1, "a\r\nb".into()), (2..90, "\r".into())],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert_eq!(buffer.text(), "a\nb\n");
        check_lines(&buffer);
    }

    #[test]
    fn unchanged_edits_change_nothing() {
        let mut buffer = Buffer::new("same");
        let changes = buffer.edit(
            vec![(0..4, "same".into()), (4..4, String::new())],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert!(changes.is_empty());
        assert_eq!(buffer.version(), 0);
        assert!(!buffer.can_undo());
        assert_eq!(buffer.last_line_span(), None);
    }

    #[test]
    fn undo_and_redo_restore_text_and_selections() {
        let mut buffer = Buffer::new("hello");
        let before = Selections::single(Selection::new(0, 5));
        buffer.edit(
            vec![(0..5, "bye\nnow".into())],
            &before,
            &caret(7),
            EditKind::Other,
        );
        assert!(buffer.can_undo());
        let (changes, selections) = buffer.undo().unwrap();
        assert_eq!(buffer.text(), "hello");
        assert_eq!(selections, before);
        assert_eq!(
            changes,
            vec![Change {
                range: 0..7,
                new_len: 5
            }]
        );
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 0,
                old_count: 2,
                new_count: 1
            })
        );
        assert!(buffer.can_redo());
        let (changes, selections) = buffer.redo().unwrap();
        assert_eq!(buffer.text(), "bye\nnow");
        assert_eq!(selections, caret(7));
        assert_eq!(
            changes,
            vec![Change {
                range: 0..5,
                new_len: 7
            }]
        );
        assert_eq!(buffer.version(), 3);
        assert!(buffer.redo().is_none());
    }

    #[test]
    fn multi_edit_undo_changes_are_sequential() {
        let mut buffer = Buffer::new("a b c");
        buffer.edit(
            vec![
                (0..1, "xx".into()),
                (2..3, "yyy".into()),
                (4..5, String::new()),
            ],
            &carets(&[0, 2, 4]),
            &carets(&[2, 6, 7]),
            EditKind::Other,
        );
        assert_eq!(buffer.text(), "xx yyy ");
        let (changes, _) = buffer.undo().unwrap();
        assert_eq!(buffer.text(), "a b c");
        // Each range is in the text the earlier changes left.
        let mut text = String::from("xx yyy ");
        let olds = ["c", "b", "a"];
        for (change, old) in changes.iter().zip(olds) {
            assert_eq!(change.new_len, old.len());
            text.replace_range(change.range.clone(), old);
        }
        assert_eq!(text, "a b c");
    }

    #[test]
    fn typing_groups_by_word() {
        let mut buffer = Buffer::new("");
        type_text(&mut buffer, 0, "foo bar");
        assert_eq!(buffer.text(), "foo bar");
        buffer.undo();
        assert_eq!(buffer.text(), "foo");
        buffer.undo();
        assert_eq!(buffer.text(), "");
        assert!(!buffer.can_undo());
        buffer.redo();
        buffer.redo();
        assert_eq!(buffer.text(), "foo bar");
    }

    #[test]
    fn typing_after_a_move_or_a_break_is_a_new_step() {
        let mut buffer = Buffer::new("");
        type_text(&mut buffer, 0, "ab");
        // The caret moved back before typing on.
        type_text(&mut buffer, 0, "cd");
        assert_eq!(buffer.text(), "cdab");
        buffer.undo();
        assert_eq!(buffer.text(), "ab");

        let mut buffer = Buffer::new("");
        let at = type_text(&mut buffer, 0, "ab");
        buffer.break_undo_group();
        type_text(&mut buffer, at, "cd");
        buffer.undo();
        assert_eq!(buffer.text(), "ab");
    }

    #[test]
    fn deleting_groups() {
        let mut buffer = Buffer::new("hello 名");
        let mut at = buffer.len();
        for _ in 0..4 {
            at = backspace(&mut buffer, at);
        }
        assert_eq!(buffer.text(), "hel");
        assert_eq!(buffer.undo.back().unwrap().edits.len(), 1);
        let (_, selections) = buffer.undo().unwrap();
        assert_eq!(buffer.text(), "hello 名");
        assert_eq!(selections, caret(buffer.len()));

        // Forward deletes at one place.
        let mut buffer = Buffer::new("abcd");
        for _ in 0..3 {
            buffer.edit(
                vec![(0..1, String::new())],
                &caret(0),
                &caret(0),
                EditKind::Deleting,
            );
        }
        assert_eq!(buffer.text(), "d");
        buffer.undo();
        assert_eq!(buffer.text(), "abcd");
        assert!(!buffer.can_undo());
    }

    #[test]
    fn typing_then_deleting_are_two_steps() {
        let mut buffer = Buffer::new("");
        let at = type_text(&mut buffer, 0, "abc");
        backspace(&mut buffer, at);
        assert_eq!(buffer.text(), "ab");
        buffer.undo();
        assert_eq!(buffer.text(), "abc");
        buffer.undo();
        assert_eq!(buffer.text(), "");
    }

    #[test]
    fn other_edits_never_merge() {
        let mut buffer = Buffer::new("");
        for i in 0..3 {
            buffer.edit(
                vec![(i..i, "x".into())],
                &caret(i),
                &caret(i + 1),
                EditKind::Other,
            );
        }
        buffer.undo();
        assert_eq!(buffer.text(), "xx");
    }

    #[test]
    fn multi_caret_typing_merges() {
        let mut buffer = Buffer::new("a\nb");
        let mut at = [1, 3];
        for c in ["x", "y"] {
            let after = [at[0] + 1, at[1] + 2];
            buffer.edit(
                vec![(at[0]..at[0], c.into()), (at[1]..at[1], c.into())],
                &carets(&at),
                &carets(&after),
                EditKind::Typing,
            );
            at = after;
        }
        assert_eq!(buffer.text(), "axy\nbxy");
        let (_, selections) = buffer.undo().unwrap();
        assert_eq!(buffer.text(), "a\nb");
        assert_eq!(selections, carets(&[1, 3]));
        assert!(!buffer.can_undo());
    }

    #[test]
    fn a_new_edit_clears_redo() {
        let mut buffer = Buffer::new("");
        type_text(&mut buffer, 0, "a");
        buffer.undo();
        assert!(buffer.can_redo());
        type_text(&mut buffer, 0, "b");
        assert!(!buffer.can_redo());
    }

    #[test]
    fn history_is_capped() {
        let mut buffer = Buffer::new("");
        for i in 0..MAX_UNDO_STEPS + 5 {
            buffer.edit(
                vec![(i..i, "x".into())],
                &caret(i),
                &caret(i + 1),
                EditKind::Other,
            );
        }
        let mut steps = 0;
        while buffer.undo().is_some() {
            steps += 1;
        }
        assert_eq!(steps, MAX_UNDO_STEPS);
        assert_eq!(buffer.len(), 5);
    }

    #[test]
    fn set_text_changes_only_the_difference() {
        let mut buffer = Buffer::new("let a = 1;\nlet b = 2;\n");
        let changes = buffer.set_text("let a = 1;\nlet c = 3;\n", &caret(0), &caret(0));
        assert_eq!(
            changes,
            vec![Change {
                range: 15..20,
                new_len: 5
            }]
        );
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 1,
                old_count: 1,
                new_count: 1
            })
        );
        buffer.undo();
        assert_eq!(buffer.text(), "let a = 1;\nlet b = 2;\n");

        // é and è share their first byte: the change starts at the char.
        let mut buffer = Buffer::new("aé");
        let changes = buffer.set_text("aè", &caret(0), &caret(0));
        assert_eq!(
            changes,
            vec![Change {
                range: 1..3,
                new_len: 2
            }]
        );
        assert_eq!(buffer.text(), "aè");

        // 😀 (F0 9F 98 80) and 🙀 (F0 9F 99 80) share their last byte too.
        let mut buffer = Buffer::new("x😀y");
        buffer.set_text("x🙀y", &caret(0), &caret(0));
        assert_eq!(buffer.text(), "x🙀y");

        let mut buffer = Buffer::new("abab");
        assert_eq!(
            buffer.set_text("ab", &caret(0), &caret(0)),
            vec![Change {
                range: 2..4,
                new_len: 0
            }]
        );
        assert!(buffer.set_text("ab", &caret(0), &caret(0)).is_empty());
        buffer.set_text("x\r\nab", &caret(0), &caret(0));
        assert_eq!(buffer.text(), "x\nab");
        buffer.set_text("", &caret(0), &caret(0));
        assert!(buffer.is_empty());
    }

    #[test]
    fn set_text_on_a_big_text() {
        let text: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
        let mut buffer = Buffer::new(&text);
        let changed = text.replacen("line 10000\n", "line ten thousand\n", 1);
        let changes = buffer.set_text(&changed, &caret(0), &caret(0));
        assert_eq!(changes.len(), 1);
        assert_eq!(buffer.text(), changed);
        let span = buffer.last_line_span().unwrap();
        assert_eq!(span.first, 10000);
    }

    #[test]
    fn reset_drops_history() {
        let mut buffer = Buffer::new("a\nb\nc");
        type_text(&mut buffer, 0, "x");
        let version = buffer.version();
        buffer.reset("new\r\ntext");
        assert_eq!(buffer.text(), "new\ntext");
        assert!(buffer.version() > version);
        assert!(!buffer.can_undo());
        assert!(!buffer.can_redo());
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 0,
                old_count: 3,
                new_count: 2
            })
        );
    }

    #[test]
    fn line_spans() {
        let mut buffer = Buffer::new("a\nb\nc\nd");
        buffer.edit(
            vec![(3..3, "\n".into())],
            &caret(3),
            &caret(4),
            EditKind::Other,
        );
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 1,
                old_count: 1,
                new_count: 2
            })
        );
        // "a\nb\n\nc\nd": join lines 1..=3, and edit line 4.
        buffer.edit(
            vec![(3..5, String::new()), (7..8, "dd\ne".into())],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert_eq!(buffer.text(), "a\nbc\ndd\ne");
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 1,
                old_count: 4,
                new_count: 3
            })
        );
        // Edits far apart: the span covers the lines between them.
        let mut buffer = Buffer::new("0\n1\n2\n3\n4");
        buffer.edit(
            vec![(0..1, "x\ny".into()), (8..9, String::new())],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert_eq!(
            buffer.last_line_span(),
            Some(LineSpan {
                first: 0,
                old_count: 5,
                new_count: 6
            })
        );
    }

    #[test]
    fn mapping_offsets() {
        let changes = [
            Change {
                range: 2..2,
                new_len: 3,
            },
            Change {
                range: 8..10,
                new_len: 1,
            },
        ];
        assert_eq!(map_offset(&changes, 1, Bias::Left), 1);
        assert_eq!(map_offset(&changes, 2, Bias::Left), 2);
        assert_eq!(map_offset(&changes, 2, Bias::Right), 5);
        assert_eq!(map_offset(&changes, 3, Bias::Left), 6);
        // 5 → 8 by the insertion, the replaced range's start.
        assert_eq!(map_offset(&changes, 5, Bias::Right), 8);
        // 6 → 9, inside 8..10.
        assert_eq!(map_offset(&changes, 6, Bias::Left), 8);
        assert_eq!(map_offset(&changes, 6, Bias::Right), 9);
        // 7 → 10, the replaced range's end: its new end.
        assert_eq!(map_offset(&changes, 7, Bias::Left), 9);
        assert_eq!(map_offset(&changes, 20, Bias::Left), 22);
        assert_eq!(map_offset(&[], 4, Bias::Right), 4);
    }

    #[test]
    fn mapped_offsets_follow_real_edits() {
        let mut buffer = Buffer::new("abc def ghi");
        let changes = buffer.edit(
            vec![(0..0, "1".into()), (4..7, "D".into()), (11..11, "!".into())],
            &caret(0),
            &caret(0),
            EditKind::Other,
        );
        assert_eq!(buffer.text(), "1abc D ghi!");
        // "g" stays "g".
        assert_eq!(map_offset(&changes, 8, Bias::Left), 7);
        assert_eq!(buffer.char_at(7), Some('g'));
        assert_eq!(map_offset(&changes, 11, Bias::Left), 10);
        assert_eq!(map_offset(&changes, 11, Bias::Right), 11);
    }

    /// Edits of every kind against a model string, with ropey's line index
    /// and with the buffer's own, then undone back to the start.
    #[test]
    fn edits_match_a_model() {
        let original = "first\n\tsecond 名前\n\nfourth😀\u{0C}\nlast";
        for indexed in [false, true] {
            let mut buffer = if indexed {
                Buffer::with_line_index(original)
            } else {
                Buffer::new(original)
            };
            let mut model = String::from(original);
            let mut seed = 0x2545_f491_u64;
            let mut next = |bound: usize| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed % (bound as u64 + 1)) as usize
            };
            let pieces = [
                "", "x", "\n", "名", "👍🏽", "\r\n", "\t", "ab\ncd\n", "\u{2028}",
            ];
            for round in 0..300 {
                let mut a = buffer.clip(next(model.len()));
                let mut b = buffer.clip(next(model.len()));
                if a > b {
                    std::mem::swap(&mut a, &mut b);
                }
                let piece = pieces[next(pieces.len() - 1)];
                let changes = buffer.edit(
                    vec![(a..b, piece.into())],
                    &caret(a),
                    &caret(a + piece.len()),
                    EditKind::Other,
                );
                let old_model = model.clone();
                model.replace_range(a..b, &normalize(piece));
                assert_eq!(buffer.text(), model, "round {round}");
                if !changes.is_empty() {
                    let span = buffer.last_line_span().unwrap();
                    let old_lines = naive_starts(&old_model).len();
                    let new_lines = naive_starts(&model).len();
                    assert_eq!(
                        old_lines - span.old_count,
                        new_lines - span.new_count,
                        "lines outside the span stay"
                    );
                }
                check_lines(&buffer);
            }
            while buffer.undo().is_some() {}
            assert_eq!(buffer.text(), original);
            check_lines(&buffer);
            while buffer.redo().is_some() {}
            assert_eq!(buffer.text(), model);
            check_lines(&buffer);
        }
    }
}
