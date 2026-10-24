//! Terminal input editing. Native edits use grapheme boundaries; the
//! engine and JavaScript see UTF-16 offsets and monotonically increasing
//! edit counts, as they do on the graphical backends.

use std::ops::Range;

use nsh_core::input_tokens::{InputTokenRule, InputTokenSpan, InputTokens, TokenEdit};
use nsh_core::{AutoCapitalize, InputConfig, KeyboardType};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug)]
struct Snapshot {
    text: String,
    anchor: usize,
    cursor: usize,
    pending: Option<Range<usize>>,
}

/// One input's retained text, selection and undo history.
#[derive(Clone, Debug, Default)]
pub(crate) struct Editor {
    text: String,
    anchor: usize,
    cursor: usize,
    count: u32,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    goal_column: Option<usize>,
    tokens: InputTokens,
}

impl Editor {
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn count(&self) -> u32 {
        self.count
    }

    pub(crate) fn set_tokens(&mut self, rules: &[InputTokenRule]) -> bool {
        if !self.tokens.set_rules(rules, &self.text) {
            return false;
        }
        let before = (self.anchor, self.cursor);
        (self.anchor, self.cursor) = self.tokens.select(self.anchor, self.cursor);
        if before != (self.anchor, self.cursor) {
            self.goal_column = None;
            true
        } else {
            false
        }
    }

    pub(crate) fn token_spans(&self) -> &[InputTokenSpan] {
        self.tokens.spans()
    }

    pub(crate) fn selected_range(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }

    pub(crate) fn selected(&self) -> &str {
        &self.text[self.selected_range()]
    }

    pub(crate) fn selection(&self) -> (u32, u32) {
        let range = self.selected_range();
        (
            utf16_len(&self.text[..range.start]),
            utf16_len(&self.text[..range.end]),
        )
    }

    /// A stale controlled value must never erase text typed since its turn.
    pub(crate) fn controlled(&mut self, text: String, count: u32) -> bool {
        if count < self.count {
            return false;
        }
        // Values are editing data; the renderer filters terminal controls
        // without changing the source text or its UTF-16 offsets.
        self.assign_text(text)
    }

    /// Label selection uses the original UTF-16 offsets carried by the
    /// shaped layout, including characters hidden by the text renderer.
    pub(crate) fn label_text(&mut self, text: &str) -> bool {
        self.assign_text(text.to_owned())
    }

    fn assign_text(&mut self, text: String) -> bool {
        if text == self.text {
            return false;
        }
        let at_end = self.cursor == self.text.len();
        let old_cursor = utf16_len(&self.text[..self.cursor]);
        self.text = text;
        self.cursor = if at_end {
            self.text.len()
        } else {
            byte_at_utf16(&self.text, old_cursor)
        };
        self.tokens.reset(&self.text);
        (self.anchor, self.cursor) = self.tokens.select(self.cursor, self.cursor);
        self.goal_column = None;
        self.undo.clear();
        self.redo.clear();
        true
    }

    pub(crate) fn set_selection(&mut self, start: u32, end: u32) -> bool {
        let start = byte_at_utf16(&self.text, start);
        let end = byte_at_utf16(&self.text, end);
        self.select_bytes(start, end)
    }

    /// Host edits must name an exact UTF-16 grapheme boundary rather than
    /// rounding a stale or malformed selection into a different edit.
    pub(crate) fn is_boundary_utf16(&self, offset: u32) -> bool {
        let mut units = 0u32;
        if offset == 0 {
            return true;
        }
        for grapheme in self.text.graphemes(true) {
            units = units.saturating_add(utf16_len(grapheme));
            if units >= offset {
                return units == offset;
            }
        }
        false
    }

    fn select_bytes(&mut self, anchor: usize, cursor: usize) -> bool {
        let (anchor, cursor) = self.tokens.select(anchor, cursor);
        let changed = (self.anchor, self.cursor) != (anchor, cursor);
        self.anchor = anchor;
        self.cursor = cursor;
        self.goal_column = None;
        changed
    }

    pub(crate) fn select_all(&mut self) -> bool {
        self.select_bytes(0, self.text.len())
    }

    pub(crate) fn move_to(&mut self, offset: u32, extend: bool) -> bool {
        let offset = byte_at_utf16(&self.text, offset);
        self.select_bytes(if extend { self.anchor } else { offset }, offset)
    }

    pub(crate) fn horizontal(&mut self, forward: bool, word: bool, extend: bool) -> bool {
        let range = self.selected_range();
        let offset = if !extend && !range.is_empty() && !word {
            if forward { range.end } else { range.start }
        } else if word {
            self.word_boundary(self.cursor, forward)
        } else {
            self.boundary(self.cursor, forward)
        };
        let offset = self.tokens.step(offset, forward);
        self.select_bytes(if extend { self.anchor } else { offset }, offset)
    }

    pub(crate) fn home_end(&mut self, end: bool, document: bool, extend: bool) -> bool {
        let offset = if document {
            if end { self.text.len() } else { 0 }
        } else if end {
            self.text[self.cursor..]
                .find(['\r', '\n'])
                .map_or(self.text.len(), |i| self.cursor + i)
        } else {
            self.text[..self.cursor]
                .rfind(['\r', '\n'])
                .map_or(0, |i| i + 1)
        };
        let offset = self.tokens.step(offset, end);
        self.select_bytes(if extend { self.anchor } else { offset }, offset)
    }

    pub(crate) fn vertical(
        &mut self,
        down: bool,
        extend: bool,
        columns: usize,
        secure: bool,
        alignments: (usize, usize),
    ) -> bool {
        let (row, column) = self.cursor_cell(columns, secure);
        let goal = self
            .goal_column
            .unwrap_or(column.saturating_add(alignments.0));
        let row = if down {
            row.saturating_add(1)
        } else {
            row.saturating_sub(1)
        };
        let offset = self.offset_at_inner(
            row,
            goal.saturating_sub(alignments.1),
            columns,
            secure,
            false,
        );
        let offset = self.tokens.step(byte_at_utf16(&self.text, offset), down);
        let offset = utf16_len(&self.text[..offset]);
        let changed = self.move_to(offset, extend);
        self.goal_column = Some(goal);
        changed
    }

    fn boundary(&self, offset: usize, forward: bool) -> usize {
        if forward {
            self.text
                .grapheme_indices(true)
                .map(|(i, _)| i)
                .find(|&i| i > offset)
                .unwrap_or(self.text.len())
        } else {
            self.text
                .grapheme_indices(true)
                .map(|(i, _)| i)
                .take_while(|&i| i < offset)
                .last()
                .unwrap_or(0)
        }
    }

    fn word_boundary(&self, offset: usize, forward: bool) -> usize {
        if forward {
            self.text
                .unicode_word_indices()
                .map(|(i, word)| i + word.len())
                .find(|&i| i > offset)
                .unwrap_or(self.text.len())
        } else {
            self.text
                .unicode_word_indices()
                .map(|(i, _)| i)
                .take_while(|&i| i < offset)
                .last()
                .unwrap_or(0)
        }
    }

    /// An explicit text-entry policy for hosts implementing an on-screen
    /// keyboard. Physical terminal keys and paste keep their literal text.
    pub(crate) fn typed(&mut self, incoming: &str, config: &InputConfig) -> bool {
        if !config.editable || incoming.is_empty() {
            return false;
        }
        let text = sanitize(incoming, config.multiline);
        if text.is_empty() {
            return false;
        }
        if config.secure
            || config.keyboard != KeyboardType::Default
            || config.auto_capitalize == AutoCapitalize::None
        {
            return self.type_literal(&text, config);
        }
        let prefix = &self.text[..self.selected_range().start];
        let text = match config.auto_capitalize {
            AutoCapitalize::Characters => text.to_uppercase(),
            AutoCapitalize::Words => capitalize_words(prefix, &text),
            AutoCapitalize::Sentences => capitalize_sentences(prefix, &text),
            AutoCapitalize::None => text,
        };
        self.type_literal(&text, config)
    }

    pub(crate) fn type_literal(&mut self, incoming: &str, config: &InputConfig) -> bool {
        self.replace_inner(incoming, config, TokenEdit::Typing)
            .unwrap_or(false)
    }

    pub(crate) fn replace(&mut self, incoming: &str, config: &InputConfig) -> bool {
        self.replace_inner(incoming, config, TokenEdit::Commit)
            .unwrap_or(false)
    }

    pub(crate) fn replace_range(
        &mut self,
        start: u32,
        end: u32,
        incoming: &str,
        config: &InputConfig,
    ) -> bool {
        self.replace_at(
            byte_at_utf16(&self.text, start)..byte_at_utf16(&self.text, end),
            incoming,
            config,
            TokenEdit::Commit,
        )
    }

    fn replace_at(
        &mut self,
        range: Range<usize>,
        incoming: &str,
        config: &InputConfig,
        kind: TokenEdit,
    ) -> bool {
        let previous = (
            self.anchor,
            self.cursor,
            self.goal_column,
            self.tokens.pending(),
        );
        self.anchor = range.start;
        self.cursor = range.end;
        match self.replace_inner(incoming, config, kind) {
            Some(changed) => {
                // The replacement range is not the selection the user had
                // before accepting a completion. Undo restores that selection.
                if changed && let Some(snapshot) = self.undo.last_mut() {
                    snapshot.anchor = previous.0;
                    snapshot.cursor = previous.1;
                    snapshot.pending = previous.3;
                }
                changed
            }
            None => {
                (self.anchor, self.cursor, self.goal_column) = (previous.0, previous.1, previous.2);
                self.tokens.restore(&self.text, previous.3);
                false
            }
        }
    }

    fn replace_inner(
        &mut self,
        incoming: &str,
        config: &InputConfig,
        kind: TokenEdit,
    ) -> Option<bool> {
        if !config.editable {
            return None;
        }
        let text = if config.multiline {
            incoming.to_owned()
        } else {
            sanitize(incoming, false)
        };
        let text: String = if config.keyboard == KeyboardType::Number {
            text.chars().filter(char::is_ascii_digit).collect()
        } else {
            text
        };
        // A rejected key or paste does not delete the current selection.
        if !incoming.is_empty() && text.is_empty() {
            return None;
        }
        let range = self.tokens.expand(self.selected_range());
        let retained = utf16_len(&self.text) - utf16_len(&self.text[range.clone()]);
        let limit = config.max_length.map(|max| max.saturating_sub(retained));
        let mut units = 0u32;
        let fit: String = text
            .graphemes(true)
            .take_while(|g| {
                units = units.saturating_add(utf16_len(g));
                limit.is_none_or(|limit| units <= limit)
            })
            .collect();
        if !text.is_empty() && fit.is_empty() {
            return None;
        }
        if self.text[range.clone()] == fit {
            self.tokens.edited(&self.text, &range, fit.len(), kind);
            self.select_bytes(range.start + fit.len(), range.start + fit.len());
            return Some(false);
        }
        self.record();
        self.text.replace_range(range.clone(), &fit);
        self.tokens.edited(&self.text, &range, fit.len(), kind);
        let cursor = range.start + fit.len();
        // Combining text inserted beside a cluster may merge with it.
        self.cursor = ceil_grapheme(&self.text, cursor);
        (self.anchor, self.cursor) = self.tokens.select(self.cursor, self.cursor);
        self.goal_column = None;
        self.count = self.count.saturating_add(1);
        Some(true)
    }

    pub(crate) fn delete(&mut self, backward: bool, word: bool, config: &InputConfig) -> bool {
        if !config.editable {
            return false;
        }
        let range = if self.selected_range().is_empty() {
            let offset = if word {
                self.word_boundary(self.cursor, !backward)
            } else {
                self.boundary(self.cursor, !backward)
            };
            if offset == self.cursor {
                return false;
            }
            offset.min(self.cursor)..offset.max(self.cursor)
        } else {
            self.selected_range()
        };
        self.replace_at(range, "", config, TokenEdit::Delete)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            anchor: self.anchor,
            cursor: self.cursor,
            pending: self.tokens.pending(),
        }
    }

    fn record(&mut self) {
        let snapshot = self.snapshot();
        self.undo.push(snapshot);
        self.redo.clear();
    }

    fn restore(&mut self, snapshot: Snapshot) {
        self.text = snapshot.text;
        self.tokens.restore(&self.text, snapshot.pending);
        (self.anchor, self.cursor) = self.tokens.select(snapshot.anchor, snapshot.cursor);
        self.goal_column = None;
        self.count = self.count.saturating_add(1);
    }

    pub(crate) fn undo(&mut self, config: &InputConfig) -> bool {
        if !config.editable {
            return false;
        }
        let Some(snapshot) = self.undo.pop() else {
            return false;
        };
        let current = self.snapshot();
        self.redo.push(current);
        self.restore(snapshot);
        true
    }

    pub(crate) fn redo(&mut self, config: &InputConfig) -> bool {
        if !config.editable {
            return false;
        }
        let Some(snapshot) = self.redo.pop() else {
            return false;
        };
        let current = self.snapshot();
        self.undo.push(current);
        self.restore(snapshot);
        true
    }

    #[cfg(test)]
    pub(crate) fn display(&self, secure: bool) -> String {
        if !secure {
            return self.text.clone();
        }
        self.text
            .graphemes(true)
            .map(|g| {
                if matches!(g, "\n" | "\r" | "\r\n") {
                    "\n"
                } else {
                    "•"
                }
            })
            .collect()
    }

    pub(crate) fn cursor_cell(&self, columns: usize, secure: bool) -> (usize, usize) {
        let mut result = (0, 0);
        self.walk_cells(columns, secure, |offset, row, column| {
            if offset <= self.cursor {
                result = (row, column)
            }
        });
        result
    }

    pub(crate) fn cell_extent(&self, columns: usize, secure: bool) -> (usize, usize) {
        let mut extent = (0, 0);
        self.walk_cells(columns, secure, |_, row, column| {
            extent.0 = extent.0.max(row);
            extent.1 = extent.1.max(column);
        });
        extent
    }

    /// Finds the nearest caret boundary on a visual line, including tabs,
    /// wide glyphs, masked passwords and wrapped continuation lines.
    pub(crate) fn offset_at(&self, row: usize, column: usize, columns: usize, secure: bool) -> u32 {
        self.offset_at_inner(row, column, columns, secure, true)
    }

    fn offset_at_inner(
        &self,
        row: usize,
        column: usize,
        columns: usize,
        secure: bool,
        atoms: bool,
    ) -> u32 {
        let mut closest = (usize::MAX, usize::MAX, 0);
        self.walk_cells(columns, secure, |offset, r, c| {
            if atoms && !self.tokens.is_caret(offset) {
                return;
            }
            let distance = (r.abs_diff(row), c.abs_diff(column), offset);
            if (distance.0, distance.1) < (closest.0, closest.1) {
                closest = distance;
            }
        });
        utf16_len(&self.text[..closest.2])
    }

    fn walk_cells(&self, columns: usize, secure: bool, mut visit: impl FnMut(usize, usize, usize)) {
        let columns = columns.max(1);
        let (mut row, mut column) = (0usize, 0usize);
        for (offset, grapheme) in self.text.grapheme_indices(true) {
            if matches!(grapheme, "\n" | "\r" | "\r\n") {
                visit(offset, row, column);
                row += 1;
                column = 0;
                continue;
            }
            let width = if secure {
                1
            } else if grapheme == "\t" {
                4 - column % 4
            } else {
                UnicodeWidthStr::width(grapheme)
            };
            if column > 0 && column.saturating_add(width) > columns {
                row += 1;
                column = 0;
            }
            visit(offset, row, column);
            column = column.saturating_add(width);
        }
        if column >= columns {
            row += column / columns;
            column %= columns;
        }
        visit(self.text.len(), row, column);
    }
}

fn capitalize_words(prefix: &str, incoming: &str) -> String {
    // Segment the prefix together with the insertion so apostrophes and
    // letters spanning the caret still belong to the same Unicode word.
    let mut context = String::with_capacity(prefix.len().saturating_add(incoming.len()));
    context.push_str(prefix);
    context.push_str(incoming);
    let mut result = String::with_capacity(incoming.len());
    let mut copied = prefix.len();
    for (start, word) in context.unicode_word_indices() {
        let Some((offset, letter)) = word.char_indices().find(|(_, c)| c.is_alphabetic()) else {
            continue;
        };
        let offset = start + offset;
        if offset >= prefix.len() {
            result.push_str(&context[copied..offset]);
            result.extend(letter.to_uppercase());
            copied = offset + letter.len_utf8();
        }
    }
    result.push_str(&context[copied..]);
    result
}

fn capitalize_sentences(prefix: &str, incoming: &str) -> String {
    let mut result = String::with_capacity(incoming.len());
    let mut sentence_start = true;
    let mut terminator = false;
    for (inserted, c) in prefix
        .chars()
        .map(|c| (false, c))
        .chain(incoming.chars().map(|c| (true, c)))
    {
        let uppercase = sentence_start && c.is_alphabetic();
        match c {
            '\n' | '\r' => {
                sentence_start = true;
                terminator = false;
            }
            c if c.is_whitespace() => {
                sentence_start |= terminator;
            }
            '.' | '!' | '?' | '。' | '！' | '？' => terminator = true,
            // Quotes and brackets between a sentence and its whitespace
            // must not hide its punctuation or consume its first letter.
            '\'' | '"' | '‘' | '’' | '“' | '”' | '«' | '»' | '(' | ')' | '[' | ']' | '{' | '}'
            | '「' | '」' | '『' | '』' => {}
            c => {
                if c.is_alphanumeric() {
                    sentence_start = false;
                }
                terminator = false;
            }
        }
        if inserted {
            if uppercase {
                result.extend(c.to_uppercase());
            } else {
                result.push(c);
            }
        }
    }
    result
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count().min(u32::MAX as usize) as u32
}

fn byte_at_utf16(text: &str, offset: u32) -> usize {
    let mut units = 0u32;
    for (i, grapheme) in text.grapheme_indices(true) {
        let end = units.saturating_add(utf16_len(grapheme));
        if offset < end {
            return i;
        }
        units = end;
    }
    text.len()
}

fn ceil_grapheme(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .map(|(i, _)| i)
        .find(|&i| i >= offset)
        .unwrap_or(text.len())
}

/// Typed controls and single-line paste follow the field's entry policy.
/// Multiline values/paste retain their source bytes; painting filters controls.
fn sanitize(text: &str, multiline: bool) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter_map(|c| match c {
            '\n' if !multiline => Some(' '),
            '\n' | '\t' => Some(c),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grapheme_editing_and_utf16_selection() {
        let mut editor = Editor::default();
        let config = InputConfig::default();
        assert!(editor.replace("a👨‍👩‍👧e\u{301}中", &config));
        assert_eq!(editor.selection(), (12, 12));
        assert!(editor.horizontal(false, false, false));
        assert_eq!(editor.selection(), (11, 11));
        assert!(editor.delete(true, false, &config));
        assert_eq!(editor.text(), "a👨‍👩‍👧中");
        assert!(editor.delete(true, false, &config));
        assert_eq!(editor.text(), "a中");
        editor.set_selection(1, 2);
        assert_eq!(editor.selected(), "中");

        let rule = InputTokenRule::new(
            r"(?:^|\s)(?P<token>/skill:[a-z]+)",
            Default::default(),
            true,
        )
        .unwrap();
        let mut editor = Editor::default();
        editor.set_tokens(&[rule]);
        editor.replace("/skill:one tail", &config);
        editor.set_selection(0, 0);
        assert!(editor.horizontal(true, false, false));
        assert_eq!(editor.selection(), (10, 10));
        assert!(editor.horizontal(false, false, false));
        assert_eq!(editor.selection(), (0, 0));
        assert_eq!(editor.offset_at(0, 8, 80, false), 10);
        assert!(editor.vertical(true, false, 4, false, (0, 0)));
        assert_eq!(editor.selection(), (10, 10));
        assert!(editor.vertical(false, false, 4, false, (0, 0)));
        assert_eq!(editor.selection(), (0, 0));
        editor.set_selection(2, 4);
        assert_eq!(editor.selected(), "/skill:one");
        assert!(editor.delete(true, false, &config));
        assert_eq!(editor.text(), " tail");
        assert!(editor.undo(&config));
        assert_eq!(editor.text(), "/skill:one tail");
        assert_eq!(editor.selected(), "/skill:one");
        assert!(editor.redo(&config));
        assert_eq!(editor.text(), " tail");

        editor.controlled(String::new(), editor.count());
        for character in "/skill:one".chars() {
            assert!(editor.type_literal(&character.to_string(), &config));
        }
        assert_eq!(editor.tokens.pending(), Some(0..10));
        assert!(!editor.controlled("/skill:one".into(), editor.count()));
        assert_eq!(editor.tokens.pending(), Some(0..10));
        assert!(editor.delete(true, false, &config));
        assert_eq!(editor.text(), "/skill:on");
        assert_eq!(editor.tokens.pending(), Some(0..9));
        assert!(editor.undo(&config));
        assert_eq!(editor.tokens.pending(), Some(0..10));
        assert!(editor.replace_range(0, 10, "/skill:two", &config));
        assert_eq!(editor.tokens.pending(), None);
        assert!(editor.undo(&config));
        assert_eq!(editor.text(), "/skill:one");
        assert_eq!(editor.tokens.pending(), Some(0..10));
        editor.set_selection(0, 0);
        assert!(editor.delete(false, false, &config));
        assert_eq!(editor.text(), "skill:one");
    }

    #[test]
    fn stale_controlled_values_and_history() {
        let mut editor = Editor::default();
        let config = InputConfig::default();
        editor.controlled("hello".into(), 0);
        editor.replace("中", &config);
        assert!(!editor.controlled("hello".into(), 0));
        assert_eq!(editor.text(), "hello中");
        assert!(editor.undo(&config));
        assert_eq!(editor.text(), "hello");
        assert!(editor.redo(&config));
        assert_eq!(editor.text(), "hello中");
        assert_eq!(editor.count(), 3);
        assert!(editor.controlled("server".into(), 3));
        assert!(!editor.undo(&config));
    }

    #[test]
    fn utf16_limit_does_not_split_clusters_or_erase_rejected_selection() {
        let mut editor = Editor::default();
        let config = InputConfig {
            max_length: Some(3),
            ..InputConfig::default()
        };
        editor.replace("a😀b", &config);
        assert_eq!(editor.text(), "a😀");
        editor.set_selection(0, 1);
        assert!(!editor.replace("🇨🇳", &config));
        assert_eq!(editor.text(), "a😀");
        assert_eq!(editor.selected(), "a");
        editor.replace("z", &config);
        assert_eq!(editor.text(), "z😀");
    }

    #[test]
    fn paste_sanitization_numeric_and_read_only() {
        let mut editor = Editor::default();
        let mut config = InputConfig::default();
        editor.replace("a\r\nb\x1b[31m\0", &config);
        assert_eq!(editor.text(), "a b[31m");
        editor.select_all();
        config.keyboard = KeyboardType::Number;
        editor.replace("a12-３", &config);
        assert_eq!(editor.text(), "12");
        config.editable = false;
        assert!(!editor.replace("3", &config));
        assert!(!editor.delete(true, false, &config));
        assert!(!editor.undo(&config));
    }

    #[test]
    fn visual_navigation_wide_glyphs_wrap_and_passwords() {
        let mut editor = Editor::default();
        let config = InputConfig {
            multiline: true,
            ..InputConfig::default()
        };
        editor.replace("a中b\nc", &config);
        assert_eq!(editor.cursor_cell(3, false), (2, 1));
        editor.set_selection(1, 1);
        assert_eq!(editor.cursor_cell(3, false), (0, 1));
        editor.vertical(true, false, 3, false, (0, 0));
        assert_eq!(editor.selection(), (3, 3));
        assert_eq!(editor.display(true), "•••\n•");
        assert_eq!(editor.offset_at(0, 2, 10, true), 2);
    }

    #[test]
    fn combining_insert_stays_on_boundary() {
        let mut editor = Editor::default();
        let config = InputConfig::default();
        editor.controlled("e".into(), editor.count());
        editor.replace("\u{301}", &config);
        assert_eq!(editor.selection(), (2, 2));
        editor.horizontal(false, false, false);
        assert_eq!(editor.selection(), (0, 0));
    }

    #[test]
    fn label_source_keeps_hidden_utf16_units_for_shaped_selection() {
        let mut editor = Editor::default();
        editor.label_text("a\x1bb");
        editor.set_selection(2, 3);
        assert_eq!(editor.selected(), "b");
        assert_eq!(editor.selection(), (2, 3));
        editor.controlled("a\x1bb".into(), 0);
        assert_eq!(editor.text(), "a\x1bb");
    }

    #[test]
    fn host_edit_offsets_require_exact_utf16_grapheme_boundaries() {
        let mut editor = Editor::default();
        editor.controlled("a😀e\u{301}中".into(), 0);
        for offset in [0, 1, 3, 5, 6] {
            assert!(editor.is_boundary_utf16(offset), "{offset}");
        }
        // Neither a surrogate pair nor a combining sequence is split.
        for offset in [2, 4, 7, u32::MAX] {
            assert!(!editor.is_boundary_utf16(offset), "{offset}");
        }
        let empty = Editor::default();
        assert!(empty.is_boundary_utf16(0));
        assert!(!empty.is_boundary_utf16(1));
    }

    #[test]
    fn explicit_word_capitalization_respects_context_and_literal_paste() {
        let mut editor = Editor::default();
        let config = InputConfig {
            auto_capitalize: AutoCapitalize::Words,
            ..InputConfig::default()
        };
        assert!(editor.typed("élise don't-stop", &config));
        assert_eq!(editor.text(), "Élise Don't-Stop");
        editor.controlled("don'".into(), editor.count());
        editor.typed("t", &config);
        assert_eq!(editor.text(), "don't");
        editor.typed(" ", &config);
        editor.typed("é", &config);
        editor.typed("lise", &config);
        assert_eq!(editor.text(), "don't Élise");
        editor.replace(" pasted words", &config);
        assert_eq!(editor.text(), "don't Élise pasted words");

        editor.controlled("hello world".into(), editor.count());
        editor.set_selection(6, 11);
        editor.typed("friend", &config);
        assert_eq!(editor.text(), "hello Friend");
        editor.set_selection(1, 5);
        editor.typed("i", &config);
        assert_eq!(editor.text(), "hi Friend");
    }

    #[test]
    fn explicit_sentence_capitalization_handles_typing_and_punctuation() {
        let mut editor = Editor::default();
        let config = InputConfig {
            multiline: true,
            ..InputConfig::default()
        };
        editor.typed("hello", &config);
        editor.typed(" there. ", &config);
        editor.typed("“élise?!” yes。 next\nnew line", &config);
        assert_eq!(editor.text(), "Hello there. “Élise?!” Yes。 Next\nNew line");

        editor.controlled("version 3.14 and example.".into(), editor.count());
        editor.typed("com lower", &config);
        assert_eq!(editor.text(), "version 3.14 and example.com lower");
        editor.controlled("hello. world".into(), editor.count());
        editor.set_selection(7, 12);
        editor.typed("friend", &config);
        assert_eq!(editor.text(), "hello. Friend");
    }

    #[test]
    fn capitalization_expansion_obeys_grapheme_limits_and_undo() {
        let mut editor = Editor::default();
        let config = InputConfig {
            auto_capitalize: AutoCapitalize::Characters,
            max_length: Some(5),
            ..InputConfig::default()
        };
        editor.typed("ße\u{301}😀", &config);
        assert_eq!(editor.text(), "SSE\u{301}");
        assert_eq!(editor.selection(), (4, 4));
        assert_eq!(editor.count(), 1);
        assert!(editor.undo(&config));
        assert_eq!(editor.text(), "");
        assert!(editor.redo(&config));
        assert_eq!(editor.text(), "SSE\u{301}");

        editor.set_selection(0, 2);
        let tight = InputConfig {
            max_length: Some(3),
            ..config
        };
        assert!(!editor.typed("é\u{301}", &tight));
        assert_eq!(editor.selected(), "SS");
    }

    #[test]
    fn explicit_capitalization_keeps_secure_and_specialized_inputs_literal() {
        let mut editor = Editor::default();
        let mut config = InputConfig {
            auto_capitalize: AutoCapitalize::Characters,
            ..InputConfig::default()
        };
        config.secure = true;
        editor.typed("secret", &config);
        assert_eq!(editor.text(), "secret");
        config.secure = false;
        for keyboard in [
            KeyboardType::Decimal,
            KeyboardType::Numeric,
            KeyboardType::NumbersAndPunctuation,
            KeyboardType::Email,
            KeyboardType::Phone,
            KeyboardType::Url,
        ] {
            editor.select_all();
            config.keyboard = keyboard;
            editor.typed("mixedCase", &config);
            assert_eq!(editor.text(), "mixedCase");
        }
        editor.select_all();
        config.keyboard = KeyboardType::Number;
        editor.typed("abc123", &config);
        assert_eq!(editor.text(), "123");

        config.keyboard = KeyboardType::Default;
        config.auto_capitalize = AutoCapitalize::None;
        editor.select_all();
        editor.typed("literal", &config);
        assert_eq!(editor.text(), "literal");
        editor.select_all();
        assert!(!editor.typed("\x1b\0", &config));
        assert!(!editor.typed("", &config));
        assert_eq!(editor.selected(), "literal");
        config.editable = false;
        assert!(!editor.typed("replacement", &config));
        assert_eq!(editor.selected(), "literal");
    }
}
