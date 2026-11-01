//! Scroll views: the Windows side of [`nsh_core::scroll`], which holds
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
//! Here are what Direct2D and the view tree do: drawing the indicator and
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
use windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT;

use crate::{
    geom::Mat4,
    input::KeyEvent,
    render::{DrawCx, rect_f},
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

    fn wake_after(&self, ms: u64) {
        let weak = Rc::downgrade(self.surface);
        let view = self.view.clone();
        crate::input::after_ms(ms, move || {
            if let Some(surface) = weak.upgrade() {
                shared::hold_ended(&Host::new(&surface, &view));
            }
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
    replaced: bool,
    mirrored: bool,
) {
    shared::config(
        &Host::new(surface, view),
        horizontal,
        indicator,
        replaced,
        mirrored,
    );
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
    shared::command(&Host::new(surface, view), command);
}

// Input.

/// A finger or pen drag starts scrolling `view` (the mouse never drags
/// content).
pub(crate) fn drag_begin(surface: &Rc<Surface>, view: &NshView) {
    shared::drag_begin(&Host::new(surface, view));
}

/// Stops the row's scroll owners before its recycling acknowledgement.
pub(crate) fn detached(surface: &Rc<Surface>, view: &NshView) {
    if view.kind() == ViewKind::Scroll {
        shared::detached(&Host::new(surface, view));
    }
    for child in view.child_views() {
        detached(surface, &child);
    }
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

/// True when [`draw_indicator`] may draw something for `state` (its
/// indicator shows, or it is pulled down).
pub(crate) fn indicates(state: &ViewState) -> bool {
    state.scroll.as_ref().is_some_and(ScrollState::indicates)
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

/// Reveal the indicator when the pointer reaches its draggable thumb.
/// Moving over content must not restart the indicator's fade timer.
pub(crate) fn hovered(surface: &Rc<Surface>, view: &NshView, x: f32, y: f32) {
    if !grabs_thumb(view, x, y) {
        return;
    }
    shared::hovered(&Host::new(surface, view));
}

/// The mouse grabbed `view`'s indicator ([`grabs_thumb`]).
pub(crate) fn thumb_begin(surface: &Rc<Surface>, view: &NshView) {
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
    if !s.indicator || s.live.alpha <= 0.0 {
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
    let a = s.live.alpha;
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

/// Fills a rounded rectangle with the pass's solid brush.
fn fill_rounded(cx: &DrawCx<'_>, x: f32, y: f32, w: f32, h: f32, radius: f32, color: Color) {
    let rr = D2D1_ROUNDED_RECT {
        rect: rect_f(x, y, w, h),
        radiusX: radius,
        radiusY: radius,
    };
    // SAFETY: a COM call on the pass's live context and brush.
    unsafe { cx.dc.FillRoundedRectangle(&rr, cx.solid(color)) };
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
    let Some(bounds) = target.to_root().and_then(|m| {
        let s = target.state();
        m.bounds(0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)
    }) else {
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
/// when the pointer is outside it) that can move that way. Fields keep
/// their keys, also those they do not use: Down in a one-line field is no
/// scroll. True when handled.
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
    let Some(view) = pick(root, x, y).and_then(|v| key_scroll_view(&v, horizontal, m.sign()))
    else {
        return false;
    };
    // Left and Right follow what they show in a right-to-left list.
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
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_DOWN, VK_END, VK_HOME, VK_LEFT, VK_NEXT, VK_SPACE,
    };

    use super::*;
    use crate::input::Modifiers;

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
            key_move(&key(VK_DOWN.0, none)),
            Some((false, KeyMove::Points(KEY_LINE)))
        );
        assert_eq!(
            key_move(&key(VK_LEFT.0, none)),
            Some((true, KeyMove::Points(-KEY_LINE)))
        );
        assert_eq!(
            key_move(&key(VK_SPACE.0, shift)),
            Some((false, KeyMove::Pages(-1.0)))
        );
        assert_eq!(
            key_move(&key(VK_NEXT.0, none)),
            Some((false, KeyMove::Pages(1.0)))
        );
        assert_eq!(key_move(&key(VK_END.0, none)), Some((false, KeyMove::End)));
        assert_eq!(key_move(&key(VK_LEFT.0, alt)), None);
        assert_eq!(key_move(&key(b'A' as u16, none)), None);
        let ctrl = Modifiers { ctrl: true, ..none };
        assert_eq!(
            key_move(&key(VK_HOME.0, ctrl)),
            Some((false, KeyMove::Start))
        );
        assert_eq!(key_move(&key(VK_DOWN.0, ctrl)), None);
        let up = KeyEvent {
            down: false,
            ..key(VK_DOWN.0, none)
        };
        assert_eq!(key_move(&up), None);
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
