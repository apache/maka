//! A selection across the texts of a selectable view (a `View` with
//! `selectable`, a selectable `TextView`): one range from a point in one text
//! to a point in another, in document order, as a browser selects across
//! the elements of a page.
//!
//! The model is platform-independent and runs where the gestures are: on
//! each platform's main thread, which knows the texts' layouts. A backend
//! lists the texts of an area in document order ([`SelectionTexts`]: their
//! content, frames and hit-testing), feeds the model its gestures (pointer
//! presses and drags with their click count, a long press, the handles'
//! drags, select all) and draws what [`SelectionModel::ranges`] says, with
//! its own highlight, handles and menus; copying takes
//! [`SelectionModel::text`].
//!
//! Offsets are UTF-16 code units, as everywhere text crosses to the
//! platforms (`TextLine::start`); the model never puts one inside a
//! surrogate pair.
//!
//! A point is hit-tested across the texts as a browser does, in reading
//! order: a point inside a text's frame is in that text; otherwise, among
//! the texts whose rows (vertical extent) contain the point, the
//! horizontally nearest one; above every text, the first text's start;
//! below every text, the last text's end; between rows, the end of the last
//! text above (in document order) or the start of the first text below,
//! whichever is vertically nearer (the text above on a tie). A point is
//! clamped into the chosen text's frame before
//! [`SelectionTexts::offset_at`].
//!
//! Words are runs of letters, digits, `_` and combining marks, runs of
//! spaces, or single other characters: punctuation, an emoji, each CJK
//! ideograph or kana (scripts written without spaces between words).

use std::ops::Range;

use crate::geometry::{Bounds, Point, Points};

/// A place in the texts of an area: a text (its index in document order)
/// and a UTF-16 offset in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct TextPosition {
    /// The text, in document order.
    pub text: usize,
    /// The UTF-16 offset in the text (0 ..= its length).
    pub offset: u32,
}

impl TextPosition {
    /// Offset `offset` of text `text`.
    pub const fn new(text: usize, offset: u32) -> Self {
        Self { text, offset }
    }
}

/// What a backend knows of the texts of one selectable view, in document
/// order (the area's subtree, depth first): their content, where they are
/// and which character is where. Coordinates are the area's (its top left
/// is the origin, y down), scroll offsets of the views between applied.
pub trait SelectionTexts {
    /// How many texts take part.
    fn len(&self) -> usize;

    /// Whether none takes part.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Text `i`'s content (attachments are U+FFFC, left out of copies).
    fn content(&self, i: usize) -> &str;

    /// Text `i`'s content box.
    fn frame(&self, i: usize) -> Bounds<Points>;

    /// The UTF-16 offset of text `i` nearest `point` (inside its content
    /// box; the model clamps points into it first): the caret position a
    /// click there puts, as the text engine hit-tests its lines.
    fn offset_at(&self, i: usize, point: Point<Points>) -> u32;

    /// A stable identity of text `i` (its view's node), so that a
    /// selection follows its texts when others come or go before them
    /// ([`SelectionModel::texts_changed`]). By default its index: texts
    /// are then only clamped.
    fn key(&self, i: usize) -> u64 {
        i as u64
    }
}

/// What a press, drag or extension selects by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Granularity {
    /// Characters (a press and drag).
    #[default]
    Character,
    /// Words (a double click, a long press, then drags by words).
    Word,
    /// Paragraphs: a whole text (a triple click).
    Paragraph,
}

/// One of the two ends of a selection, for touch handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    /// The start (in document order).
    Start,
    /// The end.
    End,
}

/// The selection of one area: an anchor where it started and a focus
/// where it goes, extended by words or paragraphs after a double or triple
/// click. Methods that change it return whether it changed, so the backend
/// redraws only then.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionModel {
    anchor: Option<TextPosition>,
    focus: Option<TextPosition>,
    granularity: Granularity,
    /// The unit (word, paragraph) around the anchor that a drag by words
    /// or paragraphs keeps selected.
    anchor_unit: Option<(TextPosition, TextPosition)>,
    /// The keys of the texts of the anchor, the focus and the anchor unit's
    /// ends ([`SelectionTexts::key`]), as of the last change.
    keys: [Option<u64>; 4],
}

impl SelectionModel {
    /// No selection.
    pub fn new() -> Self {
        Self::default()
    }

    /// Nothing is selected (no range, or an empty one).
    pub fn is_empty(&self) -> bool {
        self.bounds().is_none_or(|(start, end)| start == end)
    }

    /// A pointer press at `point`: one click puts the anchor there (nothing
    /// selected until a drag), two select the word, three the paragraph
    /// (the whole text); `extend` (Shift) extends the selection from its
    /// anchor to `point` instead, by the current granularity.
    pub fn press(
        &mut self,
        texts: &impl SelectionTexts,
        point: Point<Points>,
        clicks: u32,
        extend: bool,
    ) -> bool {
        let before = self.bounds();
        let Some(pos) = hit(texts, point) else {
            return self.clear();
        };
        if extend && self.anchor.is_some() {
            self.extend_to(texts, pos);
            self.remember(texts);
            return self.bounds() != before;
        }
        let granularity = match clicks {
            0 | 1 => Granularity::Character,
            2 => Granularity::Word,
            _ => Granularity::Paragraph,
        };
        self.select_unit(texts, pos, granularity);
        self.remember(texts);
        self.bounds() != before
    }

    /// The pointer moved to `point` while pressed: the focus follows, by
    /// the press's granularity (from text to text: above the first text is
    /// its start, below the last its end, between two the nearer edge).
    pub fn drag(&mut self, texts: &impl SelectionTexts, point: Point<Points>) -> bool {
        if self.anchor.is_none() {
            return false;
        }
        let Some(pos) = hit(texts, point) else {
            return false;
        };
        let before = self.bounds();
        self.extend_to(texts, pos);
        self.remember(texts);
        self.bounds() != before
    }

    /// Selects the word at `point` (a long press on a touch screen).
    pub fn select_word_at(&mut self, texts: &impl SelectionTexts, point: Point<Points>) -> bool {
        let before = self.bounds();
        let Some(pos) = hit(texts, point) else {
            return self.clear();
        };
        self.select_unit(texts, pos, Granularity::Word);
        self.remember(texts);
        self.bounds() != before
    }

    /// Handle `handle` dragged to `point`: that end moves, the other stays
    /// (they swap when one passes the other).
    pub fn move_handle(
        &mut self,
        texts: &impl SelectionTexts,
        handle: Handle,
        point: Point<Points>,
    ) -> bool {
        let Some((start, end)) = self.bounds() else {
            return false;
        };
        let Some(pos) = hit(texts, point) else {
            return false;
        };
        // The end that stays becomes the anchor: from here on the selection
        // is by characters, as handles move.
        let fixed = match handle {
            Handle::Start => end,
            Handle::End => start,
        };
        self.anchor = Some(fixed);
        self.focus = Some(pos);
        self.granularity = Granularity::Character;
        self.anchor_unit = None;
        self.remember(texts);
        self.bounds() != Some((start, end))
    }

    /// Selects every text of the area.
    pub fn select_all(&mut self, texts: &impl SelectionTexts) -> bool {
        if texts.is_empty() {
            return self.clear();
        }
        let before = self.bounds();
        let last = texts.len() - 1;
        self.anchor = Some(TextPosition::new(0, 0));
        self.focus = Some(TextPosition::new(last, utf16_len(texts.content(last))));
        self.granularity = Granularity::Character;
        self.anchor_unit = None;
        self.remember(texts);
        self.bounds() != before
    }

    /// Clears the selection.
    pub fn clear(&mut self) -> bool {
        let had = self.anchor.is_some();
        *self = Self::default();
        had
    }

    /// The texts changed (new content, texts added or gone): positions are
    /// clamped to what is there, and a selection whose texts are gone is
    /// cleared. `texts` is the new list.
    pub fn texts_changed(&mut self, texts: &impl SelectionTexts) -> bool {
        let (Some(mut anchor), Some(mut focus)) = (self.anchor, self.focus) else {
            return false;
        };
        // Each end follows its text by key: texts that came or went before
        // it move its index; a text that is gone clears the selection.
        let find = |key: Option<u64>, at: usize| -> Option<usize> {
            let key = key?;
            if at < texts.len() && texts.key(at) == key {
                return Some(at);
            }
            (0..texts.len()).find(|&i| texts.key(i) == key)
        };
        let (Some(a), Some(f)) = (
            find(self.keys[0], anchor.text),
            find(self.keys[1], focus.text),
        ) else {
            return self.clear();
        };
        let moved = a != anchor.text || f != focus.text;
        anchor.text = a;
        focus.text = f;
        self.anchor = Some(anchor);
        self.focus = Some(focus);
        if let Some((u0, u1)) = self.anchor_unit {
            self.anchor_unit = match (find(self.keys[2], u0.text), find(self.keys[3], u1.text)) {
                (Some(i), Some(j)) => Some((
                    TextPosition::new(i, u0.offset),
                    TextPosition::new(j, u1.offset),
                )),
                _ => None,
            };
        }
        let before = self.bounds();
        self.anchor = Some(clamp_position(texts, anchor));
        self.focus = Some(clamp_position(texts, focus));
        self.anchor_unit = self.anchor_unit.and_then(|(a, b)| {
            (a.text < texts.len() && b.text < texts.len())
                .then(|| (clamp_position(texts, a), clamp_position(texts, b)))
        });
        if self.anchor_unit.is_none() {
            self.granularity = Granularity::Character;
        }
        self.remember(texts);
        moved || self.bounds() != before
    }

    /// Records the keys of the texts the selection is in.
    fn remember(&mut self, texts: &impl SelectionTexts) {
        let key = |p: Option<TextPosition>| {
            p.filter(|p| p.text < texts.len())
                .map(|p| texts.key(p.text))
        };
        self.keys = [
            key(self.anchor),
            key(self.focus),
            key(self.anchor_unit.map(|u| u.0)),
            key(self.anchor_unit.map(|u| u.1)),
        ];
    }

    /// The start and the end, in document order (`None` without a
    /// selection).
    pub fn bounds(&self) -> Option<(TextPosition, TextPosition)> {
        let (anchor, focus) = (self.anchor?, self.focus?);
        Some((anchor.min(focus), anchor.max(focus)))
    }

    /// What each text has selected: its index and UTF-16 range, in order,
    /// only non-empty ranges (what the backend highlights).
    pub fn ranges(&self, texts: &impl SelectionTexts) -> Vec<(usize, Range<u32>)> {
        let Some((start, end)) = self.bounds() else {
            return Vec::new();
        };
        if texts.is_empty() || start == end {
            return Vec::new();
        }
        let last = end.text.min(texts.len() - 1);
        (start.text..=last)
            .filter_map(|i| {
                let len = utf16_len(texts.content(i));
                let from = if i == start.text {
                    start.offset.min(len)
                } else {
                    0
                };
                let to = if i == end.text {
                    end.offset.min(len)
                } else {
                    len
                };
                (from < to).then_some((i, from..to))
            })
            .collect()
    }

    /// The selected text, as a copy gives it: each text's selected part,
    /// attachments left out, texts on one row (their frames overlap
    /// vertically) joined by a tab, the others by a line break.
    pub fn text(&self, texts: &impl SelectionTexts) -> String {
        let mut out = String::new();
        let mut previous: Option<Bounds<Points>> = None;
        for (i, range) in self.ranges(texts) {
            let frame = texts.frame(i);
            if let Some(previous) = previous {
                let same_row = previous.top() < frame.bottom() && frame.top() < previous.bottom();
                out.push(if same_row { '\t' } else { '\n' });
            }
            previous = Some(frame);
            let content = texts.content(i);
            let part = &content[byte_offset(content, range.start)..byte_offset(content, range.end)];
            out.extend(part.chars().filter(|&c| c != OBJECT_REPLACEMENT));
        }
        out
    }

    /// Puts the anchor at `pos` and selects the unit of `granularity`
    /// around it (nothing for characters).
    fn select_unit(
        &mut self,
        texts: &impl SelectionTexts,
        pos: TextPosition,
        granularity: Granularity,
    ) {
        self.granularity = granularity;
        if granularity == Granularity::Character {
            self.anchor = Some(pos);
            self.focus = Some(pos);
            self.anchor_unit = None;
        } else {
            let unit = unit_at(texts, pos, granularity);
            self.anchor = Some(unit.0);
            self.focus = Some(unit.1);
            self.anchor_unit = Some(unit);
        }
    }

    /// Moves the focus to `pos` by the current granularity: by words or
    /// paragraphs, the anchor's unit stays selected and the focus goes to
    /// the edge of the unit at `pos` that is farther from it.
    fn extend_to(&mut self, texts: &impl SelectionTexts, pos: TextPosition) {
        let Some((unit_start, unit_end)) = self.anchor_unit else {
            self.focus = Some(pos);
            return;
        };
        let (start, end) = unit_at(texts, pos, self.granularity);
        if pos < unit_start {
            self.anchor = Some(unit_end);
            self.focus = Some(start.min(unit_start));
        } else {
            self.anchor = Some(unit_start);
            self.focus = Some(end.max(unit_end));
        }
    }
}

/// U+FFFC, which stands for an attachment in a text's content.
const OBJECT_REPLACEMENT: char = '\u{FFFC}';

/// The position under `point` ([module docs](self): the hit-testing rule),
/// `None` without texts.
fn hit(texts: &impl SelectionTexts, point: Point<Points>) -> Option<TextPosition> {
    let count = texts.len();
    if count == 0 {
        return None;
    }
    let at = |i: usize| {
        let frame = texts.frame(i);
        let clamped = Point::new(
            point.x.clamp(frame.left(), frame.right().max(frame.left())),
            point.y.clamp(frame.top(), frame.bottom().max(frame.top())),
        );
        clamp_position(texts, TextPosition::new(i, texts.offset_at(i, clamped)))
    };
    if let Some(i) = (0..count).find(|&i| texts.frame(i).contains(&point)) {
        return Some(at(i));
    }
    // The texts on the point's row: the horizontally nearest.
    let mut nearest: Option<(usize, Points)> = None;
    for i in 0..count {
        let frame = texts.frame(i);
        if point.y >= frame.top() && point.y < frame.bottom() {
            let distance = if point.x < frame.left() {
                frame.left() - point.x
            } else {
                (point.x - frame.right()).max(Points::ZERO)
            };
            if nearest.is_none_or(|(_, best)| distance < best) {
                nearest = Some((i, distance));
            }
        }
    }
    if let Some((i, _)) = nearest {
        return Some(at(i));
    }
    // Between rows: the end of the last text above or the start of the
    // first text below, whichever is nearer.
    let above = (0..count)
        .rev()
        .find(|&i| texts.frame(i).bottom() <= point.y);
    let below = (0..count).find(|&i| texts.frame(i).top() > point.y);
    let end_of = |i: usize| TextPosition::new(i, utf16_len(texts.content(i)));
    let start_of = |i: usize| TextPosition::new(i, 0);
    Some(match (above, below) {
        (Some(a), Some(b)) => {
            let to_above = point.y - texts.frame(a).bottom();
            let to_below = texts.frame(b).top() - point.y;
            if to_above <= to_below {
                end_of(a)
            } else {
                start_of(b)
            }
        }
        (Some(a), None) => end_of(a),
        (None, Some(b)) => start_of(b),
        // Only frames of no height, which no row contains.
        (None, None) => end_of(count - 1),
    })
}

/// The unit of `granularity` around `pos`: its word or its whole text.
fn unit_at(
    texts: &impl SelectionTexts,
    pos: TextPosition,
    granularity: Granularity,
) -> (TextPosition, TextPosition) {
    let content = texts.content(pos.text);
    let range = match granularity {
        Granularity::Character => pos.offset..pos.offset,
        Granularity::Word => word_range(content, pos.offset),
        Granularity::Paragraph => 0..utf16_len(content),
    };
    (
        TextPosition::new(pos.text, range.start),
        TextPosition::new(pos.text, range.end),
    )
}

/// What kind of character `c` is, for word boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharKind {
    /// Letters, digits, `_`, combining marks: runs of them are words.
    Word,
    /// Spaces and tabs: a run is one unit.
    Space,
    /// A line break, punctuation, an emoji, a CJK ideograph or kana: each
    /// is a unit of its own.
    Single,
}

impl CharKind {
    fn of(c: char) -> Self {
        if c == '\n' || c == '\r' || c == '\u{2028}' || c == '\u{2029}' {
            CharKind::Single
        } else if c.is_whitespace() {
            CharKind::Space
        } else if is_spaceless_script(c) {
            CharKind::Single
        } else if c.is_alphanumeric() || c == '_' || is_combining_mark(c) {
            CharKind::Word
        } else {
            CharKind::Single
        }
    }
}

/// Characters of scripts written without spaces between words (CJK
/// ideographs, kana): each one is a word.
fn is_spaceless_script(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30FF}'     // Hiragana, Katakana
        | '\u{31F0}'..='\u{31FF}'   // Katakana phonetic extensions
        | '\u{3400}'..='\u{4DBF}'   // CJK extension A
        | '\u{4E00}'..='\u{9FFF}'   // CJK unified ideographs
        | '\u{F900}'..='\u{FAFF}'   // CJK compatibility ideographs
        | '\u{FF66}'..='\u{FF9F}'   // Half-width Katakana
        | '\u{20000}'..='\u{3FFFF}' // CJK extensions B and on
    )
}

/// Combining marks that belong to the word before them (accents written
/// apart, as Vietnamese is).
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}'
        | '\u{1AB0}'..='\u{1AFF}'
        | '\u{1DC0}'..='\u{1DFF}'
        | '\u{20D0}'..='\u{20FF}'
        | '\u{FE20}'..='\u{FE2F}'
        | '\u{200D}' // zero-width joiner
        | '\u{FE0F}' // emoji presentation
    )
}

/// The UTF-16 range of the word at UTF-16 offset `offset` of `text`: the
/// word of the character after the offset, or of the one before at a line's
/// or the text's end. Empty on an empty line or text.
fn word_range(text: &str, offset: u32) -> Range<u32> {
    // UTF-16 starts of each character, with the characters.
    let chars: Vec<(u32, char)> = text
        .chars()
        .scan(0u32, |at, c| {
            let start = *at;
            *at += c.len_utf16() as u32;
            Some((start, c))
        })
        .collect();
    let len = utf16_len(text);
    let offset = snap(text, offset.min(len));
    let after = chars.partition_point(|&(start, _)| start < offset);
    let is_break = |i: usize| matches!(chars.get(i), Some((_, '\n' | '\r')) | None);
    let index = if is_break(after) {
        // At a line's or the text's end: the character before, unless the
        // line is empty.
        match after.checked_sub(1) {
            Some(before) if !is_break(before) => before,
            _ => return offset..offset,
        }
    } else {
        after
    };
    let kind = CharKind::of(chars[index].1);
    let (mut first, mut last) = (index, index);
    if kind != CharKind::Single {
        while first > 0 && CharKind::of(chars[first - 1].1) == kind {
            first -= 1;
        }
        while last + 1 < chars.len() && CharKind::of(chars[last + 1].1) == kind {
            last += 1;
        }
    }
    let end = chars[last].0 + chars[last].1.len_utf16() as u32;
    chars[first].0..end
}

/// `text`'s length in UTF-16 code units.
fn utf16_len(text: &str) -> u32 {
    text.chars().map(|c| c.len_utf16() as u32).sum()
}

/// The UTF-8 index of UTF-16 offset `offset` of `text` (rounded down to a
/// character, clamped to the end).
fn byte_offset(text: &str, offset: u32) -> usize {
    let mut at = 0u32;
    for (byte, c) in text.char_indices() {
        let next = at + c.len_utf16() as u32;
        if next > offset {
            return byte;
        }
        at = next;
    }
    text.len()
}

/// `offset` clamped to `text` and moved out of a surrogate pair (to the
/// pair's start).
fn snap(text: &str, offset: u32) -> u32 {
    let mut at = 0u32;
    for c in text.chars() {
        let next = at + c.len_utf16() as u32;
        if next > offset {
            return at;
        }
        at = next;
    }
    at
}

/// `pos` with its offset clamped into its text and out of a surrogate pair.
fn clamp_position(texts: &impl SelectionTexts, pos: TextPosition) -> TextPosition {
    TextPosition::new(pos.text, snap(texts.content(pos.text), pos.offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{bounds, point, px, size};

    /// Texts set in a monospace font: each character is 8pt wide, lines
    /// break at '\n' and are 20pt high.
    struct Fake(Vec<(String, Bounds<Points>)>);

    /// A frame's x, y, width and height.
    type Frame = (f32, f32, f32, f32);

    impl Fake {
        fn new(texts: &[(&str, Frame)]) -> Self {
            Fake(
                texts
                    .iter()
                    .map(|&(text, (x, y, w, h))| {
                        (
                            text.to_string(),
                            bounds(point(px(x), px(y)), size(px(w), px(h))),
                        )
                    })
                    .collect(),
            )
        }
    }

    impl SelectionTexts for Fake {
        fn len(&self) -> usize {
            self.0.len()
        }

        fn content(&self, i: usize) -> &str {
            &self.0[i].0
        }

        fn frame(&self, i: usize) -> Bounds<Points> {
            self.0[i].1
        }

        fn offset_at(&self, i: usize, point: Point<Points>) -> u32 {
            let (text, frame) = &self.0[i];
            let lines: Vec<&str> = text.split('\n').collect();
            let line =
                (((point.y - frame.top()).0 / 20.0).floor().max(0.0) as usize).min(lines.len() - 1);
            let column = ((point.x - frame.left()).0 / 8.0).round().max(0.0) as usize;
            let before: u32 = lines[..line].iter().map(|l| utf16_len(l) + 1).sum();
            let within: u32 = lines[line]
                .chars()
                .take(column)
                .map(|c| c.len_utf16() as u32)
                .sum();
            before + within
        }
    }

    /// Three texts in a column: one line, two lines, one line, with gaps.
    fn column() -> Fake {
        Fake::new(&[
            ("Hello world", (0.0, 0.0, 200.0, 20.0)),
            ("Second line\nmore text", (0.0, 40.0, 200.0, 40.0)),
            ("Last", (0.0, 100.0, 200.0, 20.0)),
        ])
    }

    fn at(x: f32, y: f32) -> Point<Points> {
        point(px(x), px(y))
    }

    fn pos(text: usize, offset: u32) -> TextPosition {
        TextPosition::new(text, offset)
    }

    #[test]
    fn one_click_puts_the_anchor() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(model.is_empty());
        assert!(model.press(&texts, at(17.0, 5.0), 1, false));
        assert!(model.is_empty());
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(0, 2))));
        assert!(model.ranges(&texts).is_empty());
        assert_eq!(model.text(&texts), "");
    }

    #[test]
    fn drags_forward_and_backward_across_texts() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(16.0, 5.0), 1, false);
        assert!(model.drag(&texts, at(24.0, 105.0)));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(2, 3))));
        assert_eq!(
            model.ranges(&texts),
            vec![(0, 2..11), (1, 0..21), (2, 0..3)]
        );
        assert_eq!(model.text(&texts), "llo world\nSecond line\nmore text\nLas");
        assert!(
            !model.drag(&texts, at(24.0, 105.0)),
            "the same point changes nothing"
        );

        let mut model = SelectionModel::new();
        model.press(&texts, at(24.0, 105.0), 1, false);
        model.drag(&texts, at(16.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(2, 3))));
        assert_eq!(
            model.ranges(&texts),
            vec![(0, 2..11), (1, 0..21), (2, 0..3)]
        );
    }

    #[test]
    fn drag_without_a_press_does_nothing() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(!model.drag(&texts, at(10.0, 10.0)));
        assert_eq!(model.bounds(), None);
    }

    #[test]
    fn between_rows_goes_to_the_nearer_edge() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(0.0, 5.0), 1, false);
        model.drag(&texts, at(50.0, 25.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(0, 11))));
        model.drag(&texts, at(50.0, 35.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(1, 0))));
        // A tie goes to the text above.
        model.drag(&texts, at(50.0, 30.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(0, 11))));
    }

    #[test]
    fn above_and_below_all_texts() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(40.0, 105.0), 1, false);
        model.drag(&texts, at(50.0, -10.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(2, 4))));

        model.press(&texts, at(0.0, 5.0), 1, false);
        model.drag(&texts, at(10.0, 500.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(2, 4))));
        assert_eq!(
            model.text(&texts),
            "Hello world\nSecond line\nmore text\nLast"
        );
    }

    #[test]
    fn beside_a_text_on_its_row() {
        let texts = Fake::new(&[
            ("left", (0.0, 0.0, 32.0, 20.0)),
            ("right", (100.0, 0.0, 40.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(8.0, 5.0), 1, false);
        // Nearer the left text: its end.
        model.drag(&texts, at(50.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 4))));
        // Nearer the right text: its start.
        model.drag(&texts, at(90.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(1, 0))));
        // Past the right text: its end.
        model.drag(&texts, at(300.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(1, 5))));
        assert_eq!(model.text(&texts), "eft\tright");
    }

    #[test]
    fn double_click_selects_and_drags_by_words() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(model.press(&texts, at(56.0, 5.0), 2, false));
        assert_eq!(model.bounds(), Some((pos(0, 6), pos(0, 11))));
        assert_eq!(model.text(&texts), "world");

        // Forward into the next text: to the end of the word there.
        model.drag(&texts, at(9.0, 45.0));
        assert_eq!(model.bounds(), Some((pos(0, 6), pos(1, 6))));
        // Back before the anchor's word: from the start of the word there to
        // the end of the anchor's.
        model.drag(&texts, at(8.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(0, 11))));
        assert_eq!(model.text(&texts), "Hello world");
        // Back inside the anchor's word: just it.
        model.drag(&texts, at(64.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 6), pos(0, 11))));
    }

    #[test]
    fn double_click_at_a_line_end_selects_the_word_before() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(150.0, 45.0), 2, false);
        assert_eq!(model.text(&texts), "line");
        model.press(&texts, at(150.0, 5.0), 2, false);
        assert_eq!(model.text(&texts), "world");
    }

    #[test]
    fn triple_click_selects_and_drags_by_paragraphs() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(20.0, 65.0), 3, false);
        assert_eq!(model.bounds(), Some((pos(1, 0), pos(1, 21))));
        model.drag(&texts, at(8.0, 105.0));
        assert_eq!(model.bounds(), Some((pos(1, 0), pos(2, 4))));
        assert_eq!(model.text(&texts), "Second line\nmore text\nLast");
        model.drag(&texts, at(8.0, 5.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(1, 21))));
    }

    #[test]
    fn shift_click_extends_from_the_anchor() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(16.0, 5.0), 1, false);
        assert!(model.press(&texts, at(24.0, 105.0), 1, true));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(2, 3))));
        // Again, before the anchor.
        model.press(&texts, at(8.0, 5.0), 1, true);
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 2))));

        // By words after a double click.
        model.press(&texts, at(56.0, 5.0), 2, false);
        model.press(&texts, at(8.0, 105.0), 1, true);
        assert_eq!(model.bounds(), Some((pos(0, 6), pos(2, 4))));

        // Without a selection, a Shift-click is a click.
        let mut model = SelectionModel::new();
        model.press(&texts, at(16.0, 5.0), 1, true);
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(0, 2))));
    }

    #[test]
    fn long_press_selects_a_word() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(model.select_word_at(&texts, at(10.0, 65.0)));
        assert_eq!(model.text(&texts), "more");
    }

    #[test]
    fn handles_move_their_end_and_swap_when_crossing() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(!model.move_handle(&texts, Handle::End, at(0.0, 0.0)));
        assert!(model.select_all(&texts));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(2, 4))));
        assert!(model.move_handle(&texts, Handle::End, at(16.0, 5.0)));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(0, 2))));
        assert!(model.move_handle(&texts, Handle::Start, at(8.0, 45.0)));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(1, 1))));
        assert_eq!(model.text(&texts), "llo world\nS");
        // The start handle passed the end: it is the end now.
        assert!(model.move_handle(&texts, Handle::End, at(24.0, 5.0)));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(0, 3))));
    }

    #[test]
    fn select_all_and_clear() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert!(model.select_all(&texts));
        assert!(!model.select_all(&texts));
        assert_eq!(
            model.ranges(&texts),
            vec![(0, 0..11), (1, 0..21), (2, 0..4)]
        );
        assert!(model.clear());
        assert!(!model.clear());
        assert_eq!(model.bounds(), None);

        let none = Fake(Vec::new());
        assert!(!model.select_all(&none));
        assert!(!model.press(&none, at(0.0, 0.0), 1, false));
    }

    #[test]
    fn copies_rows_with_tabs_and_leaves_attachments_out() {
        let texts = Fake::new(&[
            ("ab\u{FFFC}c", (0.0, 0.0, 80.0, 20.0)),
            ("de", (100.0, 5.0, 80.0, 20.0)),
            ("fg", (0.0, 40.0, 80.0, 20.0)),
            ("", (0.0, 60.0, 80.0, 20.0)),
            ("h", (0.0, 80.0, 80.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        model.select_all(&texts);
        assert_eq!(model.text(&texts), "abc\tde\nfg\nh");
        assert_eq!(model.ranges(&texts).len(), 4, "the empty text has no range");
    }

    #[test]
    fn never_splits_surrogate_pairs() {
        let texts = Fake::new(&[("a😀b c", (0.0, 0.0, 200.0, 20.0))]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(9.0, 5.0), 2, false);
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 3))));
        assert_eq!(model.text(&texts), "😀");
        model.press(&texts, at(0.0, 5.0), 1, false);
        model.drag(&texts, at(16.0, 5.0));
        assert_eq!(model.text(&texts), "a😀");

        assert_eq!(snap("a😀b", 2), 1);
        assert_eq!(snap("a😀b", 3), 3);
        assert_eq!(snap("a😀b", 9), 4);
        assert_eq!(byte_offset("a😀b", 3), 5);
        assert_eq!(word_range("a😀b", 2), 1..3);
    }

    #[test]
    fn words_in_latin_and_cjk() {
        let text = "中文abc 测试, café_1  x\n\nend";
        let word = |offset| {
            let range = word_range(text, offset);
            let (from, to) = (byte_offset(text, range.start), byte_offset(text, range.end));
            text[from..to].to_string()
        };
        assert_eq!(word(0), "中");
        assert_eq!(word(1), "文");
        assert_eq!(word(2), "abc");
        assert_eq!(word(4), "abc");
        assert_eq!(word(5), " ");
        assert_eq!(word(6), "测");
        assert_eq!(word(8), ",");
        assert_eq!(word(10), "café_1");
        assert_eq!(word(16), "  ");
        // At the end of a line: the word before; on an empty line: nothing.
        assert_eq!(word(19), "x");
        assert_eq!(word(20), "");
        assert_eq!(word(24), "end");
        assert_eq!(word_range("", 0), 0..0);
    }

    #[test]
    fn texts_changed_clamps_and_clears() {
        let texts = column();
        let mut model = SelectionModel::new();
        model.press(&texts, at(16.0, 5.0), 1, false);
        model.drag(&texts, at(24.0, 105.0));

        let shorter = Fake::new(&[
            ("Hello world", (0.0, 0.0, 200.0, 20.0)),
            ("Second", (0.0, 40.0, 200.0, 20.0)),
            ("L", (0.0, 100.0, 200.0, 20.0)),
        ]);
        assert!(model.texts_changed(&shorter));
        assert_eq!(model.bounds(), Some((pos(0, 2), pos(2, 1))));
        assert!(!model.texts_changed(&shorter));

        let fewer = Fake::new(&[("Hello world", (0.0, 0.0, 200.0, 20.0))]);
        assert!(model.texts_changed(&fewer));
        assert_eq!(model.bounds(), None);
        assert!(!model.texts_changed(&fewer));
    }

    /// Texts with keys of their own, as backends give them (their nodes).
    struct Keyed(Fake, Vec<u64>);

    impl SelectionTexts for Keyed {
        fn len(&self) -> usize {
            self.0.len()
        }

        fn content(&self, i: usize) -> &str {
            self.0.content(i)
        }

        fn frame(&self, i: usize) -> Bounds<Points> {
            self.0.frame(i)
        }

        fn offset_at(&self, i: usize, point: Point<Points>) -> u32 {
            self.0.offset_at(i, point)
        }

        fn key(&self, i: usize) -> u64 {
            self.1[i]
        }
    }

    #[test]
    fn a_selection_follows_its_texts_by_key() {
        let texts = Keyed(column(), vec![10, 20, 30]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(0.0, 45.0), 1, false);
        model.drag(&texts, at(16.0, 105.0));
        assert_eq!(model.bounds(), Some((pos(1, 0), pos(2, 2))));
        // A text comes before them: the selection moves with its texts.
        let more = Keyed(
            Fake::new(&[
                ("New", (0.0, 0.0, 200.0, 20.0)),
                ("Hello world", (0.0, 30.0, 200.0, 20.0)),
                ("Second line\nmore text", (0.0, 70.0, 200.0, 40.0)),
                ("Last", (0.0, 130.0, 200.0, 20.0)),
            ]),
            vec![5, 10, 20, 30],
        );
        assert!(model.texts_changed(&more));
        assert_eq!(model.bounds(), Some((pos(2, 0), pos(3, 2))));
        assert_eq!(model.text(&more), "Second line\nmore text\nLa");
        // The text of an end goes: the selection goes too.
        let gone = Keyed(
            Fake::new(&[
                ("New", (0.0, 0.0, 200.0, 20.0)),
                ("Second line\nmore text", (0.0, 70.0, 200.0, 40.0)),
            ]),
            vec![5, 20],
        );
        assert!(model.texts_changed(&gone));
        assert!(model.bounds().is_none());
    }
}
