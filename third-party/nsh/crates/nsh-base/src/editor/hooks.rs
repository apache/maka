//! What an app builds language features on (hover information, go to
//! definition, code actions; completion is built in, `completion.rs`), as
//! gpui-base's `lsp` hooks allow: the editor draws no popup of its own for
//! them, it tells the app where the pointer
//! rests (`onHover`, `onHoverEnd`) and what was pressed (`onTextPress`),
//! and its ref says where the text is (`caretBounds`, `rangeBounds`) and
//! scrolls (`revealPosition`, `goToLine`), so the app places its popups
//! (an `Overlay` against a `pageBounds`, a box in the editor's).
//!
//! Where the text is in the root view: the editor measures its box and the
//! rows' box (`ElementRef::measure`) when they are laid out, and each
//! pointer event over the rows tells where they are exactly then. The
//! offset of the rows in the editor moves only with the editor's own
//! scrolling, which it knows; so a box of the text is placed with what was
//! last seen and the scrolling since.

use std::{cell::RefCell, ops::Range, rc::Rc, time::Duration};

use nsh_core::{
    keymap::Modifiers,
    prelude::*,
    time::{Instant, now},
};

use super::{
    EditorDiagnostic, EditorEvent, EditorPosition, EditorRange,
    buffer::Buffer,
    commands::Outcome,
    controller::Ed,
    movement,
    state::State,
    types::{Selection, Selections},
    view::CARET_WIDTH,
};

/// How long the pointer rests before a hover is reported (gpui-base's
/// hover delay).
pub(crate) const HOVER_DELAY: Duration = Duration::from_millis(150);

/// Where the pointer rests over an [`super::Editor`]'s text
/// (`onHover`): what to ask a language server about (`textDocument/hover`)
/// and where to show what it says.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorHoverEvent {
    /// The character under the pointer.
    pub position: EditorPosition,
    /// The same place as an offset in the text: UTF-16 code units, as JS
    /// strings count them.
    pub offset: u32,
    /// The word (or run of punctuation or blanks) the character is in: a
    /// new hover comes only once the pointer leaves it.
    pub range: EditorRange,
    /// The pointer, in the root view.
    pub page_position: Point<Points>,
    /// The word's box on its row, in the root view: what a popup is
    /// placed against (an `Overlay`'s `anchor`).
    pub page_bounds: Bounds<Points>,
    /// The modifier keys held (Mod held: a definition to underline).
    pub modifiers: Modifiers,
    /// The diagnostics at the character, their ranges as they are now:
    /// their messages to show.
    pub diagnostics: Vec<EditorDiagnostic>,
}

/// A press on an [`super::Editor`]'s text (`onTextPress`), after the
/// editor placed its caret: with the modifiers, Mod-click goes to a
/// definition.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorTextPressEvent {
    /// The character pressed.
    pub position: EditorPosition,
    /// The same place as an offset in the text (UTF-16 code units).
    pub offset: u32,
    /// The word (or run of punctuation or blanks) the character is in.
    pub range: EditorRange,
    /// The pointer, in the root view.
    pub page_position: Point<Points>,
    /// The modifier keys held.
    pub modifiers: Modifiers,
    /// Consecutive presses at the same place: 1, 2 for a double click, ...
    pub clicks: u32,
}

/// A box of an [`super::Editor`]'s text (`caretBounds`, `rangeBounds`), in
/// two coordinate spaces.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorBounds {
    /// In the editor's box, its scrolling applied: for a popup the app
    /// lays out over the editor, in a view around it.
    pub bounds: Bounds<Points>,
    /// In the root view (the surface, or the dialog the editor is in): an
    /// `Overlay`'s `anchor`.
    pub page_bounds: Bounds<Points>,
}

/// Where the editor was last seen.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Place {
    /// The editor's top left in the root view.
    page: Point<Points>,
    /// The rows' box's top left in the editor's box, with the scroll views
    /// at `scroll`.
    rows: Point<Points>,
    scroll: Point<Points>,
}

impl Place {
    /// The rows' box's top left in the editor's box, the scroll views at
    /// `scroll`.
    fn rows_at(&self, scroll: Point<Points>) -> Point<Points> {
        self.rows - (scroll - self.scroll)
    }
}

/// The pointer over the rows.
#[derive(Debug, Clone, Copy)]
struct Pointer {
    /// In the rows' box.
    local: Point<Points>,
    /// In the root view.
    page: Point<Points>,
    modifiers: Modifiers,
    /// When it moved there.
    moved: Instant,
}

/// The hover's state.
#[derive(Debug, Default)]
struct Hover {
    /// Where the pointer is, while it is over the rows.
    pointer: Option<Pointer>,
    /// A task waits for the pointer to rest.
    waiting: bool,
    /// The range of the hover reported, until it ends.
    shown: Option<Range<usize>>,
}

/// The editor's part of these hooks. Cloned with the controller.
#[derive(Clone)]
pub(crate) struct Hooks {
    /// The editor's outer view.
    pub(crate) outer: ElementRef,
    /// The rows' box.
    pub(crate) rows: ElementRef,
    place: Rc<RefCell<Option<Place>>>,
    /// Changes when `place` is measured again.
    placed: Signal<u64>,
    hover: Rc<RefCell<Hover>>,
}

impl Hooks {
    pub(crate) fn new() -> Hooks {
        Hooks {
            outer: element_ref(),
            rows: element_ref(),
            place: Rc::default(),
            placed: signal(0),
            hover: Rc::default(),
        }
    }
}

/// What is under a point of the rows' box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Hit {
    /// The start of the character under the point, or (`over` false) the
    /// caret offset nearest to it.
    pub(crate) offset: usize,
    /// The point is over a character: not past a line's end, left of a
    /// wrapped row's indentation or below the text.
    pub(crate) over: bool,
}

/// What is under `point` of the rows' box.
pub(crate) fn hit(st: &State, point: Point<Points>) -> Hit {
    let near = st.offset_at(point);
    let lh = st.line_height().0.max(1.0);
    let rows = st.display.row_count();
    if point.x.0 < 0.0 || point.y.0 < 0.0 || point.y.0 >= lh * rows as f32 {
        return Hit {
            offset: near,
            over: false,
        };
    }
    let row = st.display.row((point.y.0 / lh) as usize);
    let x = st.caret_point(near).x;
    if x > point.x {
        // The nearest boundary is right of the point: the character before
        // it is under the point, unless the row starts there.
        if near > row.range.start {
            return Hit {
                offset: movement::prev_grapheme(&st.buffer, near),
                over: true,
            };
        }
        return Hit {
            offset: near,
            over: false,
        };
    }
    // The character after the boundary; a wrapped row's last offset is
    // before its last character, a line's end after it.
    Hit {
        offset: near,
        over: near < row.range.end,
    }
}

/// The word (or run of punctuation or blanks) the character at `offset` is
/// in.
pub(crate) fn word_at(st: &State, offset: usize) -> Range<usize> {
    let word = movement::word_range(&st.buffer, offset, st.language.word_chars);
    // At a word's end the word before is the one `word_range` picks (a
    // double click there selects it); the character after is the one here.
    if word.start <= offset && offset < word.end {
        word
    } else {
        offset..movement::next_grapheme(&st.buffer, offset)
    }
}

/// `range` of the text as positions.
fn editor_range(st: &State, range: &Range<usize>) -> EditorRange {
    EditorRange::new(st.position(range.start), st.position(range.end))
}

/// The diagnostics marking the character at `offset`, their ranges as they
/// are now.
pub(crate) fn diagnostics_at(st: &State, offset: usize) -> Vec<EditorDiagnostic> {
    // An empty mark at the end of the line can mark the char before it.
    let line_end = st.buffer.line_end(st.buffer.line_of(offset));
    st.diagnostics_near(offset, line_end.max(offset))
        .filter(|mark| {
            let r = &mark.range;
            if !r.is_empty() {
                return r.start <= offset && offset < r.end;
            }
            // An empty range marks the character after it, or at a line's
            // end the one before it (as its mark is drawn).
            let line_end = st.buffer.line_end(st.buffer.line_of(r.start));
            if r.start < line_end {
                offset == r.start
            } else {
                r.start > 0 && offset == movement::prev_grapheme(&st.buffer, r.start)
            }
        })
        .map(|mark| {
            let mut diagnostic = mark.item.clone();
            diagnostic.range = editor_range(st, &mark.range);
            diagnostic
        })
        .collect()
}

/// The UTF-16 offset of byte offset `offset`.
pub(crate) fn utf16_offset(buffer: &Buffer, offset: usize) -> u32 {
    let rope = buffer.rope();
    let units = rope.char_to_utf16_cu(rope.byte_to_char(buffer.clip(offset)));
    u32::try_from(units).unwrap_or(u32::MAX)
}

/// The byte offset of UTF-16 offset `units`: past the end, the end; inside
/// a surrogate pair, the start of its character.
pub(crate) fn byte_offset(buffer: &Buffer, units: u32) -> usize {
    let rope = buffer.rope();
    let units = (units as usize).min(rope.len_utf16_cu());
    rope.char_to_byte(rope.utf16_cu_to_char(units))
}

/// The hover at `local` of the rows' box (`page` in the root view): the
/// event and the range it holds for.
fn hover_at(
    st: &State,
    local: Point<Points>,
    page: Point<Points>,
    modifiers: Modifiers,
) -> Option<(EditorHoverEvent, Range<usize>)> {
    let hit = hit(st, local);
    if !hit.over {
        return None;
    }
    let word = word_at(st, hit.offset);
    let (row, _) = st.display.locate(&st.buffer, hit.offset);
    let word_box = st
        .range_rects(word.clone(), row..row + 1, false)
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            Bounds::new(
                st.caret_point(hit.offset),
                Size::new(px(0.0), st.line_height()),
            )
        });
    // The pointer says exactly where the rows are now.
    let rows_page = page - local;
    let event = EditorHoverEvent {
        position: st.position(hit.offset),
        offset: utf16_offset(&st.buffer, hit.offset),
        range: editor_range(st, &word),
        page_position: page,
        page_bounds: Bounds::new(word_box.origin + rows_page, word_box.size),
        modifiers,
        diagnostics: diagnostics_at(st, hit.offset),
    };
    Some((event, word))
}

/// Whether the hover over `shown` still holds at character `offset`.
fn holds(shown: &Range<usize>, offset: usize) -> bool {
    shown.start <= offset && offset < shown.end.max(shown.start + 1)
}

/// The rows (from the first one in view) the viewport shows, with
/// `scroll_y` the vertical offset, `rows_top` where the rows start in the
/// scrolled content, `height` the viewport's.
pub(crate) fn rows_in_view(
    st: &State,
    scroll_y: Points,
    rows_top: Points,
    height: Points,
) -> Range<usize> {
    let lh = st.line_height().0.max(1.0);
    let last_row = st.display.row_count() - 1;
    let top = (scroll_y - rows_top).0.max(0.0);
    let first = ((top / lh).floor() as usize).min(last_row);
    let bottom = top + height.0.max(0.0);
    let last = ((bottom / lh).ceil() as usize)
        .saturating_sub(1)
        .clamp(first, last_row);
    first..last + 1
}

impl Ed {
    /// Follows what ends a hover: an edit or a new layout of the text, and
    /// scrolling (the text moves from under the pointer); and keeps where
    /// the rows are in the editor as the gutter changes width.
    pub(crate) fn follow_hooks(&self) {
        let ed = self.clone();
        effect(move || {
            ed.text_rev.get();
            ed.scroll_x.get();
            ed.scroll_y.get();
            ed.end_hover();
        });
        let ed = self.clone();
        let gutter = computed(move || {
            ed.text_rev.get();
            let digits = ed.st.borrow().buffer.line_count().max(1).ilog10();
            (ed.props.line_numbers.get(), ed.props.folding.get(), digits)
        });
        let ed = self.clone();
        effect(move || {
            gutter.get();
            ed.measure_place();
        });
    }

    /// Measures where the editor and its rows are (after a layout).
    pub(crate) fn measure_place(&self) {
        let ed = self.clone();
        spawn(async move {
            let outer = ed.hooks.outer.measure();
            let rows = ed.hooks.rows.measure();
            let (Some(outer), Some(rows)) = (outer.await, rows.await) else {
                return;
            };
            *ed.hooks.place.borrow_mut() = Some(Place {
                page: outer.page,
                rows: rows.page - outer.page,
                scroll: ed.scroll_offset(),
            });
            ed.hooks.placed.update(|n| *n += 1);
        });
    }

    /// `local`, a point of the rows' box, in the editor's box, following
    /// where the rows are and the scroll views (tracked); the rows' box's
    /// own point until the editor was measured.
    pub(crate) fn in_editor(&self, local: Point<Points>) -> Point<Points> {
        self.hooks.placed.get();
        let scroll = Point::new(self.scroll_x.get(), self.scroll_y.get());
        match *self.hooks.place.borrow() {
            Some(place) => local + place.rows_at(scroll),
            None => local,
        }
    }

    /// The pointer at `local` of the rows' box is at `page` in the root
    /// view: where the editor is now, should it have moved with what is
    /// around it.
    fn pointer_seen(&self, local: Point<Points>, page: Point<Points>) {
        let scroll = self.scroll_offset();
        if let Some(place) = self.hooks.place.borrow_mut().as_mut() {
            place.page = page - local - place.rows_at(scroll);
        }
    }

    /// `local` (a box of the rows') in the editor's box and the root view.
    fn place_bounds(&self, local: Bounds<Points>) -> Option<EditorBounds> {
        let place = (*self.hooks.place.borrow())?;
        let origin = local.origin + place.rows_at(self.scroll_offset());
        Some(EditorBounds {
            bounds: Bounds::new(origin, local.size),
            page_bounds: Bounds::new(origin + place.page, local.size),
        })
    }

    // Hover.

    /// The mouse moved over the rows (no button down), or the modifiers
    /// changed while it rests (the platforms report that as a move to
    /// where it is).
    pub(crate) fn hover_move(&self, e: &HoverEvent) {
        self.pointer_seen(e.position, e.page_position);
        let before = self.hooks.hover.borrow().pointer;
        // Only the modifiers changed: the pointer still rests since it came.
        let moved = match before {
            Some(p) if p.local == e.position => p.moved,
            _ => now(),
        };
        let modifiers_changed = before.is_some_and(|p| p.modifiers != e.modifiers);
        let pointer = Pointer {
            local: e.position,
            page: e.page_position,
            modifiers: e.modifiers,
            moved,
        };
        let shown = {
            let mut hover = self.hooks.hover.borrow_mut();
            hover.pointer = Some(pointer);
            hover.shown.clone()
        };
        self.definition_hover(e.position, e.modifiers);
        if let Some(shown) = shown {
            let hit = hit(&self.st.borrow(), e.position);
            if hit.over && holds(&shown, hit.offset) {
                // The same word with other modifiers: reported again, as
                // they decide what it is for (Mod: a definition).
                if modifiers_changed {
                    self.show_hover(pointer);
                }
                return;
            }
            // Off the word shown: the next one at once (a popup is open),
            // or the end.
            if !self.show_hover(pointer) {
                self.end_hover();
            }
            return;
        }
        self.wait_for_rest();
    }

    /// Reports the hover once the pointer rests, unless a task waits
    /// already: it waits again while the pointer keeps moving, so one task
    /// serves a whole move.
    fn wait_for_rest(&self) {
        {
            let mut hover = self.hooks.hover.borrow_mut();
            if hover.waiting {
                return;
            }
            hover.waiting = true;
        }
        let ed = self.clone();
        spawn(async move {
            loop {
                let moved = ed.hooks.hover.borrow().pointer.map(|p| p.moved);
                let Some(moved) = moved else { break };
                let due = moved + HOVER_DELAY;
                if now() < due {
                    timer_until(due).await;
                    continue;
                }
                let pointer = ed.hooks.hover.borrow().pointer;
                ed.hooks.hover.borrow_mut().waiting = false;
                if let Some(pointer) = pointer {
                    ed.show_hover(pointer);
                }
                return;
            }
            ed.hooks.hover.borrow_mut().waiting = false;
        });
    }

    /// Reports the hover at `pointer`: whether there is one (the pointer
    /// is over a character).
    fn show_hover(&self, pointer: Pointer) -> bool {
        let found = hover_at(
            &self.st.borrow(),
            pointer.local,
            pointer.page,
            pointer.modifiers,
        );
        let Some((event, range)) = found else {
            return false;
        };
        self.hooks.hover.borrow_mut().shown = Some(range);
        self.cx.emit(EditorEvent::Hover(event));
        true
    }

    /// The mouse left the rows.
    pub(crate) fn hover_out(&self) {
        self.hooks.hover.borrow_mut().pointer = None;
        self.hide_definition_link();
        self.end_hover();
    }

    /// Ends the hover reported, if any (`onHoverEnd`).
    pub(crate) fn end_hover(&self) {
        let shown = self.hooks.hover.borrow_mut().shown.take();
        if shown.is_some() {
            self.cx.emit(EditorEvent::HoverEnd);
        }
    }

    // Presses.

    /// A press at `local` of the rows' box (`page` in the root view),
    /// after the editor placed its caret: reported over a character.
    pub(crate) fn text_press(
        &self,
        local: Point<Points>,
        page: Point<Points>,
        modifiers: Modifiers,
        clicks: u32,
    ) {
        self.pointer_seen(local, page);
        let event = {
            let st = self.st.borrow();
            let hit = hit(&st, local);
            if !hit.over {
                return;
            }
            let word = word_at(&st, hit.offset);
            EditorTextPressEvent {
                position: st.position(hit.offset),
                offset: utf16_offset(&st.buffer, hit.offset),
                range: editor_range(&st, &word),
                page_position: page,
                modifiers,
                clicks: clicks.max(1),
            }
        };
        self.cx.emit(EditorEvent::TextPress(event));
    }

    // The ref.

    pub(crate) fn caret_bounds(&self) -> Option<EditorBounds> {
        let local = {
            let st = self.st.borrow();
            let p = st.caret_point(st.primary_head());
            Bounds::new(
                Point::new(p.x - px(CARET_WIDTH / 2.0), p.y),
                Size::new(px(CARET_WIDTH), st.line_height()),
            )
        };
        self.place_bounds(local)
    }

    pub(crate) fn range_bounds(&self, range: EditorRange) -> Vec<EditorBounds> {
        let boxes = {
            let st = self.st.borrow();
            let a = st.offset_of(range.start);
            let b = st.offset_of(range.end);
            let (start, end) = (a.min(b), a.max(b));
            if start == end {
                vec![Bounds::new(
                    st.caret_point(start),
                    Size::new(px(0.0), st.line_height()),
                )]
            } else {
                st.range_rects(start..end, 0..st.display.row_count(), false)
            }
        };
        boxes
            .into_iter()
            .filter_map(|b| self.place_bounds(b))
            .collect()
    }

    pub(crate) fn set_scroll_offset(&self, offset: Point<Points>) {
        let y = offset.y.max(px(0.0));
        self.scroll_y.set(y);
        self.vscroll.scroll_to(Point::new(px(0.0), y), false);
        if !self.props.soft_wrap.get_untracked() {
            let x = offset.x.max(px(0.0));
            self.scroll_x.set(x);
            self.hscroll.scroll_to(Point::new(x, px(0.0)), false);
        }
    }

    pub(crate) fn visible_range(&self) -> EditorRange {
        let st = self.st.borrow();
        let rows = rows_in_view(
            &st,
            self.scroll_y.get_untracked(),
            self.rows_top.get_untracked(),
            self.viewport.get_untracked().height,
        );
        let start = st.display.row(rows.start).range.start;
        let end = st.display.row(rows.end - 1).range.end;
        editor_range(&st, &(start..end))
    }

    pub(crate) fn selected_text(&self) -> String {
        let st = self.st.borrow();
        st.buffer.slice(st.selections.primary().range())
    }

    pub(crate) fn offset_to_position(&self, offset: u32) -> EditorPosition {
        let st = self.st.borrow();
        st.position(byte_offset(&st.buffer, offset))
    }

    pub(crate) fn position_to_offset(&self, position: EditorPosition) -> u32 {
        let st = self.st.borrow();
        utf16_offset(&st.buffer, st.offset_of(position))
    }

    pub(crate) fn reveal_position(&self, position: EditorPosition, center: bool) {
        let (point, lh) = {
            let mut st = self.st.borrow_mut();
            let offset = st.offset_of(position);
            st.reveal(offset);
            (st.caret_point(offset), st.line_height())
        };
        self.bump_text();
        self.scroll_into_view(point, lh);
        if center {
            self.center_vertically(point, lh);
        }
    }

    pub(crate) fn go_to_line(&self, line: u32) {
        {
            let mut st = self.st.borrow_mut();
            let offset = st.buffer.line_start(line as usize);
            st.selections = Selections::single(Selection::caret(offset));
        }
        self.after(Outcome::Moved);
        let (point, lh) = {
            let st = self.st.borrow();
            (st.caret_point(st.primary_head()), st.line_height())
        };
        self.center_vertically(point, lh);
    }

    /// Scrolls so that a row at `point` of the rows' box (`lh` tall) is in
    /// the middle of the viewport, as far as the text goes.
    fn center_vertically(&self, point: Point<Points>, lh: Points) {
        let viewport = self.viewport.get_untracked();
        if viewport.height.0 <= 0.0 {
            return;
        }
        let middle = self.rows_top.get_untracked() + point.y + lh / 2.0;
        let target = (middle - viewport.height / 2.0).max(px(0.0));
        self.scroll_y.set(target);
        self.vscroll.scroll_to(Point::new(px(0.0), target), false);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        super::{
            EditorDiagnosticSeverity,
            commands::EditOptions,
            diagnostics::Mark,
            language,
            state::{Font, State},
        },
        *,
    };

    /// Every char 10 points wide, rows 20 tall.
    fn state(text: &str) -> State {
        let font = Font {
            family: "monospace".into(),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|text: &str| px(10.0 * text.chars().count() as f32));
        State::new(
            text,
            language::language("rust"),
            EditOptions::default(),
            font,
            measure,
        )
    }

    fn at(x: f32, y: f32) -> Point<Points> {
        Point::new(px(x), px(y))
    }

    #[test]
    fn hits_the_character_under_the_point() {
        let st = state("let foo = 1;\nx");
        // The left and the right half of `f` (x 40..50).
        assert_eq!(
            hit(&st, at(41.0, 5.0)),
            Hit {
                offset: 4,
                over: true
            }
        );
        assert_eq!(
            hit(&st, at(49.0, 5.0)),
            Hit {
                offset: 4,
                over: true
            }
        );
        // The first character of a line.
        assert_eq!(hit(&st, at(2.0, 25.0)).offset, 13);
        assert!(hit(&st, at(2.0, 25.0)).over);
    }

    #[test]
    fn misses_past_a_line_end_and_below_the_text() {
        let st = state("ab\nlonger line");
        // Right of `ab`, on the first line.
        assert!(!hit(&st, at(60.0, 5.0)).over);
        assert_eq!(hit(&st, at(60.0, 5.0)).offset, 2);
        // The right half of `b` is still over it.
        assert!(hit(&st, at(18.0, 5.0)).over);
        // Below the last row, and left of the text.
        assert!(!hit(&st, at(5.0, 45.0)).over);
        assert!(!hit(&st, at(-1.0, 5.0)).over);
        // An empty text has no character.
        assert!(!hit(&state(""), at(0.0, 0.0)).over);
    }

    #[test]
    fn a_hover_is_over_the_word_and_holds_inside_it() {
        let st = state("let foo = 1;");
        let (event, range) = hover_at(&st, at(52.0, 5.0), at(152.0, 105.0), Modifiers::default())
            .expect("over `foo`");
        assert_eq!(range, 4..7);
        assert_eq!(event.position, EditorPosition::new(0, 5));
        assert_eq!(event.offset, 5);
        assert_eq!(
            event.range,
            EditorRange::new(EditorPosition::new(0, 4), EditorPosition::new(0, 7))
        );
        // The rows are at (100, 100) of the root view: the word's box there.
        assert_eq!(
            event.page_bounds,
            Bounds::new(at(140.0, 100.0), Size::new(px(30.0), px(20.0)))
        );
        assert!(holds(&range, 6));
        assert!(!holds(&range, 7));
        // A blank is a run of its own.
        let (_, blank) = hover_at(&st, at(32.0, 5.0), at(0.0, 0.0), Modifiers::default()).unwrap();
        assert_eq!(blank, 3..4);
        assert!(hover_at(&st, at(500.0, 5.0), at(0.0, 0.0), Modifiers::default()).is_none());
    }

    #[test]
    fn diagnostics_at_a_character_carry_their_current_ranges() {
        let mut st = state("let foo = bar;\n");
        let diagnostic = |message: &str| EditorDiagnostic {
            message: message.to_string().into(),
            severity: EditorDiagnosticSeverity::Warning,
            ..Default::default()
        };
        st.set_diagnostics(vec![
            Mark {
                range: 4..7,
                item: diagnostic("unused"),
            },
            // Empty: the character after it.
            Mark {
                range: 10..10,
                item: diagnostic("at bar"),
            },
            // Empty at the line's end: the character before it.
            Mark {
                range: 14..14,
                item: diagnostic("at the end"),
            },
        ]);
        let messages = |offset| -> Vec<String> {
            diagnostics_at(&st, offset)
                .into_iter()
                .map(|d| d.message.to_string())
                .collect()
        };
        assert_eq!(messages(5), ["unused"]);
        assert_eq!(
            diagnostics_at(&st, 5)[0].range.end,
            EditorPosition::new(0, 7)
        );
        assert!(messages(7).is_empty());
        assert_eq!(messages(10), ["at bar"]);
        assert!(messages(11).is_empty());
        assert_eq!(messages(13), ["at the end"]);
    }

    #[test]
    fn utf16_offsets_round_trip_and_clamp() {
        let buffer = Buffer::new("a😀b\nü");
        // `😀` is 4 bytes and 2 UTF-16 units.
        assert_eq!(utf16_offset(&buffer, 1), 1);
        assert_eq!(utf16_offset(&buffer, 5), 3);
        assert_eq!(utf16_offset(&buffer, buffer.len()), 6);
        assert_eq!(byte_offset(&buffer, 3), 5);
        // Inside the surrogate pair: the start of its character.
        assert_eq!(byte_offset(&buffer, 2), 1);
        // Past the end: the end.
        assert_eq!(byte_offset(&buffer, 100), buffer.len());
        for offset in [0, 1, 5, 6, 7, buffer.len()] {
            assert_eq!(byte_offset(&buffer, utf16_offset(&buffer, offset)), offset);
        }
    }

    #[test]
    fn rows_in_view_follow_the_scroll_offset() {
        let st = state(&"x\n".repeat(99));
        // 100 rows of 20: a viewport of 100 shows 5 of them.
        assert_eq!(rows_in_view(&st, px(0.0), px(0.0), px(100.0)), 0..5);
        // Half a row scrolled: a sixth shows partly.
        assert_eq!(rows_in_view(&st, px(10.0), px(0.0), px(100.0)), 0..6);
        // Rows that start below the top of the content.
        assert_eq!(rows_in_view(&st, px(40.0), px(20.0), px(100.0)), 1..6);
        // Past the end, and before a layout.
        assert_eq!(rows_in_view(&st, px(5000.0), px(0.0), px(100.0)), 99..100);
        assert_eq!(rows_in_view(&st, px(0.0), px(0.0), px(0.0)), 0..1);
    }

    #[test]
    fn a_place_follows_the_editors_scrolling() {
        let place = Place {
            page: at(10.0, 10.0),
            rows: at(50.0, 0.0),
            scroll: at(0.0, 100.0),
        };
        assert_eq!(place.rows_at(at(0.0, 100.0)), at(50.0, 0.0));
        assert_eq!(place.rows_at(at(30.0, 140.0)), at(20.0, -40.0));
    }
}
