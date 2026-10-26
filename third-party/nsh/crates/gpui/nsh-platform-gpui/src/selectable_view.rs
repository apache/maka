//! Selectable views (`View`'s `selectable`: a view whose
//! `ViewProps::selectable_view` is set): one selection across the texts of
//! the view's subtree, from a point in one text to a point in another, as a
//! browser selects across the elements of a page.
//!
//! The model is the core's ([`nsh_core::selection`]). This module lists an
//! area's texts for it ([`AreaTexts`]: the texts of the subtree that are not
//! `selectable={false}`, depth first; their content boxes in the area's
//! coordinates through the views' positions, transforms and scroll
//! offsets; hit tests on [`crate::text`]'s line layout), feeds it the
//! mouse's gestures, which [`crate::input`] routes here before a text could
//! select alone, and writes what each text has selected to its
//! `DrawnText::area_range`, which [`crate::text::draw`] highlights in the
//! text's `selectionColor`.
//!
//! The conventions are a single selectable text's: a drag selects past a
//! slop (a larger one over a press target, so a click on a link still
//! presses it), a double click words, a triple click paragraphs, Shift+click
//! extends; Cmd (macOS) or Ctrl +C / +A and Escape; a right click shows Copy
//! and Select All. Dragging past the edge of a scroll view around the area
//! scrolls it. An area inside another is part of the outer one. One
//! selection at a time: an area's clears a single text's and the other way
//! around; a press outside the area clears it.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use nsh_core::{
    AttributedText, Bounds, EventKind, Points,
    geometry::{Point, point},
    selection::{SelectionModel, SelectionTexts},
};
use rustc_hash::FxHashSet;

use crate::{
    geom::Mat4,
    input::{KeyEvent, PointerKind},
    surface::Surface,
    view::NshView,
};

/// How often a drag past a scroll view's edge scrolls it (ms).
const AUTOSCROLL_MS: u64 = 16;
/// Points scrolled per tick for each point the pointer is past the edge.
const AUTOSCROLL_RATE: f32 = 0.5;
/// The most points scrolled per tick.
const AUTOSCROLL_MAX: f32 = 40.0;

thread_local! {
    /// The area with a selection, or the last one pressed (which Ctrl+A
    /// selects): one at a time, as text selections are.
    static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) };
}

/// The selection of one area.
struct Active {
    /// Its surface's key.
    surface: u64,
    area: NshView,
    model: SelectionModel,
    /// The texts and their content when the model last saw them: a batch
    /// that changes them tells the model.
    seen: Vec<(NshView, Arc<AttributedText>)>,
    /// The texts with a highlighted range.
    highlighted: Vec<NshView>,
    /// The mouse button is down in the area.
    gesture: Option<Gesture>,
}

/// A press in an area, while the button is down.
struct Gesture {
    /// Where the button went down (root coordinates).
    down: (f32, f32),
    /// Where the pointer is (root coordinates).
    at: (f32, f32),
    /// It moved past the slop (or extends a double or triple click).
    dragging: bool,
    /// It began over a press target (a link, `onPress`).
    over_press: bool,
    /// An autoscroll timer runs.
    scrolling: bool,
}

/// One text of an area.
struct AreaText {
    view: NshView,
    text: Arc<AttributedText>,
    /// From the text view's coordinates to the root's.
    to_root: Mat4,
    /// Its content box in the area's coordinates.
    frame: Bounds<Points>,
}

/// The texts of an area in document order, as the model sees them.
struct AreaTexts {
    /// From the area's coordinates to the root's.
    area: Mat4,
    texts: Vec<AreaText>,
}

impl SelectionTexts for AreaTexts {
    fn len(&self) -> usize {
        self.texts.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.texts[i].text.text
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.texts[i].frame
    }

    fn offset_at(&self, i: usize, p: Point<Points>) -> u32 {
        let t = &self.texts[i];
        self.area
            .map(p.x.0, p.y.0)
            .and_then(|(x, y)| t.to_root.unproject(x, y))
            .and_then(|(x, y)| crate::text::caret_at(&t.view.state(), x, y))
            .unwrap_or(0)
    }
    fn key(&self, i: usize) -> u64 {
        u64::from(self.texts[i].view.id())
    }
}

impl AreaTexts {
    /// The texts of `area` (`None` when it is not attached).
    fn of(area: &NshView) -> Option<Self> {
        let to_root = area.to_root()?;
        let mut texts = Vec::new();
        collect(area, &to_root, &to_root, &mut texts);
        Some(AreaTexts {
            area: to_root,
            texts,
        })
    }

    /// Root coordinates `(x, y)` in the area's.
    fn point(&self, (x, y): (f32, f32)) -> Point<Points> {
        let (x, y) = self.area.unproject(x, y).unwrap_or((x, y));
        point(Points(x), Points(y))
    }

    fn seen(&self) -> Vec<(NshView, Arc<AttributedText>)> {
        self.texts
            .iter()
            .map(|t| (t.view.clone(), t.text.clone()))
            .collect()
    }

    /// Whether these are the texts `seen` lists, saying the same.
    fn same(&self, seen: &[(NshView, Arc<AttributedText>)]) -> bool {
        self.texts.len() == seen.len()
            && self.texts.iter().zip(seen).all(|(t, (view, text))| {
                t.view == *view && (Arc::ptr_eq(&t.text, text) || t.text.text == text.text)
            })
    }
}

/// Adds the texts of `view`'s subtree (`m`: from its coordinates to the
/// root's), depth first: drawing order, which is the document's.
fn collect(view: &NshView, m: &Mat4, area: &Mat4, out: &mut Vec<AreaText>) {
    let s = view.state();
    if s.style.hidden || s.concealed || s.live.as_ref().is_some_and(|l| l.dying()) {
        return;
    }
    if let Some(drawn) = &s.text
        && drawn.text.selectable != Some(false)
        && let Some(frame) = frame_in(area, m, drawn.content)
    {
        out.push(AreaText {
            view: view.clone(),
            text: drawn.text.clone(),
            to_root: *m,
            frame,
        });
    }
    view.with_children(|children| {
        for child in children {
            let local = {
                let c = child.state();
                let (x, y) = s.child_origin(c.frame, c.shift);
                let local = Mat4::new().translate(x, y);
                match c.transform() {
                    Some(t) => Mat4::mul(&t, &local),
                    None => local,
                }
            };
            collect(child, &Mat4::mul(&local, m), area, out);
        }
    });
}

/// `content` (a text view's coordinates, `m` to the root's) in the area's
/// coordinates (`area` to the root's): the bounds of its corners.
fn frame_in(area: &Mat4, m: &Mat4, content: Bounds<Points>) -> Option<Bounds<Points>> {
    let (x, y) = (content.origin.x.0, content.origin.y.0);
    let (w, h) = (content.size.width.0, content.size.height.0);
    let mut min = (f32::MAX, f32::MAX);
    let mut max = (f32::MIN, f32::MIN);
    for (cx, cy) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
        let (rx, ry) = m.map(cx, cy)?;
        let (ax, ay) = area.unproject(rx, ry)?;
        min = (min.0.min(ax), min.1.min(ay));
        max = (max.0.max(ax), max.1.max(ay));
    }
    Some(crate::geom::rect(
        min.0,
        min.1,
        max.0 - min.0,
        max.1 - min.1,
    ))
}

/// Writes what each text has selected to the texts and clears the
/// highlights of the texts that no longer have any.
fn highlight(highlighted: &mut Vec<NshView>, model: &SelectionModel, texts: &AreaTexts) {
    let ranges = model.ranges(texts);
    let mut now = Vec::with_capacity(ranges.len());
    let mut ids = FxHashSet::default();
    for (i, range) in ranges {
        let view = &texts.texts[i].view;
        set_range(view, Some((range.start, range.end)));
        ids.insert(view.id());
        now.push(view.clone());
    }
    for view in highlighted.drain(..) {
        if !ids.contains(&view.id()) {
            set_range(&view, None);
        }
    }
    *highlighted = now;
}

/// Clears every highlight of `highlighted`.
fn unhighlight(highlighted: &[NshView]) {
    for view in highlighted {
        set_range(view, None);
    }
}

fn set_range(view: &NshView, range: Option<(u32, u32)>) {
    let changed = {
        let mut s = view.state_mut();
        match s.text.as_mut() {
            Some(drawn) if drawn.area_range != range => {
                drawn.area_range = range;
                true
            }
            _ => false,
        }
    };
    if changed {
        view.changed();
    }
}

/// Makes `area` of `surface` the active area (the one before loses its
/// selection) and calls `f` with it.
fn with_area<R>(surface: u64, area: &NshView, f: impl FnOnce(&mut Active) -> R) -> R {
    ACTIVE.with_borrow_mut(|active| {
        if active
            .as_ref()
            .is_some_and(|a| a.area != *area || a.surface != surface)
            && let Some(old) = active.take()
        {
            unhighlight(&old.highlighted);
        }
        let a = active.get_or_insert_with(|| Active {
            surface,
            area: area.clone(),
            model: SelectionModel::new(),
            seen: Vec::new(),
            highlighted: Vec::new(),
            gesture: None,
        });
        f(a)
    })
}

/// The selectable view `view` is in (the outermost, as an area inside
/// another is part of it), if any.
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

/// Whether a press on `view` may select in its area: anything in it but a
/// text that is `selectable={false}` (which [`crate::input`] also leaves to
/// pans and touch handlers).
pub(crate) fn takes(view: &NshView) -> bool {
    view.state()
        .text
        .as_ref()
        .is_none_or(|t| t.text.selectable != Some(false))
}

/// Whether the text a view draws takes part in a selectable view around it
/// (the I-beam over it).
pub(crate) fn selects(state: &crate::view::ViewState) -> bool {
    state
        .text
        .as_ref()
        .is_some_and(|t| t.text.selectable != Some(false))
}

/// Whether a press at `(x, y)` (root coordinates) on `target` is over a
/// press target between it and `area`: a pressable link, a view with press
/// listeners.
fn over_press(area: &NshView, target: &NshView, (x, y): (f32, f32)) -> bool {
    let press = [EventKind::Press, EventKind::LongPress, EventKind::PressDown];
    let link = target
        .to_root()
        .and_then(|m| m.unproject(x, y))
        .and_then(|(lx, ly)| {
            let s = target.state();
            let i = crate::text::char_at(&s, lx, ly)?;
            let link = s.text.as_ref()?.text.link_at(i)?;
            Some(press.iter().any(|&k| link.events.contains(k)))
        })
        .unwrap_or(false);
    if link {
        return true;
    }
    let mut current = Some(target.clone());
    while let Some(v) = current {
        if press.iter().any(|&k| v.state().events.contains(k)) {
            return true;
        }
        if v == *area {
            break;
        }
        current = v.parent_view();
    }
    false
}

/// The mouse's primary button went down at `(x, y)` (root coordinates) on
/// `target` in `area` (`clicks`: the click count).
pub(crate) fn down(
    surface: &Rc<Surface>,
    area: &NshView,
    target: &NshView,
    at: (f32, f32),
    clicks: u32,
    shift: bool,
) {
    crate::text::clear_selection();
    let Some(texts) = AreaTexts::of(area) else {
        return;
    };
    let over_press = over_press(area, target, at);
    let p = texts.point(at);
    with_area(surface.key(), area, |a| {
        a.seen = texts.seen();
        let extend = shift && clicks <= 1;
        a.model.press(&texts, p, clicks.max(1), extend);
        highlight(&mut a.highlighted, &a.model, &texts);
        a.gesture = Some(Gesture {
            down: at,
            at,
            dragging: clicks >= 2 || extend,
            over_press,
            scrolling: false,
        });
    });
}

/// The mouse moved or its button went up (`kind`) at `(x, y)` (root
/// coordinates) after [`down`]; true when the area took it (a drag that
/// selects).
pub(crate) fn pointer(surface: &Rc<Surface>, kind: PointerKind, x: f32, y: f32) -> bool {
    let key = surface.key();
    match kind {
        PointerKind::Move => {
            let (taken, scroll) = ACTIVE.with_borrow_mut(|active| {
                let Some(a) = active.as_mut().filter(|a| a.surface == key) else {
                    return (false, false);
                };
                let Some(g) = a.gesture.as_mut() else {
                    return (false, false);
                };
                g.at = (x, y);
                if !g.dragging {
                    let slop = if g.over_press {
                        crate::text::SELECT_SLOP_PRESS
                    } else {
                        crate::text::SELECT_SLOP
                    };
                    if (x - g.down.0).hypot(y - g.down.1) <= slop {
                        return (false, false);
                    }
                    g.dragging = true;
                }
                let Some(texts) = AreaTexts::of(&a.area) else {
                    return (true, false);
                };
                if a.model.drag(&texts, texts.point((x, y))) {
                    highlight(&mut a.highlighted, &a.model, &texts);
                }
                let scroll = !g.scrolling && autoscroll_delta(&a.area, (x, y)).is_some();
                g.scrolling |= scroll;
                (true, scroll)
            });
            if scroll {
                autoscroll(key);
            }
            taken
        }
        PointerKind::Up | PointerKind::Cancel => {
            let text = ACTIVE.with_borrow_mut(|active| {
                let a = active.as_mut().filter(|a| a.surface == key)?;
                let g = a.gesture.take()?;
                if !g.dragging || a.model.is_empty() {
                    return Some(None);
                }
                let texts = AreaTexts::of(&a.area)?;
                Some(Some(a.model.text(&texts)))
            });
            match text {
                Some(Some(text)) => {
                    set_primary(text);
                    true
                }
                _ => false,
            }
        }
        PointerKind::Down | PointerKind::Leave => false,
    }
}

/// A finished drag sets the primary selection (Linux: middle-click pastes
/// it).
fn set_primary(text: String) {
    #[cfg(target_os = "linux")]
    if !text.is_empty() {
        crate::rt::on_app(move |cx| cx.write_to_primary(gpui::ClipboardItem::new_string(text)));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = text;
}

/// How a drag at `(x, y)` (root coordinates) scrolls the scroll views
/// around `area` (the area itself included), nearest first: the view and
/// its wheel deltas, when the pointer is past one's edge along its axis and
/// it can scroll that way.
fn autoscroll_delta(area: &NshView, (x, y): (f32, f32)) -> Option<(NshView, f32, f32)> {
    let past = |at: f32, size: f32| {
        let d = if at < 0.0 {
            at
        } else if at > size {
            at - size
        } else {
            0.0
        };
        (d * AUTOSCROLL_RATE).clamp(-AUTOSCROLL_MAX, AUTOSCROLL_MAX)
    };
    let mut current = Some(area.clone());
    while let Some(v) = current {
        let axis = v.state().scroll.as_ref().map(|s| s.horizontal);
        if let Some(horizontal) = axis
            && let Some((lx, ly)) = v.to_root().and_then(|m| m.unproject(x, y))
        {
            let (w, h) = {
                let s = v.state();
                (s.frame.size.width.0, s.frame.size.height.0)
            };
            let (dx, dy) = if horizontal {
                (past(lx, w), 0.0)
            } else {
                (0.0, past(ly, h))
            };
            if (dx != 0.0 || dy != 0.0) && crate::scroll::can_scroll(&v, dx, dy) {
                return Some((v, dx, dy));
            }
        }
        current = v.parent_view();
    }
    None
}

/// Scrolls while a drag is past a scroll view's edge, selecting on as the
/// content moves under the pointer.
fn autoscroll(key: u64) {
    crate::rt::after_ms(AUTOSCROLL_MS, move || {
        let Some(surface) = Surface::by_key(key) else {
            return;
        };
        let next = ACTIVE.with_borrow_mut(|active| {
            let a = active.as_mut().filter(|a| a.surface == key)?;
            let g = a.gesture.as_mut().filter(|g| g.dragging)?;
            let delta = autoscroll_delta(&a.area, g.at);
            if delta.is_none() {
                g.scrolling = false;
            }
            delta
        });
        let Some((view, dx, dy)) = next else {
            return;
        };
        crate::scroll::wheel(&surface, &view, dx, dy);
        ACTIVE.with_borrow_mut(|active| {
            let Some(a) = active.as_mut().filter(|a| a.surface == key) else {
                return;
            };
            let Some(at) = a.gesture.as_ref().map(|g| g.at) else {
                return;
            };
            if let Some(texts) = AreaTexts::of(&a.area)
                && a.model.drag(&texts, texts.point(at))
            {
                highlight(&mut a.highlighted, &a.model, &texts);
            }
        });
        autoscroll(key);
    });
}

/// Clears the area selection, if there is one (a text selects alone).
pub(crate) fn clear_all() {
    if let Some(a) = ACTIVE.with_borrow_mut(Option::take) {
        unhighlight(&a.highlighted);
    }
}

/// A press anywhere in the window at `(x, y)` (root coordinates), before
/// the views get it: a press outside the active area clears its selection.
pub(crate) fn window_pressed(surface: &Surface, x: f32, y: f32) {
    let Some(area) = ACTIVE.with_borrow(|a| {
        a.as_ref()
            .filter(|a| a.surface == surface.key())
            .map(|a| a.area.clone())
    }) else {
        return;
    };
    let inside = area
        .to_root()
        .and_then(|m| m.unproject(x, y))
        .is_some_and(|(lx, ly)| {
            let s = area.state();
            lx >= 0.0 && ly >= 0.0 && lx < s.frame.size.width.0 && ly < s.frame.size.height.0
        });
    if !inside {
        clear_all();
    }
}

/// A batch was applied to `surface`: the active area's texts may have
/// changed (new content, texts added or gone), or the area itself gone.
pub(crate) fn batch_applied(surface: &Surface) {
    let gone = ACTIVE.with_borrow_mut(|active| {
        let a = active.as_mut().filter(|a| a.surface == surface.key())?;
        let texts = match AreaTexts::of(&a.area) {
            Some(texts) if a.area.state().props.selectable_view => texts,
            _ => return Some(()),
        };
        if !texts.same(&a.seen) {
            a.model.texts_changed(&texts);
            a.seen = texts.seen();
            highlight(&mut a.highlighted, &a.model, &texts);
        }
        None
    });
    if gone.is_some() {
        clear_all();
    }
}

/// Selects every text of `area`.
fn select_all(surface: u64, area: &NshView) {
    crate::text::clear_selection();
    let Some(texts) = AreaTexts::of(area) else {
        return;
    };
    with_area(surface, area, |a| {
        a.seen = texts.seen();
        if a.model.select_all(&texts) {
            highlight(&mut a.highlighted, &a.model, &texts);
        }
    });
}

/// The selected text of the active area of `surface`, if any is selected.
fn selected_text(surface: u64) -> Option<String> {
    ACTIVE.with_borrow(|active| {
        let a = active.as_ref().filter(|a| a.surface == surface)?;
        if a.model.is_empty() {
            return None;
        }
        let texts = AreaTexts::of(&a.area)?;
        Some(a.model.text(&texts)).filter(|t| !t.is_empty())
    })
}

/// A right click in `area`: Copy (its selection) and Select All.
pub(crate) fn context_menu(surface: &Rc<Surface>, area: &NshView) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    // The area becomes the active one, for Select All and the keys.
    let key = surface.key();
    let selected = with_area(key, area, |a| !a.model.is_empty());
    let all = area.clone();
    crate::chrome::popup_actions(
        surface,
        vec![
            LocalItem::Item {
                role: Some(MenuRole::Copy),
                label: "",
                enabled: selected,
                action: Rc::new(move |s| {
                    if let Some(text) = selected_text(s.key()) {
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

/// The retained area owner, independent of its changing selection range.
pub(crate) fn keyboard_owner(surface: &Surface) -> Option<NshView> {
    ACTIVE.with_borrow(|active| {
        active
            .as_ref()
            .filter(|active| active.surface == surface.key() && active.area.attached())
            .map(|active| active.area.clone())
    })
}

/// Keys for the active area's selection (Ctrl+C or Ctrl+Insert, Ctrl+A,
/// Escape; Cmd on macOS); true when handled. Ctrl+A selects the area last
/// pressed; copying and Escape need a selection.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    const VK_A: u16 = 0x41;
    const VK_C: u16 = 0x43;
    const VK_INSERT: u16 = 0x2D;
    const VK_ESCAPE: u16 = 0x1B;
    if !event.down {
        return false;
    }
    let key = surface.key();
    let Some(area) = keyboard_owner(surface) else {
        return false;
    };
    let empty = ACTIVE.with_borrow(|active| active.as_ref().unwrap().model.is_empty());
    let m = event.modifiers;
    let command = if surface.environment.get().uses_apple_keys() {
        m.meta && !m.ctrl
    } else {
        m.ctrl
    } && !m.alt;
    match event.vk {
        VK_C | VK_INSERT if command && !empty => {
            if let Some(text) = selected_text(key) {
                crate::system::set_clipboard_text(&text);
            }
        }
        VK_A if command => select_all(key, &area),
        VK_ESCAPE if !empty => {
            ACTIVE.with_borrow_mut(|active| {
                if let Some(a) = active.as_mut()
                    && a.model.clear()
                {
                    unhighlight(&a.highlighted);
                    a.highlighted.clear();
                }
            });
        }
        _ => return false,
    }
    true
}
