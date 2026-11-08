//! The editing model of a text input, without a window (the Windows and
//! GPUI backends draw it with their own text engines): the text, the
//! selection, caret stops and word boundaries, undo and redo, and the IME
//! composition shown at the caret. Offsets are bytes of the UTF-8 text,
//! always on character boundaries; JS sees UTF-16 units (converted by the
//! helpers at the end).

/// How far a caret movement or a deletion goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    /// One user-perceived character (a base character with its marks).
    Char,
    /// To the next word boundary.
    Word,
}

/// What an edit was, to merge runs of typing (or of deleting) into one
/// undo step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Typing,
    Deleting,
    Other,
}

/// The text and selection at one point of the history.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    text: String,
    anchor: usize,
    caret: usize,
}

/// Text an input method is composing, shown at the caret until it is
/// committed or cancelled.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Composition {
    /// The text being composed.
    pub text: String,
    /// The caret inside it (bytes).
    pub cursor: usize,
    /// The clause being converted (bytes of `text`), drawn with a thicker
    /// underline.
    pub target: Option<(usize, usize)>,
}

impl Composition {
    /// `text` composed with the caret at `cursor` and the clause `target`
    /// being converted (bytes of `text`).
    pub fn new(text: String, cursor: usize, target: Option<(usize, usize)>) -> Self {
        Composition {
            text,
            cursor,
            target,
        }
    }
}

/// The most undo steps kept.
const MAX_UNDO: usize = 200;

/// A text input's text, selection and history.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct Model {
    text: String,
    /// Where the selection started (the end that stays when extending).
    anchor: usize,
    /// Where the caret is (the end that moves).
    caret: usize,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    /// The last edit, for merging; `None` after the caret moved.
    last: Option<EditKind>,
    /// The IME's text, if it composes.
    pub composition: Option<Composition>,
}

impl Model {
    /// The text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The caret.
    pub fn caret(&self) -> usize {
        self.caret
    }

    /// The selection's fixed end.
    #[cfg(test)]
    pub fn anchor(&self) -> usize {
        self.anchor
    }

    /// The selection, `start <= end`.
    pub fn selection(&self) -> (usize, usize) {
        (self.anchor.min(self.caret), self.anchor.max(self.caret))
    }

    /// True when some text is selected.
    pub fn has_selection(&self) -> bool {
        self.anchor != self.caret
    }

    /// The selected text.
    pub fn selected(&self) -> &str {
        let (s, e) = self.selection();
        &self.text[s..e]
    }

    /// Replaces the text without history (a value from JS), keeping the
    /// caret where it was, or at the end if it was there.
    pub fn set_text(&mut self, text: &str) {
        let at_end = self.caret >= self.text.len();
        let caret = if at_end {
            text.len()
        } else {
            floor(text, self.caret.min(text.len()))
        };
        self.text.clear();
        self.text.push_str(text);
        self.anchor = caret;
        self.caret = caret;
        // The old history would bring back text JS replaced.
        self.undo.clear();
        self.redo.clear();
        self.last = None;
        self.composition = None;
    }

    /// Selects from `anchor` to `caret` (clamped to the text, moved onto
    /// character boundaries).
    pub fn select(&mut self, anchor: usize, caret: usize) {
        let anchor = floor(&self.text, anchor.min(self.text.len()));
        let caret = floor(&self.text, caret.min(self.text.len()));
        if (anchor, caret) != (self.anchor, self.caret) {
            self.last = None;
        }
        self.anchor = anchor;
        self.caret = caret;
    }

    /// Moves the caret to `to`, extending the selection or not.
    pub fn move_to(&mut self, to: usize, extend: bool) {
        let anchor = if extend { self.anchor } else { to };
        self.select(anchor, to);
    }

    /// Moves the caret by `unit` (`forward` or back). Without `extend`, a
    /// selection collapses to its end in that direction instead.
    pub fn step(&mut self, unit: Unit, forward: bool, extend: bool) {
        if !extend && self.has_selection() && unit == Unit::Char {
            let (s, e) = self.selection();
            let to = if forward { e } else { s };
            return self.select(to, to);
        }
        let to = self.boundary(self.caret, unit, forward);
        self.move_to(to, extend);
    }

    /// The position `unit` away from `at`.
    pub fn boundary(&self, at: usize, unit: Unit, forward: bool) -> usize {
        match (unit, forward) {
            (Unit::Char, true) => next_cluster(&self.text, at),
            (Unit::Char, false) => prev_cluster(&self.text, at),
            (Unit::Word, true) => word_right(&self.text, at),
            (Unit::Word, false) => word_left(&self.text, at),
        }
    }

    /// Selects everything.
    pub fn select_all(&mut self) {
        self.select(0, self.text.len());
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            anchor: self.anchor,
            caret: self.caret,
        }
    }

    /// Records the state before an edit of `kind`, unless it continues a
    /// run of the same kind.
    fn record(&mut self, kind: EditKind) {
        if kind == EditKind::Other || self.last != Some(kind) {
            self.undo.push(self.snapshot());
            if self.undo.len() > MAX_UNDO {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.last = Some(kind);
    }

    /// Replaces the selection with `text`, clipped to what `max_len`
    /// (UTF-16 units of the whole text) leaves room for. Returns what was
    /// inserted; `None` when nothing changed.
    pub fn insert(&mut self, text: &str, max_len: Option<u32>) -> Option<String> {
        let (s, e) = self.selection();
        let fit = match max_len {
            Some(max) => {
                let kept = utf16_len(&self.text[..s]) + utf16_len(&self.text[e..]);
                clip_utf16(text, (max as usize).saturating_sub(kept))
            }
            None => text,
        };
        if fit.is_empty() && s == e {
            return None;
        }
        // A run of typing merges; a paste or a replaced selection does not.
        let typing = s == e && fit.chars().count() == 1 && !fit.starts_with('\n');
        self.record(if typing {
            EditKind::Typing
        } else {
            EditKind::Other
        });
        self.text.replace_range(s..e, fit);
        let caret = s + fit.len();
        self.anchor = caret;
        self.caret = caret;
        Some(fit.to_owned())
    }

    /// Deletes the selection, or `unit` before (`forward == false`) or
    /// after the caret. True when something was deleted.
    pub fn delete(&mut self, unit: Unit, forward: bool) -> bool {
        let (s, e) = if self.has_selection() {
            self.selection()
        } else if forward {
            (self.caret, self.boundary(self.caret, unit, true))
        } else {
            // Backspace takes one code point, as Windows' editors do: an
            // accent typed after its letter goes alone.
            let start = match unit {
                Unit::Char => prev_char(&self.text, self.caret),
                Unit::Word => word_left(&self.text, self.caret),
            };
            (start, self.caret)
        };
        if s == e {
            return false;
        }
        self.record(if unit == Unit::Char && self.anchor == self.caret {
            EditKind::Deleting
        } else {
            EditKind::Other
        });
        self.text.replace_range(s..e, "");
        self.anchor = s;
        self.caret = s;
        true
    }

    /// There is an edit to undo.
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Undoes the last edit; true when there was one.
    pub fn undo(&mut self) -> bool {
        let Some(snap) = self.undo.pop() else {
            return false;
        };
        self.redo.push(self.snapshot());
        self.restore(snap);
        true
    }

    /// Redoes the last undone edit; true when there was one.
    pub fn redo(&mut self) -> bool {
        let Some(snap) = self.redo.pop() else {
            return false;
        };
        self.undo.push(self.snapshot());
        self.restore(snap);
        true
    }

    fn restore(&mut self, snap: Snapshot) {
        self.text = snap.text;
        self.anchor = snap.anchor;
        self.caret = snap.caret;
        self.last = None;
    }

    /// The word (or run of spaces, or punctuation) at `at`, for double
    /// clicks.
    pub fn word_at(&self, at: usize) -> (usize, usize) {
        word_at(&self.text, at)
    }

    /// The line (between line breaks) at `at`, for triple clicks.
    pub fn line_at(&self, at: usize) -> (usize, usize) {
        let at = at.min(self.text.len());
        let start = self.text[..at].rfind('\n').map_or(0, |i| i + 1);
        let end = self.text[at..]
            .find('\n')
            .map_or(self.text.len(), |i| at + i);
        (start, end)
    }

    /// The text shown: the text with the composition at the caret.
    pub fn display(&self) -> std::borrow::Cow<'_, str> {
        match &self.composition {
            Some(c) if !c.text.is_empty() => {
                let mut s = String::with_capacity(self.text.len() + c.text.len());
                s.push_str(&self.text[..self.caret]);
                s.push_str(&c.text);
                s.push_str(&self.text[self.caret..]);
                s.into()
            }
            _ => std::borrow::Cow::Borrowed(&self.text),
        }
    }

    /// The UTF-16 offset in the shown text (`secure`: one bullet per
    /// character) of text offset `at`.
    pub fn to_display(&self, at: usize, secure: bool) -> u32 {
        let units = |s: &str| {
            if secure {
                s.chars().count()
            } else {
                utf16_len(s)
            }
        };
        let mut u = units(&self.text[..at.min(self.text.len())]);
        if let Some(c) = &self.composition
            && at > self.caret
        {
            u += units(&c.text);
        }
        u as u32
    }

    /// The text offset of UTF-16 offset `u` in the shown text; offsets in
    /// the composition go to the caret.
    pub fn text_at(&self, u: u32, secure: bool) -> usize {
        let comp = match &self.composition {
            Some(c) if !c.text.is_empty() => Some((self.to_display(self.caret, secure), &c.text)),
            _ => None,
        };
        let mut u = u as usize;
        if let Some((at, text)) = comp {
            let len = if secure {
                text.chars().count()
            } else {
                utf16_len(text)
            };
            if u >= at as usize + len {
                u -= len;
            } else if u > at as usize {
                return self.caret;
            }
        }
        if secure {
            self.text
                .char_indices()
                .nth(u)
                .map_or(self.text.len(), |(i, _)| i)
        } else {
            utf16_to_byte(&self.text, u as u32)
        }
    }

    /// Where the caret shows in the shown text (inside the composition
    /// while there is one).
    pub fn display_caret(&self, secure: bool) -> u32 {
        let base = self.to_display(self.caret, secure);
        match &self.composition {
            Some(c) => base + utf16_len(&c.text[..c.cursor.min(c.text.len())]) as u32,
            None => base,
        }
    }
}

/// The largest character boundary of `s` at or before `at`.
pub fn floor(s: &str, mut at: usize) -> usize {
    at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The character before `at`.
fn prev_char(s: &str, at: usize) -> usize {
    s[..at].char_indices().next_back().map_or(0, |(i, _)| i)
}

/// True when `c` joins the character before it into one cluster: marks,
/// variation selectors, emoji modifiers and tags, and what follows a
/// zero-width joiner.
fn extends(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F
        | 0x0483..=0x0489
        | 0x0591..=0x05BD
        | 0x0610..=0x061A
        | 0x064B..=0x065F
        | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E
        | 0x1AB0..=0x1AFF
        | 0x1DC0..=0x1DFF
        | 0x200C..=0x200D
        | 0x20D0..=0x20FF
        | 0x3099..=0x309A
        | 0xFE00..=0xFE0F
        | 0xFE20..=0xFE2F
        | 0x1F3FB..=0x1F3FF
        | 0xE0020..=0xE007F
        | 0xE0100..=0xE01EF)
}

fn regional(c: char) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&(c as u32))
}

/// The end of the cluster starting at `at`.
pub fn next_cluster(s: &str, at: usize) -> usize {
    let mut chars = s[at..].char_indices().peekable();
    let Some((_, first)) = chars.next() else {
        return s.len();
    };
    let mut prev = first;
    // Two regional indicators make one flag.
    let mut flag = regional(first);
    while let Some(&(i, c)) = chars.peek() {
        let joined = prev == '\u{200D}' || extends(c) || (flag && regional(c));
        if !joined {
            return at + i;
        }
        if regional(c) {
            flag = false;
        }
        prev = c;
        chars.next();
    }
    s.len()
}

/// The start of the cluster ending at `at`.
pub fn prev_cluster(s: &str, at: usize) -> usize {
    // Clusters are found forward from the line's start: flags pair up from
    // there.
    let start = s[..at].rfind('\n').map_or(0, |i| i + 1);
    let mut pos = start;
    if at == start {
        return prev_char(s, at);
    }
    loop {
        let next = next_cluster(s, pos);
        if next >= at {
            return pos;
        }
        pos = next;
    }
}

/// What a character counts as, for word boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Space,
    Word,
    Ideograph,
    Punct,
}

fn class(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if is_ideograph(c) {
        Class::Ideograph
    } else if c.is_alphanumeric() || c == '_' || c == '\'' || extends(c) {
        Class::Word
    } else {
        Class::Punct
    }
}

/// CJK ideographs, kana and Hangul: a run of them is one word (Windows'
/// editors have no dictionary either).
fn is_ideograph(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF | 0x20000..=0x3134F)
}

/// Ctrl+Right: past the word at `at` and the spaces after it.
pub fn word_right(s: &str, at: usize) -> usize {
    let mut chars = s[at..].char_indices().peekable();
    let Some(&(_, first)) = chars.peek() else {
        return s.len();
    };
    let first = class(first);
    if first != Class::Space {
        while let Some(&(_, c)) = chars.peek() {
            if class(c) != first {
                break;
            }
            chars.next();
        }
    }
    while let Some(&(i, c)) = chars.peek() {
        if c == '\n' && first != Class::Space {
            return at + i;
        }
        if class(c) != Class::Space {
            return at + i;
        }
        chars.next();
    }
    s.len()
}

/// Ctrl+Left: back over spaces, then to the start of the word before.
pub fn word_left(s: &str, at: usize) -> usize {
    let mut chars = s[..at].char_indices().rev().peekable();
    while let Some(&(_, c)) = chars.peek() {
        if class(c) != Class::Space {
            break;
        }
        chars.next();
    }
    let Some(&(mut pos, c)) = chars.peek() else {
        return 0;
    };
    let kind = class(c);
    for (i, c) in chars {
        if class(c) != kind {
            break;
        }
        pos = i;
    }
    pos
}

/// The run of one class of characters around `at` (a double click).
pub fn word_at(s: &str, at: usize) -> (usize, usize) {
    let at = floor(s, at);
    // The character after the point, or the one before it at the end.
    let probe = if at < s.len() { at } else { prev_char(s, at) };
    let Some(c) = s[probe..].chars().next() else {
        return (at, at);
    };
    if c == '\n' {
        return (probe, probe);
    }
    let kind = class(c);
    let mut start = probe;
    for (i, c) in s[..probe].char_indices().rev() {
        if class(c) != kind || c == '\n' {
            break;
        }
        start = i;
    }
    let mut end = s.len();
    for (i, c) in s[probe..].char_indices() {
        if class(c) != kind || c == '\n' {
            end = probe + i;
            break;
        }
    }
    (start, end)
}

/// Length of `s` in UTF-16 units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The UTF-16 offset of byte offset `at` of `s`.
pub fn byte_to_utf16(s: &str, at: usize) -> u32 {
    utf16_len(&s[..floor(s, at)]) as u32
}

/// The byte offset of UTF-16 offset `units` of `s`: an offset inside a
/// surrogate pair moves past the pair; one past the end clamps.
pub fn utf16_to_byte(s: &str, units: u32) -> usize {
    let mut at = 0;
    for (i, c) in s.char_indices() {
        if at >= units as usize {
            return i;
        }
        at += c.len_utf16();
    }
    s.len()
}

/// The longest prefix of `s` that fits in `max` UTF-16 units, cut between
/// characters.
pub fn clip_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The key an insertion reports (`onKeyPress`).
pub fn key_of(text: &str) -> &str {
    if text == "\n" { "Enter" } else { text }
}

/// Pasted text for a field: Windows line breaks become `\n`, and a
/// single-line field gets spaces instead.
pub fn pasted(text: &str, multiline: bool) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if multiline {
        text
    } else {
        text.trim_end_matches('\n').replace('\n', " ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(text: &str) -> Model {
        let mut m = Model::default();
        m.set_text(text);
        m
    }

    #[test]
    fn utf16_offsets() {
        let s = "a😀b";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(byte_to_utf16(s, 0), 0);
        assert_eq!(byte_to_utf16(s, 1), 1);
        assert_eq!(byte_to_utf16(s, 5), 3);
        assert_eq!(byte_to_utf16(s, 6), 4);
        assert_eq!(utf16_to_byte(s, 0), 0);
        assert_eq!(utf16_to_byte(s, 1), 1);
        assert_eq!(utf16_to_byte(s, 2), 5);
        assert_eq!(utf16_to_byte(s, 3), 5);
        assert_eq!(utf16_to_byte(s, 4), 6);
        assert_eq!(utf16_to_byte(s, 99), 6);
    }

    #[test]
    fn max_length_clipping() {
        assert_eq!(clip_utf16("hello", 3), "hel");
        assert_eq!(clip_utf16("hello", 0), "");
        assert_eq!(clip_utf16("a😀", 2), "a");
        assert_eq!(clip_utf16("中文", 1), "中");
        let mut m = model("abc");
        assert_eq!(m.insert("defg", Some(5)).as_deref(), Some("de"));
        assert_eq!(m.text(), "abcde");
        assert_eq!(m.insert("x", Some(5)), None);
        // Replacing a selection frees its room.
        m.select(0, 2);
        assert_eq!(m.insert("xyz", Some(5)).as_deref(), Some("xy"));
        assert_eq!(m.text(), "xycde");
    }

    #[test]
    fn values_keep_the_caret() {
        let mut m = model("hello");
        assert_eq!(m.caret(), 5);
        m.set_text("hello world");
        assert_eq!(m.caret(), 11);
        m.select(2, 2);
        m.set_text("héllo");
        // 2 is inside 'é' (bytes 1..3): moved back onto a boundary.
        assert_eq!(m.caret(), 1);
        m.select(3, 3);
        m.set_text("hé!");
        assert_eq!(m.caret(), 3);
    }

    #[test]
    fn typing_and_deleting() {
        let mut m = model("");
        for c in ["a", "b", "c"] {
            m.insert(c, None);
        }
        assert_eq!(m.text(), "abc");
        assert!(m.delete(Unit::Char, false));
        assert_eq!(m.text(), "ab");
        m.move_to(0, false);
        assert!(!m.delete(Unit::Char, false));
        assert!(m.delete(Unit::Char, true));
        assert_eq!(m.text(), "b");
        let mut m = model("one two three");
        assert!(m.delete(Unit::Word, false));
        assert_eq!(m.text(), "one two ");
        m.move_to(0, false);
        assert!(m.delete(Unit::Word, true));
        assert_eq!(m.text(), "two ");
    }

    #[test]
    fn undo_merges_runs() {
        let mut m = model("");
        for c in ["h", "i", " ", "y", "o"] {
            m.insert(c, None);
        }
        m.delete(Unit::Char, false);
        m.delete(Unit::Char, false);
        assert_eq!(m.text(), "hi ");
        assert!(m.undo());
        assert_eq!(m.text(), "hi yo");
        assert!(m.undo());
        assert_eq!(m.text(), "");
        assert!(!m.undo());
        assert!(m.redo());
        assert_eq!(m.text(), "hi yo");
        assert!(m.redo());
        assert_eq!(m.text(), "hi ");
        assert!(!m.redo());
        // Moving the caret ends a run.
        let mut m = model("");
        m.insert("a", None);
        m.move_to(0, false);
        m.insert("b", None);
        m.undo();
        assert_eq!(m.text(), "a");
        // A paste is a step of its own.
        m.move_to(1, false);
        m.insert("c", None);
        m.insert("pasted", None);
        m.undo();
        assert_eq!(m.text(), "ac");
    }

    #[test]
    fn clusters() {
        let s = "e\u{301}x";
        assert_eq!(next_cluster(s, 0), 3);
        assert_eq!(prev_cluster(s, 3), 0);
        let family = "a👨\u{200D}👩\u{200D}👧b";
        let end = family.len() - 1;
        assert_eq!(next_cluster(family, 1), end);
        assert_eq!(prev_cluster(family, end), 1);
        let flags = "🇨🇳🇯🇵";
        assert_eq!(next_cluster(flags, 0), 8);
        assert_eq!(prev_cluster(flags, 16), 8);
        let mut m = model("a😀");
        m.step(Unit::Char, false, false);
        assert_eq!(m.caret(), 1);
        // Backspace takes a code point, not the cluster.
        let mut m = model("e\u{301}");
        m.delete(Unit::Char, false);
        assert_eq!(m.text(), "e");
    }

    #[test]
    fn words() {
        let s = "hello, world  foo";
        assert_eq!(word_right(s, 0), 5);
        assert_eq!(word_right(s, 5), 7);
        assert_eq!(word_right(s, 7), 14);
        assert_eq!(word_right(s, 14), s.len());
        assert_eq!(word_left(s, s.len()), 14);
        assert_eq!(word_left(s, 14), 7);
        assert_eq!(word_left(s, 7), 5);
        assert_eq!(word_left(s, 5), 0);
        assert_eq!(word_at(s, 8), (7, 12));
        assert_eq!(word_at(s, 12), (12, 14));
        assert_eq!(word_at(s, s.len()), (14, s.len()));
        // A run of ideographs is one word; Latin next to it is another.
        let cjk = "你好world";
        assert_eq!(word_at(cjk, 0), (0, 6));
        assert_eq!(word_right(cjk, 0), 6);
        assert_eq!(word_at("don't stop", 1), (0, 5));
    }

    #[test]
    fn selection_steps() {
        let mut m = model("abcdef");
        m.select(1, 4);
        assert_eq!(m.selected(), "bcd");
        m.step(Unit::Char, false, false);
        assert_eq!((m.anchor(), m.caret()), (1, 1));
        m.step(Unit::Char, true, true);
        m.step(Unit::Char, true, true);
        assert_eq!(m.selection(), (1, 3));
        m.step(Unit::Char, true, false);
        assert_eq!(m.selection(), (3, 3));
        assert_eq!(model("ab\ncd\nef").line_at(4), (3, 5));
    }

    #[test]
    fn composition_display() {
        let mut m = model("ab");
        m.move_to(1, false);
        m.composition = Some(Composition {
            text: "ni".into(),
            cursor: 1,
            target: None,
        });
        assert_eq!(m.display(), "anib");
        assert_eq!(m.to_display(1, false), 1);
        assert_eq!(m.to_display(2, false), 4);
        assert_eq!(m.display_caret(false), 2);
        assert_eq!(m.text_at(0, false), 0);
        assert_eq!(m.text_at(2, false), 1);
        assert_eq!(m.text_at(4, false), 2);
        m.composition = None;
        // Secure text shows one bullet per character.
        let m = model("a😀b");
        assert_eq!(m.to_display(5, true), 2);
        assert_eq!(m.text_at(2, true), 5);
        assert_eq!(m.text_at(9, true), 6);
    }

    #[test]
    fn paste_normalization() {
        assert_eq!(pasted("a\r\nb\r\n", true), "a\nb\n");
        assert_eq!(pasted("a\r\nb\r\n", false), "a b");
        assert_eq!(key_of("\n"), "Enter");
        assert_eq!(key_of("x"), "x");
    }
}
