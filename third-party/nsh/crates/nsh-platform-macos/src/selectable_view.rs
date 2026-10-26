//! Selectable views (`ViewProps::selectable_view`, `View`'s
//! `selectable`): one selection across the texts of a view's subtree, from a
//! point in one text to a point in another, as a browser selects across a
//! page. The texts that take part are those not `selectable={false}`, in
//! document order (subviews are in mount order); an area inside another is
//! part of the outer one. Texts outside areas keep their own selection
//! ([`crate::text::Selection`]).
//!
//! The logic is [`nsh_core::selection::SelectionModel`]'s; this module
//! lists an area's texts for it ([`Texts`]: content, content boxes in the
//! area's coordinates, CoreText hit tests), feeds it the mouse ([`down`],
//! [`drag`], [`up`] from [`crate::input`]; Cmd+A, Cmd+C and Escape through
//! [`crate::text`]) and sets each text's part of it, which
//! [`crate::text::draw`] highlights as a single text's selection. The
//! surface keeps the selection of the area last pressed
//! ([`AreaSelection`], in [`crate::text::Selected`]); a press anywhere else
//! clears it, and the texts are listed again after each batch while it
//! selects something ([`end_batch`]).

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use nsh_core::{
    AttributedText, Bounds, Point, Points, ViewKind,
    geometry::{bounds, point},
    selection::{SelectionModel, SelectionTexts},
};
use rustc_hash::FxHashSet;

use crate::{
    surface::Surface,
    view::{NshView, ViewObj},
};

/// How far (points) the mouse moves before a press in an area selects, as
/// on a single text (`crate::text`'s slops).
const SLOP: f32 = 3.0;
/// The same over a press target (links, `onPress`).
const SLOP_PRESS: f32 = 10.0;

/// The texts of an area at one moment, in document order.
#[derive(Default)]
struct Texts {
    views: Vec<NshView>,
    contents: Vec<Arc<AttributedText>>,
    /// Each view's origin in the area's coordinates.
    origins: Vec<(f32, f32)>,
    /// Each text's content box in the area's coordinates.
    frames: Vec<Bounds<Points>>,
}

impl SelectionTexts for Texts {
    fn len(&self) -> usize {
        self.views.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.contents[i].text
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.frames[i]
    }

    fn offset_at(&self, i: usize, p: Point<Points>) -> u32 {
        let (x, y) = self.origins[i];
        crate::text::caret_at(&self.views[i].state(), p.x.0 - x, p.y.0 - y)
    }

    fn key(&self, i: usize) -> u64 {
        u64::from(self.views[i].id())
    }
}

/// Lists the texts of `area`'s subtree.
fn collect(area: &NshView) -> Texts {
    let mut texts = Texts::default();
    walk(area, (0.0, 0.0), &mut texts);
    texts
}

fn walk(view: &NshView, origin: (f32, f32), out: &mut Texts) {
    if view.ns().isHidden() {
        return;
    }
    {
        let state = view.state();
        if let Some(drawn) = &state.text
            && drawn.text.selectable != Some(false)
        {
            let content = drawn.content;
            out.views.push(view.clone());
            out.contents.push(drawn.text.clone());
            out.origins.push(origin);
            out.frames.push(bounds(
                point(
                    Points(origin.0 + content.origin.x.0),
                    Points(origin.1 + content.origin.y.0),
                ),
                content.size,
            ));
        }
    }
    // Children sit in the container's bounds, which scroll views move: by
    // their offset, which shows as a layer transform before the bounds
    // have it.
    let offset = crate::scroll::bounds_origin(view);
    for child in view.child_views() {
        let o = child.ns().frame().origin;
        let at = (
            origin.0 + o.x as f32 - offset.0,
            origin.1 + o.y as f32 - offset.1,
        );
        walk(&child, at, out);
    }
}

/// The selectable view `view` is in: its outermost ancestor (or itself)
/// that is one.
fn area_of(view: &NshView) -> Option<NshView> {
    let mut found = None;
    let mut current = Some(view.clone());
    while let Some(v) = current {
        if v.state().props.selectable_view {
            found = Some(v.clone());
        }
        current = v.parent_view();
    }
    found
}

/// The area a press on `view` selects in: its area, unless `view` is a
/// text kept out (`selectable={false}`).
pub(crate) fn target(view: &NshView) -> Option<NshView> {
    let out = view
        .state()
        .text
        .as_ref()
        .is_some_and(|t| t.text.selectable == Some(false));
    if out { None } else { area_of(view) }
}

/// Whether `view` (whose state is `state`) is a text of an area: the
/// pointer over it is the I-beam.
pub(crate) fn is_area_text(view: &NshView, state: &crate::view::ViewState) -> bool {
    state
        .text
        .as_ref()
        .is_some_and(|t| t.text.selectable != Some(false))
        && area_of(view).is_some()
}

/// Whether `view` is a selectable view (the pointer selects in it).
pub(crate) fn is_area(view: &NshView) -> bool {
    view.state().props.selectable_view
}

/// The selection of the area last pressed.
#[derive(Default)]
pub(crate) struct AreaSelection {
    active: RefCell<Option<Active>>,
    /// The autoscroll's frame callback runs ([`autoscroll`]).
    scrolling: Cell<bool>,
}

struct Active {
    area: objc2::rc::Weak<ViewObj>,
    model: SelectionModel,
    /// The texts that show a part of it.
    shown: Vec<objc2::rc::Weak<ViewObj>>,
    /// The pressed button moved far enough to select.
    dragging: Cell<bool>,
    /// The press began over a press target.
    over_press: bool,
    /// Where the pointer is while it drags (root coordinates).
    pointer: Cell<Option<(f32, f32)>>,
}

impl Active {
    fn area(&self) -> Option<NshView> {
        let view = self.area.load()?;
        NshView::from_ns(&view)
    }

    /// Sets each text's part of the selection, and clears it where the
    /// texts no longer take part.
    fn show(&mut self, texts: &Texts) {
        let mut parts = vec![None; texts.len()];
        for (i, range) in self.model.ranges(texts) {
            parts[i] = Some((range.start, range.end));
        }
        let listed: FxHashSet<*const ViewObj> =
            texts.views.iter().map(|v| &**v as *const ViewObj).collect();
        for old in self.shown.drain(..) {
            if let Some(view) = old.load().and_then(|v| NshView::from_ns(&v))
                && !listed.contains(&(&*view as *const ViewObj))
            {
                crate::text::set_area_range(&view, None);
            }
        }
        for (view, part) in texts.views.iter().zip(parts) {
            crate::text::set_area_range(view, part);
            if part.is_some() {
                self.shown.push(objc2::rc::Weak::from(&**view));
            }
        }
    }

    /// Clears every text's part.
    fn hide(&mut self) {
        for old in self.shown.drain(..) {
            if let Some(view) = old.load().and_then(|v| NshView::from_ns(&v)) {
                crate::text::set_area_range(&view, None);
            }
        }
    }
}

impl AreaSelection {
    /// Whether `area` has the selection.
    fn is(&self, area: &NshView) -> bool {
        self.active
            .borrow()
            .as_ref()
            .and_then(Active::area)
            .is_some_and(|a| &a == area)
    }

    /// Clears the selection and forgets the area.
    pub(crate) fn clear(&self) {
        let active = self.active.borrow_mut().take();
        if let Some(mut active) = active {
            active.hide();
        }
    }

    /// Whether something is selected.
    pub(crate) fn has_selection(&self) -> bool {
        self.active
            .borrow()
            .as_ref()
            .is_some_and(|a| !a.model.is_empty())
    }

    /// The selected text, as a copy gives it (`None` without a selection).
    pub(crate) fn text(&self) -> Option<String> {
        let active = self.active.borrow();
        let active = active.as_ref().filter(|a| !a.model.is_empty())?;
        let texts = collect(&active.area()?);
        Some(active.model.text(&texts))
    }

    /// Selects every text of the area last pressed (Cmd+A). False without
    /// one.
    pub(crate) fn select_all(&self) -> bool {
        let mut active = self.active.borrow_mut();
        let Some(active) = active.as_mut() else {
            return false;
        };
        let Some(area) = active.area() else {
            return false;
        };
        let texts = collect(&area);
        active.model.select_all(&texts);
        active.show(&texts);
        true
    }
}

/// The primary button went down at `(x, y)` (root coordinates) in `area`,
/// the `clicks`th click in a row; `over_press` if a press target is under
/// it. Clears any other selection; one click puts the anchor (a drag past
/// the slop selects), two select a word, three a text, Shift extends.
#[allow(clippy::too_many_arguments)]
pub(crate) fn down(
    surface: &Surface,
    area: &NshView,
    x: f32,
    y: f32,
    clicks: usize,
    shift: bool,
    over_press: bool,
) {
    let selection = &surface.selection;
    if !selection.area.is(area) {
        crate::text::clear(surface);
    }
    let (lx, ly) = crate::input::local(surface, area, x, y);
    let texts = collect(area);
    let mut active = selection.area.active.borrow_mut();
    let active = active.get_or_insert_with(|| Active {
        area: objc2::rc::Weak::from(&**area),
        model: SelectionModel::new(),
        shown: Vec::new(),
        dragging: Cell::new(false),
        over_press: false,
        pointer: Cell::new(None),
    });
    let clicks = clicks.max(1) as u32;
    active.over_press = over_press;
    active.dragging.set(clicks > 1 || shift);
    // Content may have changed since the last batch looked.
    active.model.texts_changed(&texts);
    active
        .model
        .press(&texts, point(Points(lx), Points(ly)), clicks, shift);
    active.show(&texts);
}

/// The primary button, pressed in `area`, moved by `(dx, dy)` from where it
/// went down, to `(x, y)` (root coordinates). True while the drag selects
/// (past a slop): presses must not fire then. Past the edge of a scroll
/// view around the area, that scrolls ([`autoscroll`]).
pub(crate) fn drag(
    surface: &Rc<Surface>,
    area: &NshView,
    dx: f32,
    dy: f32,
    x: f32,
    y: f32,
) -> bool {
    {
        let active = surface.selection.area.active.borrow();
        let Some(active) = active.as_ref() else {
            return false;
        };
        if !active.dragging.get() {
            let slop = if active.over_press { SLOP_PRESS } else { SLOP };
            if dx.hypot(dy) <= slop {
                return false;
            }
            active.dragging.set(true);
        }
        active.pointer.set(Some((x, y)));
    }
    extend(surface, area, x, y);
    if past_edge(surface, area, x, y).is_some() {
        autoscroll(surface);
    }
    true
}

/// The selection's focus follows the pointer at `(x, y)` (root
/// coordinates).
fn extend(surface: &Surface, area: &NshView, x: f32, y: f32) {
    let (lx, ly) = crate::input::local(surface, area, x, y);
    let texts = collect(area);
    let mut active = surface.selection.area.active.borrow_mut();
    let Some(active) = active.as_mut() else {
        return;
    };
    if active.model.drag(&texts, point(Points(lx), Points(ly))) {
        active.show(&texts);
    }
}

/// The primary button, pressed in an area, went up. True if it ended a
/// selecting drag.
pub(crate) fn up(surface: &Surface) -> bool {
    surface
        .selection
        .area
        .active
        .borrow()
        .as_ref()
        .is_some_and(|a| {
            a.pointer.set(None);
            a.dragging.replace(false)
        })
}

/// How far the autoscroll moves per point the pointer is past the edge,
/// per 60 Hz frame, and at most.
const AUTOSCROLL_RATE: f32 = 0.4;
const AUTOSCROLL_MAX: f32 = 40.0;

/// The innermost scroll view around `area` (or `area` itself) that can
/// still move toward where the pointer at `(x, y)` (root coordinates) is
/// past its edge, and how far past it is.
fn past_edge(surface: &Surface, area: &NshView, x: f32, y: f32) -> Option<(NshView, f32, f32)> {
    let past = |p: f32, extent: f32| {
        if p < 0.0 {
            p
        } else if p > extent {
            p - extent
        } else {
            0.0
        }
    };
    let mut current = Some(area.clone());
    while let Some(view) = current {
        if view.kind() == ViewKind::Scroll {
            let (lx, ly) = crate::input::local(surface, &view, x, y);
            let frame = view.state().frame.size;
            let horizontal = view.state().scroll.as_ref().is_some_and(|s| s.horizontal);
            // Along its axis only.
            let (dx, dy) = if horizontal {
                (past(lx, frame.width.0), 0.0)
            } else {
                (0.0, past(ly, frame.height.0))
            };
            if (dx != 0.0 || dy != 0.0) && crate::scroll::can_scroll(&view, dx, dy) {
                return Some((view, dx, dy));
            }
        }
        current = view.parent_view();
    }
    None
}

/// Starts scrolling on every frame while the selecting pointer stays past
/// the edge of a scroll view around the area, held still too: faster the
/// further past, the selection extended each frame. It stops when the
/// button goes up, the pointer comes back inside or the content ends.
fn autoscroll(surface: &Rc<Surface>) {
    if surface.selection.area.scrolling.replace(true) {
        return;
    }
    let mut last = None;
    surface.add_frame_callback(move |surface, now| {
        // Frames as long as at 60 Hz move as far whatever the display's
        // rate.
        let scale = last.map_or(1.0, |l: f64| ((now - l) * 60.0).clamp(0.25, 4.0) as f32);
        last = Some(now);
        let going = autoscroll_frame(surface, scale);
        if !going {
            surface.selection.area.scrolling.set(false);
        }
        going
    });
}

/// One frame of the autoscroll; false when it is over.
fn autoscroll_frame(surface: &Rc<Surface>, scale: f32) -> bool {
    let target = {
        let active = surface.selection.area.active.borrow();
        active
            .as_ref()
            .filter(|a| a.dragging.get())
            .and_then(|a| Some((a.area()?, a.pointer.get()?)))
    };
    let Some((area, (x, y))) = target else {
        return false;
    };
    let Some((view, dx, dy)) = past_edge(surface, &area, x, y) else {
        return false;
    };
    let step = |d: f32| (d * AUTOSCROLL_RATE * scale).clamp(-AUTOSCROLL_MAX, AUTOSCROLL_MAX);
    if !crate::scroll::autoscroll(surface, &view, step(dx), step(dy)) {
        return false;
    }
    extend(surface, &area, x, y);
    true
}

/// The batch is applied: the texts of the area that has a selection are
/// listed again (new content, texts added or gone).
pub(crate) fn end_batch(surface: &Surface) {
    let mut slot = surface.selection.area.active.borrow_mut();
    let Some(active) = slot.as_mut() else {
        return;
    };
    let Some(area) = active.area() else {
        // The area is gone.
        active.hide();
        *slot = None;
        return;
    };
    if active.model.is_empty() && !active.dragging.get() {
        return;
    }
    let texts = collect(&area);
    active.model.texts_changed(&texts);
    active.show(&texts);
}
