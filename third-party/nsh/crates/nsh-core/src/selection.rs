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
//! order: a point inside a text's frame is in that text; otherwise, when the
//! point sits below a text in a closer, horizontally disjoint column than any
//! text whose row contains the point, it stays in that column (clamping to the
//! vertically nearer text above or below in the column) so multi-column gaps,
//! card margins, space beneath a shorter sidebar and unequal-height table
//! cells do not jump sideways; otherwise, among the texts whose rows (vertical
//! extent) contain the point, the horizontally nearest one; above every text,
//! the first text's start; between rows or below a column, the vertically
//! nearer text above or below in the point's column (with the text above on a
//! tie). A point is clamped into the chosen text's frame before
//! [`SelectionTexts::offset_at`].
//!
//! Words are runs of letters, digits, `_` and combining marks, runs of
//! spaces, or single other characters: punctuation, an emoji, each CJK
//! ideograph or kana (scripts written without spaces between words). A long
//! press on a touch screen selects a token, as the phones' own text views keep
//! a link or an address whole: the punctuation of a hostname, URL, path or id
//! between two words joins them into one (`demo-app.pages.dev`,
//! `https://x.y/a-b?c=1`, `~/a/b-c.md`, `v0.5.1`), while a sentence's last word
//! (`foo.`) is still the word alone. A double click selects the word alone, as
//! desktops and browsers do.

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

    /// Text `i`'s content (attachments are U+FFFC).
    fn content(&self, i: usize) -> &str;

    /// The UTF-16 range `range` of text `i` as a copy gives it. By default
    /// its content's characters without attachments' placeholders; a
    /// backend that has the texts' runs gives
    /// [`crate::AttributedText::copied_text`], which puts an attachment's
    /// copy text (`copyText`) in its place and leaves hidden runs out
    /// (`visibility: "hidden"` on a span).
    fn copied(&self, i: usize, range: Range<u32>) -> String {
        let content = self.content(i);
        content[byte_offset(content, range.start)..byte_offset(content, range.end)]
            .chars()
            .filter(|&c| c != OBJECT_REPLACEMENT)
            .collect()
    }

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

    /// Whether text `i` continues text `i - 1`: the next part of a long
    /// line drawn as several texts, one per wrapped part (the view's
    /// [`ViewProps::continues_text`](crate::ViewProps::continues_text)).
    /// A copy joins the two with nothing between them, and a word or a
    /// paragraph (a double or triple click) runs on across them. By
    /// default none does; the first text never does.
    fn continues(&self, i: usize) -> bool {
        let _ = i;
        false
    }

    /// The box around what the characters `range` of text `i` cover, in
    /// the coordinates of the content boxes ([`Self::frame`]): what
    /// [`SelectionModel::selected_bounds`] unites. `None` by default: the
    /// platform's text engine places characters, the model does not.
    fn range_bounds(&self, i: usize, range: Range<u32>) -> Option<Bounds<Points>> {
        let _ = (i, range);
        None
    }
}

/// What a press, drag or extension selects by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Granularity {
    /// Characters (a press and drag).
    #[default]
    Character,
    /// Words (a double click, then drags by words).
    Word,
    /// Paragraphs: a whole text (a triple click).
    Paragraph,
}

/// What the model selects by: a [`Granularity`], or a long press's tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Unit {
    #[default]
    Character,
    Word,
    /// Words joined by the punctuation of a hostname, URL, path or id
    /// between them (a long press on a touch screen).
    Token,
    Paragraph,
}

impl From<Granularity> for Unit {
    fn from(granularity: Granularity) -> Self {
        match granularity {
            Granularity::Character => Unit::Character,
            Granularity::Word => Unit::Word,
            Granularity::Paragraph => Unit::Paragraph,
        }
    }
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
    granularity: Unit,
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
        self.select_unit(texts, pos, granularity.into());
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

    /// Selects the token at `point` (a long press on a touch screen): a
    /// hostname, URL, path or id whole, or else the word.
    pub fn select_word_at(&mut self, texts: &impl SelectionTexts, point: Point<Points>) -> bool {
        let before = self.bounds();
        let Some(pos) = hit(texts, point) else {
            return self.clear();
        };
        self.select_unit(texts, pos, Unit::Token);
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
        self.granularity = Unit::Character;
        self.anchor_unit = None;
        self.remember(texts);
        self.bounds() != Some((start, end))
    }

    /// Selects a range of UTF-16 positions, for assistive technologies and
    /// programmatic selection. Offsets clamp to the text and character boundary;
    /// a position naming a missing text clears the selection.
    pub fn select_range(
        &mut self,
        texts: &impl SelectionTexts,
        start: TextPosition,
        end: TextPosition,
    ) -> bool {
        if start.text >= texts.len() || end.text >= texts.len() {
            return self.clear();
        }
        let before = self.bounds();
        self.anchor = Some(clamp_position(texts, start));
        self.focus = Some(clamp_position(texts, end));
        self.granularity = Unit::Character;
        self.anchor_unit = None;
        self.remember(texts);
        self.bounds() != before
    }

    /// Selects every text of the area.
    pub fn select_all(&mut self, texts: &impl SelectionTexts) -> bool {
        if texts.is_empty() {
            return self.clear();
        }
        let last = texts.len() - 1;
        self.select_range(
            texts,
            TextPosition::new(0, 0),
            TextPosition::new(last, utf16_len(texts.content(last))),
        )
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
            self.granularity = Unit::Character;
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

    /// The selected text, as a copy gives it: each text's selected part
    /// as [`SelectionTexts::copied`] gives it (attachments as their copy
    /// text, hidden runs left out),
    /// a text that continues the one before it
    /// ([`SelectionTexts::continues`]) joined to it with nothing between,
    /// other texts on one row (their frames overlap vertically) joined by a
    /// tab, the others by a line break; an empty text inside the selection
    /// counts as a text, so a blank line stays in the copy.
    pub fn text(&self, texts: &impl SelectionTexts) -> String {
        let mut out = String::new();
        let mut previous: Option<(usize, Bounds<Points>)> = None;
        let ranges = self.ranges(texts);
        let (Some(&(first, _)), Some(&(last, _))) = (ranges.first(), ranges.last()) else {
            return out;
        };
        let mut ranges = ranges.into_iter().peekable();
        for i in first..=last {
            // An empty text between the ends (a blank line of code) has
            // nothing to highlight but still takes its line in a copy.
            let range = match ranges.next_if(|&(at, _)| at == i) {
                Some((_, range)) => range,
                None if texts.content(i).is_empty() => 0..0,
                None => continue,
            };
            let frame = texts.frame(i);
            if let Some((before, previous)) = previous
                && (before + 1 != i || !continues(texts, i))
            {
                let same_row = previous.top() < frame.bottom() && frame.top() < previous.bottom();
                out.push(if same_row { '\t' } else { '\n' });
            }
            previous = Some((i, frame));
            out.push_str(&texts.copied(i, range));
        }
        out
    }

    /// The box around what is selected in `texts`, in their coordinates:
    /// each text's part of the selection ([`SelectionTexts::range_bounds`])
    /// united. `None` while nothing is selected, or where the texts cannot
    /// place their characters.
    pub fn selected_bounds(&self, texts: &impl SelectionTexts) -> Option<Bounds<Points>> {
        self.ranges(texts)
            .into_iter()
            .filter_map(|(i, range)| texts.range_bounds(i, range))
            .reduce(|a, b| a.union(&b))
    }

    /// Where the selection starts in the copy of all of `texts` (what
    /// [`Self::text`] gives once everything is selected), in UTF-16 code
    /// units: what maps it back to the document the texts show.
    pub fn start_offset(&self, texts: &impl SelectionTexts) -> u32 {
        let Some((start, _)) = self.bounds() else {
            return 0;
        };
        if texts.is_empty() || (start.text == 0 && start.offset == 0) {
            return 0;
        }
        let before = Self {
            anchor: Some(TextPosition { text: 0, offset: 0 }),
            focus: Some(start),
            ..Self::default()
        };
        let mut len = utf16_len(&before.text(texts));
        // A selection from the start of a text: the break before it.
        if start.offset == 0 && len > 0 {
            len += 1;
        }
        len
    }

    /// Puts the anchor at `pos` and selects the unit of `granularity`
    /// around it (nothing for characters).
    fn select_unit(&mut self, texts: &impl SelectionTexts, pos: TextPosition, granularity: Unit) {
        self.granularity = granularity;
        if granularity == Unit::Character {
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

/// The order of the texts a backend listed child by child, in mount order:
/// `runs` are the children's frames (in their parent) and the ranges of
/// texts each added. The children with texts go by their tops when they
/// stack (no two share a row): a virtual list's cells, which recycling
/// leaves in mount order rather than their items'. Otherwise (a row, an
/// overlay) mount order stands. Children without texts never count: a
/// spare cell left where it was may overlap the shown ones. `None` when
/// the order stays; else the texts' indices in their new order, from the
/// first run's start.
pub fn reading_order(runs: &[(Bounds<Points>, Range<usize>)]) -> Option<Vec<usize>> {
    let runs: Vec<_> = runs.iter().filter(|(_, r)| !r.is_empty()).collect();
    let stacked = runs.iter().enumerate().all(|(i, (a, _))| {
        runs[i + 1..]
            .iter()
            .all(|(b, _)| a.bottom() <= b.top() || b.bottom() <= a.top())
    });
    let mut order: Vec<usize> = (0..runs.len()).collect();
    if stacked {
        order.sort_by(|&a, &b| {
            runs[a]
                .0
                .top()
                .partial_cmp(&runs[b].0.top())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    if order.iter().enumerate().all(|(i, &o)| i == o) {
        return None;
    }
    Some(order.into_iter().flat_map(|i| runs[i].1.clone()).collect())
}

/// Puts `items[start..]` in `order` ([`reading_order`]'s indices).
pub fn reorder<T>(items: &mut Vec<T>, start: usize, order: &[usize]) {
    let mut taken: Vec<Option<T>> = items.drain(start..).map(Some).collect();
    items.extend(order.iter().filter_map(|&i| taken[i - start].take()));
}

/// The virtual list rows a selection keeps rendered: the nodes of the
/// texts at its ends, which the backend hands the engine
/// (`EngineControl::keep_rendered`) so that scrolling away does not
/// recycle them. Tracks what was last handed over.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeptRows(Vec<u64>);

impl KeptRows {
    /// The nodes to keep when they changed since the last call (none: the
    /// selection is gone), else `None`.
    pub fn changed(&mut self, model: &SelectionModel) -> Option<Vec<u64>> {
        let mut keys: Vec<u64> = if model.anchor.is_some() {
            model.keys.iter().flatten().copied().collect()
        } else {
            Vec::new()
        };
        keys.sort_unstable();
        keys.dedup();
        (keys != self.0).then(|| {
            self.0 = keys.clone();
            keys
        })
    }
    /// Lets go of every row (the selection's area is gone): an empty list
    /// when some were kept, else `None`.
    pub fn release(&mut self) -> Option<Vec<u64>> {
        (!self.0.is_empty()).then(|| {
            self.0.clear();
            Vec::new()
        })
    }
}

/// How far a selection drag scrolls a scroll view per 16 ms tick (points,
/// negative toward its start) with the pointer `at` along the view's axis
/// (its coordinates; `extent` long), 0 away from the edges. It starts
/// [`AUTOSCROLL_INSIDE`] inside an edge, as a maximized window leaves the
/// pointer little room past it, and speeds up linearly from
/// [`AUTOSCROLL_MIN`] to [`AUTOSCROLL_MAX`] over [`AUTOSCROLL_RAMP`] from
/// there outward.
pub fn autoscroll_step(at: Points, extent: Points) -> Points {
    let into = if at < AUTOSCROLL_INSIDE {
        at - AUTOSCROLL_INSIDE
    } else if at > extent - AUTOSCROLL_INSIDE {
        at - (extent - AUTOSCROLL_INSIDE)
    } else {
        return Points(0.0);
    };
    let t = (into.0.abs() / AUTOSCROLL_RAMP.0).min(1.0);
    Points(into.0.signum() * (AUTOSCROLL_MIN.0 + t * (AUTOSCROLL_MAX.0 - AUTOSCROLL_MIN.0)))
}

/// How far inside an edge a selection drag starts scrolling ([`autoscroll_step`]).
pub const AUTOSCROLL_INSIDE: Points = Points(16.0);
/// Its step per tick where it starts.
pub const AUTOSCROLL_MIN: Points = Points(12.0);
/// Its largest step per tick, [`AUTOSCROLL_RAMP`] from where it starts on.
pub const AUTOSCROLL_MAX: Points = Points(64.0);
/// How far from where it starts it reaches [`AUTOSCROLL_MAX`].
pub const AUTOSCROLL_RAMP: Points = Points(96.0);

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
    let end_of = |i: usize| TextPosition::new(i, utf16_len(texts.content(i)));
    let start_of = |i: usize| TextPosition::new(i, 0);
    let h_dist = |frame: Bounds<Points>| {
        if point.x < frame.left() {
            frame.left() - point.x
        } else if point.x > frame.right() {
            point.x - frame.right()
        } else {
            Points::ZERO
        }
    };
    let v_dist = |frame: Bounds<Points>| {
        if point.y < frame.top() {
            frame.top() - point.y
        } else if point.y > frame.bottom() {
            point.y - frame.bottom()
        } else {
            Points::ZERO
        }
    };
    let h_overlaps =
        |a: Bounds<Points>, b: Bounds<Points>| a.left() < b.right() && b.left() < a.right();

    // 1. Inside a text's frame: topmost (last in paint order) wins when frames overlap.
    if let Some(i) = (0..count).rfind(|&i| texts.frame(i).contains(&point)) {
        return Some(at(i));
    }

    // 2. Nearest texts above and below `point` in `point.x`'s column.
    //    First check texts whose horizontal span covers `point.x`; when
    //    `point` sits in a margin or beside shorter lines, anchor on the
    //    horizontally nearest non-empty-width text (ties broken vertically).
    let mut col_above: Option<(usize, Points)> = None;
    let mut col_below: Option<(usize, Points)> = None;
    let mut any_covering_x = false;
    for i in 0..count {
        let frame = texts.frame(i);
        if h_dist(frame) != Points::ZERO {
            continue;
        }
        any_covering_x = true;
        if frame.bottom() <= point.y {
            let d = point.y - frame.bottom();
            if col_above.is_none_or(|(_, best)| d <= best) {
                col_above = Some((i, d));
            }
        }
        if frame.top() > point.y {
            let d = frame.top() - point.y;
            if col_below.is_none_or(|(_, best)| d < best) {
                col_below = Some((i, d));
            }
        }
    }
    let nearest_in_column = |anchor: Bounds<Points>, above: bool, base: Option<(usize, Points)>| {
        let mut best = base;
        for i in 0..count {
            let frame = texts.frame(i);
            if !h_overlaps(frame, anchor) {
                continue;
            }
            if above && frame.bottom() <= point.y {
                let d = point.y - frame.bottom();
                if best.is_none_or(|(bi, b)| {
                    d < b || (d == b && h_dist(frame) <= h_dist(texts.frame(bi)))
                }) {
                    best = Some((i, d));
                }
            } else if !above && frame.top() > point.y {
                let d = frame.top() - point.y;
                if best.is_none_or(|(bi, b)| {
                    d < b || (d == b && h_dist(frame) < h_dist(texts.frame(bi)))
                }) {
                    best = Some((i, d));
                }
            }
        }
        best
    };
    let refine_covering = |anchor_idx: usize,
                           other_idx: Option<usize>,
                           above: bool,
                           base: Option<(usize, Points)>| {
        let anchor = texts.frame(anchor_idx);
        let restrict = other_idx
            .map(|o| texts.frame(o))
            .filter(|o| o.size.width < anchor.size.width && h_overlaps(*o, anchor));
        // Among texts overlapping `anchor` that sit closer vertically than
        // `base` (and stay within any narrower opposite-side column), pick the
        // horizontally nearest one first so a full-width header/footer cannot
        // pull in a closer text from a disjoint sibling column.
        let sub_anchor = (0..count)
            .filter(|&i| {
                let frame = texts.frame(i);
                if frame.size.width <= Points::ZERO || !h_overlaps(frame, anchor) {
                    return false;
                }
                if let Some(r) = restrict
                    && !h_overlaps(frame, r)
                {
                    return false;
                }
                if above {
                    frame.bottom() <= point.y
                        && base.is_none_or(|(_, b)| point.y - frame.bottom() < b)
                } else {
                    frame.top() > point.y && base.is_none_or(|(_, b)| frame.top() - point.y < b)
                }
            })
            .min_by(|&a, &b| {
                let (fa, fb) = (texts.frame(a), texts.frame(b));
                h_dist(fa)
                    .partial_cmp(&h_dist(fb))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        v_dist(fa)
                            .partial_cmp(&v_dist(fb))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .then_with(|| if above { b.cmp(&a) } else { a.cmp(&b) })
            });
        match sub_anchor {
            Some(sub) => nearest_in_column(texts.frame(sub), above, base),
            None => base,
        }
    };
    if any_covering_x {
        // A shorter line in the same column may sit closer vertically than a
        // wider text that covered `point.x` (e.g. a short last paragraph under
        // a wide one, or a short heading above a wide paragraph).
        let (orig_above, orig_below) = (col_above, col_below);
        if let Some((a, _)) = orig_above {
            col_above = refine_covering(a, orig_below.map(|(b, _)| b), true, orig_above);
        }
        if let Some((b, _)) = orig_below {
            col_below = refine_covering(b, col_above.map(|(a, _)| a), false, orig_below);
        } else if let Some((a, _)) = col_above {
            col_below = refine_covering(a, None, false, None);
        }
        if orig_above.is_none()
            && let Some((b, _)) = col_below
        {
            col_above = refine_covering(b, None, true, None);
        }
    } else if let Some(anchor) = (0..count)
        .filter(|&i| texts.frame(i).size.width > Points::ZERO)
        .min_by(|&a, &b| {
            let (fa, fb) = (texts.frame(a), texts.frame(b));
            h_dist(fa)
                .partial_cmp(&h_dist(fb))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    v_dist(fa)
                        .partial_cmp(&v_dist(fb))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        })
    {
        let anchor_frame = texts.frame(anchor);
        col_above = nearest_in_column(anchor_frame, true, None);
        col_below = nearest_in_column(anchor_frame, false, None);
    }

    // 3. The texts on the point's row: the horizontally nearest.
    let mut nearest: Option<(usize, Points)> = None;
    for i in 0..count {
        let frame = texts.frame(i);
        if point.y >= frame.top() && point.y < frame.bottom() {
            let distance = h_dist(frame);
            if nearest.is_none_or(|(_, best)| distance < best) {
                nearest = Some((i, distance));
            }
        }
    }
    if let Some((i, row_h_dist)) = nearest {
        let row_frame = texts.frame(i);
        // When `point` sits below a text in a closer, horizontally disjoint
        // column, stay in that column instead of jumping sideways across
        // columns (gaps in a left column, card margins, space below a shorter
        // right sidebar, or blank space in a 1-line table cell beside a
        // wrapped sibling cell).
        if let Some((a, to_above)) = col_above
            && !h_overlaps(texts.frame(a), row_frame)
            && h_dist(texts.frame(a)) < row_h_dist
        {
            return Some(match col_below {
                Some((b, to_below))
                    if to_below < to_above && h_dist(texts.frame(b)) < row_h_dist =>
                {
                    start_of(b)
                }
                _ => end_of(a),
            });
        }
        return Some(at(i));
    }

    // 4. Between rows, above all, or below all.
    if (0..count).all(|i| texts.frame(i).bottom() > point.y) {
        return Some(start_of(0));
    }
    let below_all = (0..count).all(|i| texts.frame(i).bottom() <= point.y);
    let v_overlaps =
        |a: Bounds<Points>, b: Bounds<Points>| a.top() < b.bottom() && b.top() < a.bottom();
    match (col_above, col_below) {
        (Some((a, to_above)), Some((b, to_below))) => {
            return Some(if to_above <= to_below {
                end_of(a)
            } else {
                start_of(b)
            });
        }
        (Some((a, _)), None) => {
            // Below every text in the area: if `a` shares the bottom row with
            // later sibling cells (e.g. a multi-column table), reach the end
            // of that row instead of truncating at column 1.
            let target = if below_all {
                let af = texts.frame(a);
                (a..count)
                    .rev()
                    .find(|&i| v_overlaps(texts.frame(i), af))
                    .unwrap_or(a)
            } else {
                a
            };
            return Some(end_of(target));
        }
        (None, Some((b, _))) => return Some(start_of(b)),
        (None, None) => {}
    }

    // Fallback when only zero-width or zero-height frames exist.
    let above = (0..count)
        .rev()
        .find(|&i| texts.frame(i).bottom() <= point.y);
    let below = (0..count).find(|&i| texts.frame(i).top() > point.y);
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
        (None, None) => end_of(count - 1),
    })
}

/// The unit of `granularity` around `pos`: its word or its whole text.
fn unit_at(
    texts: &impl SelectionTexts,
    pos: TextPosition,
    granularity: Unit,
) -> (TextPosition, TextPosition) {
    let content = texts.content(pos.text);
    match granularity {
        Unit::Character => (pos, pos),
        Unit::Word | Unit::Token => {
            // The word is found in the line the text is part of (it, the
            // texts it continues and those that continue it, joined as a
            // copy joins them): a word a wrap cut, or a token whose parts
            // are texts of their own, runs on into the parts around it.
            let (first, last) = line_of(texts, pos.text);
            let mut line = String::new();
            let mut starts = Vec::with_capacity(last - first + 1);
            for i in first..=last {
                starts.push(utf16_len(&line));
                line.push_str(texts.content(i));
            }
            let mut at = starts[pos.text - first] + pos.offset;
            // At a text's end, the character before it, as in a text alone.
            if pos.offset > 0 && pos.offset == utf16_len(content) {
                let before = content.chars().next_back().map_or(0, char::len_utf16);
                at -= before as u32;
            }
            let range = word_range(&line, at, granularity == Unit::Token);
            if range.is_empty() {
                return (pos, pos);
            }
            // The start in the text its first character is in, the end in
            // the text its last character is in.
            let start_text = starts.partition_point(|&s| s <= range.start) - 1;
            let end_text = starts.partition_point(|&s| s < range.end) - 1;
            (
                TextPosition::new(first + start_text, range.start - starts[start_text]),
                TextPosition::new(first + end_text, range.end - starts[end_text]),
            )
        }
        // The whole line: the text and the texts it continues and that
        // continue it.
        Unit::Paragraph => {
            let (first, last) = line_of(texts, pos.text);
            (
                TextPosition::new(first, 0),
                TextPosition::new(last, utf16_len(texts.content(last))),
            )
        }
    }
}

/// Whether text `i` continues the text before it (never the first).
fn continues(texts: &impl SelectionTexts, i: usize) -> bool {
    i > 0 && i < texts.len() && texts.continues(i)
}

/// The first and last texts of the line text `i` is part of: it, the
/// texts it continues and the texts that continue it.
fn line_of(texts: &impl SelectionTexts, i: usize) -> (usize, usize) {
    let mut first = i;
    while continues(texts, first) {
        first -= 1;
    }
    let mut last = i;
    while last + 1 < texts.len() && continues(texts, last + 1) {
        last += 1;
    }
    (first, last)
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
/// or the text's end; with `tokens`, the token (`token_at`) there, if any.
/// Empty on an empty line or text.
fn word_range(text: &str, offset: u32, tokens: bool) -> Range<u32> {
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
    if let Some((first, last)) = tokens.then(|| token_at(&chars, index)).flatten() {
        let end = chars[last].0 + chars[last].1.len_utf16() as u32;
        return chars[first].0..end;
    }
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

/// Punctuation that joins the words on both sides of it into one: a
/// hostname's dots and hyphens, a path's slashes, a URL's `://` and `%`, an
/// address's `@`, a version's dots, a port's or a time's `:`; with `query`,
/// also a URL query's `?`, `=`, `&` and fragment's `#`.
fn is_joiner(c: char, query: bool) -> bool {
    matches!(c, '-' | '.' | '/' | ':' | '@' | '~' | '%') || (query && is_query(c))
}

/// A URL query's and fragment's punctuation.
fn is_query(c: char) -> bool {
    matches!(c, '?' | '=' | '&' | '#')
}

/// Joiners a token may start with: a path's root or home (`/etc`, `~/a`),
/// a relative path's or a dotfile's dot (`./x`, `.env`), a flag's dashes
/// (`--force`), a handle's `@`.
fn is_leading(c: char) -> bool {
    matches!(c, '/' | '~' | '.' | '-' | '@')
}

/// The token around character `index` of `chars`, as indexes of its first
/// and last characters: words joined by runs of joiners (`is_joiner`) each
/// between two words, after a run of leading joiners (`is_leading`) and
/// before a directory's last `/`. A query's punctuation joins only after a
/// `/` (a URL's path): `a=b` or `really?yes` are words apart. `None` when the
/// character is a joiner in no token, or is no word's nor a joiner's.
fn token_at(chars: &[(u32, char)], index: usize) -> Option<(usize, usize)> {
    let (first, last) = grow_token(chars, index, true)?;
    match (first..=last).find(|&i| is_query(chars[i].1)) {
        Some(q) if !(first..q).any(|i| chars[i].1 == '/') => grow_token(chars, index, false),
        _ => Some((first, last)),
    }
}

/// `token_at`'s token, with the query's punctuation joining (`query`) or not.
fn grow_token(chars: &[(u32, char)], index: usize, query: bool) -> Option<(usize, usize)> {
    let word = |i: usize| CharKind::of(chars[i].1) == CharKind::Word;
    let joiner = |i: usize| is_joiner(chars[i].1, query);
    let n = chars.len();
    // A word of the token to grow from.
    let core = if word(index) {
        index
    } else if joiner(index) {
        let (mut a, mut b) = (index, index);
        while a > 0 && joiner(a - 1) {
            a -= 1;
        }
        while b + 1 < n && joiner(b + 1) {
            b += 1;
        }
        let before = a > 0 && word(a - 1);
        let after = b + 1 < n && word(b + 1);
        if before && after {
            a - 1
        } else if after && !before && (a..=b).all(|i| is_leading(chars[i].1)) {
            b + 1
        } else {
            return None;
        }
    } else {
        return None;
    };
    let (mut first, mut last) = (core, core);
    loop {
        while last + 1 < n && word(last + 1) {
            last += 1;
        }
        let mut j = last + 1;
        while j < n && joiner(j) {
            j += 1;
        }
        if j > last + 1 && j < n && word(j) {
            last = j;
        } else {
            break;
        }
    }
    loop {
        while first > 0 && word(first - 1) {
            first -= 1;
        }
        let mut j = first;
        while j > 0 && joiner(j - 1) {
            j -= 1;
        }
        if j < first && j > 0 && word(j - 1) {
            first = j - 1;
        } else {
            break;
        }
    }
    while first > 0 && is_leading(chars[first - 1].1) {
        first -= 1;
    }
    if last + 1 < n && chars[last + 1].1 == '/' {
        last += 1;
    }
    Some((first, last))
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

        // ASCII only: a character is a UTF-16 unit.
        fn range_bounds(&self, i: usize, range: Range<u32>) -> Option<Bounds<Points>> {
            let (text, frame) = &self.0[i];
            let place = |offset: u32| {
                let before = &text[..offset as usize];
                let line = before.matches('\n').count();
                let column = before.len() - before.rfind('\n').map_or(0, |n| n + 1);
                (line as f32, column as f32)
            };
            let ((l0, c0), (l1, c1)) = (place(range.start), place(range.end));
            let (left, width) = if l0 == l1 {
                (c0 * 8.0, (c1 - c0) * 8.0)
            } else {
                (0.0, frame.size.width.0)
            };
            Some(bounds(
                point(frame.left() + px(left), frame.top() + px(l0 * 20.0)),
                size(px(width), px((l1 - l0 + 1.0) * 20.0)),
            ))
        }
    }

    #[test]
    fn explicit_ranges_snap_utf16_and_clear_missing_texts() {
        let texts = Fake::new(&[("前😀日本", (0.0, 0.0, 100.0, 20.0))]);
        let mut model = SelectionModel::new();
        assert!(model.select_range(&texts, TextPosition::new(0, 2), TextPosition::new(0, 99)));
        assert!(!model.select_range(&texts, TextPosition::new(0, 1), TextPosition::new(0, 5)));
        assert_eq!(model.text(&texts), "😀日本");
        assert_eq!(model.start_offset(&texts), 1);
        model.select_range(&texts, TextPosition::new(0, 3), TextPosition::new(0, 1));
        assert_eq!(model.text(&texts), "😀");
        assert!(model.select_range(&texts, TextPosition::new(1, 0), TextPosition::new(0, 1)));
        assert!(model.is_empty());
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

    /// The selected part of each text, united: on one line, then across
    /// the texts of the column; nothing for nothing selected.
    #[test]
    fn the_selected_bounds_unite_each_texts_part() {
        let texts = column();
        let mut model = SelectionModel::new();
        assert_eq!(model.selected_bounds(&texts), None);
        model.press(&texts, at(16.0, 5.0), 1, false);
        assert_eq!(model.selected_bounds(&texts), None);
        model.drag(&texts, at(40.0, 5.0));
        assert_eq!(
            model.selected_bounds(&texts),
            Some(bounds(point(px(16.0), px(0.0)), size(px(24.0), px(20.0))))
        );
        model.drag(&texts, at(24.0, 105.0));
        assert_eq!(
            model.selected_bounds(&texts),
            Some(bounds(point(px(0.0), px(0.0)), size(px(200.0), px(120.0))))
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
        // The empty text is a blank line inside the selection: it keeps its
        // line in the copy, though it has nothing to highlight.
        assert_eq!(model.text(&texts), "abc\tde\nfg\n\nh");
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
        assert_eq!(word_range("a😀b", 2, false), 1..3);
    }

    #[test]
    fn words_in_latin_and_cjk() {
        let text = "中文abc 测试, café_1  x\n\nend";
        let word = |offset| {
            let range = word_range(text, offset, false);
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
        assert_eq!(word_range("", 0, false), 0..0);
    }

    /// The word `word_range` finds at each `at` of `text` (the first
    /// occurrence of `at`, then `skip` characters into it).
    fn word_at(text: &str, at: &str, skip: usize) -> String {
        let byte = text.find(at).expect("in the text") + at.char_indices().nth(skip).unwrap().0;
        let offset = utf16_len(&text[..byte]);
        let range = word_range(text, offset, true);
        text[byte_offset(text, range.start)..byte_offset(text, range.end)].to_string()
    }

    #[test]
    fn hostnames_urls_paths_and_ids_are_one_word() {
        let host = "Open demo-app.pages.dev now.";
        for (at, skip) in [
            ("demo", 0),
            ("demo", 3),
            ("-app", 0),
            ("app", 1),
            (".pages", 0),
            ("dev", 2),
        ] {
            assert_eq!(
                word_at(host, at, skip),
                "demo-app.pages.dev",
                "at {at}+{skip}"
            );
        }
        let url = "See https://x.y/a-b?c=1, then";
        for (at, skip) in [("https", 0), ("://", 1), ("x.y", 2), ("a-b", 2), ("c=1", 2)] {
            assert_eq!(
                word_at(url, at, skip),
                "https://x.y/a-b?c=1",
                "at {at}+{skip}"
            );
        }
        assert_eq!(word_at("edit ~/a/b-c.md today", "b-c", 0), "~/a/b-c.md");
        assert_eq!(word_at("edit ~/a/b-c.md today", "~", 0), "~/a/b-c.md");
        assert_eq!(word_at("(in /etc/hosts)", "hosts", 0), "/etc/hosts");
        assert_eq!(word_at("cd client/ui/ first", "ui", 0), "client/ui/");
        assert_eq!(word_at("run with --force-all", "force", 0), "--force-all");
        assert_eq!(word_at("mail me@x.io.", "me", 0), "me@x.io");
        assert_eq!(word_at("NSH v0.5.1 is out", "5", 0), "v0.5.1");
        assert_eq!(word_at("id ab-1234cdef ok", "12", 0), "ab-1234cdef");
        assert_eq!(word_at("worker `abc_def-1` here", "def", 0), "abc_def-1");
        // Punctuation after a token, or alone, stays out of it.
        assert_eq!(word_at("It ends with foo.", "foo", 1), "foo");
        assert_eq!(word_at("It ends with foo.", ".", 0), ".");
        assert_eq!(
            word_at("(see demo-app.pages.dev)", "dev", 0),
            "demo-app.pages.dev"
        );
        assert_eq!(word_at("one, two", "one", 0), "one");
        assert_eq!(word_at("a - b", "-", 0), "-");
        assert_eq!(word_at("so -- then", "--", 0), "-");
        // Prose and CJK as before.
        assert_eq!(word_at("the quick brown fox", "quick", 2), "quick");
        assert_eq!(word_at("it's here", "it", 0), "it");
        assert_eq!(word_at("中文demo-app.pages.dev。", "中", 0), "中");
        assert_eq!(
            word_at("中文demo-app.pages.dev。", "app", 0),
            "demo-app.pages.dev"
        );
        assert_eq!(word_at("测试。日本", "。", 0), "。");
        assert_eq!(word_at("测试-日本", "-", 0), "-");
    }

    #[test]
    fn a_long_press_selects_a_hostname_whole_and_a_double_click_its_word() {
        let texts = Fake::new(&[("Open demo-app.pages.dev now.", (0.0, 0.0, 300.0, 20.0))]);
        let mut model = SelectionModel::new();
        // On `demo` (characters 5 to 8, 8pt each).
        assert!(model.select_word_at(&texts, at(44.0, 10.0)));
        assert_eq!(model.text(&texts), "demo-app.pages.dev");
        // A double click (desktops), as the platforms' own text views do.
        model.press(&texts, at(44.0, 10.0), 2, false);
        assert_eq!(model.text(&texts), "demo");
        model.drag(&texts, at(124.0, 10.0));
        assert_eq!(model.text(&texts), "demo-app.pages");
    }

    #[test]
    fn a_query_joins_only_in_a_url_and_operators_never() {
        assert_eq!(
            word_at("go to https://x.y/a?b=1&c=2#d now", "c=2", 0),
            "https://x.y/a?b=1&c=2#d"
        );
        assert_eq!(word_at("go to x.y/a?b=1 now", "b=1", 2), "x.y/a?b=1");
        assert_eq!(word_at("set a=b first", "a=b", 0), "a");
        assert_eq!(word_at("set a=b first", "a=b", 2), "b");
        assert_eq!(word_at("then x+y is", "x+y", 0), "x");
        assert_eq!(word_at("really?yes", "yes", 0), "yes");
        assert_eq!(word_at("issue#12 here", "issue", 0), "issue");
        // A time, a port, a key and a missing space after a period are
        // written as tokens are: they stay one.
        assert_eq!(word_at("at 12:30 today", "30", 0), "12:30");
        assert_eq!(
            word_at("on localhost:8080 now", "8080", 0),
            "localhost:8080"
        );
        assert_eq!(word_at("key:value pairs", "key", 0), "key:value");
        assert_eq!(word_at("the end.Next one", "end", 0), "end.Next");
    }

    #[test]
    fn a_token_a_wrap_cut_after_a_hyphen_is_one_word() {
        // `demo-` ends the first line, `app.pages.dev` starts the next.
        let texts = Wrapped(
            Fake::new(&[
                ("Open demo-", (0.0, 0.0, 80.0, 20.0)),
                ("app.pages.dev now.", (0.0, 20.0, 144.0, 20.0)),
            ]),
            vec![false, true],
        );
        let mut model = SelectionModel::new();
        model.select_word_at(&texts, at(44.0, 5.0));
        assert_eq!(model.text(&texts), "demo-app.pages.dev");
        assert_eq!(model.bounds(), Some((pos(0, 5), pos(1, 13))));
        model.select_word_at(&texts, at(4.0, 25.0));
        assert_eq!(model.text(&texts), "demo-app.pages.dev");
        // A double click selects the word alone, wrapped or not.
        model.press(&texts, at(44.0, 5.0), 2, false);
        assert_eq!(model.text(&texts), "demo");
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

    #[test]
    fn stacked_children_go_by_their_tops_and_rows_stay_in_mount_order() {
        let frame = |x: f32, y: f32, h: f32| bounds(point(px(x), px(y)), size(px(100.0), px(h)));
        // Recycled cells: mounted showing rows 2, 0, 1 (two texts in the
        // first), and an empty spare cell overlapping them.
        let runs = [
            (frame(0.0, 200.0, 100.0), 0..2),
            (frame(0.0, 0.0, 300.0), 2..2),
            (frame(0.0, 0.0, 100.0), 2..3),
            (frame(0.0, 100.0, 100.0), 3..4),
        ];
        let order = reading_order(&runs).unwrap();
        assert_eq!(order, [2, 3, 0, 1]);
        let mut items = vec!["x", "c1", "c2", "a", "b"];
        let shifted: Vec<usize> = order.iter().map(|i| i + 1).collect();
        reorder(&mut items, 1, &shifted);
        assert_eq!(items, ["x", "a", "b", "c1", "c2"]);
        // Already in order, a row, an overlay: mount order.
        let in_order = [
            (frame(0.0, 0.0, 10.0), 0..1),
            (frame(0.0, 10.0, 10.0), 1..2),
        ];
        assert_eq!(reading_order(&in_order), None);
        let row = [
            (frame(200.0, 0.0, 20.0), 0..1),
            (frame(0.0, 0.0, 20.0), 1..2),
        ];
        assert_eq!(reading_order(&row), None);
        let overlay = [
            (frame(0.0, 50.0, 100.0), 0..1),
            (frame(0.0, 0.0, 100.0), 1..2),
        ];
        assert_eq!(reading_order(&overlay), None);
    }

    #[test]
    fn kept_rows_follow_the_ends_texts() {
        let texts = column();
        let mut model = SelectionModel::new();
        let mut kept = KeptRows::default();
        assert_eq!(kept.changed(&model), None);
        model.press(&texts, at(4.0, 4.0), 1, false);
        model.drag(&texts, at(4.0, 64.0));
        assert!(!kept.changed(&model).unwrap().is_empty());
        assert_eq!(kept.changed(&model), None);
        model.clear();
        assert_eq!(kept.changed(&model), Some(Vec::new()));
    }

    #[test]
    fn autoscroll_starts_inside_the_edge_and_speeds_up_outward() {
        let step = |at: f32| autoscroll_step(Points(at), Points(400.0));
        assert_eq!(step(200.0), Points(0.0));
        assert_eq!(step(17.0), Points(0.0));
        assert!(step(15.0) < Points(0.0));
        assert!(step(385.0) > Points(0.0));
        assert_eq!(step(400.0 - 16.0 + 96.0), AUTOSCROLL_MAX);
        assert_eq!(step(-500.0), Points(-AUTOSCROLL_MAX.0));
        assert!(step(420.0) > step(390.0));
    }

    /// Texts of which some continue the one before them (a long line's
    /// wrapped parts).
    struct Wrapped(Fake, Vec<bool>);

    impl SelectionTexts for Wrapped {
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

        fn continues(&self, i: usize) -> bool {
            self.1[i]
        }
    }

    /// `first line` alone, then `a long li` + `ne wrapped` (one line in two
    /// parts, the second continuing the first), then `last`.
    #[test]
    fn a_copy_keeps_the_blank_lines_inside_the_selection() {
        let texts = Fake::new(&[
            ("}", (0.0, 0.0, 200.0, 20.0)),
            ("", (0.0, 20.0, 0.0, 20.0)),
            ("next", (0.0, 40.0, 200.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        model.select_all(&texts);
        assert_eq!(model.text(&texts), "}\n\nnext");
    }

    fn wrapped() -> Wrapped {
        Wrapped(
            Fake::new(&[
                ("first line", (0.0, 0.0, 200.0, 20.0)),
                ("a long li", (0.0, 20.0, 200.0, 20.0)),
                ("ne wrapped", (0.0, 40.0, 200.0, 20.0)),
                ("last", (0.0, 60.0, 200.0, 20.0)),
            ]),
            vec![false, false, true, false],
        )
    }

    #[test]
    fn a_copy_joins_a_wrapped_lines_parts_with_nothing_between() {
        let texts = wrapped();
        let mut model = SelectionModel::new();
        model.select_all(&texts);
        assert_eq!(model.text(&texts), "first line\na long line wrapped\nlast");
        // From inside the first part into the second.
        model.press(&texts, at(16.0, 25.0), 1, false);
        model.drag(&texts, at(16.0, 45.0));
        assert_eq!(model.text(&texts), "long line");
    }

    #[test]
    fn a_continued_text_whose_part_before_is_not_selected_starts_the_copy() {
        let texts = wrapped();
        let mut model = SelectionModel::new();
        // From the second part to the last line: no break before the part,
        // one after it.
        model.press(&texts, at(0.0, 45.0), 1, false);
        model.drag(&texts, at(32.0, 65.0));
        assert_eq!(model.text(&texts), "ne wrapped\nlast");
    }

    #[test]
    fn a_triple_click_selects_a_wrapped_line_whole() {
        let texts = wrapped();
        let mut model = SelectionModel::new();
        model.press(&texts, at(16.0, 45.0), 3, false);
        assert_eq!(model.bounds(), Some((pos(1, 0), pos(2, 10))));
        assert_eq!(model.text(&texts), "a long line wrapped");
        // A text that continues none and that none continues: itself.
        model.press(&texts, at(8.0, 5.0), 3, false);
        assert_eq!(model.text(&texts), "first line");
    }

    #[test]
    fn a_double_click_selects_a_word_a_wrap_cut_across_its_parts() {
        let texts = wrapped();
        let mut model = SelectionModel::new();
        // On `li` at the first part's end, and on `ne` at the second's
        // start: the word `line` both times.
        model.press(&texts, at(60.0, 25.0), 2, false);
        assert_eq!(model.text(&texts), "line");
        model.press(&texts, at(8.0, 45.0), 2, false);
        assert_eq!(model.text(&texts), "line");
        // A word that ends where its text does, the next text not
        // continuing it, stays its own.
        model.press(&texts, at(60.0, 5.0), 2, false);
        assert_eq!(model.text(&texts), "line");
        assert_eq!(model.bounds(), Some((pos(0, 6), pos(0, 10))));
    }

    #[test]
    fn two_column_gaps_and_short_sidebar_stay_in_their_column() {
        let texts = Fake::new(&[
            ("Left 1", (12.0, 12.0, 200.0, 40.0)),
            ("Left 2", (12.0, 66.0, 200.0, 40.0)),
            ("Left 3", (12.0, 120.0, 200.0, 40.0)),
            ("Sidebar", (240.0, 20.0, 140.0, 70.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(20.0, 20.0), 1, false);
        // Gap between Left 1 and Left 2 (vertically overlapping Sidebar):
        // stays at Left 1's end instead of jumping to Sidebar.
        model.drag(&texts, at(80.0, 59.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 6))));
        assert_eq!(model.text(&texts), "eft 1");
        // Entering Left 2 grows monotonically.
        model.drag(&texts, at(80.0, 80.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(1, 6))));
        // Below Left 3 in the left column: stays at Left 3's end.
        model.drag(&texts, at(80.0, 190.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(2, 6))));
        // Dragging right into Sidebar, then straight down into the empty space
        // beneath Sidebar (beside Left 3) and past the bottom: stays at
        // Sidebar's end and never jumps back to Left 3 or shrinks.
        model.drag(&texts, at(280.0, 50.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 5))));
        model.drag(&texts, at(280.0, 140.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 7))));
        model.drag(&texts, at(280.0, 220.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 7))));
    }

    #[test]
    fn absolute_top_badge_does_not_hijack_body_gaps_or_bottom() {
        let texts = Fake::new(&[
            ("Title", (14.0, 14.0, 360.0, 22.0)),
            ("Body 1", (14.0, 50.0, 360.0, 40.0)),
            ("Body 2", (14.0, 104.0, 360.0, 40.0)),
            ("BADGE", (310.0, 15.0, 60.0, 18.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(20.0, 20.0), 1, false);
        // Gap between Title and Body 1: stays on Title, never flashes BADGE.
        model.drag(&texts, at(100.0, 43.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 5))));
        assert_eq!(model.text(&texts), "itle");
        // Below Body 2: stays on Body 2, never jumps up to BADGE.
        model.drag(&texts, at(100.0, 160.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(2, 6))));
        assert!(!model.text(&texts).contains("BADGE"));
        // Even directly under BADGE's x below Body 2, Body 2 is much nearer.
        model.drag(&texts, at(330.0, 160.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(2, 6))));
    }

    #[test]
    fn wrapped_table_cell_blank_space_does_not_jump_back_to_tall_sibling() {
        let texts = Fake::new(&[
            ("Long wrapped cell", (0.0, 40.0, 200.0, 60.0)),
            ("UIKit", (220.0, 40.0, 100.0, 20.0)),
            ("CoreText", (340.0, 40.0, 100.0, 20.0)),
            ("Next row left", (0.0, 110.0, 200.0, 20.0)),
            ("Views", (220.0, 110.0, 100.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(228.0, 48.0), 1, false);
        // Dragging down into the blank lower half of the UIKit cell (y=75,
        // still vertically inside the tall left cell 40..100): stays at
        // UIKit's end rather than jumping backward to cell 0.
        model.drag(&texts, at(260.0, 75.0));
        assert_eq!(model.bounds(), Some((pos(1, 1), pos(1, 5))));
        assert_eq!(model.text(&texts), "IKit");
    }

    #[test]
    fn single_column_short_lines_still_hit_their_row_and_bottom() {
        let texts = Fake::new(&[
            ("Hi", (0.0, 0.0, 40.0, 20.0)),
            ("A much wider middle paragraph", (0.0, 30.0, 300.0, 20.0)),
            ("End", (0.0, 60.0, 40.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        // Beside the short heading (directly above the wide middle line):
        // stays on the heading's row.
        model.press(&texts, at(0.0, 10.0), 1, false);
        model.drag(&texts, at(150.0, 10.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(0, 2))));
        // Below the short last line, under the wide middle line's right half:
        // still reaches the short last line's end.
        model.drag(&texts, at(150.0, 120.0));
        assert_eq!(model.bounds(), Some((pos(0, 0), pos(2, 3))));
    }

    #[test]
    fn margins_and_short_column_lines_stay_in_nearest_column() {
        let texts = Fake::new(&[
            ("Apple", (20.0, 12.0, 50.0, 20.0)),
            ("Banana", (20.0, 48.0, 60.0, 20.0)),
            ("Cherry", (20.0, 84.0, 60.0, 20.0)),
            ("Sidebar", (300.0, 12.0, 120.0, 50.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(28.0, 20.0), 1, false);
        // Left margin across the gap between Apple and Banana: stays on Apple.
        model.drag(&texts, at(4.0, 38.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 5))));
        // Empty space to the right of short left-column lines (still far
        // closer to Left than Sidebar): stays on Apple instead of Sidebar.
        model.drag(&texts, at(120.0, 38.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(0, 5))));
        // Right margin below Sidebar (beside Cherry): stays on Sidebar.
        model.drag(&texts, at(340.0, 30.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 5))));
        model.drag(&texts, at(440.0, 92.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 7))));
    }

    #[test]
    fn full_width_header_and_footer_around_two_columns_stay_monotonic() {
        let texts = Fake::new(&[
            ("Header", (0.0, 0.0, 500.0, 20.0)),
            ("Left 1", (0.0, 40.0, 200.0, 40.0)),
            ("Left 2", (0.0, 100.0, 200.0, 80.0)),
            ("Right", (300.0, 40.0, 200.0, 60.0)),
            ("Footer", (0.0, 200.0, 500.0, 20.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(10.0, 10.0), 1, false);
        // Gutter near Left 2 (20px from Left 2, 80px from Right) stays on Left 2.
        model.drag(&texts, at(220.0, 140.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(2, 6))));
        // Dragging down Right into the space below Right transitions smoothly
        // from Right to Footer without shrinking back to Left 2.
        model.drag(&texts, at(350.0, 70.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 5))));
        model.drag(&texts, at(350.0, 130.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(3, 5))));
        model.drag(&texts, at(350.0, 180.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(4, 0))));
    }

    #[test]
    fn full_width_header_does_not_pull_sibling_column_into_narrow_right_column() {
        let texts = Fake::new(&[
            ("Full-width Header", (16.0, 12.0, 420.0, 22.0)),
            ("Left column item 1", (16.0, 50.0, 190.0, 36.0)),
            ("Left column item 2", (16.0, 98.0, 190.0, 24.0)),
            ("Left column item 3", (16.0, 134.0, 190.0, 44.0)),
            ("Right", (280.0, 50.0, 56.0, 48.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(288.0, 66.0), 1, false);
        // Dragging into the empty right-column margin under the full-width
        // header stays on `Right` instead of pulling in `Left column item 2/3`.
        for y in [126.0, 129.0, 132.0, 156.0] {
            model.drag(&texts, at(356.0, y));
            assert_eq!(model.bounds(), Some((pos(4, 1), pos(4, 5))), "at y={y}");
            assert_eq!(model.text(&texts), "ight", "at y={y}");
        }
    }

    #[test]
    fn dragging_below_a_multi_column_table_reaches_the_last_cell() {
        let texts = Fake::new(&[
            ("Column A", (16.0, 20.0, 160.0, 24.0)),
            ("Column B", (200.0, 20.0, 160.0, 24.0)),
            ("Row 1 Left", (16.0, 58.0, 160.0, 24.0)),
            ("Row 1 Right", (200.0, 58.0, 160.0, 24.0)),
            ("Row 2 Left", (16.0, 96.0, 160.0, 24.0)),
            ("Row 2 Right", (200.0, 96.0, 160.0, 24.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(24.0, 32.0), 1, false);
        model.drag(&texts, at(80.0, 156.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(5, 11))));
        assert_eq!(
            model.text(&texts),
            "olumn A\tColumn B\nRow 1 Left\tRow 1 Right\nRow 2 Left\tRow 2 Right"
        );
    }

    #[test]
    fn same_bottom_side_by_side_texts_under_wide_title_keep_right_text() {
        let texts = Fake::new(&[
            (
                "Wide section title above two tags",
                (16.0, 20.0, 360.0, 24.0),
            ),
            ("Status:", (16.0, 60.0, 64.0, 24.0)),
            ("Ready", (96.0, 60.0, 56.0, 24.0)),
            ("Next paragraph below", (16.0, 140.0, 240.0, 24.0)),
        ]);
        let mut model = SelectionModel::new();
        model.press(&texts, at(24.0, 32.0), 1, false);
        // Gap to the right of `Ready` (still under the wide title): reaches
        // `Ready`'s end instead of dropping back to `Status:`.
        model.drag(&texts, at(230.0, 96.0));
        assert_eq!(model.bounds(), Some((pos(0, 1), pos(2, 5))));
        assert_eq!(
            model.text(&texts),
            "ide section title above two tags\nStatus:\tReady"
        );
    }
}
