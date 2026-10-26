//! Scroll views: the GPUI side of [`nsh_core::scroll`], which holds
//! their offsets, wheel / touchpad / touch / keyboard scrolling with
//! momentum, snapping, the core's scroll requests and scroll events.
//!
//! [`crate::render`] draws the children at [`ViewState::child_origin`],
//! which follows the offset. Every change of the offset reaches
//! [`Host::moved`], which redraws, pins the sticky cells and feeds the
//! native scroll value in the same frame. Reports are coalesced to one per
//! frame by the view's frame client ([`Surface::on_frame`]), which also
//! runs glides, animated scrolls, the indicator's fade and the refresh
//! spinner, and stops when none of them is left.
//!
//! Here are what GPUI and the view tree do: drawing the indicator and
//! the refresh spinner, the sticky cells' views, and finding the scroll
//! view a key or a focused field moves. Mirrored (right to left)
//! horizontal lists keep their offsets left to right:
//! [`ViewState::child_origin`] places each child at the mirror image of
//! its frame, and keys are mirrored here.

use std::rc::Rc;

use nsh_core::{
    Color, Command, EventKind, EventPayload, Point, Points, ScrollBehavior, Size, StickyCell,
    ViewKind,
    geometry::{Percentage, Radians, point},
    scroll::{self as shared, INDICATOR_THICK, KeyMove, ScrollHost, ScrollState},
};

use crate::{
    geom::Mat4,
    input::KeyEvent,
    render::DrawCx,
    surface::Surface,
    view::{NshView, ViewState},
};

/// A scroll view and its surface, as [`nsh_core::scroll`] drives them.
struct Host<'a> {
    surface: &'a Rc<Surface>,
    view: &'a NshView,
}

impl<'a> Host<'a> {
    fn new(surface: &'a Rc<Surface>, view: &'a NshView) -> Self {
        Self { surface, view }
    }
}

impl ScrollHost for Host<'_> {
    fn scroll<R>(&self, f: impl FnOnce(&ScrollState, Size<Points>) -> R) -> Option<R> {
        let state = self.view.state();
        let size = state.frame.size;
        state.scroll.as_ref().map(|s| f(s, size))
    }

    fn scroll_mut<R>(&self, f: impl FnOnce(&mut ScrollState, Size<Points>) -> R) -> Option<R> {
        let mut state = self.view.state_mut();
        let size = state.frame.size;
        state.scroll.as_mut().map(|s| f(s, size))
    }

    fn now(&self) -> f64 {
        self.surface.clock() * 1000.0
    }

    fn listens(&self, kind: EventKind) -> bool {
        self.view.state().events.contains(kind)
    }

    fn event(&self, kind: EventKind, payload: EventPayload) {
        self.surface.event(self.view.id(), kind, payload);
    }

    fn report(&self, offset: Point<Points>, applied: u32) {
        let id = self.view.id();
        self.surface.control(|c| c.scroll(id, offset, applied));
    }

    fn moved(&self, offset: Point<Points>) {
        self.view.moved();
        pin_sticky(self.surface, self.view);
        let scrolled =
            self.surface
                .anim
                .borrow_mut()
                .scrolled(self.view.id(), offset.x.0, offset.y.0);
        if scrolled && self.surface.mounter.try_borrow().is_ok() {
            // While a batch is applied the surface writes animations after it.
            self.surface.write_animations();
        }
    }

    fn pulled(&self, distance: Points) {
        let pulled = self
            .surface
            .anim
            .borrow_mut()
            .pulled(self.view.id(), distance);
        if pulled && self.surface.mounter.try_borrow().is_ok() {
            self.surface.write_animations();
        }
    }

    fn relayout(&self) {
        self.view.moved();
    }

    fn redraw(&self) {
        self.view.changed();
    }

    fn attached(&self) -> bool {
        self.view.attached()
    }

    fn start_ticking(&self) {
        let view = self.view.clone();
        self.surface.on_frame(move |surface, now| {
            let host = Host::new(surface, &view);
            if !view.attached() {
                // Removed: nothing draws it; a later move starts again.
                shared::detached(&host);
                return false;
            }
            shared::frame(&host, now * 1000.0)
        });
    }

    fn settled(&self) {
        let id = self.view.id();
        if self.surface.anim.borrow_mut().scroll_ended(id) {
            self.surface.ensure_ticking();
        }
    }
}

/// Whether `view` is a scroll view the user can scroll by `(dx, dy)`
/// ([`ScrollState::can_scroll`]). Input uses it to pick which of nested
/// scroll views a wheel moves.
pub(crate) fn can_scroll(view: &NshView, dx: f32, dy: f32) -> bool {
    let state = view.state();
    state
        .scroll
        .as_ref()
        .is_some_and(|s| s.can_scroll(state.frame.size, point(Points(dx), Points(dy))))
}

// Sticky cells.

/// Calls `f` with the view of node `id` in `view` (a child, or for a list
/// in the scroll view's viewport, the list's).
fn with_cell(surface: &Surface, view: &NshView, id: nsh_core::NodeId, f: impl FnOnce(&NshView)) {
    if let Ok(mounter) = surface.mounter.try_borrow() {
        if let Some(cell) = &mounter.views.get(id) {
            f(cell);
        }
        return;
    }
    // While a batch is applied: look among the children, then deeper (the
    // cells of a list in the scroll view's viewport are in the list).
    let mut views = view.with_children(|c| c.to_vec());
    if let Some(cell) = views.iter().find(|c| c.id() == id) {
        f(cell);
        return;
    }
    while let Some(v) = views.pop() {
        if v.id() == id {
            f(&v);
            return;
        }
        views.extend(v.with_children(|c| c.to_vec()));
    }
}

/// Translates the sticky cells to the offset.
fn pin_sticky(surface: &Surface, view: &NshView) {
    let state = view.state();
    let Some(s) = &state.scroll else { return };
    if s.sticky.is_empty() {
        return;
    }
    // An animated offset is the graph's (pinned again with its frames,
    // `pin_animated_sticky`, when it is being written).
    let anim = surface.anim.try_borrow().ok();
    let value = |n| anim.as_ref().map_or(0.0, |a| a.value(n));
    for (cell, shift) in s.sticky_shifts_with(value) {
        let shift = (shift.x.0, shift.y.0);
        with_cell(surface, view, cell, |cell| {
            let mut cs = cell.state_mut();
            if cs.shift != shift {
                cs.shift = shift;
                drop(cs);
                cell.moved();
            }
        });
    }
}

/// Pins again the sticky cells of the scroll views whose cells stick an
/// animated value further in, after the graph's values were written.
pub(crate) fn pin_animated_sticky(surface: &Surface) {
    let views: Vec<u32> = surface.anim.borrow().sticky_views().to_vec();
    for id in views {
        let view = surface
            .mounter
            .try_borrow()
            .ok()
            .and_then(|m| m.views.get(id));
        if let Some(view) = view {
            pin_sticky(surface, &view);
        }
    }
}

/// Keeps the sticky cells last among `view`'s children, so they draw (and
/// take pointers) above the other cells.
fn front_sticky(view: &NshView) {
    let cells = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        if s.sticky.is_empty() {
            return;
        }
        view.with_children(|children| {
            let is_sticky = |v: &NshView| s.sticky.iter().any(|c| c.cell == v.id());
            // Reorder only when a sticky cell is not among the last children.
            let at_end = children.iter().rev().take_while(|c| is_sticky(c)).count();
            let cells: Vec<NshView> = children.iter().filter(|c| is_sticky(c)).cloned().collect();
            if at_end == cells.len() {
                Vec::new()
            } else {
                cells
            }
        })
    };
    for cell in cells {
        cell.insert_before(view, None);
    }
}

/// A child was inserted into scroll view `view` (mounting): new cells must
/// not cover the pinned ones.
pub(crate) fn child_inserted(view: &NshView) {
    front_sticky(view);
}

// Mount items.

/// `ScrollConfig`.
pub(crate) fn config(
    surface: &Rc<Surface>,
    view: &NshView,
    horizontal: bool,
    indicator: bool,
    mirrored: bool,
) {
    shared::config(&Host::new(surface, view), horizontal, indicator, mirrored);
}

/// The viewport size changed.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    shared::resized(&Host::new(surface, view));
}

/// `ScrollContent`.
pub(crate) fn content(surface: &Rc<Surface>, view: &NshView, size: Size<Points>) {
    shared::content(&Host::new(surface, view), size);
}

/// `ScrollBy`.
pub(crate) fn scroll_by(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::scroll_by(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// `StickyCells`.
pub(crate) fn sticky(surface: &Rc<Surface>, view: &NshView, cells: Vec<StickyCell>) {
    let old = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        std::mem::replace(&mut s.sticky, cells)
    };
    // Cells no longer sticky go back to their frames.
    for c in old {
        let still = view
            .state()
            .scroll
            .as_ref()
            .is_some_and(|s| s.sticky.iter().any(|n| n.cell == c.cell));
        if !still {
            with_cell(surface, view, c.cell, |cell| {
                cell.state_mut().shift = (0.0, 0.0);
                cell.moved();
            });
        }
    }
    front_sticky(view);
    pin_sticky(surface, view);
}

/// `ScrollBehavior`.
pub(crate) fn behavior(surface: &Rc<Surface>, view: &NshView, behavior: &ScrollBehavior) {
    shared::behavior(&Host::new(surface, view), behavior);
}

/// `Refreshing`.
pub(crate) fn refreshing(surface: &Rc<Surface>, view: &NshView, refreshing: bool) {
    shared::refreshing(&Host::new(surface, view), refreshing);
}

/// `scrollTo` and `scrollToEnd`.
pub(crate) fn command(surface: &Rc<Surface>, view: &NshView, command: &Command) {
    let diagnostic = log::log_enabled!(target: "nsh::scroll", log::Level::Debug)
        && matches!(
            command,
            Command::ScrollTo { .. } | Command::ScrollToEnd { .. }
        );
    if diagnostic {
        let state = view.state();
        if let Some(scroll) = &state.scroll {
            match command {
                Command::ScrollTo { x, y, animated } => {
                    log::debug!(target: "nsh::scroll", "native_scroll_to surface={} node={} old_x={} old_y={} target_x={} target_y={} viewport_w={} viewport_h={} content_w={} content_h={} animated={animated}", surface.key(), state.id, scroll.x.0, scroll.y.0, x.0, y.0, state.frame.size.width.0, state.frame.size.height.0, scroll.content.width.0, scroll.content.height.0);
                }
                Command::ScrollToEnd { animated } => {
                    log::debug!(target: "nsh::scroll", "native_scroll_to_end surface={} node={} old_x={} old_y={} viewport_w={} viewport_h={} content_w={} content_h={} animated={animated}", surface.key(), state.id, scroll.x.0, scroll.y.0, state.frame.size.width.0, state.frame.size.height.0, scroll.content.width.0, scroll.content.height.0);
                }
                _ => {}
            }
        }
    }
    shared::command(&Host::new(surface, view), command);
    if diagnostic {
        let state = view.state();
        if let Some(scroll) = &state.scroll {
            log::debug!(target: "nsh::scroll", "native_scroll_applied surface={} node={} x={} y={} applied={}", surface.key(), state.id, scroll.x.0, scroll.y.0, scroll.applied);
        }
    }
}

// Input.

/// The actual user target reports intent before changing native scroll state.
/// Programmatic commands, reveal, animation and momentum do not call this.
pub(crate) fn intent(surface: &Surface, view: &NshView, intent: &'static str) {
    let enabled = {
        let state = view.state();
        state.events.contains(EventKind::ScrollIntent)
            && state
                .scroll
                .as_ref()
                .is_some_and(|scroll| scroll.behavior.enabled)
    };
    if enabled {
        surface.event(
            view.id(),
            EventKind::ScrollIntent,
            EventPayload::Map(vec![("intent", nsh_core::PayloadValue::Str(intent.into()))]),
        );
    }
}

/// A finger or pen drag starts scrolling `view` (the mouse never drags
/// content).
pub(crate) fn drag_begin(surface: &Rc<Surface>, view: &NshView) {
    intent(surface, view, "scroll");
    shared::drag_begin(&Host::new(surface, view));
}

/// The drag moved by `(dx, dy)` points since the last move (content
/// follows the pointer: positive scrolls toward the start).
pub(crate) fn drag_move(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::drag_move(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// The drag ended with a velocity (points per second): a glide follows.
pub(crate) fn drag_end(surface: &Rc<Surface>, view: &NshView, vx: f32, vy: f32) {
    shared::drag_end(&Host::new(surface, view), vx, vy);
}

/// Whether a mouse press at `(x, y)` (view coordinates) grabs `view`'s
/// indicator, faded out or not: on the desktop it is a scroll bar.
pub(crate) fn grabs_thumb(view: &NshView, x: f32, y: f32) -> bool {
    let state = view.state();
    state
        .scroll
        .as_ref()
        .is_some_and(|s| s.grabs_thumb(state.frame.size, point(Points(x), Points(y))))
}

/// The mouse moved over `view`: its indicator brightens, then fades back
/// to its resting opacity once the mouse rests.
pub(crate) fn hovered(surface: &Rc<Surface>, view: &NshView) {
    shared::hovered(&Host::new(surface, view));
}

/// The mouse grabbed `view`'s indicator ([`grabs_thumb`]).
pub(crate) fn thumb_begin(surface: &Rc<Surface>, view: &NshView) {
    intent(surface, view, "scroll");
    shared::thumb_begin(&Host::new(surface, view));
}

/// The grabbed indicator was dragged by `(dx, dy)` points since it was
/// grabbed.
pub(crate) fn thumb_move(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::thumb_move(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// The grabbed indicator was let go.
pub(crate) fn thumb_end(surface: &Rc<Surface>, view: &NshView) {
    shared::thumb_end(&Host::new(surface, view));
}

/// A physical capture was lost: stop its native phase without end callbacks.
pub(crate) fn cancel_pointer(surface: &Rc<Surface>, view: &NshView) {
    shared::cancel_pointer(&Host::new(surface, view));
}

/// Ends the removed owner's scroll work before its native ancestry changes.
/// A retained view may be inserted again before the next frame; that does
/// not resume an old wheel settle, glide or animated command.
pub(crate) fn retire_motion(surface: &Rc<Surface>, root: &NshView) {
    let mut pending = vec![root.clone()];
    while let Some(view) = pending.pop() {
        pending.extend(view.child_views());
        if view.kind() == ViewKind::Scroll {
            shared::stop_motion(&Host::new(surface, &view));
        }
    }
}

/// Draws a scroll view's indicator, over its content (inside its clip),
/// and the refresh spinner; the context is in the view's coordinates.
pub(crate) fn draw_indicator(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(s) = &state.scroll else { return };
    let size = state.frame.size;
    if let Some((center, progress)) =
        s.spinner(size.width, state.events.contains(EventKind::Refresh))
    {
        draw_spinner(cx, center.x.0, center.y.0, progress, s.live.spin);
    }
    if !s.indicator {
        return;
    }
    let Some((rect, _)) = s.thumb(size) else {
        return;
    };
    let (x, y, rw, rh) = (
        rect.origin.x.0,
        rect.origin.y.0,
        rect.size.width.0,
        rect.size.height.0,
    );
    // A knob with a thin border of the opposite tone, as UIKit's default
    // indicator style: the appearance says what the window is, not what
    // the content under the knob is, which may be light in a dark app.
    // The desktop thumb remains draggable at rest; keep its position visible
    // without extending the shared fade timer or requesting another frame.
    let a = s.live.alpha.max(0.3);
    let (knob, border) = if cx.dark {
        (
            Color::rgba(255, 255, 255, (140.0 * a) as u8),
            Color::rgba(0, 0, 0, (70.0 * a) as u8),
        )
    } else {
        (
            Color::rgba(0, 0, 0, (115.0 * a) as u8),
            Color::rgba(255, 255, 255, (110.0 * a) as u8),
        )
    };
    const RIM: f32 = 0.75;
    fill_rounded(
        cx,
        x - RIM,
        y - RIM,
        rw + 2.0 * RIM,
        rh + 2.0 * RIM,
        INDICATOR_THICK.0 / 2.0 + RIM,
        border,
    );
    fill_rounded(cx, x, y, rw, rh, INDICATOR_THICK.0 / 2.0, knob);
}

/// Fills a rounded rectangle.
fn fill_rounded(cx: &mut DrawCx<'_>, x: f32, y: f32, w: f32, h: f32, radius: f32, color: Color) {
    cx.fill_rounded(x, y, w, h, radius, color);
}

/// The activity spinner's spokes ([`shared::spokes`]) at `(x, y)`.
fn draw_spinner(cx: &mut DrawCx<'_>, x: f32, y: f32, progress: Percentage, spin: Radians) {
    let base = if cx.dark { 255.0 } else { 64.0 };
    let world = cx.transform;
    for (angle, fade) in shared::spokes(progress, spin) {
        let m = Mat4::new()
            .translate(x, y)
            .rotate(angle.0.to_degrees())
            .then(&world);
        cx.set_transform(m);
        let gray = base as u8;
        fill_rounded(
            cx,
            -1.25,
            -10.0,
            2.5,
            5.5,
            1.25,
            Color::rgba(gray, gray, gray, (fade * 255.0) as u8),
        );
    }
    cx.set_transform(world);
}

/// A wheel or touchpad scroll starts on `view` (a touchpad gesture: it
/// ends with [`wheel_end`]).
pub(crate) fn wheel_begin(surface: &Rc<Surface>, view: &NshView) {
    shared::wheel_begin(&Host::new(surface, view));
}

/// Scrolls `view` by `(dx, dy)` points (positive toward the end). Without
/// [`wheel_begin`] it is a mouse wheel, which settles when idle.
pub(crate) fn wheel(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::wheel(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// The wheel scroll ended (velocity in points per second; 0 for wheels
/// without momentum).
pub(crate) fn wheel_end(surface: &Rc<Surface>, view: &NshView, vx: f32, vy: f32) {
    shared::wheel_end(&Host::new(surface, view), vx, vy);
}

// The keyboard.

/// What a key scrolls: whether along the horizontal axis, and how.
fn key_move(event: &KeyEvent) -> Option<(bool, KeyMove)> {
    let m = event.modifiers;
    if !event.down || m.alt || m.meta {
        return None;
    }
    // Ctrl+Home / Ctrl+End go to the edges, as in browsers; other Ctrl,
    // Alt and Windows key combinations are shortcuts (Alt+Left goes back).
    shared::vk_key_move(event.vk, m.shift, m.ctrl)
}

/// Scrolls the scroll views around `target` (animated) so that it shows,
/// as iOS and Android do for the focused field: text inputs call it when
/// they get the focus.
pub(crate) fn reveal(surface: &Rc<Surface>, target: &NshView) {
    let bounds = {
        let s = target.state();
        (0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)
    };
    reveal_rect(surface, target, bounds);
}

/// Reveals an actual content range rather than its potentially long paragraph.
pub(crate) fn reveal_rect(surface: &Rc<Surface>, target: &NshView, rect: (f32, f32, f32, f32)) {
    let Some(bounds) = target
        .to_root()
        .and_then(|m| m.bounds(rect.0, rect.1, rect.2, rect.3))
    else {
        return;
    };
    // Content moved by the scroll views inside, which bounds measured now
    // do not show yet.
    let (mut moved_x, mut moved_y) = (0.0, 0.0);
    let mut current = target.parent_view();
    while let Some(view) = current {
        current = view.parent_view();
        if view.kind() != ViewKind::Scroll {
            continue;
        }
        let Some((ox, oy)) = view.to_root().and_then(|m| m.map(0.0, 0.0)) else {
            continue;
        };
        let Some(horizontal) = view.state().scroll.as_ref().map(|s| s.horizontal) else {
            continue;
        };
        let (start, len) = if horizontal {
            (bounds.0 - ox - moved_x, bounds.2)
        } else {
            (bounds.1 - oy - moved_y, bounds.3)
        };
        let moved = shared::reveal(&Host::new(surface, &view), Points(start), Points(len)).0;
        if horizontal {
            moved_x += moved;
        } else {
            moved_y += moved;
        }
    }
}

/// Keyboard scrolling (arrows by a line, Page Up / Page Down and Space /
/// Shift+Space by a page, Home / End to the edges) of the innermost
/// scroll view under `(x, y)` (root coordinates; the middle of the window
/// when the pointer is outside it) that can move that way. Home / End
/// stay with the focused reader even at its edge or when its content fits.
/// Fields keep their keys, also those they do not use: Down in a one-line
/// field is no scroll. True when handled.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent, x: f32, y: f32) -> bool {
    let Some((horizontal, m)) = key_move(event) else {
        return false;
    };
    if crate::text_input::focused(surface).is_some() {
        return false;
    }
    let root = &surface.root;
    let (w, h) = surface.size();
    let (x, y) = if x >= 0.0 && y >= 0.0 && x < w && y < h {
        (x, y)
    } else {
        (w / 2.0, h / 2.0)
    };
    let focused = crate::text_input::focused_view(surface);
    let edge_owner = focused.as_ref().and_then(|view| {
        if !matches!(m, KeyMove::Start | KeyMove::End) {
            return None;
        }
        std::iter::successors(Some(view.clone()), NshView::parent_view).find(|view| {
            view.state()
                .scroll
                .as_ref()
                .is_some_and(|scroll| scroll.behavior.enabled)
        })
    });
    let origin = focused.or_else(|| pick(root, x, y));
    let user_intent = match m {
        KeyMove::Start => "start",
        KeyMove::End => "end",
        _ => "scroll",
    };
    let Some(view) = edge_owner.or_else(|| {
        origin
            .as_ref()
            .and_then(|view| key_scroll_view(view, horizontal, m.sign()))
    }) else {
        if let Some(origin) = origin {
            let target = nsh_core::input::scroll_target(
                std::iter::successors(Some(origin), NshView::parent_view).collect(),
                Points(if horizontal { m.sign() } else { 0.0 }),
                Points(if horizontal { 0.0 } else { m.sign() }),
                |view| view.state().scroll.as_ref().map(|scroll| scroll.horizontal),
                |view| {
                    view.state()
                        .scroll
                        .as_ref()
                        .is_some_and(|scroll| scroll.behavior.enabled)
                },
            );
            if let Some(target) = target {
                intent(surface, &target, user_intent);
            }
        }
        return false;
    };
    // Left and Right follow what they show in a right-to-left list.
    intent(surface, &view, user_intent);
    shared::key_scroll(&Host::new(surface, &view), m, horizontal);
    true
}

/// The innermost scroll view from `view` outwards that a key moving
/// towards `sign` along an axis can move; for vertical keys one along
/// that axis first, then a horizontal one (as vertical wheels move those).
fn key_scroll_view(view: &NshView, horizontal: bool, sign: f32) -> Option<NshView> {
    let mut chain = Vec::new();
    let mut current = Some(view.clone());
    while let Some(v) = current {
        current = v.parent_view();
        if v.kind() != ViewKind::Scroll {
            continue;
        }
        let (dx, dy) = {
            let state = v.state();
            let mirrored = state.scroll.as_ref().is_some_and(|s| s.mirrored);
            if horizontal {
                // can_scroll mirrors horizontal deltas; keys are mirrored
                // in `key`, so undo it here.
                (if mirrored { -sign } else { sign }, 0.0)
            } else {
                (0.0, sign)
            }
        };
        if can_scroll(&v, dx, dy) {
            chain.push(v);
        }
    }
    let along = |v: &NshView| v.state().scroll.as_ref().is_some_and(|s| s.horizontal) == horizontal;
    let first = chain.iter().position(along).unwrap_or(0);
    chain.into_iter().nth(first)
}

/// The innermost view at `(x, y)` (`view`'s coordinates).
fn pick(view: &NshView, x: f32, y: f32) -> Option<NshView> {
    let state = view.state();
    if state.style.hidden || state.concealed {
        return None;
    }
    let inside =
        x >= 0.0 && y >= 0.0 && x < state.frame.size.width.0 && y < state.frame.size.height.0;
    if !inside && (state.clips() || state.overflow.is_none()) {
        return None;
    }
    let hit = view.with_children(|children| {
        children.iter().rev().find_map(|child| {
            let local = {
                let cs = child.state();
                let (ox, oy) = state.child_origin(cs.frame, cs.shift);
                let m = Mat4::new().translate(ox, oy);
                match cs.transform() {
                    Some(t) => Mat4::mul(&t, &m),
                    None => m,
                }
            };
            let (cx, cy) = local.unproject(x, y)?;
            pick(child, cx, cy)
        })
    });
    hit.or_else(|| inside.then(|| view.clone()))
}

#[cfg(test)]
mod tests {
    use nsh_core::{Bounds, Point, Points, Size, scroll::KEY_LINE};

    use super::*;
    use crate::{
        input::Modifiers,
        keys::{VK_DOWN, VK_END, VK_HOME, VK_LEFT, VK_NEXT, VK_SPACE},
    };

    fn scroll_view(w: f32, h: f32, content: (f32, f32), horizontal: bool) -> NshView {
        let view = NshView::new(2, ViewKind::Scroll);
        {
            let mut state = view.state_mut();
            state.frame = Bounds {
                origin: Point {
                    x: Points(0.0),
                    y: Points(0.0),
                },
                size: Size {
                    width: Points(w),
                    height: Points(h),
                },
            };
            let s = state.scroll.as_mut().unwrap();
            s.content = nsh_core::geometry::size(Points(content.0), Points(content.1));
            s.horizontal = horizontal;
        }
        view
    }

    #[test]
    fn source_removal_stops_owned_scroll_motion_but_insert_only_moves_continue() {
        use nsh_core::{MountItem, ROOT_ID};

        for removed in [false, true] {
            let surface = Surface::new(nsh_engine::Environment::default());
            surface.root.state_mut().frame = crate::geom::rect(0.0, 0.0, 300.0, 400.0);
            for (id, kind, parent) in [(2, ViewKind::View, ROOT_ID), (4, ViewKind::Scroll, 2)] {
                for item in [
                    MountItem::Create { id, kind },
                    MountItem::Frame {
                        id,
                        frame: crate::geom::rect(0.0, 0.0, 300.0, 400.0),
                    },
                    MountItem::Insert {
                        parent,
                        child: id,
                        before: None,
                    },
                ] {
                    surface.mounter.borrow_mut().apply(&surface, &item);
                }
            }
            let scroll = surface.view(4).unwrap();
            scroll.state_mut().scroll.as_mut().unwrap().content =
                nsh_core::geometry::size(Points(300.0), Points(2000.0));
            shared::command(
                &Host::new(&surface, &scroll),
                &Command::ScrollTo {
                    x: Points(0.0),
                    y: Points(200.0),
                    animated: true,
                },
            );
            if removed {
                surface
                    .mounter
                    .borrow_mut()
                    .apply(&surface, &MountItem::Remove { id: 2 });
            }
            surface.mounter.borrow_mut().apply(
                &surface,
                &MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            );
            assert!(scroll.attached());
            let now = surface.clock() * 1000.0;
            shared::frame(&Host::new(&surface, &scroll), now + 1000.0);
            assert_eq!(
                scroll.state().scroll.as_ref().unwrap().y,
                Points(if removed { 0.0 } else { 200.0 })
            );

            // Termination affects the old task, not future input on a
            // retained native view.
            shared::command(
                &Host::new(&surface, &scroll),
                &Command::ScrollTo {
                    x: Points(0.0),
                    y: Points(300.0),
                    animated: true,
                },
            );
            shared::frame(&Host::new(&surface, &scroll), now + 2000.0);
            assert_eq!(scroll.state().scroll.as_ref().unwrap().y, Points(300.0));
        }
    }

    #[test]
    fn viewport_frame_reconciles_offsets_without_a_content_update() {
        use nsh_core::{MountItem, ROOT_ID};

        let surface = Surface::new(nsh_engine::Environment::default());
        for item in [
            MountItem::Create {
                id: 2,
                kind: ViewKind::Scroll,
            },
            MountItem::Frame {
                id: 2,
                frame: crate::geom::rect(0.0, 0.0, 300.0, 400.0),
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ] {
            surface.mounter.borrow_mut().apply(&surface, &item);
        }
        let view = surface.view(2).unwrap();
        {
            let mut state = view.state_mut();
            let scroll = state.scroll.as_mut().unwrap();
            scroll.content = nsh_core::geometry::size(Points(900.0), Points(900.0));
            scroll.x = Points(500.0);
            scroll.y = Points(70.0);
        }
        surface.mounter.borrow_mut().apply(
            &surface,
            &MountItem::Frame {
                id: 2,
                frame: crate::geom::rect(0.0, 0.0, 800.0, 400.0),
            },
        );
        surface.tick();
        assert_eq!(
            view.state()
                .child_origin(crate::geom::rect(0.0, 0.0, 900.0, 900.0), (0.0, 0.0)),
            (-100.0, -70.0)
        );
    }

    #[test]
    fn can_scroll_follows_edges_and_mirroring() {
        let view = scroll_view(300.0, 400.0, (300.0, 1000.0), false);
        view.state_mut().scroll.as_mut().unwrap().behavior.enabled = true;
        assert!(can_scroll(&view, 0.0, 10.0));
        assert!(!can_scroll(&view, 0.0, -10.0));
        view.state_mut().scroll.as_mut().unwrap().y = Points(600.0);
        assert!(!can_scroll(&view, 0.0, 10.0));
        view.state_mut().scroll.as_mut().unwrap().behavior.enabled = false;
        assert!(!can_scroll(&view, 0.0, -10.0));

        let row = scroll_view(300.0, 100.0, (1000.0, 100.0), true);
        {
            let mut state = row.state_mut();
            let s = state.scroll.as_mut().unwrap();
            s.behavior.enabled = true;
            s.mirrored = true;
        }
        // Right to left: content past the start is on the left.
        assert!(can_scroll(&row, -10.0, 0.0));
        assert!(!can_scroll(&row, 10.0, 0.0));
        // Vertical wheels move horizontal lists, unmirrored.
        assert!(can_scroll(&row, 0.0, 10.0));
        assert_eq!(key_scroll_view(&row, true, -1.0), None);
        assert_eq!(key_scroll_view(&row, true, 1.0), Some(row.clone()));
    }

    fn key(vk: u16, modifiers: Modifiers) -> KeyEvent {
        KeyEvent {
            vk,
            down: true,
            repeat: false,
            modifiers,
        }
    }

    #[test]
    fn scroll_keys() {
        let none = Modifiers::default();
        let shift = Modifiers {
            shift: true,
            ..none
        };
        let alt = Modifiers { alt: true, ..none };
        assert_eq!(
            key_move(&key(VK_DOWN, none)),
            Some((false, KeyMove::Points(KEY_LINE)))
        );
        assert_eq!(
            key_move(&key(VK_LEFT, none)),
            Some((true, KeyMove::Points(-KEY_LINE)))
        );
        assert_eq!(
            key_move(&key(VK_SPACE, shift)),
            Some((false, KeyMove::Pages(-1.0)))
        );
        assert_eq!(
            key_move(&key(VK_NEXT, none)),
            Some((false, KeyMove::Pages(1.0)))
        );
        assert_eq!(key_move(&key(VK_END, none)), Some((false, KeyMove::End)));
        assert_eq!(key_move(&key(VK_LEFT, alt)), None);
        assert_eq!(key_move(&key(b'A' as u16, none)), None);
        let ctrl = Modifiers { ctrl: true, ..none };
        assert_eq!(key_move(&key(VK_HOME, ctrl)), Some((false, KeyMove::Start)));
        assert_eq!(key_move(&key(VK_DOWN, ctrl)), None);
        let up = KeyEvent {
            down: false,
            ..key(VK_DOWN, none)
        };
        assert_eq!(key_move(&up), None);
    }

    #[test]
    fn focused_reader_home_end_keep_the_native_scroll_owner_at_edges() {
        use nsh_core::{MountItem, ROOT_ID};

        let surface = Surface::new(nsh_engine::Environment::default());
        surface.root.state_mut().frame = crate::geom::rect(0.0, 0.0, 300.0, 300.0);
        let mount = |id, parent, kind, frame| {
            for item in [
                MountItem::Create { id, kind },
                MountItem::Frame { id, frame },
                MountItem::Insert {
                    parent,
                    child: id,
                    before: None,
                },
            ] {
                surface.mounter.borrow_mut().apply(&surface, &item);
            }
            surface.view(id).unwrap()
        };
        let outer = mount(
            2,
            ROOT_ID,
            ViewKind::Scroll,
            crate::geom::rect(0.0, 0.0, 300.0, 300.0),
        );
        let inner = mount(
            4,
            outer.id(),
            ViewKind::Scroll,
            crate::geom::rect(0.0, 500.0, 300.0, 100.0),
        );
        outer.state_mut().scroll.as_mut().unwrap().content =
            nsh_core::geometry::size(Points(300.0), Points(1200.0));
        outer.state_mut().scroll.as_mut().unwrap().y = Points(450.0);
        crate::text_input::focus_view(&surface, &inner);
        assert_eq!(
            crate::text_input::focused_view(&surface),
            Some(inner.clone())
        );
        let settle = || {
            // Settle the real native animation with one virtual frame, without
            // waiting on a display or a wall-clock sleep.
            let now = surface.clock() * 1000.0 + 1000.0;
            shared::frame(&Host::new(&surface, &inner), now);
            shared::frame(&Host::new(&surface, &outer), now);
        };
        let press = |vk| {
            let event = key(vk, Modifiers::default());
            assert!(crate::input::key(&surface, event));
            crate::input::key(
                &surface,
                KeyEvent {
                    down: false,
                    ..event
                },
            );
            settle();
        };
        for (horizontal, content, start, name, end) in [
            (false, 500.0, 0.0, "home", 0.0),
            (false, 500.0, 400.0, "end", 400.0),
            (false, 100.0, 0.0, "home", 0.0),
            (false, 100.0, 0.0, "end", 0.0),
            (false, 500.0, 120.0, "home", 0.0),
            (false, 500.0, 0.0, "end", 400.0),
            (true, 500.0, 0.0, "home", 0.0),
            (true, 500.0, 200.0, "end", 200.0),
            (true, 500.0, 0.0, "end", 200.0),
        ] {
            {
                let mut state = inner.state_mut();
                let scroll = state.scroll.as_mut().unwrap();
                scroll.horizontal = horizontal;
                scroll.content = if horizontal {
                    nsh_core::geometry::size(Points(content), Points(100.0))
                } else {
                    nsh_core::geometry::size(Points(300.0), Points(content))
                };
                scroll.x = Points(if horizontal { start } else { 0.0 });
                scroll.y = Points(if horizontal { 0.0 } else { start });
            }
            press(if name == "home" { VK_HOME } else { VK_END });
            assert_eq!(
                {
                    let state = inner.state();
                    let scroll = state.scroll.as_ref().unwrap();
                    if horizontal { scroll.x } else { scroll.y }
                },
                Points(end),
                "{name}"
            );
            assert_eq!(
                outer.state().scroll.as_ref().unwrap().y,
                Points(450.0),
                "{name} moved the parent"
            );
            assert_eq!(
                crate::text_input::focused_view(&surface),
                Some(inner.clone())
            );
        }

        {
            let mut state = inner.state_mut();
            let scroll = state.scroll.as_mut().unwrap();
            scroll.horizontal = false;
            scroll.content = nsh_core::geometry::size(Points(300.0), Points(500.0));
            scroll.x = Points(0.0);
            scroll.y = Points(400.0);
        }
        let editor = mount(
            6,
            inner.id(),
            ViewKind::Input,
            crate::geom::rect(0.0, 400.0, 300.0, 32.0),
        );
        crate::text_input::focus_view(&surface, &editor);
        crate::text_input::char_input(&surface, "ab");
        settle();
        let outer_offset = outer.state().scroll.as_ref().unwrap().y;
        let inner_offset = inner.state().scroll.as_ref().unwrap().y;
        press(VK_HOME);
        crate::text_input::char_input(&surface, "L");
        press(VK_END);
        crate::text_input::char_input(&surface, "R");
        assert_eq!(
            crate::text_input::accessible_value(&editor).unwrap().text,
            "LabR"
        );
        assert_eq!(inner.state().scroll.as_ref().unwrap().y, inner_offset);
        assert_eq!(outer.state().scroll.as_ref().unwrap().y, outer_offset);
    }

    #[test]
    fn pick_finds_scrolled_children() {
        let root = NshView::new(0, ViewKind::View);
        root.state_mut().frame = Bounds {
            origin: Point {
                x: Points(0.0),
                y: Points(0.0),
            },
            size: Size {
                width: Points(300.0),
                height: Points(400.0),
            },
        };
        let scroll = scroll_view(300.0, 400.0, (300.0, 1000.0), false);
        scroll.insert_before(&root, None);
        let cell = NshView::new(4, ViewKind::View);
        cell.state_mut().frame = Bounds {
            origin: Point {
                x: Points(0.0),
                y: Points(500.0),
            },
            size: Size {
                width: Points(300.0),
                height: Points(50.0),
            },
        };
        cell.insert_before(&scroll, None);
        assert_eq!(pick(&root, 10.0, 10.0), Some(scroll.clone()));
        scroll.state_mut().scroll.as_mut().unwrap().y = Points(480.0);
        assert_eq!(pick(&root, 10.0, 30.0), Some(cell.clone()));
    }
}
