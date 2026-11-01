//! Scroll views: the GTK side of [`nsh_core::scroll`], which holds
//! their offsets, wheel / touchpad / touch / keyboard scrolling with
//! momentum, snapping, the core's scroll requests and scroll events.
//!
//! [`NshView`]'s `size_allocate` places the children by the offset. Every
//! change of the offset reaches [`Host::moved`], which re-places the
//! children, pins the sticky cells and feeds the native scroll value in
//! the same frame. Reports are coalesced to one per frame by the view's
//! own tick callback, which also runs glides, animated scrolls, the
//! indicator's fade and the refresh spinner, and stops when none of them
//! is left.
//!
//! Here are what GTK does: drawing the indicator and the refresh spinner,
//! the sticky cells' widgets, the keys the window gets, and finding the
//! scroll view a key or a focused widget moves. Mirrored (right to left)
//! horizontal lists keep their offsets left to right: `size_allocate`
//! places each child at the mirror image of its frame.

use std::rc::Rc;

use gtk4::{self as gtk, gdk, glib, graphene, prelude::*};
use nsh_core::{
    Command, EventKind, EventPayload, Point, Points, ScrollBehavior, Size, StickyCell, ViewKind,
    geometry::{Percentage, Radians, point},
    scroll::{self as shared, INDICATOR_THICK, KeyMove, ScrollHost, ScrollState},
};

use crate::{
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
        glib::monotonic_time() as f64 / 1000.0
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
        self.view.queue_allocate();
        self.view.queue_draw();
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
        self.view.queue_allocate();
    }

    fn redraw(&self) {
        self.view.queue_draw();
    }

    fn attached(&self) -> bool {
        // No frames come while unmapped.
        self.view.is_mapped()
    }

    fn start_ticking(&self) {
        let weak = Rc::downgrade(self.surface);
        self.view.add_tick_callback(move |view, clock| {
            let Some(surface) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            let now = clock.frame_time() as f64 / 1000.0;
            if shared::frame(&Host::new(&surface, view), now) {
                glib::ControlFlow::Continue
            } else {
                glib::ControlFlow::Break
            }
        });
    }

    fn wake_after(&self, ms: u64) {
        let weak = Rc::downgrade(self.surface);
        let view = self.view.clone();
        glib::timeout_add_local_once(std::time::Duration::from_millis(ms), move || {
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

    fn dark(&self) -> bool {
        self.surface.environment.get().color_scheme == nsh_engine::ColorScheme::Dark
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
        if let Some(cell) = mounter.views.get(&id) {
            f(cell);
        }
        return;
    }
    // While a batch is applied: look among the children, then deeper (the
    // cells of a list in the scroll view's viewport are in the list).
    let mut views = view.child_views();
    if let Some(cell) = views.iter().find(|c| c.id() == id) {
        f(cell);
        return;
    }
    while let Some(v) = views.pop() {
        if v.id() == id {
            f(&v);
            return;
        }
        views.extend(v.child_views());
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
            .and_then(|m| m.views.get(&id).cloned());
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
        let is_sticky = |w: &gtk::Widget| {
            w.downcast_ref::<NshView>()
                .is_some_and(|v| s.sticky.iter().any(|c| c.cell == v.id()))
        };
        // Reorder only when a sticky cell is not among the last children.
        let mut at_end = 0;
        let mut child = view.last_child();
        while let Some(w) = child.filter(is_sticky) {
            at_end += 1;
            child = w.prev_sibling();
        }
        let mut cells = Vec::new();
        let mut child = view.first_child();
        while let Some(w) = child {
            child = w.next_sibling();
            if is_sticky(&w) {
                cells.push(w);
            }
        }
        if at_end == cells.len() {
            return;
        }
        cells
    };
    for cell in cells {
        cell.insert_before(view, None::<&gtk::Widget>);
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

/// A touchscreen drag on `view` began (the mouse never drags content).
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

/// The drag moved by `(dx, dy)` points since it began.
pub(crate) fn drag_move(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::drag_to(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// The drag ended at velocity `(vx, vy)` points per second.
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
/// and the refresh spinner.
pub(crate) fn draw_indicator(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(s) = &state.scroll else { return };
    let size = state.frame.size;
    if let Some((center, progress)) =
        s.spinner(size.width, state.events.contains(EventKind::Refresh))
    {
        draw_spinner(
            snapshot,
            center.x.0,
            center.y.0,
            progress,
            s.live.spin,
            s.live.dark,
        );
    }
    if !s.indicator || s.live.alpha <= 0.0 {
        return;
    }
    let Some((thumb, _)) = s.thumb(size) else {
        return;
    };
    let rect = graphene::Rect::new(
        thumb.origin.x.0,
        thumb.origin.y.0,
        thumb.size.width.0,
        thumb.size.height.0,
    );
    let color = if s.live.dark {
        gdk::RGBA::new(1.0, 1.0, 1.0, 0.55 * s.live.alpha)
    } else {
        gdk::RGBA::new(0.0, 0.0, 0.0, 0.45 * s.live.alpha)
    };
    snapshot.push_rounded_clip(&crate::view::rounded(rect, [INDICATOR_THICK.0 / 2.0; 4]));
    snapshot.append_color(&color, &rect);
    snapshot.pop();
}

/// The activity spinner's spokes ([`shared::spokes`]) at `(cx, cy)`.
fn draw_spinner(
    snapshot: &gtk::Snapshot,
    cx: f32,
    cy: f32,
    progress: Percentage,
    spin: Radians,
    dark: bool,
) {
    let base = if dark { 1.0 } else { 0.25 };
    for (angle, fade) in shared::spokes(progress, spin) {
        snapshot.save();
        snapshot.translate(&graphene::Point::new(cx, cy));
        snapshot.rotate(angle.0.to_degrees());
        let rect = graphene::Rect::new(-1.25, -10.0, 2.5, 5.5);
        snapshot.push_rounded_clip(&crate::view::rounded(rect, [1.25; 4]));
        snapshot.append_color(&gdk::RGBA::new(base, base, base, fade), &rect);
        snapshot.pop();
        snapshot.restore();
    }
}

/// A wheel or touchpad scroll gesture over `view` began.
pub(crate) fn wheel_begin(surface: &Rc<Surface>, view: &NshView) {
    shared::wheel_begin(&Host::new(surface, view));
}

/// A wheel or touchpad scroll by `(dx, dy)` points (positive: content
/// moves up / left, as GTK reports wheel deltas). Without [`wheel_begin`]
/// it is a mouse wheel, which settles when idle.
pub(crate) fn wheel(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    shared::wheel(&Host::new(surface, view), point(Points(dx), Points(dy)));
}

/// The touchpad gesture ended with velocity `(vx, vy)` points per second
/// (0 for wheels without momentum).
pub(crate) fn wheel_end(surface: &Rc<Surface>, view: &NshView, vx: f32, vy: f32) {
    shared::wheel_end(&Host::new(surface, view), vx, vy);
}

// The keyboard.

/// What a key scrolls: whether along the horizontal axis, and how.
fn key_move(key: gdk::Key, modifiers: gdk::ModifierType) -> Option<(bool, KeyMove)> {
    use gdk::Key;
    use nsh_core::scroll::KEY_LINE;
    // Ctrl / Alt / Super combinations are shortcuts (Alt+Left goes back).
    let shortcuts = gdk::ModifierType::CONTROL_MASK
        | gdk::ModifierType::ALT_MASK
        | gdk::ModifierType::SUPER_MASK;
    if modifiers.intersects(shortcuts) {
        return None;
    }
    let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    Some(match key {
        Key::Up | Key::KP_Up => (false, KeyMove::Points(-KEY_LINE)),
        Key::Down | Key::KP_Down => (false, KeyMove::Points(KEY_LINE)),
        Key::Left | Key::KP_Left => (true, KeyMove::Points(-KEY_LINE)),
        Key::Right | Key::KP_Right => (true, KeyMove::Points(KEY_LINE)),
        Key::Page_Up | Key::KP_Page_Up => (false, KeyMove::Pages(-1.0)),
        Key::Page_Down | Key::KP_Page_Down => (false, KeyMove::Pages(1.0)),
        Key::space if shift => (false, KeyMove::Pages(-1.0)),
        Key::space => (false, KeyMove::Pages(1.0)),
        Key::Home | Key::KP_Home => (false, KeyMove::Start),
        Key::End | Key::KP_End => (false, KeyMove::End),
        _ => return None,
    })
}

/// Lets the keyboard scroll the surface's scroll views: arrows by a line,
/// Page Up / Page Down and Space / Shift+Space by a page, Home / End to
/// the edges. The keys go to the window (they reach it when nothing
/// focused took them) and move the innermost scroll view around the
/// focused widget, or else under the pointer, that can move that way.
/// A widget that gets the focus (Tab, a click, `focus()`) is scrolled
/// into view.
pub(crate) fn install_keyboard(surface: &Rc<Surface>) {
    let weak = Rc::downgrade(surface);
    let installed = std::cell::RefCell::new(glib::WeakRef::<gtk::Window>::new());
    surface.root.connect_realize(move |root| {
        let Some(window) = root.root().and_downcast::<gtk::Window>() else {
            return;
        };
        if installed.borrow().upgrade().as_ref() == Some(&window) {
            return;
        }
        installed.borrow().set(Some(&window));
        let keys = gtk::EventControllerKey::new();
        let pressed = weak.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| match pressed.upgrade() {
            Some(surface) if key_pressed(&surface, key, modifiers) => glib::Propagation::Stop,
            _ => glib::Propagation::Proceed,
        });
        window.add_controller(keys);
        let weak = weak.clone();
        window.connect_focus_widget_notify(move |window| {
            if let Some(surface) = weak.upgrade() {
                let focus = GtkWindowExt::focus(window);
                surface.control(|control| {
                    control.set_focus_path(crate::input::focus_path(&surface, focus.clone()));
                });
                if let Some(focus) = focus {
                    reveal(&surface, &focus);
                }
            }
        });
    });
}

/// Scrolls the scroll views around the newly focused `focus` (animated)
/// so that the view hosting it shows, as iOS and Android do for the
/// focused field.
fn reveal(surface: &Rc<Surface>, focus: &gtk::Widget) {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    if focus == root || !focus.is_ancestor(root) {
        return;
    }
    let Some(target) = nearest_view(focus) else {
        return;
    };
    // Content moved by the scroll views inside, which bounds measured
    // now do not show yet.
    let (mut moved_x, mut moved_y) = (0.0, 0.0);
    let mut current = target.parent_view();
    while let Some(view) = current {
        current = view.parent_view();
        if view.kind() != ViewKind::Scroll || !view.is_mapped() {
            continue;
        }
        let Some(bounds) = target.compute_bounds(&view) else {
            continue;
        };
        let Some(horizontal) = view.state().scroll.as_ref().map(|s| s.horizontal) else {
            continue;
        };
        let (start, len) = if horizontal {
            (bounds.x() - moved_x, bounds.width())
        } else {
            (bounds.y() - moved_y, bounds.height())
        };
        let moved = shared::reveal(&Host::new(surface, &view), Points(start), Points(len)).0;
        if horizontal {
            moved_x += moved;
        } else {
            moved_y += moved;
        }
    }
}

/// A key reached the window: whether it scrolled a view.
fn key_pressed(surface: &Rc<Surface>, key: gdk::Key, modifiers: gdk::ModifierType) -> bool {
    let Some((horizontal, m)) = key_move(key, modifiers) else {
        return false;
    };
    let root = &surface.root;
    if !root.is_mapped() {
        return false;
    }
    let focus = root.root().and_then(|r| r.focus());
    // Fields (and hosted widgets that scroll themselves) keep their keys,
    // also those they do not use: Down in a one-line field is no scroll.
    if focus
        .as_ref()
        .is_some_and(|f| f.is::<gtk::Text>() || f.is::<gtk::TextView>() || native_owner(f))
    {
        return false;
    }
    let sign = m.sign();
    let (dx, dy) = if horizontal { (sign, 0.0) } else { (0.0, sign) };
    let from_focus = focus
        .filter(|f| f.is_ancestor(root) || f == root.upcast_ref::<gtk::Widget>())
        .and_then(|f| nearest_view(&f));
    let target = from_focus
        .and_then(|v| key_scroll_view(&v, horizontal, dx, dy))
        .or_else(|| {
            let (x, y) = pointer(root)
                .unwrap_or_else(|| (root.width() as f32 / 2.0, root.height() as f32 / 2.0));
            let widget = root.pick(x as f64, y as f64, gtk::PickFlags::DEFAULT)?;
            key_scroll_view(&nearest_view(&widget)?, horizontal, dx, dy)
        });
    let Some(view) = target else {
        return false;
    };
    shared::key_scroll(&Host::new(surface, &view), m, false);
    true
}

/// Whether `widget` belongs to a hosted widget (a web view, a video's
/// controls), which handles the keyboard itself.
fn native_owner(widget: &gtk::Widget) -> bool {
    !widget.is::<NshView>() && widget.ancestor(NshView::static_type()).is_some()
}

/// `widget` if it is a view, or the view it is hosted in.
fn nearest_view(widget: &gtk::Widget) -> Option<NshView> {
    widget
        .downcast_ref::<NshView>()
        .cloned()
        .or_else(|| widget.ancestor(NshView::static_type()).and_downcast())
}

/// The innermost scroll view from `view` outwards that a key moving by
/// `(dx, dy)` can move; for vertical keys one along that axis first, then
/// a horizontal one (as vertical wheels move those).
fn key_scroll_view(view: &NshView, horizontal: bool, dx: f32, dy: f32) -> Option<NshView> {
    let mut chain = Vec::new();
    let mut current = Some(view.clone());
    while let Some(v) = current {
        current = v.parent_view();
        if v.kind() == ViewKind::Scroll && can_scroll(&v, dx, dy) {
            chain.push(v);
        }
    }
    let along = |v: &NshView| v.state().scroll.as_ref().is_some_and(|s| s.horizontal) == horizontal;
    let first = chain.iter().position(along).unwrap_or(0);
    chain.into_iter().nth(first)
}

/// The pointer in `root`'s coordinates, if it is over its window.
fn pointer(root: &NshView) -> Option<(f32, f32)> {
    let native = root.native()?;
    let pointer = root.display().default_seat()?.pointer()?;
    let (x, y, _) = native.surface()?.device_position(&pointer)?;
    let (tx, ty) = native.surface_transform();
    let p = native.compute_point(
        root,
        &graphene::Point::new((x - tx) as f32, (y - ty) as f32),
    )?;
    let inside =
        p.x() >= 0.0 && p.y() >= 0.0 && p.x() < root.width() as f32 && p.y() < root.height() as f32;
    inside.then(|| (p.x(), p.y()))
}

#[cfg(test)]
mod tests {
    use nsh_core::scroll::KEY_LINE;

    use super::*;

    #[test]
    fn scroll_keys() {
        use gdk::{Key, ModifierType as M};
        assert_eq!(
            key_move(Key::Down, M::empty()),
            Some((false, KeyMove::Points(KEY_LINE)))
        );
        assert_eq!(
            key_move(Key::Left, M::empty()),
            Some((true, KeyMove::Points(-KEY_LINE)))
        );
        assert_eq!(
            key_move(Key::space, M::SHIFT_MASK),
            Some((false, KeyMove::Pages(-1.0)))
        );
        assert_eq!(key_move(Key::End, M::empty()), Some((false, KeyMove::End)));
        assert_eq!(key_move(Key::Left, M::ALT_MASK), None);
        assert_eq!(key_move(Key::a, M::empty()), None);
    }
}
