//! Selectable views (`ViewProps::selectable_view`: `View`'s
//! `selectable`, a selectable `TextView`): one selection across the texts of
//! a view's subtree, from text to text, as a browser selects across a
//! page. The selection itself is [`nsh_core::selection`]'s model; this
//! module lists an area's texts for it ([`Texts`]), feeds it the mouse's
//! gestures and draws what it selects.
//!
//! - The texts of an area are the text views of its subtree, depth first
//!   (document order), whose text is not `selectable={false}`; an area
//!   inside another is part of the outer one (only the outermost is
//!   active). Frames are the texts' content boxes in the area's
//!   coordinates, through GTK's allocation transforms (frames, scroll
//!   offsets, shifts); hit-testing is the main thread's layout of each
//!   text ([`LinuxLayout::hit_test`]).
//! - Gestures come from `input.rs`, whose pointer handlers serve real and
//!   simulated (`nsh test --target linux`) input alike: a mouse press in an area presses
//!   the model (the click count as GTK counts double clicks; Shift+click
//!   extends), drags past [`SELECT_SLOP`] (or [`SELECT_SLOP_PRESS`] over a
//!   press target inside the area, so links still press) drag it and
//!   cancel the press, the release sets the primary selection. Any press
//!   elsewhere (a touch, another area, a hosted widget, anything outside)
//!   clears it: one selection per surface. Dragging past the edge of a
//!   scroll view around the area scrolls it ([`autoscroll`]).
//! - While it has a selection the area view takes keyboard focus: Ctrl+A
//!   selects all of the area, Ctrl+C / Ctrl+Insert copy, Escape clears;
//!   so do the window menu's Copy and Select All roles (the `clipboard` /
//!   `selection` action groups on the area). Losing the focus clears it,
//!   which also ends a single text's selection when an area takes the
//!   focus, and the other way around.
//! - Each text draws its part ([`ViewState::area_selection`]) with the
//!   single-text highlight (`text::draw`); texts in an area never run a
//!   selection of their own.
//! - Batches touching an area's subtree mark it; at the end of the batch
//!   its texts are listed again, the model told ([`SelectionModel::texts_changed`])
//!   and the highlights redrawn.
//!
//! [`ViewState::area_selection`]: crate::view::ViewState::area_selection

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use gtk4::{self as gtk, gdk, gio, glib, graphene, prelude::*};
use nsh_core::{
    AttributedText, NodeId, TextLayout,
    geometry::{Bounds, Point, Points},
    selection::{SelectionModel, SelectionTexts},
};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    text::{LinuxLayout, SELECT_SLOP, SELECT_SLOP_PRESS},
    view::NshView,
};

/// The selectable views of a surface and the mouse's gesture in one.
#[derive(Default)]
pub(crate) struct State {
    /// Every view with `selectable_view`, by node id (nested ones too).
    areas: RefCell<FxHashMap<NodeId, Area>>,
    /// The mouse is down in an area.
    drag: RefCell<Option<Drag>>,
    /// The last press, for counting double and triple clicks.
    click: Cell<Option<Click>>,
}

/// One selectable view.
struct Area {
    view: glib::WeakRef<NshView>,
    model: SelectionModel,
    /// The texts that draw part of the selection.
    highlighted: Vec<glib::WeakRef<NshView>>,
    /// A batch changed its subtree.
    dirty: bool,
    /// Its keys and focus controllers.
    controllers: [gtk::EventController; 2],
}

/// The mouse pressed in an area.
struct Drag {
    area: NodeId,
    /// Where it went down (root coordinates).
    start: (f32, f32),
    /// How far it moves before it selects.
    slop: f32,
    /// It selects (moved past the slop, or a double / triple click or a
    /// Shift+click that selected on the press).
    selecting: bool,
    /// Where it is (root coordinates).
    last: (f32, f32),
    /// The timer scrolling a scroll view while the pointer is past its
    /// edge.
    autoscroll: Option<glib::SourceId>,
}

#[derive(Debug, Clone, Copy)]
struct Click {
    area: NodeId,
    time: f64,
    x: f32,
    y: f32,
    count: u32,
}

/// The texts of an area, in document order.
#[derive(Default)]
struct Texts {
    items: Vec<Item>,
}

struct Item {
    view: NshView,
    text: Arc<AttributedText>,
    layout: TextLayout,
    /// The content box, in the area's coordinates.
    frame: Bounds<Points>,
}

impl SelectionTexts for Texts {
    fn len(&self) -> usize {
        self.items.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.items[i].text.text
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.items[i].frame
    }

    fn key(&self, i: usize) -> u64 {
        // The text view's node: the selection follows it when texts come
        // or go before it.
        u64::from(self.items[i].view.id())
    }

    fn offset_at(&self, i: usize, point: Point<Points>) -> u32 {
        let item = &self.items[i];
        item.layout.downcast::<LinuxLayout>().map_or(0, |l| {
            l.hit_test(
                (point.x - item.frame.origin.x).0,
                (point.y - item.frame.origin.y).0,
            )
            .offset
        })
    }
}

/// Lists the texts of `area`.
fn collect(area: &NshView) -> Texts {
    fn walk(area: &NshView, view: &NshView, out: &mut Vec<Item>) {
        {
            let s = view.state();
            if s.style.hidden {
                return;
            }
            if let Some(drawn) = &s.text
                && drawn.text.selectable != Some(false)
            {
                let origin = drawn.content.origin;
                let at = view
                    .compute_point(area, &graphene::Point::new(origin.x.0, origin.y.0))
                    .map_or(origin, |p| Point::new(Points(p.x()), Points(p.y())));
                out.push(Item {
                    view: view.clone(),
                    text: drawn.text.clone(),
                    layout: drawn.layout.clone(),
                    frame: Bounds::new(at, drawn.content.size),
                });
            }
        }
        for child in view.child_views() {
            walk(area, &child, out);
        }
    }
    let mut items = Vec::new();
    walk(area, area, &mut items);
    Texts { items }
}

/// The outermost selectable view around `view` (itself included).
pub(crate) fn area_of(view: &NshView) -> Option<NshView> {
    let mut area = None;
    let mut current = Some(view.clone());
    while let Some(v) = current {
        if v.state().props.selectable_view {
            area = Some(v.clone());
        }
        current = v.parent_view();
    }
    area
}

/// Whether `view` draws text that takes part in an area (its pointer is
/// the I-beam).
pub(crate) fn takes_part(view: &NshView) -> bool {
    let part = view
        .state()
        .text
        .as_ref()
        .is_some_and(|t| t.text.selectable != Some(false));
    part && area_of(view).is_some()
}

/// A point in root coordinates in `area`'s.
fn to_area(surface: &Surface, area: &NshView, (x, y): (f32, f32)) -> Point<Points> {
    let (x, y) = surface
        .root
        .compute_point(area, &graphene::Point::new(x, y))
        .map_or((x, y), |p| (p.x(), p.y()));
    Point::new(Points(x), Points(y))
}

fn view_of(surface: &Surface, id: NodeId) -> Option<NshView> {
    surface
        .selection
        .areas
        .borrow()
        .get(&id)
        .and_then(|a| a.view.upgrade())
}

// --- Mounting -----------------------------------------------------------------------

/// `view`'s props changed: it became a selectable view or stopped being one.
pub(crate) fn props_changed(surface: &Rc<Surface>, view: &NshView) {
    let on = view.state().props.selectable_view;
    let id = view.id();
    let state = &surface.selection;
    let current = state
        .areas
        .borrow()
        .get(&id)
        .is_some_and(|a| a.view.upgrade().as_ref() == Some(view));
    match (current, on) {
        (false, true) => {
            let area = Area::install(surface, view);
            if let Some(old) = state.areas.borrow_mut().insert(id, area) {
                old.uninstall();
            }
        }
        (true, false) => {
            let old = state.areas.borrow_mut().remove(&id);
            if let Some(old) = old {
                old.uninstall();
            }
        }
        _ => {}
    }
}

/// A batch changed `view` (its text, its place in the tree): the area
/// around it lists its texts again at the end of the batch.
pub(crate) fn touched(surface: &Surface, view: &NshView) {
    let state = &surface.selection;
    if state.areas.borrow().is_empty() {
        return;
    }
    if let Some(area) = area_of(view)
        && let Some(a) = state.areas.borrow_mut().get_mut(&area.id())
    {
        a.dirty = true;
    }
}

/// The batch is applied: areas it changed list their texts again.
pub(crate) fn end_batch(surface: &Rc<Surface>) {
    let state = &surface.selection;
    let dirty: Vec<(NodeId, NshView)> = {
        let mut areas = state.areas.borrow_mut();
        if areas.is_empty() {
            return;
        }
        areas.retain(|_, a| a.view.upgrade().is_some());
        areas
            .iter_mut()
            .filter_map(|(&id, a)| {
                std::mem::take(&mut a.dirty).then(|| Some((id, a.view.upgrade()?)))?
            })
            .collect()
    };
    for (id, view) in dirty {
        // An area inside another is part of the outer one.
        if area_of(&view).as_ref() != Some(&view) {
            continue;
        }
        let texts = collect(&view);
        // The I-beam, for texts that came in with no cursor of their own.
        for item in texts.items.iter().filter(|i| i.view.cursor().is_none()) {
            crate::input::style_changed(&item.view);
        }
        // Highlights follow the texts even when the model stays as it was
        // (a text inserted before the selection moves it to the next).
        let selected = state.areas.borrow_mut().get_mut(&id).is_some_and(|a| {
            a.model.texts_changed(&texts);
            !a.model.is_empty() || !a.highlighted.is_empty()
        });
        if selected {
            apply(surface, id, &view, &texts);
        }
    }
}

/// Forgets every area (the surface's views are gone).
pub(crate) fn reset(surface: &Surface) {
    let state = &surface.selection;
    if let Some(mut drag) = state.drag.take()
        && let Some(timer) = drag.autoscroll.take()
    {
        timer.remove();
    }
    state.click.set(None);
    let areas = std::mem::take(&mut *state.areas.borrow_mut());
    for (_, area) in areas {
        area.uninstall();
    }
}

impl Area {
    /// Gives `view` the controllers and actions of an area.
    fn install(surface: &Rc<Surface>, view: &NshView) -> Area {
        let id = view.id();
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(surface);
        keys.connect_key_pressed(move |_, key, _, modifiers| match weak.upgrade() {
            Some(surface) if key_in(&surface, id, key, modifiers) => glib::Propagation::Stop,
            _ => glib::Propagation::Proceed,
        });
        let focus = gtk::EventControllerFocus::new();
        let weak = Rc::downgrade(surface);
        focus.connect_is_focus_notify(move |c| {
            // The window going to the background keeps its focus widget,
            // and so the selection.
            let Some(surface) = weak.upgrade() else {
                return;
            };
            let Some(view) = c.widget() else { return };
            if !c.is_focus() && view.root().and_then(|r| r.focus()).as_ref() != Some(&view) {
                clear(&surface, id);
            }
        });
        view.add_controller(keys.clone());
        view.add_controller(focus.clone());
        // The window menu's editing roles run the focused widget's actions.
        let action = |name: &str, f: fn(&Rc<Surface>, NodeId)| {
            let action = gio::SimpleAction::new(name, None);
            let weak = Rc::downgrade(surface);
            action.connect_activate(move |_, _| {
                if let Some(surface) = weak.upgrade() {
                    f(&surface, id);
                }
            });
            let group = gio::SimpleActionGroup::new();
            group.add_action(&action);
            group
        };
        view.insert_action_group("clipboard", Some(&action("copy", copy)));
        view.insert_action_group("selection", Some(&action("select-all", select_all)));
        Area {
            view: view.downgrade(),
            model: SelectionModel::new(),
            highlighted: Vec::new(),
            dirty: true,
            controllers: [keys.upcast(), focus.upcast()],
        }
    }

    /// Takes the selection, controllers and actions off the view.
    fn uninstall(self) {
        unhighlight(&self.highlighted, &[]);
        let Some(view) = self.view.upgrade() else {
            return;
        };
        for c in &self.controllers {
            view.remove_controller(c);
        }
        view.insert_action_group("clipboard", None::<&gio::ActionGroup>);
        view.insert_action_group("selection", None::<&gio::ActionGroup>);
        view.set_focusable(false);
    }
}

// --- Gestures -----------------------------------------------------------------------

/// A pointer went down on `hit` (a hosted widget when `native`): clears a
/// selection anywhere else, and returns the area a mouse press there
/// selects in (its drags select rather than pan).
pub(crate) fn pressed(
    surface: &Surface,
    hit: &NshView,
    mouse: bool,
    native: bool,
) -> Option<NshView> {
    let state = &surface.selection;
    if state.areas.borrow().is_empty() {
        return None;
    }
    let area = area_of(hit).filter(|_| !native);
    let keep = area.as_ref().map(NshView::id);
    let others: Vec<NodeId> = state
        .areas
        .borrow()
        .iter()
        .filter(|&(&id, a)| Some(id) != keep && !a.model.is_empty())
        .map(|(&id, _)| id)
        .collect();
    for id in others {
        clear(surface, id);
    }
    area.filter(|_| mouse)
}

/// The mouse went down at `(x, y)` (root coordinates) in `area`; the press
/// is over a press target inside the area when `over_press`.
pub(crate) fn begin(
    surface: &Surface,
    area: &NshView,
    (x, y): (f32, f32),
    time: f64,
    modifiers: gdk::ModifierType,
    over_press: bool,
) {
    let state = &surface.selection;
    let id = area.id();
    let count = click_count(state, id, x, y, time);
    let extend = count == 1 && modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    if let Some(mut old) = state.drag.take()
        && let Some(timer) = old.autoscroll.take()
    {
        timer.remove();
    }
    state.drag.replace(Some(Drag {
        area: id,
        start: (x, y),
        slop: if over_press {
            SELECT_SLOP_PRESS
        } else {
            SELECT_SLOP
        },
        selecting: count > 1 || extend,
        last: (x, y),
        autoscroll: None,
    }));
    let texts = collect(area);
    let point = to_area(surface, area, (x, y));
    let changed = state
        .areas
        .borrow_mut()
        .get_mut(&id)
        .is_some_and(|a| a.model.press(&texts, point, count, extend));
    if changed {
        apply(surface, id, area, &texts);
    }
}

/// The press's click count: 2 or 3 when it follows the last one quickly
/// and close by, in the same area, as GTK counts them.
fn click_count(state: &State, area: NodeId, x: f32, y: f32, time: f64) -> u32 {
    let settings = gtk::Settings::default();
    let interval = settings.as_ref().map_or(400, |s| s.gtk_double_click_time()) as f64;
    let distance = settings
        .as_ref()
        .map_or(5, |s| s.gtk_double_click_distance()) as f32;
    let count = match state.click.get() {
        Some(c)
            if c.area == area
                && time - c.time >= 0.0
                && time - c.time <= interval
                && (x - c.x).abs() <= distance
                && (y - c.y).abs() <= distance =>
        {
            (c.count % 3) + 1
        }
        _ => 1,
    };
    state.click.set(Some(Click {
        area,
        time,
        x,
        y,
        count,
    }));
    count
}

/// The mouse moved to `(x, y)` (root coordinates) while down: past the
/// slop the selection follows it. Returns whether it selects (the press
/// under it is over).
pub(crate) fn dragged(surface: &Rc<Surface>, x: f32, y: f32) -> bool {
    {
        let mut drag = surface.selection.drag.borrow_mut();
        let Some(d) = drag.as_mut() else {
            return false;
        };
        d.last = (x, y);
        if !d.selecting {
            if (x - d.start.0).hypot(y - d.start.1) <= d.slop {
                return false;
            }
            d.selecting = true;
        }
    }
    follow(surface);
    autoscroll(surface);
    true
}

/// The selection follows the dragging mouse.
fn follow(surface: &Surface) {
    let Some((id, last)) = surface
        .selection
        .drag
        .borrow()
        .as_ref()
        .map(|d| (d.area, d.last))
    else {
        return;
    };
    let Some(area) = view_of(surface, id) else {
        return;
    };
    let texts = collect(&area);
    let point = to_area(surface, &area, last);
    let changed = surface
        .selection
        .areas
        .borrow_mut()
        .get_mut(&id)
        .is_some_and(|a| a.model.drag(&texts, point));
    if changed {
        apply(surface, id, &area, &texts);
    }
}

/// The mouse came up (or the grab broke).
pub(crate) fn released(surface: &Surface) {
    let Some(mut drag) = surface.selection.drag.take() else {
        return;
    };
    if let Some(timer) = drag.autoscroll.take() {
        timer.remove();
    }
    if !drag.selecting {
        return;
    }
    // X11 / Wayland: what is selected is the primary selection.
    if let Some((area, text)) = selected_text(surface, drag.area) {
        area.primary_clipboard().set_text(&text);
    }
}

// --- Autoscroll ---------------------------------------------------------------------

/// How often a drag past a scroll view's edge scrolls it (ms).
const AUTOSCROLL_INTERVAL: u64 = 16;

/// The scroll view around the dragging mouse's area that it is past an
/// edge of, and by how much to scroll it (wheel deltas).
fn autoscroll_target(surface: &Surface) -> Option<(NshView, f32, f32)> {
    let (id, last) = surface
        .selection
        .drag
        .borrow()
        .as_ref()
        .filter(|d| d.selecting)
        .map(|d| (d.area, d.last))?;
    let mut current = view_of(surface, id);
    while let Some(view) = current {
        current = view.parent_view();
        let (horizontal, w, h) = {
            let s = view.state();
            let Some(scroll) = &s.scroll else { continue };
            (
                scroll.horizontal,
                s.frame.size.width.0,
                s.frame.size.height.0,
            )
        };
        let (x, y) = surface
            .root
            .compute_point(&view, &graphene::Point::new(last.0, last.1))
            .map_or(last, |p| (p.x(), p.y()));
        let past = |at: f32, extent: f32| {
            if at < 0.0 {
                at
            } else if at > extent {
                at - extent
            } else {
                0.0
            }
        };
        // Faster the further past the edge, as browsers scroll.
        let speed = |d: f32| {
            if d == 0.0 {
                0.0
            } else {
                d.signum() * (d.abs() / 4.0).clamp(1.0, 24.0)
            }
        };
        let (dx, dy) = if horizontal {
            (speed(past(x, w)), 0.0)
        } else {
            (0.0, speed(past(y, h)))
        };
        if (dx, dy) != (0.0, 0.0) && crate::scroll::can_scroll(&view, dx, dy) {
            return Some((view, dx, dy));
        }
    }
    None
}

/// Starts scrolling the scroll view the dragging mouse is past the edge
/// of, while it stays there.
fn autoscroll(surface: &Rc<Surface>) {
    let running = surface
        .selection
        .drag
        .borrow()
        .as_ref()
        .is_none_or(|d| d.autoscroll.is_some());
    if running || autoscroll_target(surface).is_none() {
        return;
    }
    let weak = Rc::downgrade(surface);
    let timer = glib::timeout_add_local(Duration::from_millis(AUTOSCROLL_INTERVAL), move || {
        let Some(surface) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        let Some((view, dx, dy)) = autoscroll_target(&surface) else {
            if let Some(d) = surface.selection.drag.borrow_mut().as_mut() {
                d.autoscroll = None;
            }
            return glib::ControlFlow::Break;
        };
        crate::scroll::wheel(&surface, &view, dx, dy);
        follow(&surface);
        glib::ControlFlow::Continue
    });
    match surface.selection.drag.borrow_mut().as_mut() {
        Some(d) => d.autoscroll = Some(timer),
        None => timer.remove(),
    }
}

// --- Keys and copying ---------------------------------------------------------------

/// A key pressed while focus is in the area: Ctrl+A, Ctrl+C,
/// Ctrl+Insert, Escape.
fn key_in(surface: &Rc<Surface>, id: NodeId, key: gdk::Key, modifiers: gdk::ModifierType) -> bool {
    use gdk::Key;
    let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
    let selected = surface
        .selection
        .areas
        .borrow()
        .get(&id)
        .is_some_and(|a| !a.model.is_empty());
    match key {
        Key::c | Key::C | Key::Insert if ctrl && selected => copy(surface, id),
        Key::a | Key::A if ctrl => select_all(surface, id),
        // Without a selection Escape goes on (to going back).
        Key::Escape if selected => clear(surface, id),
        _ => return false,
    }
    true
}

/// The selected text of area `id`, as a copy gives it.
fn selected_text(surface: &Surface, id: NodeId) -> Option<(NshView, String)> {
    let area = view_of(surface, id)?;
    let texts = collect(&area);
    let text = {
        let areas = surface.selection.areas.borrow();
        let model = &areas.get(&id)?.model;
        if model.is_empty() {
            return None;
        }
        model.text(&texts)
    };
    Some((area, text))
}

/// Copies area `id`'s selection to the clipboard.
fn copy(surface: &Rc<Surface>, id: NodeId) {
    if let Some((area, text)) = selected_text(surface, id) {
        area.clipboard().set_text(&text);
    }
}

/// Selects every text of area `id`.
fn select_all(surface: &Rc<Surface>, id: NodeId) {
    let Some(area) = view_of(surface, id) else {
        return;
    };
    let texts = collect(&area);
    let changed = surface
        .selection
        .areas
        .borrow_mut()
        .get_mut(&id)
        .is_some_and(|a| a.model.select_all(&texts));
    if changed {
        apply(surface, id, &area, &texts);
    }
}

/// Clears area `id`'s selection.
fn clear(surface: &Surface, id: NodeId) {
    let changed = surface
        .selection
        .areas
        .borrow_mut()
        .get_mut(&id)
        .is_some_and(|a| a.model.clear());
    if changed && let Some(area) = view_of(surface, id) {
        apply(surface, id, &area, &Texts::default());
    }
}

// --- Drawing ------------------------------------------------------------------------

/// Shows area `id`'s selection: each text's range, the keyboard focus
/// while there is one.
fn apply(surface: &Surface, id: NodeId, area: &NshView, texts: &Texts) {
    let (ranges, empty, old) = {
        let mut areas = surface.selection.areas.borrow_mut();
        let Some(a) = areas.get_mut(&id) else { return };
        let ranges = a.model.ranges(texts);
        (
            ranges,
            a.model.is_empty(),
            std::mem::take(&mut a.highlighted),
        )
    };
    let mut highlighted = Vec::with_capacity(ranges.len());
    let mut drawn = Vec::with_capacity(ranges.len());
    for (i, range) in ranges {
        let view = &texts.items[i].view;
        let range = Some((range.start, range.end));
        if std::mem::replace(&mut view.state_mut().area_selection, range) != range {
            view.queue_draw();
        }
        highlighted.push(view.downgrade());
        drawn.push(view.clone());
    }
    unhighlight(&old, &drawn);
    if let Some(a) = surface.selection.areas.borrow_mut().get_mut(&id) {
        a.highlighted = highlighted;
    }
    // No borrows held: focus changes run the focus controllers, which may
    // clear other selections.
    if empty {
        area.set_focusable(false);
    } else if !area.has_focus() {
        area.set_focusable(true);
        area.grab_focus();
    }
}

/// Takes the highlight off the texts of `old` that are not in `keep`.
fn unhighlight(old: &[glib::WeakRef<NshView>], keep: &[NshView]) {
    for view in old.iter().filter_map(glib::WeakRef::upgrade) {
        if !keep.contains(&view) && view.state_mut().area_selection.take().is_some() {
            view.queue_draw();
        }
    }
}
