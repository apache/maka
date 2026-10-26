//! Selectable views (`View`'s `selectable`, a view whose
//! `ViewProps::selectable_view` is set): one selection across the texts of
//! the area's subtree, from text to text in document order, as a browser
//! selects across the elements of a page. The model is
//! [`nsh_core::selection`]; this module lists the texts of an area
//! ([`Texts`]: their frames through the views' frames, transforms and
//! scroll offsets, hit-testing on their layouts), feeds the model the
//! mouse's presses and drags and hands each text the part to highlight
//! ([`crate::text::DrawnText::area_range`]).
//!
//! An area inside another is part of the outer one. Texts outside areas
//! keep their own selection ([`crate::text`]); texts in an area never run
//! theirs. One selection exists at a time across the surfaces of the
//! thread, a single text's or an area's: the area last pressed is current
//! (Ctrl+A selects all of it even before anything is selected), a press
//! outside it ends it. While the mouse selects past an edge of the scroll
//! view around the area, that scroll view scrolls ([`autoscroll`]).

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::Arc,
};

use nsh_core::{
    AttributedText, Bounds, EventKind, Point, Points,
    geometry::point,
    selection::{SelectionModel, SelectionTexts},
};

use crate::{
    geom::{Mat4, rect},
    input::{KeyEvent, PointerKind},
    surface::Surface,
    view::{ItemPointer, NshView},
};

/// How far (points) the mouse moves before a drag selects, as on single
/// texts.
const SELECT_SLOP: f32 = 3.0;
/// The same over a press target (a link, `onPress`).
const SELECT_SLOP_PRESS: f32 = 10.0;
/// How often (ms) autoscroll scrolls while the mouse is past an edge.
const AUTOSCROLL_TICK: u64 = 16;
/// Autoscroll's step per tick for each point the mouse is past the edge,
/// and its largest step.
const AUTOSCROLL_RATE: f32 = 0.3;
const AUTOSCROLL_MAX: f32 = 40.0;

/// The texts of an area, in document order (depth first, children bottom
/// to top), as the model sees them: coordinates are the area's.
struct Texts {
    views: Vec<NshView>,
    texts: Vec<Arc<AttributedText>>,
    /// Content boxes in the area's coordinates.
    frames: Vec<Bounds<Points>>,
    /// Each text view's transform to the root.
    to_root: Vec<Mat4>,
    /// The area's transform to the root.
    area: Mat4,
}

impl Texts {
    /// The texts of `area` (none when it is not attached).
    fn of(area: &NshView) -> Texts {
        let mut texts = Texts {
            views: Vec::new(),
            texts: Vec::new(),
            frames: Vec::new(),
            to_root: Vec::new(),
            area: area.to_root().unwrap_or_default(),
        };
        if area.attached() {
            texts.collect(area);
        }
        texts
    }

    fn collect(&mut self, view: &NshView) {
        view.with_children(|children| {
            for child in children {
                self.add(child);
                self.collect(child);
            }
        });
    }

    /// Adds `view` when it is text that takes part.
    fn add(&mut self, view: &NshView) {
        let (text, content) = {
            let s = view.state();
            match &s.text {
                Some(d) if takes_part(&d.text) => (d.text.clone(), d.content),
                _ => return,
            }
        };
        let Some(to_root) = view.to_root() else {
            return;
        };
        let Some(frame) = self.to_area(&to_root, content) else {
            return;
        };
        self.views.push(view.clone());
        self.texts.push(text);
        self.frames.push(frame);
        self.to_root.push(to_root);
    }

    /// `content` (a view's coordinates) in the area's: the bounds of its
    /// corners.
    fn to_area(&self, to_root: &Mat4, content: Bounds<Points>) -> Option<Bounds<Points>> {
        let (x, y) = (content.origin.x.0, content.origin.y.0);
        let (w, h) = (content.size.width.0, content.size.height.0);
        let mut min = (f32::INFINITY, f32::INFINITY);
        let mut max = (f32::NEG_INFINITY, f32::NEG_INFINITY);
        for (cx, cy) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
            let (rx, ry) = to_root.map(cx, cy)?;
            let (ax, ay) = self.area.unproject(rx, ry)?;
            min = (min.0.min(ax), min.1.min(ay));
            max = (max.0.max(ax), max.1.max(ay));
        }
        Some(rect(min.0, min.1, max.0 - min.0, max.1 - min.1))
    }
}

impl SelectionTexts for Texts {
    fn len(&self) -> usize {
        self.views.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.texts[i].text
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.frames[i]
    }

    fn offset_at(&self, i: usize, p: Point<Points>) -> u32 {
        let local = self
            .area
            .map(p.x.0, p.y.0)
            .and_then(|(rx, ry)| self.to_root[i].unproject(rx, ry));
        let Some((x, y)) = local else { return 0 };
        crate::text::caret_at(&self.views[i].state(), x, y).unwrap_or(0)
    }

    fn key(&self, i: usize) -> u64 {
        u64::from(self.views[i].id())
    }
}

/// Whether text takes part in the area around it.
fn takes_part(text: &AttributedText) -> bool {
    text.selectable != Some(false)
}

/// The area `view` is in (itself included): the outermost one.
pub(crate) fn area_of(view: &NshView) -> Option<NshView> {
    let mut area = None;
    let mut at = Some(view.clone());
    while let Some(v) = at {
        if v.state().props.selectable_view {
            area = Some(v.clone());
        }
        at = v.parent_view();
    }
    area
}

/// The area a mouse press on `view` selects in: `view` is in one and is
/// neither a text field nor text that is `selectable={false}`.
pub(crate) fn target(view: &NshView) -> Option<NshView> {
    {
        let s = view.state();
        if s.kind == nsh_core::ViewKind::Input
            || s.text.as_ref().is_some_and(|d| !takes_part(&d.text))
        {
            return None;
        }
    }
    area_of(view)
}

/// Whether `view` is text that takes part in an area (the I-beam).
pub(crate) fn is_area_text(view: &NshView) -> bool {
    let part = view
        .state()
        .text
        .as_ref()
        .is_some_and(|d| takes_part(&d.text));
    part && area_of(view).is_some()
}

/// The current area: its selection and the mouse's press on it.
struct Current {
    surface: u64,
    area: NshView,
    model: SelectionModel,
    /// The texts that show a highlight.
    highlighted: Vec<NshView>,
    /// Where the button went down (area coordinates), while it is down.
    down: Option<(f32, f32)>,
    /// The pressed button moved far enough to select.
    dragging: bool,
    /// The press began over a press target (links, `onPress`).
    over_press: bool,
    /// Where the pressed mouse last was (root coordinates).
    last: Option<(f32, f32)>,
    /// An autoscroll tick is pending.
    autoscrolling: bool,
}

impl Current {
    fn new(surface: u64, area: NshView) -> Current {
        Current {
            surface,
            area,
            model: SelectionModel::new(),
            highlighted: Vec::new(),
            down: None,
            dragging: false,
            over_press: false,
            last: None,
            autoscrolling: false,
        }
    }

    /// Hands each text its part of the selection.
    fn apply(&mut self, texts: &Texts) {
        let ranges = self.model.ranges(texts);
        let mut highlighted = Vec::with_capacity(ranges.len());
        for (i, range) in ranges {
            let view = &texts.views[i];
            set_range(view, Some((range.start, range.end)));
            highlighted.push(view.clone());
        }
        for view in std::mem::replace(&mut self.highlighted, highlighted) {
            if !self.highlighted.contains(&view) {
                set_range(&view, None);
            }
        }
    }

    /// Takes the highlights away.
    fn unhighlight(&mut self) {
        for view in self.highlighted.drain(..) {
            set_range(&view, None);
        }
    }
}

fn set_range(view: &NshView, range: Option<(u32, u32)>) {
    let changed = view
        .state()
        .text
        .as_ref()
        .is_some_and(|d| d.area_range.replace(range) != range);
    if changed {
        view.changed();
    }
}

thread_local! {
    /// The area last pressed or selected in. Taken out while it is worked
    /// on, so nothing called meanwhile (a redraw, a menu's message loop)
    /// finds it borrowed.
    static CURRENT: RefCell<Option<Current>> = const { RefCell::new(None) };
    /// Texts or the tree changed since the last batch ended.
    static DIRTY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The current area of `surface`, taken out (put it back with
/// [`put`]).
fn take(surface: u64, area: Option<&NshView>) -> Option<Current> {
    let current = CURRENT.take()?;
    if current.surface == surface && area.is_none_or(|a| *a == current.area) {
        Some(current)
    } else {
        CURRENT.set(Some(current));
        None
    }
}

fn put(current: Current) {
    // Something made another current meanwhile: that one stays.
    let mut current = Some(current);
    CURRENT.with_borrow_mut(|c| {
        if c.is_none() {
            *c = current.take();
        }
    });
    if let Some(mut lost) = current {
        lost.unhighlight();
    }
}

/// Ends the current area's selection (a single text was selected).
pub(crate) fn clear() {
    if let Some(mut current) = CURRENT.take() {
        current.unhighlight();
    }
}

/// A mount item changed texts or the tree: the selection is clamped to
/// them at the end of the batch.
pub(crate) fn tree_changed() {
    DIRTY.set(true);
}

/// The batch is applied: the selection follows new content, and ends
/// with its area.
pub(crate) fn end_batch(surface: &Rc<Surface>) {
    if !DIRTY.get() {
        return;
    }
    let Some(mut current) = take(surface.key(), None) else {
        return;
    };
    DIRTY.set(false);
    let gone = !current.area.attached() || !current.area.state().props.selectable_view;
    if gone {
        current.unhighlight();
        return;
    }
    let texts = Texts::of(&current.area);
    current.model.texts_changed(&texts);
    current.apply(&texts);
    put(current);
}

/// A press anywhere in the window at `(x, y)` (root coordinates), before
/// the views get it: ends the area's selection when the press is outside
/// it.
pub(crate) fn window_pressed(surface: &Surface, x: f32, y: f32) {
    let Some(mut current) = take(surface.key(), None) else {
        return;
    };
    let inside = current
        .area
        .to_root()
        .and_then(|m| m.unproject(x, y))
        .is_some_and(|(lx, ly)| {
            let s = current.area.state();
            lx >= 0.0 && ly >= 0.0 && lx < s.frame.size.width.0 && ly < s.frame.size.height.0
        });
    if inside {
        put(current);
    } else {
        current.unhighlight();
    }
}

/// Whether a press at `(x, y)` (`area`'s coordinates) on `target` falls on
/// a press target: a view between it and the area with press listeners,
/// or a link of its text.
fn over_press(area: &NshView, target: &NshView, x: f32, y: f32) -> bool {
    let press = [EventKind::Press, EventKind::LongPress, EventKind::PressDown];
    let link = area
        .to_root()
        .and_then(|m| m.map(x, y))
        .and_then(|(rx, ry)| target.to_root()?.unproject(rx, ry))
        .is_some_and(|(tx, ty)| {
            let s = target.state();
            let Some(drawn) = &s.text else { return false };
            crate::text::char_at(&s, tx, ty)
                .and_then(|i| drawn.text.link_at(i))
                .is_some_and(|l| press.iter().any(|&k| l.events.contains(k)))
        });
    if link {
        return true;
    }
    let mut at = Some(target.clone());
    while let Some(v) = at {
        if press.iter().any(|&k| v.state().events.contains(k)) {
            return true;
        }
        if v == *area {
            break;
        }
        at = v.parent_view();
    }
    false
}

/// A mouse event on `area` (area coordinates), pressed on `target` (the
/// view under the press); true when handled. A press over a link or a
/// view with press listeners is left to them (false) and only selects once
/// dragged past a larger slop.
pub(crate) fn pointer(
    surface: &Rc<Surface>,
    area: &NshView,
    target: &NshView,
    event: &ItemPointer,
) -> bool {
    let key = surface.key();
    let at = point(Points(event.x), Points(event.y));
    match event.kind {
        PointerKind::Down => {
            let mut current = match CURRENT.take() {
                Some(c) if c.surface == key && c.area == *area => c,
                other => {
                    if let Some(mut other) = other {
                        other.unhighlight();
                    }
                    Current::new(key, area.clone())
                }
            };
            crate::text::clear_selected();
            current.down = Some((event.x, event.y));
            current.last = None;
            current.over_press = over_press(area, target, event.x, event.y);
            let clicks = event.clicks.max(1);
            let extend = event.modifiers.shift;
            // A click only places the anchor; words, paragraphs and Shift
            // select at once.
            current.dragging = clicks > 1 || extend;
            let texts = Texts::of(area);
            if current.model.press(&texts, at, clicks, extend) {
                current.apply(&texts);
            }
            let handled = !current.over_press;
            put(current);
            handled
        }
        PointerKind::Move => {
            let Some(mut current) = take(key, Some(area)) else {
                return false;
            };
            let Some((x0, y0)) = current.down else {
                put(current);
                return false;
            };
            if !current.dragging {
                let slop = if current.over_press {
                    SELECT_SLOP_PRESS
                } else {
                    SELECT_SLOP
                };
                if (event.x - x0).hypot(event.y - y0) <= slop {
                    put(current);
                    return false;
                }
                current.dragging = true;
            }
            let texts = Texts::of(area);
            if current.model.drag(&texts, at) {
                current.apply(&texts);
            }
            current.last = area.to_root().and_then(|m| m.map(event.x, event.y));
            let past = current
                .last
                .zip(scroll_view_of(area))
                .is_some_and(|((x, y), view)| past_edges(&view, x, y) != (0.0, 0.0));
            if past && !current.autoscrolling {
                current.autoscrolling = true;
                schedule(Rc::downgrade(surface));
            }
            put(current);
            true
        }
        PointerKind::Up | PointerKind::Cancel => {
            let Some(mut current) = take(key, Some(area)) else {
                return false;
            };
            let handled =
                current.down.take().is_some() && std::mem::replace(&mut current.dragging, false);
            put(current);
            handled
        }
        PointerKind::Leave => false,
    }
}

// --- Autoscroll ---------------------------------------------------------------------

/// The nearest scroll view around `area`.
fn scroll_view_of(area: &NshView) -> Option<NshView> {
    let mut at = area.parent_view();
    while let Some(v) = at {
        if v.state().scroll.is_some() {
            return Some(v);
        }
        at = v.parent_view();
    }
    None
}

/// How far `(x, y)` (root coordinates) is past the edges of `view`
/// (negative above or left of it, 0 inside).
fn past_edges(view: &NshView, x: f32, y: f32) -> (f32, f32) {
    let bounds = view.to_root().and_then(|m| {
        let s = view.state();
        m.bounds(0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)
    });
    let Some((bx, by, bw, bh)) = bounds else {
        return (0.0, 0.0);
    };
    let past = |p: f32, start: f32, len: f32| {
        if p < start {
            p - start
        } else if p > start + len {
            p - (start + len)
        } else {
            0.0
        }
    };
    (past(x, bx, bw), past(y, by, bh))
}

/// Scrolls `view` toward the mouse at `(x, y)` (root coordinates) when it
/// is past an edge along the view's axis, by how far; false when it is
/// not or the view cannot move that way.
fn autoscroll_by(surface: &Rc<Surface>, view: &NshView, x: f32, y: f32) -> bool {
    let Some(horizontal) = view.state().scroll.as_ref().map(|s| s.horizontal) else {
        return false;
    };
    let (px, py) = past_edges(view, x, y);
    let step = |d: f32| (d * AUTOSCROLL_RATE).clamp(-AUTOSCROLL_MAX, AUTOSCROLL_MAX);
    let (dx, dy) = if horizontal {
        (step(px), 0.0)
    } else {
        (0.0, step(py))
    };
    if (dx, dy) == (0.0, 0.0) || !crate::scroll::can_scroll(view, dx, dy) {
        return false;
    }
    // A mouse wheel's scroll: clamped, settles when it stops.
    crate::scroll::wheel(surface, view, dx, dy);
    true
}

fn schedule(surface: Weak<Surface>) {
    crate::input::after_ms(AUTOSCROLL_TICK, move || autoscroll(surface));
}

/// One autoscroll tick: while the mouse is held past an edge of the scroll
/// view around the area, it scrolls and the selection follows the mouse
/// over the content that moved in; it stops on the release or back inside.
fn autoscroll(surface: Weak<Surface>) {
    let Some(strong) = surface.upgrade() else {
        return;
    };
    let Some(mut current) = take(strong.key(), None) else {
        return;
    };
    let held = current.down.is_some() && current.dragging;
    let Some((x, y)) = current.last.filter(|_| held) else {
        current.autoscrolling = false;
        put(current);
        return;
    };
    let area = current.area.clone();
    let scrolled = scroll_view_of(&area).is_some_and(|view| autoscroll_by(&strong, &view, x, y));
    if !scrolled {
        current.autoscrolling = false;
        put(current);
        return;
    }
    if let Some((ax, ay)) = area.to_root().and_then(|m| m.unproject(x, y)) {
        let texts = Texts::of(&area);
        if current.model.drag(&texts, point(Points(ax), Points(ay))) {
            current.apply(&texts);
        }
    }
    put(current);
    schedule(surface);
}

/// The selected text of `area`, if it is current and has a selection.
fn selected_text(surface: u64, area: Option<&NshView>) -> Option<String> {
    let current = take(surface, area)?;
    let text = (!current.model.is_empty()).then(|| {
        let texts = Texts::of(&current.area);
        current.model.text(&texts)
    });
    put(current);
    text
}

/// Selects every text of `area`, which becomes current.
fn select_all(surface: u64, area: &NshView) {
    let mut current = match CURRENT.take() {
        Some(c) if c.surface == surface && c.area == *area => c,
        other => {
            if let Some(mut other) = other {
                other.unhighlight();
            }
            Current::new(surface, area.clone())
        }
    };
    crate::text::clear_selected();
    let texts = Texts::of(area);
    if current.model.select_all(&texts) {
        current.apply(&texts);
    }
    put(current);
}

/// A right click in `area`: Copy (its selection) and Select All.
pub(crate) fn context_menu(surface: &Rc<Surface>, area: &NshView) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    let key = surface.key();
    let selected = selected_text(key, Some(area)).is_some_and(|t| !t.is_empty());
    let (copy, all) = (area.clone(), area.clone());
    crate::chrome::popup_actions(
        surface,
        vec![
            LocalItem::Item {
                role: Some(MenuRole::Copy),
                label: "",
                enabled: selected,
                action: Rc::new(move |s| {
                    if let Some(text) = selected_text(s.key(), Some(&copy)) {
                        crate::system::set_clipboard_text(&text);
                    }
                }),
            },
            LocalItem::Item {
                role: Some(MenuRole::SelectAll),
                label: "",
                enabled: true,
                action: Rc::new(move |s| select_all(s.key(), &all)),
            },
        ],
    );
}

/// Keys for the current area's selection (Ctrl+C / Ctrl+Insert, Ctrl+A,
/// Escape); true when handled.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    const VK_A: u16 = 0x41;
    const VK_C: u16 = 0x43;
    const VK_INSERT: u16 = 0x2D;
    const VK_ESCAPE: u16 = 0x1B;
    if !event.down {
        return false;
    }
    let key = surface.key();
    let Some(current) = take(key, None) else {
        return false;
    };
    let area = current.area.clone();
    let (attached, empty) = (area.attached(), current.model.is_empty());
    put(current);
    if !attached {
        return false;
    }
    let ctrl = event.modifiers.ctrl && !event.modifiers.alt;
    match event.vk {
        VK_C | VK_INSERT if ctrl && !empty => {
            if let Some(text) = selected_text(key, Some(&area)) {
                crate::system::set_clipboard_text(&text);
            }
        }
        VK_A if ctrl => select_all(key, &area),
        VK_ESCAPE if !empty => {
            if let Some(mut current) = take(key, Some(&area)) {
                if current.model.clear() {
                    current.apply(&Texts::of(&area));
                }
                put(current);
            }
        }
        _ => return false,
    }
    true
}
