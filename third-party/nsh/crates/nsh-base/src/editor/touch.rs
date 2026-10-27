//! Touch selection in an [`super::Editor`]: a tap places the caret, a
//! double tap or a long press selects the word under the finger (a long
//! press on blank space places the caret), and the selection a touch made
//! carries a handle at each end, which a finger drags to move that end.
//! The app's edit menu opens through `onContextMenu`, told where the
//! selection is in the root view (`selection`): after a long press, a
//! double tap, a handle let go, and a tap on the selection.
//!
//! The touch selection remembers the range it made. As soon as the
//! selection is something else (a tap elsewhere, typing, a command, the
//! app's `setSelections`), the handles are gone without anyone hiding
//! them; only the gesture and the handles move the range along. The
//! handles claim their touches (the text around them still scrolls with a
//! finger) and keep them from the scroll views, as a resize handle does.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::prelude::*;

use super::{
    EditorContextMenuEvent, EditorEvent, EditorPart,
    controller::Ed,
    state::State,
    types::{Selection, Selections},
    view::parts,
};
use crate::theme;

/// How soon a second tap makes a double tap.
const DOUBLE_TAP: Duration = Duration::from_millis(300);
/// How far from the first tap, in points, a second one still is a double
/// tap.
const DOUBLE_TAP_SLOP: f32 = 24.0;
/// The width of a handle's hit area, centered on its end.
const HANDLE_WIDTH: f32 = 32.0;
/// The room a handle's knob hangs in, above the start's line and below the
/// end's (part of the hit area).
const KNOB_ROOM: f32 = 16.0;
/// The knob's default diameter.
const KNOB: f32 = 10.0;

/// A rectangle in an editor's root view (the surface, or the dialog around
/// the editor): where a touch selection is, for the edit menu the app
/// opens over it.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorRect {
    /// Its left edge.
    pub x: Points,
    /// Its top edge.
    pub y: Points,
    /// Its width.
    pub width: Points,
    /// Its height.
    pub height: Points,
}

impl From<Bounds<Points>> for EditorRect {
    fn from(b: Bounds<Points>) -> Self {
        EditorRect {
            x: b.origin.x,
            y: b.origin.y,
            width: b.size.width,
            height: b.size.height,
        }
    }
}

/// An end of the touch selection, and its handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edge {
    Start,
    End,
}

/// A handle being dragged.
#[derive(Debug, Clone, Copy)]
struct HandleDrag {
    /// The other end, which stays.
    fixed: usize,
    /// The middle of the dragged end's line at the grant, in the rows' box:
    /// the text point the finger moves.
    anchor: Point<Points>,
    /// The finger at the grant, in the root view.
    origin: Point<Points>,
    /// The scroll offsets at the grant (the rows move under the finger as
    /// they scroll).
    scroll: Point<Points>,
}

#[derive(Default)]
struct Inner {
    /// The range the last touch gesture left (start, end); `None` when no
    /// touch selection was made since the last tap elsewhere.
    range: Option<(usize, usize)>,
    drag: Option<HandleDrag>,
    /// The root view less the rows' box at the last touch, and the scroll
    /// offsets then: what turns the rows' points into the root view's.
    shift: Option<(Point<Points>, Point<Points>)>,
    /// The last tap, in the root view, while a second one would make a
    /// double tap.
    last_tap: Option<Point<Points>>,
    tap_timer: Option<Spawned<()>>,
}

/// The editor's touch selection. Cloned with the controller.
#[derive(Clone)]
pub(crate) struct Touch {
    inner: Rc<RefCell<Inner>>,
    /// The touch selection was made, dropped, or a drag began or ended.
    rev: Signal<u64>,
}

impl Touch {
    pub(crate) fn new() -> Touch {
        Touch {
            inner: Rc::default(),
            rev: signal(0),
        }
    }

    fn bump(&self) {
        self.rev.update(|r| *r += 1);
    }

    /// Notes a tap at `page`; whether it is the second of a double tap.
    fn tap_at(&self, page: Point<Points>) -> bool {
        let mut inner = self.inner.borrow_mut();
        if let Some(task) = inner.tap_timer.take() {
            task.cancel();
        }
        if let Some(last) = inner.last_tap.take()
            && near(last, page)
        {
            return true;
        }
        inner.last_tap = Some(page);
        let state = self.inner.clone();
        inner.tap_timer = Some(set_timeout(DOUBLE_TAP, move || {
            state.borrow_mut().last_tap = None;
        }));
        false
    }

    fn forget_tap(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.last_tap = None;
        if let Some(task) = inner.tap_timer.take() {
            task.cancel();
        }
    }
}

/// Whether two taps are close enough for a double tap.
fn near(a: Point<Points>, b: Point<Points>) -> bool {
    let (dx, dy) = ((a.x - b.x).0, (a.y - b.y).0);
    dx * dx + dy * dy <= DOUBLE_TAP_SLOP * DOUBLE_TAP_SLOP
}

/// Whether `p` is inside `b`.
fn contains(b: Bounds<Points>, p: Point<Points>) -> bool {
    p.x >= b.origin.x
        && p.x <= b.origin.x + b.size.width
        && p.y >= b.origin.y
        && p.y <= b.origin.y + b.size.height
}

/// `range` while it is still the selection (one selection, exactly it).
pub(crate) fn live(st: &State, range: Option<(usize, usize)>) -> Option<(usize, usize)> {
    let (start, end) = range?;
    let primary = st.selections.primary();
    (st.selections.len() == 1 && primary.start() == start && primary.end() == end)
        .then_some((start, end))
}

/// The selection dragging a handle to `offset` makes, from the end that
/// stays, and the end the finger then holds; `None` where it would
/// collapse (a handle stops at the other end until the finger passes it).
pub(crate) fn drag_selection(fixed: usize, offset: usize) -> Option<(Selection, Edge)> {
    if offset == fixed {
        return None;
    }
    let edge = if offset < fixed {
        Edge::Start
    } else {
        Edge::End
    };
    Some((Selection::new(fixed, offset), edge))
}

/// The box of `start..end` in the rows' box: from the start's line to the
/// end's, as wide as the rectangles of the rows in view reach.
pub(crate) fn selection_bounds(
    st: &State,
    start: usize,
    end: usize,
    rows: std::ops::Range<usize>,
) -> Bounds<Points> {
    let lh = st.line_height();
    let a = st.caret_point(start);
    let b = st.caret_point(end);
    let (mut left, mut right) = (a.x.min(b.x), a.x.max(b.x));
    if a.y != b.y {
        for r in st.range_rects(start..end, rows, false) {
            left = left.min(r.origin.x);
            right = right.max(r.origin.x + r.size.width);
        }
    }
    Bounds::new(
        Point::new(left, a.y),
        Size::new(right - left, b.y + lh - a.y),
    )
}

/// The hit area of `edge`'s handle at `offset`, in the rows' box: the
/// line's height and the knob's room, above the line for the start, below
/// it for the end.
pub(crate) fn handle_box(st: &State, edge: Edge, offset: usize) -> Bounds<Points> {
    let p = st.caret_point(offset);
    let top = match edge {
        Edge::Start => p.y - px(KNOB_ROOM),
        Edge::End => p.y,
    };
    Bounds::new(
        Point::new(p.x - px(HANDLE_WIDTH / 2.0), top),
        Size::new(px(HANDLE_WIDTH), st.line_height() + px(KNOB_ROOM)),
    )
}

impl Ed {
    /// The scroll views' offsets now.
    fn scroll_now(&self) -> Point<Points> {
        Point::new(self.scroll_x.get_untracked(), self.scroll_y.get_untracked())
    }

    /// Notes where the rows' box is in the root view, from a touch at `at`
    /// in it and `page` in the root view.
    fn note_shift(&self, at: Point<Points>, page: Point<Points>) {
        let scroll = self.scroll_now();
        self.touch.inner.borrow_mut().shift = Some((page - at, scroll));
    }

    /// The touch selection's range while it is the selection.
    pub(crate) fn touch_range(&self) -> Option<(usize, usize)> {
        let range = self.touch.inner.borrow().range;
        live(&self.st.borrow(), range)
    }

    /// A tap at `at` in the rows' box (`page` in the root view), `clicks`
    /// as the platform counted them.
    pub(crate) fn tap(&self, at: Point<Points>, page: Point<Points>, clicks: u32) {
        let double = self.touch.tap_at(page) || clicks >= 2;
        if double {
            self.touch.forget_tap();
            self.select_word_by_touch(at, page);
            return;
        }
        // A tap on the touch selection, or on one of its handles (when the
        // press reaches the rows too), asks for its menu again.
        if let Some((start, end)) = self.touch_range() {
            let (offset, on_handle) = {
                let st = self.st.borrow();
                let on_handle = start < end
                    && self.focused.get_untracked()
                    && (contains(handle_box(&st, Edge::Start, start), at)
                        || contains(handle_box(&st, Edge::End, end), at));
                (st.offset_at(at), on_handle)
            };
            if on_handle || (offset > start && offset < end) {
                self.note_shift(at, page);
                self.open_edit_menu();
                return;
            }
        }
        self.drop_touch_selection();
        self.press(at, page, Default::default(), 1);
        self.release();
    }

    /// A long press at `at` in the rows' box: the word under the finger,
    /// or the caret on blank space, with the edit menu.
    pub(crate) fn long_press(&self, at: Point<Points>, page: Point<Points>) {
        self.touch.forget_tap();
        self.select_word_by_touch(at, page);
    }

    /// Selects the word at `at` (the caret there on blank space) as a touch
    /// selection, and opens the edit menu over it.
    fn select_word_by_touch(&self, at: Point<Points>, page: Point<Points>) {
        self.note_shift(at, page);
        self.press(at, page, Default::default(), 2);
        let blank = {
            let st = self.st.borrow();
            let s = st.selections.primary();
            st.buffer.slice(s.range()).chars().all(char::is_whitespace)
        };
        if blank {
            self.press(at, page, Default::default(), 1);
        }
        self.release();
        let range = {
            let st = self.st.borrow();
            let s = st.selections.primary();
            (s.start(), s.end())
        };
        {
            let mut inner = self.touch.inner.borrow_mut();
            inner.range = Some(range);
            inner.drag = None;
        }
        self.touch.bump();
        self.open_edit_menu();
    }

    fn drop_touch_selection(&self) {
        let had = {
            let mut inner = self.touch.inner.borrow_mut();
            inner.drag = None;
            inner.range.take().is_some()
        };
        if had {
            self.touch.bump();
        }
    }

    /// Reports `onContextMenu` over the touch selection: its box in the
    /// root view, and its top middle as the point.
    fn open_edit_menu(&self) {
        let Some((start, end)) = self.touch_range() else {
            return;
        };
        let Some((shift, scroll)) = self.touch.inner.borrow().shift else {
            return;
        };
        let rows = untracked(|| self.visible_rows());
        let (bounds, position) = {
            let st = self.st.borrow();
            let head = st.selections.primary().head;
            (selection_bounds(&st, start, end, rows), st.position(head))
        };
        // The rows moved up as the views scrolled since the shift was taken.
        let origin = bounds.origin + shift - (self.scroll_now() - scroll);
        let root = Bounds::new(origin, bounds.size);
        let event = EditorContextMenuEvent {
            position,
            x: origin.x + bounds.size.width / 2.0,
            y: origin.y,
            selection: Some(EditorRect::from(root)),
            ..Default::default()
        };
        self.cx.emit(EditorEvent::ContextMenu(event));
    }

    /// A finger took `edge`'s handle, at `location` in the handle and
    /// `page` in the root view.
    pub(crate) fn begin_handle_drag(
        &self,
        edge: Edge,
        location: Point<Points>,
        page: Point<Points>,
    ) {
        let Some((start, end)) = self.touch_range() else {
            return;
        };
        let (moving, fixed) = match edge {
            Edge::Start => (start, end),
            Edge::End => (end, start),
        };
        let (anchor, handle) = {
            let st = self.st.borrow();
            let p = st.caret_point(moving);
            (
                Point::new(p.x, p.y + st.line_height() / 2.0),
                handle_box(&st, edge, moving),
            )
        };
        self.note_shift(handle.origin + location, page);
        {
            let mut st = self.st.borrow_mut();
            st.buffer.break_undo_group();
        }
        self.touch.inner.borrow_mut().drag = Some(HandleDrag {
            fixed,
            anchor,
            origin: page,
            scroll: self.scroll_now(),
        });
        self.touch.bump();
    }

    /// The finger holding a handle moved to `page` (in the root view).
    pub(crate) fn handle_drag_to(&self, page: Point<Points>) {
        let Some(drag) = self.touch.inner.borrow().drag else {
            return;
        };
        let at = drag.anchor + (page - drag.origin) + (self.scroll_now() - drag.scroll);
        let next = {
            let st = self.st.borrow();
            drag_selection(drag.fixed, st.offset_at(at))
        };
        // Past the other end the finger holds what became the other
        // handle; the end that stays is still `fixed`.
        let Some((selection, _)) = next else {
            return;
        };
        if self.touch_range() == Some((selection.start(), selection.end())) {
            return;
        }
        self.st.borrow_mut().selections = Selections::single(selection);
        self.touch.inner.borrow_mut().range = Some((selection.start(), selection.end()));
        self.bump_selection();
        self.report_selections();
        // Near the viewport's edge the dragged end scrolls into view.
        self.show_caret();
    }

    /// The finger let the handle go: the edit menu opens again.
    pub(crate) fn end_handle_drag(&self) {
        if self.touch.inner.borrow_mut().drag.take().is_none() {
            return;
        }
        self.touch.bump();
        self.open_edit_menu();
    }
}

/// The handles of the touch selection, while it is a range and the editor
/// has the focus. The two stay made through a drag (the finger's responder
/// is one of them) and follow the ends.
pub(crate) fn handles(ed: Ed) -> impl IntoElement {
    let shown = {
        let ed = ed.clone();
        move || {
            ed.sel_rev.get();
            ed.touch.rev.get();
            ed.focused.get() && ed.touch_range().is_some_and(|(start, end)| start < end)
        }
    };
    when(shown, move || {
        [
            handle(ed.clone(), Edge::Start),
            handle(ed.clone(), Edge::End),
        ]
    })
}

/// `edge`'s handle: a hit area around the end, holding the knob (the
/// `selectionHandle` part).
fn handle(ed: Ed, edge: Edge) -> impl IntoElement {
    let props = ed.props;
    let at = {
        let ed = ed.clone();
        computed(move || {
            ed.text_rev.get();
            ed.sel_rev.get();
            ed.touch.rev.get();
            let (start, end) = ed.touch_range()?;
            let offset = match edge {
                Edge::Start => start,
                Edge::End => end,
            };
            Some(handle_box(&ed.st.borrow(), edge, offset))
        })
    };
    let lh = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            ed.st.borrow().line_height()
        }
    };
    let list: &'static [EditorPart] = match edge {
        Edge::Start => &[
            EditorPart::SelectionHandle,
            EditorPart::SelectionHandleStart,
        ],
        Edge::End => &[EditorPart::SelectionHandle, EditorPart::SelectionHandleEnd],
    };
    let knob = parts(
        view()
            .w(px(KNOB))
            .h(px(KNOB))
            .rounded_full()
            .bg(move || theme().primary)
            .pointer_events(PointerEvents::None),
        props,
        list,
    );
    let slot = view()
        .h(px(KNOB_ROOM))
        .items_center()
        .justify_center()
        .pointer_events(PointerEvents::None)
        .child(knob);
    let line = view()
        .h(move || Length::from(lh()))
        .pointer_events(PointerEvents::None);
    let (grant, mov, release, terminate) = (ed.clone(), ed.clone(), ed.clone(), ed);
    let el = view()
        .absolute()
        .left(move || Length::from(at.get().map_or(px(0.0), |b| b.origin.x)))
        .top(move || Length::from(at.get().map_or(px(0.0), |b| b.origin.y)))
        .w(px(HANDLE_WIDTH))
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if at.get_untracked().is_some() {
                request.claim();
            }
        }))
        // The scroll views around it do not take the drag over.
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| {
            grant.begin_handle_drag(edge, e.location, e.page)
        })
        .on_responder_move(move |e: &ResponderEvent| mov.handle_drag_to(e.page))
        .on_responder_release(move |_: &ResponderEvent| release.end_handle_drag())
        .on_responder_terminate(move |_: &ResponderEvent| terminate.end_handle_drag());
    match edge {
        Edge::Start => el.child(slot).child(line),
        Edge::End => el.child(line).child(slot),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::{commands::EditOptions, state::Font};

    /// A state of `text` in an 8 point wide monospaced font, 20 point rows.
    fn state(text: &str) -> State {
        let font = Font {
            family: SharedString::from("monospace"),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|s: &str| px(8.0 * s.chars().count() as f32));
        State::new(
            text,
            State::language_for(None),
            EditOptions::default(),
            font,
            measure,
        )
    }

    #[test]
    fn a_handle_moves_its_end_and_never_collapses_the_selection() {
        // "quick select value", "select" (6..12) selected: the end handle
        // (the start stays) to the end of the text.
        let (s, edge) = drag_selection(6, 18).unwrap();
        assert_eq!((s.start(), s.end(), edge), (6, 18, Edge::End));
        // Onto the other end: it stops there.
        assert!(drag_selection(6, 6).is_none());
    }

    #[test]
    fn a_handle_dragged_past_the_other_end_swaps_them() {
        // The start handle of 6..12 (the end, 12, stays) past the end: the
        // finger now holds the end handle.
        let (s, edge) = drag_selection(12, 18).unwrap();
        assert_eq!((s.start(), s.end(), edge), (12, 18, Edge::End));
        // And back before it: the start handle again.
        let (s, edge) = drag_selection(12, 0).unwrap();
        assert_eq!((s.start(), s.end(), edge), (0, 12, Edge::Start));
        assert_eq!(s.head, 0);
    }

    #[test]
    fn the_touch_selection_lives_while_it_is_the_selection() {
        let mut st = state("quick select value");
        st.selections = Selections::single(Selection::new(6, 12));
        assert_eq!(live(&st, Some((6, 12))), Some((6, 12)));
        // Reversed, it is the same range.
        st.selections = Selections::single(Selection::new(12, 6));
        assert_eq!(live(&st, Some((6, 12))), Some((6, 12)));
        // A caret elsewhere, or a second selection: gone.
        st.selections = Selections::single(Selection::caret(3));
        assert_eq!(live(&st, Some((6, 12))), None);
        st.selections = Selections::new(vec![Selection::new(6, 12), Selection::caret(0)], 0);
        assert_eq!(live(&st, Some((6, 12))), None);
        assert_eq!(live(&st, None), None);
    }

    #[test]
    fn a_selection_s_box_spans_its_rows() {
        let st = state("quick select value\nnext");
        // One row: from the start's caret to the end's, a row tall.
        let b = selection_bounds(&st, 6, 12, 0..2);
        assert_eq!(b.origin, Point::new(px(48.0), px(0.0)));
        assert_eq!(b.size, Size::new(px(48.0), px(20.0)));
        // Two rows: from the first row's left to the widest row's right.
        let b = selection_bounds(&st, 6, 21, 0..2);
        assert_eq!(b.origin.y, px(0.0));
        assert_eq!(b.size.height, px(40.0));
        assert_eq!(b.origin.x, px(0.0));
        assert!(b.size.width >= px(144.0 - 48.0));
    }

    #[test]
    fn handles_hang_above_the_start_and_below_the_end() {
        let st = state("quick select value");
        let start = handle_box(&st, Edge::Start, 6);
        let end = handle_box(&st, Edge::End, 12);
        assert_eq!(start.origin.y, px(-KNOB_ROOM));
        assert_eq!(end.origin.y, px(0.0));
        assert_eq!(start.size.height, px(20.0 + KNOB_ROOM));
        // Centered on their ends.
        assert_eq!(start.origin.x + start.size.width / 2.0, px(48.0));
        assert_eq!(end.origin.x + end.size.width / 2.0, px(96.0));
        // The knob's room below the end's line is the handle's, not the text's.
        assert!(contains(
            end,
            Point::new(px(96.0), px(20.0 + KNOB_ROOM / 2.0))
        ));
        assert!(!contains(end, Point::new(px(96.0), px(-1.0))));
    }

    #[test]
    fn taps_near_each_other_make_a_double_tap() {
        let a = Point::new(px(10.0), px(10.0));
        assert!(near(a, Point::new(px(20.0), px(20.0))));
        assert!(!near(a, Point::new(px(40.0), px(10.0))));
    }
}
