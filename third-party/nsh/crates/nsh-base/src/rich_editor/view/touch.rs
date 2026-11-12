//! Touch selection in a `RichEditor` (iOS, Android, a browser's touch
//! idiom), as the platforms' own text views select: a long press selects
//! the word under the finger (on blank space it places the caret) and the
//! finger's sweep after it goes on by words; a double tap selects a word,
//! a triple tap the paragraph. The selection a touch made carries a handle
//! at each end, which a finger drags to move that end. The system's edit
//! menu opens on the sink ([`ElementRef::open_edit_menu`]) over the
//! selection after each of those gestures and a tap on it, and at the
//! caret after a long press on blank space or a tap on the caret. As
//! gpui-kit's input does, it offers Cut, Copy, Paste and Select All,
//! leaving out what cannot apply rather than disabling it. Paste is the
//! sink's own paste (its `on_paste`); the other actions come back as
//! [`EventKind::EditAction`] and run as the editor's own transactions, so
//! undo takes them back.
//!
//! The touch selection remembers the range it made. As soon as the
//! selection is something else (typing, a command, a tap elsewhere), the
//! handles are gone and the menu closes, as the code `Editor`'s do.

use std::{cell::RefCell, rc::Rc, time::Duration};

use nsh_core::{EditAction, PayloadValue, element::EventPayload, keymap::Modifiers, prelude::*};

use super::{
    controller::{Rv, word_at},
    geometry::Hit,
    parts::Part,
    render::parts,
};
use crate::{
    rich_editor::state::{Affinity, AllSelection, NodeSelection, Selection, TextSelection},
    theme,
};

/// How soon a second tap makes a double tap.
const DOUBLE_TAP: Duration = Duration::from_millis(300);
/// How far from the first tap, in points, a second one still is a double
/// tap.
const DOUBLE_TAP_SLOP: f32 = 24.0;
/// How far beside a word's box a long press still lands on the word.
const WORD_SLOP: f32 = 4.0;
/// The width of a handle's hit area, centered on its end.
const HANDLE_WIDTH: f32 = 32.0;
/// The room a handle's knob hangs in, above the start's line and below the
/// end's (part of the hit area).
const KNOB_ROOM: f32 = 16.0;
/// The knob's default diameter.
const KNOB: f32 = 10.0;

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
    /// The middle of the dragged end's line at the grant, in the content
    /// box: the text point the finger moves.
    anchor: Point<Points>,
    /// The finger at the grant, in the root view.
    origin: Point<Points>,
    /// The scroll offset at the grant (the text moves under the finger as
    /// it scrolls).
    scroll: Points,
}

/// Where the edit menu was last opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Menu {
    Closed,
    /// Over the selection `from..to`.
    Selection(usize, usize),
    /// At the caret.
    Caret(usize),
}

struct Inner {
    /// The range (from, to) the last touch gesture left; `None` once the
    /// selection is something else.
    range: Option<(usize, usize)>,
    drag: Option<HandleDrag>,
    /// The word a long press selected while its sweep may still extend
    /// the selection (armed from the long press to the finger's lift).
    sweep: Option<(usize, usize)>,
    /// The last tap, in the root view, while a second one would make a
    /// double tap.
    last_tap: Option<Point<Points>>,
    tap_timer: Option<Spawned<()>>,
    menu: Menu,
    /// A long press selected: the menu opens as the finger lifts, as the
    /// platforms' text views open it.
    menu_on_lift: bool,
    /// The finger sweeps after a long press (the content has the touches).
    sweeping: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            range: None,
            drag: None,
            sweep: None,
            last_tap: None,
            tap_timer: None,
            menu: Menu::Closed,
            menu_on_lift: false,
            sweeping: false,
        }
    }
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

/// Whether `p` is inside `b`, grown by `slop` on each side.
fn contains(b: Bounds<Points>, p: Point<Points>, slop: f32) -> bool {
    p.x >= b.origin.x - px(slop)
        && p.x <= b.origin.x + b.size.width + px(slop)
        && p.y >= b.origin.y - px(slop)
        && p.y <= b.origin.y + b.size.height + px(slop)
}

/// The selection a long press's sweep makes from the word it selected
/// (`word`) to the word at the finger (`at`): the pressed word and every
/// word up to the finger's, whichever side it is on.
pub(crate) fn sweep_selection(word: (usize, usize), at: (usize, usize)) -> (usize, usize) {
    if at.1 > word.1 {
        (word.0, at.1)
    } else if at.0 < word.0 {
        (word.1, at.0)
    } else {
        word
    }
}

/// The selection dragging a handle to `pos` makes, from the end that
/// stays; `None` where it would collapse (a handle stops at the other end
/// until the finger passes it).
pub(crate) fn handle_selection(fixed: usize, pos: usize) -> Option<(usize, usize)> {
    (pos != fixed).then_some((fixed, pos))
}

/// The hit area of `edge`'s handle over `caret` (the end's caret box in
/// the content box): the line's height and the knob's room, above the
/// line for the start, below it for the end.
pub(crate) fn handle_box(edge: Edge, caret: Bounds<Points>) -> Bounds<Points> {
    let top = match edge {
        Edge::Start => caret.origin.y - px(KNOB_ROOM),
        Edge::End => caret.origin.y,
    };
    Bounds::new(
        Point::new(caret.origin.x - px(HANDLE_WIDTH / 2.0), top),
        Size::new(px(HANDLE_WIDTH), caret.size.height + px(KNOB_ROOM)),
    )
}

/// `selection`'s box grown by the room the handles' knobs hang in, above
/// it and below it: what the edit menu keeps clear of.
pub(crate) fn menu_bounds_around_handles(selection: Bounds<Points>) -> Bounds<Points> {
    Bounds::new(
        Point::new(selection.origin.x, selection.origin.y - px(KNOB_ROOM)),
        Size::new(
            selection.size.width,
            selection.size.height + px(KNOB_ROOM * 2.0),
        ),
    )
}

/// What the edit menu offers: Cut and Copy over a selection (Cut only
/// where the text can change), Paste where the text can change (without
/// reading the clipboard, which iOS announces), Select All unless all of
/// the text is selected.
pub(crate) fn menu_actions(selection: bool, editable: bool, all_selected: bool) -> Vec<EditAction> {
    [
        (selection && editable, EditAction::Cut),
        (selection, EditAction::Copy),
        (editable, EditAction::Paste),
        (!all_selected, EditAction::SelectAll),
    ]
    .into_iter()
    .filter_map(|(offered, action)| offered.then_some(action))
    .collect()
}

impl Rv {
    /// The touch selection's range while it is the selection.
    pub(crate) fn touch_range(&self) -> Option<(usize, usize)> {
        let range = self.touch.inner.borrow().range?;
        let state = self.session.state();
        let s = state.selection();
        (s.from() == range.0 && s.to() == range.1 && s.from() < s.to()).then_some(range)
    }

    /// The selection changed (the view took a new state): a touch selection
    /// it no longer is goes, with its handles and menu.
    pub(crate) fn touch_follow(&self) {
        let (range, menu) = {
            let inner = self.touch.inner.borrow();
            (inner.range, inner.menu)
        };
        let state = self.st.borrow().clone();
        let s = state.selection();
        if range.is_some_and(|r| r != (s.from(), s.to())) {
            {
                let mut inner = self.touch.inner.borrow_mut();
                inner.range = None;
                inner.drag = None;
                inner.sweep = None;
            }
            self.touch.bump();
        }
        let stale = match menu {
            Menu::Closed => false,
            Menu::Selection(from, to) => (from, to) != (s.from(), s.to()),
            Menu::Caret(at) => !s.empty() || s.head() != at,
        };
        if stale {
            self.close_edit_menu();
        }
    }

    /// A tap at `at` in the content box (`page` in the root view), `clicks`
    /// as the platform counted them.
    pub(crate) fn tap(
        &self,
        at: Point<Points>,
        page: Point<Points>,
        modifiers: Modifiers,
        clicks: u32,
    ) {
        let double = self.touch.tap_at(page);
        if clicks >= 2 || double {
            self.touch.forget_tap();
            self.press(at, page, modifiers, clicks.max(2));
            self.take_touch_selection();
            return;
        }
        // A tap on the touch selection, or on one of its handles (when the
        // press reaches the content too), asks for its menu again.
        if let Some((from, to)) = self.touch_range() {
            let on_handle = [Edge::Start, Edge::End]
                .into_iter()
                .any(|edge| self.handle_at(edge).is_some_and(|b| contains(b, at, 0.0)));
            let inside = matches!(self.hit(at), Some(Hit::Text(p, _)) if p > from && p < to);
            if on_handle || inside {
                self.open_edit_menu();
                return;
            }
        }
        let before = {
            let state = self.session.state();
            let s = state.selection();
            (self.focused.get_untracked() && s.empty() && s.as_text().is_some()).then(|| s.head())
        };
        let open = self.touch.inner.borrow().menu != Menu::Closed;
        self.close_edit_menu();
        self.press(at, page, modifiers, 1);
        // A tap on the caret toggles its menu, as UIKit's text views do.
        let state = self.session.state();
        let s = state.selection();
        if !open && before.is_some() && s.empty() && Some(s.head()) == before {
            self.open_edit_menu();
        }
    }

    /// A long press at `at` in the content box: the word under the finger,
    /// or the caret on blank space, with the edit menu. It arms the sweep
    /// that extends the selection by words.
    pub(crate) fn long_press(&self, at: Point<Points>, page: Point<Points>) {
        self.touch.forget_tap();
        self.focus();
        self.note_pointer(at, page);
        let Some(hit) = self.hit(at) else { return };
        let state = self.session.state();
        let doc = state.doc().clone();
        let (selection, word) = match hit {
            Hit::Node(p) => match doc.node_at(p) {
                Some(node) if NodeSelection::is_selectable(&node) => {
                    (NodeSelection::create(&doc, p), None)
                }
                _ => return,
            },
            Hit::Text(p, side) => match self.word_under(at, p) {
                Some((a, b)) => (TextSelection::create(&doc, a, Some(b)), Some((a, b))),
                None => {
                    let Ok(head) = doc.resolve(p) else { return };
                    (
                        TextSelection::with_affinity(head.clone(), head, side).into(),
                        None,
                    )
                }
            },
        };
        self.set_selection(selection, false);
        self.close_edit_menu();
        let range = {
            let state = self.session.state();
            let s = state.selection();
            (s.from() < s.to()).then_some((s.from(), s.to()))
        };
        {
            let mut inner = self.touch.inner.borrow_mut();
            inner.sweep = word;
            inner.drag = None;
            inner.range = range;
            inner.menu_on_lift = true;
        }
        self.touch.bump();
    }

    /// The word at `pos` when the finger at `at` is on it: not a space, a
    /// line's end or the blank beside a line.
    fn word_under(&self, at: Point<Points>, pos: usize) -> Option<(usize, usize)> {
        let state = self.session.state();
        let (a, b) = word_at(state.doc(), pos)?;
        if a == b {
            return None;
        }
        let text = state.doc().text_between(a, b, Some(""), None);
        if text.chars().all(char::is_whitespace) {
            return None;
        }
        let rects = self.geo.borrow().range_rects(a, b);
        rects
            .into_iter()
            .any(|r| contains(r, at, WORD_SLOP))
            .then_some((a, b))
    }

    /// Makes the selection now the touch selection, with its menu.
    fn take_touch_selection(&self) {
        let range = {
            let state = self.session.state();
            let s = state.selection();
            (s.from() < s.to()).then_some((s.from(), s.to()))
        };
        self.touch.inner.borrow_mut().range = range;
        self.touch.bump();
        self.open_edit_menu();
    }

    /// Whether a long press armed the sweep: the finger's moves extend the
    /// selection by words until it lifts.
    pub(crate) fn sweep_armed(&self) -> bool {
        self.touch.inner.borrow().sweep.is_some()
    }

    /// A finger went down on the content: whatever a long press armed
    /// before is over.
    pub(crate) fn touch_down(&self) {
        let mut inner = self.touch.inner.borrow_mut();
        inner.sweep = None;
        inner.sweeping = false;
        inner.menu_on_lift = false;
    }

    /// The finger lifted: the menu a long press left opens, unless the
    /// finger swept (its end opens it).
    pub(crate) fn touch_up(&self) {
        let lifted = {
            let mut inner = self.touch.inner.borrow_mut();
            std::mem::take(&mut inner.menu_on_lift) && !inner.sweeping
        };
        if lifted {
            self.open_edit_menu();
        }
    }

    /// The sweep began: the menu waits for the finger to lift.
    pub(crate) fn begin_sweep(&self) {
        {
            let mut inner = self.touch.inner.borrow_mut();
            inner.sweeping = true;
            inner.menu_on_lift = false;
        }
        self.close_edit_menu();
    }

    /// The finger sweeping after a long press moved to `page`.
    pub(crate) fn sweep_to(&self, page: Point<Points>) {
        let Some(word) = self.touch.inner.borrow().sweep else {
            return;
        };
        let Some(shift) = self.page_shift() else {
            return;
        };
        let at = page + shift;
        let Some(Hit::Text(pos, _)) = self.hit(at) else {
            return;
        };
        let state = self.session.state();
        let doc = state.doc().clone();
        let under = word_at(&doc, pos)
            .filter(|(a, b)| a < b)
            .unwrap_or((pos, pos));
        let (anchor, head) = sweep_selection(word, under);
        let (Ok(a), Ok(h)) = (doc.resolve(anchor), doc.resolve(head)) else {
            return;
        };
        let selection = self.between(&state, &a, &h);
        if selection.from() == state.selection().from() && selection.to() == state.selection().to()
        {
            return;
        }
        let range = (selection.from(), selection.to());
        self.set_selection(selection, true);
        self.touch.inner.borrow_mut().range = Some(range);
        self.touch.bump();
    }

    /// The finger that swept lifted (or the system took it): the menu
    /// opens over what it selected.
    pub(crate) fn end_sweep(&self) {
        let swept = {
            let mut inner = self.touch.inner.borrow_mut();
            inner.sweeping = false;
            inner.sweep.take().is_some()
        };
        if swept {
            self.take_touch_selection();
        }
    }

    /// The caret box at the end `edge` of the touch selection, in the
    /// content box, while it is a range and the editor has the focus.
    fn end_caret(&self, edge: Edge) -> Option<Bounds<Points>> {
        let (from, to) = self.touch_range()?;
        let state = self.session.state();
        let doc = state.doc();
        // An all selection's ends are outside the text: its first and last
        // text positions take the handles.
        let (pos, affinity) = match edge {
            Edge::Start => (
                doc.resolve(from)
                    .ok()
                    .map_or(from, |p| Selection::near(&p, 1).from()),
                Affinity::Downstream,
            ),
            Edge::End => (
                doc.resolve(to)
                    .ok()
                    .map_or(to, |p| Selection::near(&p, -1).to()),
                Affinity::Upstream,
            ),
        };
        self.geo.borrow().caret_rect(pos, affinity)
    }

    /// The hit area of `edge`'s handle, in the content box.
    fn handle_at(&self, edge: Edge) -> Option<Bounds<Points>> {
        if !self.focused.get_untracked() {
            return None;
        }
        let state = self.session.state();
        let s = state.selection();
        if s.as_text().is_none() && !s.is_all() {
            return None;
        }
        self.end_caret(edge).map(|caret| handle_box(edge, caret))
    }

    /// A finger took `edge`'s handle, at `page` in the root view.
    pub(crate) fn begin_handle_drag(&self, edge: Edge, page: Point<Points>) {
        let Some((from, to)) = self.touch_range() else {
            return;
        };
        let Some(caret) = self.end_caret(edge) else {
            return;
        };
        let state = self.session.state();
        let doc = state.doc();
        let near = |pos: usize, bias: i32| {
            doc.resolve(pos)
                .ok()
                .map_or(pos, |p| Selection::near(&p, bias).head())
        };
        let fixed = match edge {
            Edge::Start => near(to, -1),
            Edge::End => near(from, 1),
        };
        self.close_edit_menu();
        self.touch.inner.borrow_mut().drag = Some(HandleDrag {
            fixed,
            anchor: Point::new(caret.origin.x, caret.origin.y + caret.size.height / 2.0),
            origin: page,
            scroll: self.scroll_y.get_untracked(),
        });
        self.touch.bump();
    }

    /// The finger holding a handle moved to `page` (in the root view).
    pub(crate) fn handle_drag_to(&self, page: Point<Points>) {
        let Some(drag) = self.touch.inner.borrow().drag else {
            return;
        };
        let scrolled = self.scroll_y.get_untracked() - drag.scroll;
        let at = drag.anchor + (page - drag.origin) + Point::new(px(0.0), scrolled);
        let Some(Hit::Text(pos, _)) = self.hit(at) else {
            return;
        };
        // Past the other end the finger holds what became the other
        // handle; the end that stays is still `fixed`.
        let Some((anchor, head)) = handle_selection(drag.fixed, pos) else {
            return;
        };
        let state = self.session.state();
        let doc = state.doc().clone();
        let (Ok(a), Ok(h)) = (doc.resolve(anchor), doc.resolve(head)) else {
            return;
        };
        let selection = TextSelection::between(&a, &h, None);
        let range = (selection.from(), selection.to());
        if range.0 == range.1 || self.touch_range() == Some(range) {
            return;
        }
        // Near the viewport's edge the dragged end scrolls into view.
        self.set_selection(selection, true);
        let mut inner = self.touch.inner.borrow_mut();
        inner.range = Some(range);
        inner.drag = Some(drag);
        drop(inner);
        self.touch.bump();
    }

    /// The finger let the handle go: the edit menu opens again.
    pub(crate) fn end_handle_drag(&self) {
        if self.touch.inner.borrow_mut().drag.take().is_none() {
            return;
        }
        self.touch.bump();
        self.open_edit_menu();
    }

    /// Opens the system's edit menu over the selection, or at the caret.
    fn open_edit_menu(&self) {
        let state = self.session.state();
        let s = state.selection();
        let all: Selection = AllSelection::new(state.doc()).into();
        // An empty document has nothing to select either.
        let all_selected =
            (s.from(), s.to()) == (all.from(), all.to()) || state.doc().text_content().is_empty();
        let selection = !s.empty();
        let (menu, bounds) = if selection {
            let handles = self.touch_range().is_some();
            let bounds = self
                .visible_selection_box(s.from(), s.to())
                .or_else(|| self.node_box(s.from()))
                // Clear of the handles' knobs, above the start's line and
                // below the end's: a menu over a knob takes its touches
                // (Android's floating toolbar does).
                .map(|b| match handles {
                    true => menu_bounds_around_handles(b),
                    false => b,
                });
            (Menu::Selection(s.from(), s.to()), bounds)
        } else {
            let caret = self.geo.borrow().caret_rect(s.head(), s.affinity());
            (Menu::Caret(s.head()), caret)
        };
        let (Some(bounds), Some(shift)) = (bounds, self.page_shift()) else {
            return;
        };
        let actions = menu_actions(selection, self.editable(), all_selected);
        if actions.is_empty() {
            return self.close_edit_menu();
        }
        let page = Bounds::new(bounds.origin - shift, bounds.size);
        self.touch.inner.borrow_mut().menu = menu;
        self.input.open_edit_menu(page, actions);
    }

    /// Closes the edit menu, if the editor opened one.
    pub(crate) fn close_edit_menu(&self) {
        let open = std::mem::replace(&mut self.touch.inner.borrow_mut().menu, Menu::Closed);
        if open != Menu::Closed {
            self.input.close_edit_menu();
        }
    }

    /// The selection's box in the content box (the session's selection:
    /// the view may not have rendered it yet), cut to the viewport.
    fn visible_selection_box(&self, from: usize, to: usize) -> Option<Bounds<Points>> {
        let b = self
            .geo
            .borrow()
            .range_rects(from, to)
            .into_iter()
            .reduce(|a, b| a.union(&b))?;
        let top = self.scroll_y.get_untracked();
        let height = self.viewport.get_untracked().height;
        if height <= px(0.0) {
            return Some(b);
        }
        let y0 = b.origin.y.max(top);
        let y1 = (b.origin.y + b.size.height).min(top + height);
        if y1 <= y0 {
            return Some(b);
        }
        Some(Bounds::new(
            Point::new(b.origin.x, y0),
            Size::new(b.size.width, y1 - y0),
        ))
    }

    /// The box of the block node at `pos` (a node selection's), in the
    /// content box.
    fn node_box(&self, pos: usize) -> Option<Bounds<Points>> {
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        let block = tree.children.values().flatten().find(|b| b.pos == pos)?;
        let origin = geo.origin(block.id)?;
        let (_, frame) = geo.frames.get(&block.id)?;
        Some(Bounds::new(origin, frame.size))
    }

    /// An action chosen from the edit menu: as the keyboard's commands do
    /// it.
    pub(crate) fn edit_action(&self, payload: &EventPayload) {
        let EventPayload::Map(fields) = payload else {
            return;
        };
        let action = fields.iter().find_map(|(key, value)| match value {
            PayloadValue::Str(name) if *key == "action" => {
                [EditAction::Cut, EditAction::Copy, EditAction::SelectAll]
                    .into_iter()
                    .find(|a| a.js_name() == name.as_str())
            }
            _ => None,
        });
        // The platform closed its menu as the action was chosen.
        self.touch.inner.borrow_mut().menu = Menu::Closed;
        match action {
            Some(EditAction::Copy) => self.copy(),
            Some(EditAction::Cut) => {
                self.copy();
                if self.editable() {
                    self.delete_selection();
                }
            }
            Some(EditAction::SelectAll) => {
                self.select_all();
                self.take_touch_selection();
            }
            _ => {}
        }
    }
}

/// The handles of the touch selection, while it is a range and the editor
/// has the focus. The two stay made through a drag (the finger's responder
/// is one of them) and follow the ends.
pub(crate) fn handles(rv: Rv) -> impl IntoElement {
    let shown = {
        let rv = rv.clone();
        move || {
            rv.sel_rev.get();
            rv.touch.rev.get();
            rv.focused.get() && rv.touch_range().is_some()
        }
    };
    when(shown, move || {
        [
            handle(rv.clone(), Edge::Start),
            handle(rv.clone(), Edge::End),
        ]
    })
}

/// `edge`'s handle: a hit area around the end, holding the knob (the
/// `selectionHandle` part).
fn handle(rv: Rv, edge: Edge) -> impl IntoElement {
    let at = {
        let rv = rv.clone();
        computed(move || {
            rv.sel_rev.get();
            rv.layout_rev.get();
            rv.doc_rev.get();
            rv.touch.rev.get();
            rv.handle_at(edge)
        })
    };
    let height = move || Length::from(at.get().map_or(px(0.0), |b| b.size.height - px(KNOB_ROOM)));
    let list: &'static [Part] = match edge {
        Edge::Start => &[Part::SelectionHandle, Part::SelectionHandleStart],
        Edge::End => &[Part::SelectionHandle, Part::SelectionHandleEnd],
    };
    let knob = parts(
        view()
            .w(px(KNOB))
            .h(px(KNOB))
            .rounded_full()
            .bg(move || theme().primary)
            .pointer_events(PointerEvents::None),
        &rv,
        list,
    );
    let slot = view()
        .h(px(KNOB_ROOM))
        .items_center()
        .justify_center()
        .pointer_events(PointerEvents::None)
        .child(knob);
    let line = view().h(height).pointer_events(PointerEvents::None);
    let (grant, mov, release, terminate) = (rv.clone(), rv.clone(), rv.clone(), rv);
    let el = view()
        .absolute()
        .left(move || Length::from(at.get().map_or(px(0.0), |b| b.origin.x)))
        .top(move || Length::from(at.get().map_or(px(0.0), |b| b.origin.y)))
        .w(px(HANDLE_WIDTH))
        .opacity(move || if at.get().is_some() { 1.0_f32 } else { 0.0 })
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if at.get_untracked().is_some() {
                request.claim();
            }
        }))
        // The scroll views around it do not take the drag over.
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| grant.begin_handle_drag(edge, e.page))
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

    #[test]
    fn a_sweep_extends_by_whole_words_from_the_pressed_one() {
        // "quick brown fox": "brown" (6..11) long pressed.
        let word = (6, 11);
        // Into "fox" (12..15): the anchor stays at the pressed word's start.
        assert_eq!(sweep_selection(word, (12, 15)), (6, 15));
        // Back into "quick" (0..5): the anchor moves to its end.
        assert_eq!(sweep_selection(word, (0, 5)), (11, 0));
        // Inside the pressed word: just it.
        assert_eq!(sweep_selection(word, (6, 11)), word);
    }

    #[test]
    fn a_handle_moves_its_end_and_never_collapses_the_selection() {
        assert_eq!(handle_selection(6, 15), Some((6, 15)));
        // Past the other end the ends swap; onto it, it stops.
        assert_eq!(handle_selection(11, 0), Some((11, 0)));
        assert_eq!(handle_selection(6, 6), None);
    }

    #[test]
    fn the_menu_keeps_clear_of_the_handles_knobs() {
        // A 20 point line at y 40: the start's knob hangs in the 16 points
        // above it, the end's in the 16 below.
        let line = Bounds::new(
            Point::new(px(10.0), px(40.0)),
            Size::new(px(80.0), px(20.0)),
        );
        let menu = menu_bounds_around_handles(line);
        assert_eq!(menu.origin.y, px(40.0 - KNOB_ROOM));
        assert_eq!(menu.size.height, px(20.0 + 2.0 * KNOB_ROOM));
        let start = handle_box(
            Edge::Start,
            Bounds::new(line.origin, Size::new(px(0.0), px(20.0))),
        );
        assert!(menu.origin.y <= start.origin.y);
    }

    #[test]
    fn handles_hang_above_the_start_and_below_the_end() {
        let caret = Bounds::new(Point::new(px(48.0), px(20.0)), Size::new(px(0.0), px(20.0)));
        let start = handle_box(Edge::Start, caret);
        let end = handle_box(Edge::End, caret);
        assert_eq!(start.origin.y, px(20.0 - KNOB_ROOM));
        assert_eq!(end.origin.y, px(20.0));
        assert_eq!(start.size.height, px(20.0 + KNOB_ROOM));
        assert_eq!(start.origin.x + start.size.width / 2.0, px(48.0));
        assert!(contains(
            end,
            Point::new(px(48.0), px(40.0 + KNOB_ROOM / 2.0)),
            0.0
        ));
        assert!(!contains(end, Point::new(px(48.0), px(19.0)), 0.0));
    }

    #[test]
    fn the_menu_leaves_out_what_cannot_apply() {
        use EditAction::*;
        // Over a selection in an editable document.
        assert_eq!(
            menu_actions(true, true, false),
            [Cut, Copy, Paste, SelectAll]
        );
        // At the caret.
        assert_eq!(menu_actions(false, true, false), [Paste, SelectAll]);
        // Read-only: nothing that edits.
        assert_eq!(menu_actions(true, false, false), [Copy, SelectAll]);
        // Everything selected, or nothing to select.
        assert_eq!(menu_actions(true, true, true), [Cut, Copy, Paste]);
        assert_eq!(menu_actions(false, true, true), [Paste]);
    }

    #[test]
    fn taps_near_each_other_make_a_double_tap() {
        let a = Point::new(px(10.0), px(10.0));
        assert!(near(a, Point::new(px(20.0), px(20.0))));
        assert!(!near(a, Point::new(px(40.0), px(10.0))));
    }
}
